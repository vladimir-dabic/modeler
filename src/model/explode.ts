import * as THREE from 'three';
import { worldBounds } from './geometry';
import { selectionUnitGroup } from './groups';
import type { Entity, Group } from './types';

/**
 * Exploded view (a display state, never a model change): every unit moves away from the
 * assembly's centre in proportion to its distance from it, then the whole arrangement is
 * lifted so it still stands on the model's base. Units are what a click selects
 * (ADR 0011): top-level groups and loose parts, or, while a group is open, the parts and
 * subgroups directly inside it. DOM-free.
 */

export type ExplodeAxis = 'x' | 'y' | 'z';

/** At factor 1, every unit's distance from the centre grows by this much (×2.5 total). */
const SPREAD = 1.5;

export function explodeOffsets(
  entities: Entity[],
  groups: Group[],
  openGroupId: string | null,
  factor: number,
  axis?: ExplodeAxis | null,
): Map<string, THREE.Vector3> {
  const out = new Map<string, THREE.Vector3>();
  if (factor <= 0) return out;
  const units = new Map<string, Entity[]>();
  for (const e of entities) {
    if (!e.visible) continue;
    // Inside an open group, only its contents come apart; the rest stays put.
    if (openGroupId && !groupChainHas(e, openGroupId, groups)) continue;
    const key = selectionUnitGroup(e, groups, openGroupId) ?? e.id;
    const list = units.get(key) ?? [];
    list.push(e);
    units.set(key, list);
  }
  if (units.size < 2) return out;
  const centres = new Map<string, THREE.Vector3>();
  const all = new THREE.Box3();
  for (const [key, list] of units) {
    const box = new THREE.Box3();
    for (const e of list) box.union(worldBounds(e));
    centres.set(key, box.getCenter(new THREE.Vector3()));
    all.union(box);
  }
  const centre = all.getCenter(new THREE.Vector3());
  const k = factor * SPREAD;
  const offsets = new Map<string, THREE.Vector3>();
  for (const key of units.keys()) {
    const d = centres.get(key)!.clone().sub(centre);
    if (axis) d.set(axis === 'x' ? d.x : 0, axis === 'y' ? d.y : 0, axis === 'z' ? d.z : 0);
    offsets.set(key, d.multiplyScalar(k));
  }
  // Stand on the floor: lift everything so the lowest part sits where the model's bottom
  // was, instead of sinking below it (exploded drawings grow up and out from the base).
  let lowest = Infinity;
  for (const [key, list] of units) {
    let min = Infinity;
    for (const e of list) min = Math.min(min, worldBounds(e).min.z);
    lowest = Math.min(lowest, min + offsets.get(key)!.z);
  }
  const lift = all.min.z - lowest;
  for (const [key, list] of units) {
    const offset = offsets.get(key)!;
    offset.z += lift;
    if (offset.lengthSq() < 1e-12) continue;
    for (const e of list) out.set(e.id, offset);
  }
  return out;
}

function groupChainHas(e: Entity, groupId: string, groups: Group[]): boolean {
  let id = e.groupId;
  while (id) {
    if (id === groupId) return true;
    id = groups.find((g) => g.id === id)?.parentId;
  }
  return false;
}
