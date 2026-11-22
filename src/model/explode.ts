import * as THREE from 'three';
import { worldBounds } from './geometry';
import type { Entity, Group } from './types';

/**
 * Exploded view (a display state, never a model change; ADR 0019, ADR 0022): every part
 * comes apart, level by level through the group tree, so all parts can be seen.
 * - Groups (assemblies) move apart sideways, as clusters, until they no longer overlap.
 * - Inside a group, its parts and subgroups come apart around the group's own centre:
 *   sideways in proportion to their distance from it (legs move out), and parts that sit
 *   on or inside each other (a top in its rim, a lid on a box) are stacked upwards in
 *   order, with a gap, so concentric parts separate too.
 * - Nothing sinks below the model's base: exploded drawings grow up and out from the floor.
 * While a group is open, only its contents come apart. Offsets are computed at full spread
 * and scaled by `factor`, so the slider moves everything smoothly. DOM-free.
 */

export type ExplodeAxis = 'x' | 'y' | 'z';

/** Sideways spread at factor 1: a part's distance from its level's centre doubles. */
const SPREAD = 1;
/** Gap between stacked parts at factor 1, as a fraction of the level's largest size. */
const GAP = 0.12;
const AXES = ['x', 'y', 'z'] as const;

interface Unit {
  /** Entity ids in this unit (the part, or every visible part inside the group). */
  ids: string[];
  isGroup: boolean;
  /** Assembled bounds. */
  box: THREE.Box3;
  /** Offsets of the unit's own contents relative to it (groups only). */
  inner: Map<string, THREE.Vector3>;
  /** Bounds with the contents exploded (before this level's offset). */
  exploded: THREE.Box3;
  offset: THREE.Vector3;
}

export function explodeOffsets(
  entities: Entity[],
  groups: Group[],
  openGroupId: string | null,
  factor: number,
  axis?: ExplodeAxis | null,
): Map<string, THREE.Vector3> {
  const out = new Map<string, THREE.Vector3>();
  if (factor <= 0) return out;
  const visible = entities.filter((e) => e.visible);
  if (!visible.length) return out;
  const boxes = new Map(visible.map((e) => [e.id, worldBounds(e)]));
  const children = new Map<string | null, Group[]>();
  for (const g of groups) {
    const parent = g.parentId ?? null;
    children.set(parent, [...(children.get(parent) ?? []), g]);
  }
  const partsIn = new Map<string | null, Entity[]>();
  for (const e of visible) partsIn.set(e.groupId ?? null, [...(partsIn.get(e.groupId ?? null) ?? []), e]);

  const root = openGroupId && groups.some((g) => g.id === openGroupId) ? openGroupId : null;
  const full = explodeLevel(root, { children, partsIn, boxes }, axis ?? null);
  if (!full.size) return out;

  // Stand on the floor: the lowest exploded part sits where the assembly's bottom was.
  let assembledMin = Infinity;
  let explodedMin = Infinity;
  for (const [id, o] of full) {
    const b = boxes.get(id)!;
    assembledMin = Math.min(assembledMin, b.min.z);
    explodedMin = Math.min(explodedMin, b.min.z + o.z);
  }
  const lift = assembledMin - explodedMin;
  for (const [id, o] of full) {
    const v = o.clone();
    v.z += lift;
    v.multiplyScalar(factor);
    if (v.lengthSq() > 1e-12) out.set(id, v);
  }
  return out;
}

interface Tree {
  children: Map<string | null, Group[]>;
  partsIn: Map<string | null, Entity[]>;
  boxes: Map<string, THREE.Box3>;
}

/** Full-spread offsets for everything inside `groupId` (null: the whole model). */
function explodeLevel(groupId: string | null, tree: Tree, axis: ExplodeAxis | null): Map<string, THREE.Vector3> {
  const units: Unit[] = [];
  for (const e of tree.partsIn.get(groupId) ?? []) {
    const box = tree.boxes.get(e.id)!.clone();
    units.push({ ids: [e.id], isGroup: false, box, inner: new Map(), exploded: box.clone(), offset: new THREE.Vector3() });
  }
  for (const g of tree.children.get(groupId) ?? []) {
    const inner = explodeLevel(g.id, tree, axis);
    const ids = idsInside(g.id, tree);
    if (!ids.length) continue;
    const box = new THREE.Box3();
    const exploded = new THREE.Box3();
    for (const id of ids) {
      const b = tree.boxes.get(id)!;
      box.union(b);
      exploded.union(b.clone().translate(inner.get(id) ?? new THREE.Vector3()));
    }
    units.push({ ids, isGroup: true, box, inner, exploded, offset: new THREE.Vector3() });
  }

  const result = new Map<string, THREE.Vector3>();
  if (units.length === 1) {
    // A lone unit doesn't move at this level; its contents may still come apart.
    for (const [id, o] of units[0].inner) result.set(id, o.clone());
    return result;
  }
  if (!units.length) return result;

  const all = new THREE.Box3();
  for (const u of units) all.union(u.box);
  const centre = all.getCenter(new THREE.Vector3());
  const size = all.getSize(new THREE.Vector3());
  const gap = GAP * Math.max(size.x, size.y, size.z);
  // Stacking runs along the chosen axis (default up); sideways spread uses the others.
  const stack = axis ?? 'z';
  const side = axis ? [] : AXES.filter((a) => a !== stack);
  const radial = (u: Unit, k: number) => {
    const d = u.box.getCenter(new THREE.Vector3()).sub(centre);
    const v = new THREE.Vector3();
    for (const a of side) v[a] = d[a] * k;
    return v;
  };

  // Parts spread sideways in proportion to their distance from the centre.
  for (const u of units) if (!u.isGroup) u.offset.copy(radial(u, SPREAD));
  // Assemblies move apart sideways until their exploded clusters no longer overlap.
  const assemblies = units.filter((u) => u.isGroup);
  if (side.length && assemblies.length > 1) {
    let k = SPREAD;
    for (let i = 0; i < 40; i++) {
      for (const u of assemblies) u.offset.copy(radial(u, k));
      if (!assemblies.some((a, j) => assemblies.slice(j + 1).some((b) => overlaps(placed(a), placed(b), side, gap * 0.5)))) break;
      k *= 1.25;
    }
  }

  // Then stack along the stack axis, in order: whatever still overlaps a placed unit
  // (looking along the stack axis) goes above it, with a gap.
  const across = AXES.filter((a) => a !== stack);
  const order = [...units].sort((a, b) => a.box.getCenter(new THREE.Vector3())[stack] - b.box.getCenter(new THREE.Vector3())[stack] || volume(b.box) - volume(a.box));
  const done: Unit[] = [];
  for (const u of order) {
    const box = placed(u);
    let min = box.min[stack];
    for (const p of done) {
      const pb = placed(p);
      if (overlaps(box, pb, across, 0)) min = Math.max(min, pb.max[stack] + gap);
    }
    u.offset[stack] += min - box.min[stack];
    done.push(u);
  }

  for (const u of units) {
    for (const id of u.ids) result.set(id, u.offset.clone().add(u.inner.get(id) ?? new THREE.Vector3()));
  }
  return result;
}

function placed(u: Unit): THREE.Box3 {
  return u.exploded.clone().translate(u.offset);
}

/** Do two boxes overlap on every one of `axes` (by more than -margin)? */
function overlaps(a: THREE.Box3, b: THREE.Box3, axes: readonly ExplodeAxis[], margin: number): boolean {
  return axes.every((k) => a.min[k] < b.max[k] + margin - 1e-6 && b.min[k] < a.max[k] + margin - 1e-6);
}

function volume(b: THREE.Box3): number {
  const s = b.getSize(new THREE.Vector3());
  return s.x * s.y * s.z;
}

function idsInside(groupId: string, tree: Tree): string[] {
  const ids = (tree.partsIn.get(groupId) ?? []).map((e) => e.id);
  for (const g of tree.children.get(groupId) ?? []) ids.push(...idsInside(g.id, tree));
  return ids;
}
