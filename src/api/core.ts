import * as THREE from 'three';
import type { ModelDocument } from '../model/Document';
import { worldBounds } from '../model/geometry';
import { groupChain, groupMembers, subtreeGroupIds } from '../model/groups';
import { DRAWING_UNIT_MM, referenceBounds } from '../model/references';
import { dimensionGeometry } from '../model/annotations';
import type { Anchor, Annotation, Entity, Group, ReferenceDrawing } from '../model/types';
import { polygonArea } from '../model/geometry';
import { lathePath, tubeLength } from '../model/shapes';
import type { TargetInput } from './schemas';

// ---- errors -------------------------------------------------------------------

export type ErrorCode = 'invalid_input' | 'not_found' | 'ambiguous' | 'invalid_geometry' | 'unsupported' | 'internal';

/** An error a client (human or AI) can act on: what went wrong and how to fix it. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

// ---- results --------------------------------------------------------------------

export interface ChangeSummary {
  added: string[];
  updated: string[];
  removed: string[];
  groups_added?: string[];
  groups_removed?: string[];
}

export type ApiResult<T = unknown> =
  | { ok: true; data: T; changes?: ChangeSummary; warnings?: string[] }
  | { ok: false; error: { code: ErrorCode; message: string; hint?: string; path?: string } };

// ---- host capabilities ------------------------------------------------------------

export type ViewName = 'iso' | 'top' | 'front' | 'right' | 'left' | 'back' | 'bottom';

/**
 * File access for `open_file` / `save_file` / `export_stl`. Only the MCP server (Node) has
 * one, limited to its working folder; the browser never exposes file operations (ADR 0013).
 */
export interface FileHost {
  /** Read a text file. Throws ApiError for paths outside the working folder. */
  readText(path: string): Promise<string>;
  /** Write a file and return the path as shown to the user. */
  write(path: string, data: string | Uint8Array): Promise<string>;
  /** The project file last opened or saved, used when save_file gets no path. */
  currentPath?: string;
}

/** Capabilities only some hosts have (a browser can render; headless Node cannot). */
export interface ApiHost {
  renderViews?(views: ViewName[], size: number, opts?: { explode?: number; axis?: 'x' | 'y' | 'z' }): Promise<{ view: ViewName; png: string }[]>;
  /** The app's exploded view (display only); absent in headless hosts. */
  setExplode?(factor: number, axis: 'x' | 'y' | 'z' | null): void;
  files?: FileHost;
}

// ---- formatting (compact, token-friendly) -------------------------------------------

export const r2 = (v: number) => {
  const x = Math.round(v * 100) / 100;
  return Object.is(x, -0) ? 0 : x;
};
const v3 = (v: ArrayLike<number>) => `${r2(v[0])},${r2(v[1])},${r2(v[2])}`;
const times = (v: number[]) => v.map(r2).join('×');

export function shapeText(e: Entity): string {
  switch (e.kind) {
    case 'box':
      return `box ${times(e.size)}${e.edgeRadius ? ` r${r2(e.edgeRadius)}` : ''}`;
    case 'cylinder':
      return e.radiusTop === undefined
        ? `cylinder ø${r2(e.radius * 2)}×${r2(e.height)}`
        : `cone ø${r2(e.radius * 2)}→ø${r2(e.radiusTop * 2)}×${r2(e.height)}`;
    case 'sphere':
      return e.radii[0] === e.radii[1] && e.radii[1] === e.radii[2] ? `sphere ø${r2(e.radii[0] * 2)}` : `ellipsoid ${times(e.radii.map((r) => r * 2))}`;
    case 'revolve': {
      const zs = e.profile.map((p) => p[1]);
      return `revolve ø${r2(Math.max(...e.profile.map((p) => p[0])) * 2)}×${r2(Math.max(...zs) - Math.min(...zs))} ${e.profile.length}pt`;
    }
    case 'tube':
      return `tube ø${e.radii ? `${r2(Math.min(...e.radii) * 2)}–${r2(Math.max(...e.radii) * 2)}` : r2(e.radius * 2)} ${r2(tubeLength(e))} long ${e.path.length}pt`;
    case 'extrusion':
      return `shape ${e.points.length}pt×${r2(e.height)}`;
  }
}

/** One line per part, e.g. `k3f9a2 "Shelf 2" box 564×280×18 at 18,0,180 [component c1] material "Oak" in "Bookcase"`. */
export function entityLine(e: Entity, groups: Group[]): string {
  const parts = [`${e.id} "${e.name}" ${shapeText(e)} at ${v3(e.position)}`];
  if (e.rotation.some((a) => a !== 0)) parts.push(`rot ${v3(e.rotation)}`);
  if (e.hole) parts.push(`[${e.quiet ? 'helper ' : ''}hole${e.holeScope === 'group' ? ', own group only' : ''}]`);
  if (!e.visible) parts.push('[hidden]');
  if (e.component) parts.push(`[component ${e.component}]`);
  if (e.material) parts.push(`material "${e.material}"`);
  const g = e.groupId ? groups.find((x) => x.id === e.groupId) : undefined;
  if (g) parts.push(`in "${g.name}"`);
  return parts.join(' ');
}

export function boundsOf(entities: Entity[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const e of entities) box.union(worldBounds(e));
  return box;
}

export function boundsJson(box: THREE.Box3) {
  const size = box.getSize(new THREE.Vector3());
  return { min: [r2(box.min.x), r2(box.min.y), r2(box.min.z)], max: [r2(box.max.x), r2(box.max.y), r2(box.max.z)], size: [r2(size.x), r2(size.y), r2(size.z)] };
}

export function groupLine(g: Group, entities: Entity[], groups: Group[]): string {
  const members = groupMembers(g.id, entities, groups);
  const b = boundsOf(members).getSize(new THREE.Vector3());
  const min = boundsOf(members).min;
  return `${g.id} "${g.name}" [group, ${members.length} part${members.length === 1 ? '' : 's'}] ${times([b.x, b.y, b.z])} at ${v3([min.x, min.y, min.z])}`;
}

/** One line per reference drawing, e.g. `r8x2 "Ground floor" drawing 12400×9800 mm at 0,0,0 (7 layers, 2 hidden)`. */
export function referenceLine(r: ReferenceDrawing, doc: ModelDocument): string {
  const g = doc.geometryOf(r.id);
  const b = g ? referenceBounds({ ...r, hiddenLayers: [] }, g) : null;
  const size = b && !b.isEmpty() ? b.getSize(new THREE.Vector3()) : null;
  const parts = [`${r.id} "${r.name}" drawing${size ? ` ${times([size.x, size.y])} mm` : ''} at ${v3(r.position)}`];
  if (r.rotation) parts.push(`rot ${r2(r.rotation)}`);
  if (r.units !== 'mm') parts.push(`(drawn in ${r.units}, ×${DRAWING_UNIT_MM[r.units]})`);
  if (!r.visible) parts.push('[hidden]');
  const layers = g?.layers.length ?? 0;
  parts.push(`(${layers} layer${layers === 1 ? '' : 's'}${r.hiddenLayers.length ? `, ${r.hiddenLayers.length} hidden` : ''})`);
  return parts.join(' ');
}

function anchorText(a: Anchor, doc: ModelDocument): string {
  if ('point' in a) return v3(a.point);
  const e = doc.get(a.entity);
  return `"${e?.name ?? a.entity}"${a.at.join() === '0.5,0.5,1' ? '' : ` at ${a.at.map(r2).join(',')}`}`;
}

/** One line per annotation, e.g. `a1 dimension 600 along x: "Left side" → "Right side" at 1,0,1`. */
export function annotationLine(a: Annotation, doc: ModelDocument): string {
  if (a.kind === 'note') {
    const off = a.offset.some((v) => v !== 0) ? ` label +${v3(a.offset)}` : '';
    return `${a.id} note ${JSON.stringify(a.text)} on ${anchorText(a.anchor, doc)}${off}`;
  }
  const g = dimensionGeometry(a, (id) => doc.get(id));
  const value = g ? r2(g.value) : '?';
  const text = a.text ? ` text ${JSON.stringify(a.text)}` : '';
  return `${a.id} dimension ${value}${a.axis ? ` along ${a.axis}` : ''}: ${anchorText(a.from, doc)} → ${anchorText(a.to, doc)}, offset ${v3(a.offset)}${text}`;
}

/** Full JSON summary of one part. */
export function entitySummary(e: Entity, groups: Group[]) {
  const b = worldBounds(e);
  const base = {
    id: e.id,
    name: e.name,
    kind: e.kind,
    hole: e.hole,
    ...(e.holeScope ? { hole_scope: e.holeScope } : {}),
    visible: e.visible,
    color: e.color,
    position: e.position.map(r2),
    rotation: e.rotation.map(r2),
    group: e.groupId ? groups.find((g) => g.id === e.groupId)?.name : undefined,
    bounds: { min: [r2(b.min.x), r2(b.min.y), r2(b.min.z)], max: [r2(b.max.x), r2(b.max.y), r2(b.max.z)] },
  };
  switch (e.kind) {
    case 'box':
      return { ...base, size: e.size.map(r2), ...(e.edgeRadius ? { edge_radius: r2(e.edgeRadius) } : {}) };
    case 'cylinder':
      return { ...base, radius: r2(e.radius), ...(e.radiusTop !== undefined ? { radius_top: r2(e.radiusTop) } : {}), height: r2(e.height), segments: e.segments };
    case 'sphere':
      return { ...base, radii: e.radii.map(r2), segments: e.segments };
    case 'revolve':
      return { ...base, profile: e.profile.map(([r, z]) => [r2(r), r2(z)]), segments: e.segments };
    case 'tube':
      return { ...base, path: e.path.map((p) => p.map(r2)), radius: r2(e.radius), ...(e.radii ? { radii: e.radii.map(r2) } : {}), smooth: e.smooth, segments: e.segments, length: r2(tubeLength(e)) };
    case 'extrusion':
      return { ...base, points: e.points.map(([x, y]) => [r2(x), r2(y)]), height: r2(e.height) };
  }
}

// ---- validation -------------------------------------------------------------------------

/** Invariants every committed entity must satisfy (docs/architecture.md#invariants). */
export function validateEntity(e: Entity): void {
  const bad = (msg: string, hint?: string) => {
    throw new ApiError('invalid_geometry', `"${e.name}": ${msg}`, hint);
  };
  const finite = (v: number[]) => v.every(Number.isFinite);
  const segmentsOk = (min: number, max: number) => {
    const s = (e as { segments: number }).segments;
    if (!Number.isInteger(s) || s < min || s > max) bad(`segments must be an integer ${min}–${max}`);
  };
  if (!e.name.trim()) bad('name is empty');
  if (!finite(e.position) || !finite(e.rotation)) bad('position/rotation must be finite numbers');
  if (!/^#[0-9a-fA-F]{6}$/.test(e.color)) bad(`colour "${e.color}" is not #rrggbb`);
  if (e.kind === 'box') {
    if (!e.size.every((s) => Number.isFinite(s) && s > 0)) bad(`size must be > 0 (got ${e.size.join(', ')})`, 'To cut into another part, keep sizes positive and set hole: true.');
    if (e.edgeRadius !== undefined && !(e.edgeRadius >= 0 && e.edgeRadius < Math.min(...e.size) / 2)) {
      bad(`edge radius ${e.edgeRadius} must be ≥ 0 and less than half the smallest side (${Math.min(...e.size) / 2})`);
    }
  } else if (e.kind === 'cylinder') {
    if (!(e.height > 0)) bad('height must be > 0');
    if (e.radiusTop === undefined) {
      if (!(e.radius > 0)) bad('radius must be > 0');
    } else if (!(e.radius >= 0 && e.radiusTop >= 0 && Math.max(e.radius, e.radiusTop) > 0)) {
      bad('radii must be ≥ 0, and at least one end > 0', 'radius_top: 0 makes a pointed cone.');
    }
    segmentsOk(3, 256);
  } else if (e.kind === 'sphere') {
    if (!e.radii.every((r) => Number.isFinite(r) && r > 0)) bad(`radii must be > 0 (got ${e.radii.join(', ')})`);
    segmentsOk(8, 256);
  } else if (e.kind === 'revolve') {
    if (e.profile.length < 3) bad('a profile needs at least 3 points');
    if (!e.profile.every(([r, z]) => Number.isFinite(r) && Number.isFinite(z) && r >= 0)) bad('profile points are [radius, z] with radius ≥ 0', 'The axis is radius 0; nothing can be on the other side of it.');
    if (Math.abs(polygonArea(e.profile.map(([x, y]) => ({ x, y })))) < 1e-6) bad('the profile encloses no area');
    if (lathePath(e.profile).length < 3) bad('the profile is degenerate');
    segmentsOk(3, 256);
  } else if (e.kind === 'tube') {
    if (e.path.length < 2) bad('a tube path needs at least 2 points');
    if (!e.path.every((p) => finite(p))) bad('path points must be finite numbers');
    for (let i = 1; i < e.path.length; i++) {
      const [a, b] = [e.path[i - 1], e.path[i]];
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6) bad(`path points ${i} and ${i + 1} are the same`);
    }
    if (!(e.radius > 0)) bad('radius must be > 0');
    if (e.radii && (e.radii.length !== e.path.length || !e.radii.every((r) => r > 0))) bad(`radii needs one radius > 0 per path point (${e.path.length})`);
    segmentsOk(3, 128);
  } else {
    if (!(e.height > 0)) bad('height must be > 0');
    if (e.points.length < 3) bad('an outline needs at least 3 points');
    if (Math.abs(polygonArea(e.points.map(([x, y]) => ({ x, y })))) < 1e-6) bad('the outline encloses no area', 'Check that the points are not all on one line.');
  }
}

// ---- operation context ---------------------------------------------------------------------

/** What every operation gets: the document, the host, and target resolution. */
export class OperationContext {
  constructor(
    readonly doc: ModelDocument,
    readonly host: ApiHost | undefined,
  ) {}

  entity(id: string): Entity {
    const e = this.doc.get(id);
    if (!e) throw new ApiError('not_found', `No part with id "${id}"`, 'Use get_scene to list ids.');
    return e;
  }

  /** One part by id or exact (case-insensitive) unique name. */
  part(ref: string): Entity {
    const byId = this.doc.get(ref);
    if (byId) return byId;
    const lower = ref.toLowerCase();
    const matches = this.doc.entities.filter((e) => e.name.toLowerCase() === lower);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new ApiError('ambiguous', `${matches.length} parts are named "${ref}"`, `Use an id: ${matches.map((e) => e.id).join(', ')}`);
    throw new ApiError('not_found', `No part "${ref}"`, 'Use get_scene to list ids and names.');
  }

  /** Find an annotation by id. */
  annotation(id: string): Annotation {
    const a = this.doc.getAnnotation(id);
    if (!a) {
      const ids = this.doc.annotations.map((x) => x.id).slice(0, 30);
      throw new ApiError('not_found', `No annotation "${id}"`, ids.length ? `Annotations: ${ids.join(', ')} (see get_scene)` : 'There are no annotations.');
    }
    return a;
  }

  /** Find a reference drawing by id, or by exact (case-insensitive) name. */
  reference(ref: string): ReferenceDrawing {
    const { doc } = this;
    const byId = doc.getReference(ref);
    if (byId) return byId;
    const matches = doc.references.filter((r) => r.name.toLowerCase() === ref.toLowerCase());
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new ApiError('ambiguous', `${matches.length} reference drawings are named "${ref}"`, `Use an id: ${matches.map((r) => r.id).join(', ')}`);
    throw new ApiError(
      'not_found',
      `No reference drawing "${ref}"`,
      doc.references.length ? `Reference drawings: ${doc.references.map((r) => `${r.id} "${r.name}"`).join(', ')}` : 'There are none; import one with import_dxf.',
    );
  }

  /** Find a group by id, or by exact (case-insensitive) name. */
  group(ref: string): Group {
    const byId = this.doc.getGroup(ref);
    if (byId) return byId;
    const matches = this.doc.groups.filter((g) => g.name.toLowerCase() === ref.toLowerCase());
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new ApiError('ambiguous', `${matches.length} groups are named "${ref}"`, `Use an id: ${matches.map((g) => g.id).join(', ')}`);
    }
    throw new ApiError('not_found', `No group "${ref}"`, this.doc.groups.length ? `Groups: ${this.doc.groups.map((g) => `"${g.name}"`).slice(0, 20).join(', ')}` : 'There are no groups yet.');
  }

  /** Resolve a target selector to parts, in document order. Never returns an empty list. */
  resolve(target: TargetInput): Entity[] {
    const { doc } = this;
    let found: Entity[];
    if ('ids' in target) {
      const want = new Set<string>();
      for (const id of target.ids) {
        if (doc.get(id)) want.add(id);
        else if (doc.getGroup(id)) for (const m of groupMembers(id, doc.entities, doc.groups)) want.add(m.id);
        else throw new ApiError('not_found', `No part or group with id "${id}"`, 'Use get_scene to list ids.', 'ids');
      }
      found = doc.entities.filter((e) => want.has(e.id));
    } else if ('selection' in target) {
      found = doc.selected();
      if (!found.length) throw new ApiError('not_found', 'Nothing is selected', 'Select parts first, or target them by ids/name.');
    } else if ('group' in target) {
      found = groupMembers(this.group(target.group).id, doc.entities, doc.groups);
    } else if ('name' in target) {
      found = this.byName(target.name);
    } else {
      found = doc.entities.filter((e) => {
        if (target.kind && e.kind !== target.kind) return false;
        if (target.hole !== undefined && e.hole !== target.hole) return false;
        if (target.in_group) {
          const ids = subtreeGroupIds(this.group(target.in_group).id, doc.groups);
          if (!e.groupId || !ids.has(e.groupId)) return false;
        }
        return true;
      });
    }
    if (!found.length) throw new ApiError('not_found', 'The target matched no parts', 'Use get_scene to see names and ids.');
    return found;
  }

  private byName(name: string): Entity[] {
    const { doc } = this;
    if (name.includes('*')) {
      const re = new RegExp(`^${name.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
      const ids = new Set<string>();
      for (const e of doc.entities) if (re.test(e.name)) ids.add(e.id);
      for (const g of doc.groups) if (re.test(g.name)) for (const m of groupMembers(g.id, doc.entities, doc.groups)) ids.add(m.id);
      return doc.entities.filter((e) => ids.has(e.id));
    }
    const lower = name.toLowerCase();
    const parts = doc.entities.filter((e) => e.name.toLowerCase() === lower);
    if (parts.length === 1) return parts;
    if (parts.length > 1) {
      throw new ApiError('ambiguous', `${parts.length} parts are named "${name}"`, `Use ids (${parts.map((p) => p.id).join(', ')}) or a wildcard like "${name}*" to mean all of them.`);
    }
    const groups = doc.groups.filter((g) => g.name.toLowerCase() === lower);
    if (groups.length === 1) return groupMembers(groups[0].id, doc.entities, doc.groups);
    if (groups.length > 1) throw new ApiError('ambiguous', `${groups.length} groups are named "${name}"`, `Use a group id: ${groups.map((g) => g.id).join(', ')}`);
    const names = [...new Set(doc.entities.map((e) => `"${e.name}"`))].slice(0, 25);
    throw new ApiError('not_found', `Nothing is named "${name}"`, names.length ? `Names in the model: ${names.join(', ')}` : 'The model is empty.');
  }

  /**
   * Split parts into units that move as one: a group whose members are all in the set is
   * one unit (outermost such group wins); other parts are units on their own.
   */
  units(entities: Entity[]): Entity[][] {
    const inSet = new Set(entities.map((e) => e.id));
    const { doc } = this;
    const full = (g: Group) => groupMembers(g.id, doc.entities, doc.groups).every((m) => inSet.has(m.id));
    const byKey = new Map<string, Entity[]>();
    for (const e of entities) {
      const chain = groupChain(e.groupId, doc.groups); // innermost → outermost
      let key = e.id;
      for (let i = chain.length - 1; i >= 0; i--) {
        if (full(chain[i])) {
          key = `g:${chain[i].id}`;
          break;
        }
      }
      const list = byKey.get(key) ?? [];
      list.push(e);
      byKey.set(key, list);
    }
    return [...byKey.values()];
  }
}
