import * as THREE from 'three';
import type { ModelDocument } from '../model/Document';
import { worldBounds } from '../model/geometry';
import { groupChain, groupMembers, subtreeGroupIds } from '../model/groups';
import type { Entity, Group } from '../model/types';
import { polygonArea } from '../model/geometry';
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
  renderViews?(views: ViewName[], size: number): Promise<{ view: ViewName; png: string }[]>;
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
  if (e.kind === 'box') return `box ${times(e.size)}`;
  if (e.kind === 'cylinder') return `cylinder ø${r2(e.radius * 2)}×${r2(e.height)}`;
  return `shape ${e.points.length}pt×${r2(e.height)}`;
}

/** One line per part, e.g. `k3f9a2 "Shelf 2" box 564×280×18 at 18,0,180 [hole] in "Bookcase"`. */
export function entityLine(e: Entity, groups: Group[]): string {
  const parts = [`${e.id} "${e.name}" ${shapeText(e)} at ${v3(e.position)}`];
  if (e.rotation.some((a) => a !== 0)) parts.push(`rot ${v3(e.rotation)}`);
  if (e.hole) parts.push('[hole]');
  if (!e.visible) parts.push('[hidden]');
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

/** Full JSON summary of one part. */
export function entitySummary(e: Entity, groups: Group[]) {
  const b = worldBounds(e);
  const base = {
    id: e.id,
    name: e.name,
    kind: e.kind,
    hole: e.hole,
    visible: e.visible,
    color: e.color,
    position: e.position.map(r2),
    rotation: e.rotation.map(r2),
    group: e.groupId ? groups.find((g) => g.id === e.groupId)?.name : undefined,
    bounds: { min: [r2(b.min.x), r2(b.min.y), r2(b.min.z)], max: [r2(b.max.x), r2(b.max.y), r2(b.max.z)] },
  };
  if (e.kind === 'box') return { ...base, size: e.size.map(r2) };
  if (e.kind === 'cylinder') return { ...base, radius: r2(e.radius), height: r2(e.height), segments: e.segments };
  return { ...base, points: e.points.map(([x, y]) => [r2(x), r2(y)]), height: r2(e.height) };
}

// ---- validation -------------------------------------------------------------------------

/** Invariants every committed entity must satisfy (docs/architecture.md#invariants). */
export function validateEntity(e: Entity): void {
  const bad = (msg: string, hint?: string) => {
    throw new ApiError('invalid_geometry', `"${e.name}": ${msg}`, hint);
  };
  const finite = (v: number[]) => v.every(Number.isFinite);
  if (!e.name.trim()) bad('name is empty');
  if (!finite(e.position) || !finite(e.rotation)) bad('position/rotation must be finite numbers');
  if (!/^#[0-9a-fA-F]{6}$/.test(e.color)) bad(`colour "${e.color}" is not #rrggbb`);
  if (e.kind === 'box') {
    if (!e.size.every((s) => Number.isFinite(s) && s > 0)) bad(`size must be > 0 (got ${e.size.join(', ')})`, 'To cut into another part, keep sizes positive and set hole: true.');
  } else if (e.kind === 'cylinder') {
    if (!(e.radius > 0) || !(e.height > 0)) bad('radius and height must be > 0');
    if (!Number.isInteger(e.segments) || e.segments < 3 || e.segments > 256) bad('segments must be an integer 3–256');
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
