import type { Entity, Group } from './types';

/**
 * Pure helpers for groups (ADR 0011). Groups are flat membership: an entity names its
 * group with `groupId`, a group names its parent with `parentId`. No transforms.
 */

/** Groups from the innermost (the entity's own group) outwards. */
export function groupChain(groupId: string | undefined, groups: Group[]): Group[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const chain: Group[] = [];
  const seen = new Set<string>();
  let id = groupId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const g = byId.get(id);
    if (!g) break;
    chain.push(g);
    id = g.parentId;
  }
  return chain;
}

/** Ids of all groups nested inside `groupId` (including itself). */
export function subtreeGroupIds(groupId: string, groups: Group[]): Set<string> {
  const ids = new Set([groupId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of groups) {
      if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) {
        ids.add(g.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** All entities inside a group, at any depth. */
export function groupMembers(groupId: string, entities: Entity[], groups: Group[]): Entity[] {
  const ids = subtreeGroupIds(groupId, groups);
  return entities.filter((e) => e.groupId && ids.has(e.groupId));
}

export function isInsideGroup(e: Entity, groupId: string, groups: Group[]): boolean {
  return groupChain(e.groupId, groups).some((g) => g.id === groupId);
}

/**
 * What a click on `e` selects, SketchUp-style: with no group open, its outermost group;
 * with `openGroupId` open (and `e` inside it), the child of the open group that holds `e`.
 * Returns a group id, or null when the entity itself is the unit.
 */
export function selectionUnitGroup(e: Entity, groups: Group[], openGroupId: string | null): string | null {
  const chain = groupChain(e.groupId, groups); // innermost → outermost
  if (!openGroupId) return chain.length ? chain[chain.length - 1].id : null;
  const at = chain.findIndex((g) => g.id === openGroupId);
  if (at < 0) return chain.length ? chain[chain.length - 1].id : null; // outside the open group
  return at === 0 ? null : chain[at - 1].id;
}

/** Entity ids selected by clicking `e` (its whole unit). */
export function selectionUnit(e: Entity, entities: Entity[], groups: Group[], openGroupId: string | null): string[] {
  const g = selectionUnitGroup(e, groups, openGroupId);
  return g ? groupMembers(g, entities, groups).map((m) => m.id) : [e.id];
}

/** If the selection is exactly one group's members, that group (the outermost such). */
export function groupForSelection(selection: Set<string>, entities: Entity[], groups: Group[]): Group | null {
  if (!selection.size) return null;
  let best: Group | null = null;
  let bestDepth = Infinity;
  for (const g of groups) {
    const members = groupMembers(g.id, entities, groups);
    if (members.length !== selection.size || !members.every((m) => selection.has(m.id))) continue;
    const depth = groupChain(g.id, groups).length;
    if (depth < bestDepth) {
      best = g;
      bestDepth = depth;
    }
  }
  return best;
}

/**
 * Drop groups without members (at any depth) and repair dangling parent links.
 * Returns a new array; input is not modified.
 */
export function pruneGroups(entities: Entity[], groups: Group[]): Group[] {
  let current = groups.map((g) => ({ ...g }));
  for (;;) {
    const ids = new Set(current.map((g) => g.id));
    for (const g of current) if (g.parentId && !ids.has(g.parentId)) delete g.parentId;
    const used = new Set<string>();
    for (const e of entities) if (e.groupId) used.add(e.groupId);
    for (const g of current) if (g.parentId) used.add(g.parentId);
    const next = current.filter((g) => used.has(g.id));
    if (next.length === current.length) return next;
    current = next;
  }
}

/** Lowest group containing every given entity (null = top level). */
export function commonParentGroup(entities: Entity[], groups: Group[]): string | null {
  if (!entities.length) return null;
  const chains = entities.map((e) => groupChain(e.groupId, groups).map((g) => g.id));
  for (const candidate of chains[0]) {
    if (chains.every((c) => c.includes(candidate))) return candidate;
  }
  return null;
}
