import * as THREE from 'three';
import { anchoredIds } from './annotations';
import { cleanVec, worldBoundsOf } from './geometry';
import type { Annotation, Entity, Group, Vec3 } from './types';

/**
 * Copy and paste of parts (ADR 0023), DOM-free. The clipboard holds plain JSON text, so
 * it travels through the system clipboard between tabs and windows.
 * - Copy takes the parts with the groups that are copied whole (their nesting kept), and
 *   the notes/dimensions attached only to copied parts. A part whose group is only partly
 *   copied comes along as a loose part.
 * - Paste gives everything new ids. It lands where it was copied from, unless that spot is
 *   taken: then it goes beside the model, to the right (+x).
 */

export const CLIP_FORMAT = 'modeler-clipboard';

export interface ClipData {
  format: typeof CLIP_FORMAT;
  version: 1;
  entities: Entity[];
  groups: Group[];
  annotations: Annotation[];
}

export function copyParts(parts: Entity[], allEntities: Entity[], groups: Group[], annotations: Annotation[]): ClipData {
  const ids = new Set(parts.map((e) => e.id));
  // Groups copied whole: every part inside them (at any depth) is copied.
  const membersOf = new Map<string, string[]>();
  const parentOf = new Map(groups.map((g) => [g.id, g.parentId]));
  for (const e of allEntities) {
    let g = e.groupId;
    while (g) {
      membersOf.set(g, [...(membersOf.get(g) ?? []), e.id]);
      g = parentOf.get(g);
    }
  }
  const whole = new Set(groups.filter((g) => (membersOf.get(g.id) ?? []).every((id) => ids.has(id)) && membersOf.get(g.id)?.length).map((g) => g.id));
  const keptGroup = (id: string | undefined): string | undefined => {
    // The nearest enclosing group that is copied whole.
    let g = id;
    while (g && !whole.has(g)) g = parentOf.get(g);
    return g;
  };
  const entities = parts.map((e) => {
    const copy = structuredClone(e);
    const g = keptGroup(e.groupId);
    if (g) copy.groupId = g;
    else delete copy.groupId;
    return copy;
  });
  const copiedGroups = groups
    .filter((g) => whole.has(g.id))
    .map((g) => {
      const parent = keptGroup(g.parentId);
      return { id: g.id, name: g.name, ...(parent ? { parentId: parent } : {}) };
    });
  const copiedAnnotations = annotations.filter((a) => {
    const anchored = anchoredIds(a);
    return anchored.length > 0 && anchored.every((id) => ids.has(id));
  });
  return { format: CLIP_FORMAT, version: 1, entities, groups: copiedGroups, annotations: structuredClone(copiedAnnotations) };
}

/** Clipboard text → data, or null if it isn't modeler parts. */
export function parseClip(text: string | null | undefined): ClipData | null {
  if (!text || !text.trimStart().startsWith('{')) return null;
  try {
    const raw = JSON.parse(text);
    if (raw?.format !== CLIP_FORMAT || !Array.isArray(raw.entities)) return null;
    return { format: CLIP_FORMAT, version: 1, entities: raw.entities, groups: Array.isArray(raw.groups) ? raw.groups : [], annotations: Array.isArray(raw.annotations) ? raw.annotations : [] };
  } catch {
    return null;
  }
}

/**
 * Where pasted parts go: their own place if it is free, else beside the model (+x, with a
 * gap of a tenth of their width, at least 20 mm). Returns the offset to apply.
 */
export function pasteOffset(pasted: Entity[], existing: Entity[]): Vec3 {
  const box = worldBoundsOf(pasted);
  const model = worldBoundsOf(existing.filter((e) => e.visible));
  if (box.isEmpty() || model.isEmpty() || !box.intersectsBox(model)) return [0, 0, 0];
  const gap = Math.max(20, box.getSize(new THREE.Vector3()).x * 0.1);
  return cleanVec(new THREE.Vector3(model.max.x + gap - box.min.x, 0, 0));
}

/** Fresh ids for everything in the clip, references remapped, moved by `offset`. */
export function instantiateClip(clip: ClipData, newId: () => string, offset: Vec3): ClipData {
  const ids = new Map<string, string>();
  const map = (id: string) => {
    let n = ids.get(id);
    if (!n) ids.set(id, (n = newId()));
    return n;
  };
  const d = new THREE.Vector3(...offset);
  const groups = clip.groups.map((g) => ({ ...g, id: map(g.id), ...(g.parentId ? { parentId: map(g.parentId) } : {}) }));
  const entities = clip.entities.map((e) => {
    const c = structuredClone(e);
    c.id = map(e.id);
    if (c.groupId) c.groupId = map(c.groupId);
    // Pasted copies stay linked to each other, as a new component.
    if (c.component) c.component = map(`component:${c.component}`);
    c.position = cleanVec(new THREE.Vector3(...c.position).add(d));
    return c;
  });
  const annotations = clip.annotations.map((a) => {
    const c = structuredClone(a);
    c.id = newId();
    const fix = (anchor: { entity: string } | { point: Vec3 }) => {
      if ('entity' in anchor) anchor.entity = map(anchor.entity);
      else anchor.point = cleanVec(new THREE.Vector3(...anchor.point).add(d));
    };
    if (c.kind === 'note') fix(c.anchor as never);
    else {
      fix(c.from as never);
      fix(c.to as never);
    }
    return c;
  });
  return { format: CLIP_FORMAT, version: 1, entities, groups, annotations };
}
