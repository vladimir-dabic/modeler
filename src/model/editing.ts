import type { ModelDocument } from './Document';
import { newId } from './Document';
import { groupMembers } from './groups';
import { copyName } from './naming';
import type { Entity, Group } from './types';

/**
 * Copy parts. Groups whose members are all being copied are copied too (when
 * `groupCopies`), so duplicating a drawer gives a new drawer group; other copies stay in
 * the original's group. `place` positions each copy (mutating it) before it is added.
 */
export function copyEntities(doc: ModelDocument, entities: Entity[], place: (copy: Entity) => void, groupCopies = true): Entity[] {
  const inSet = new Set(entities.map((e) => e.id));
  const groupMap = new Map<string, string>();
  let newGroups: Group[] = [];
  if (groupCopies) {
    const full = doc.groups.filter((g) => {
      const m = groupMembers(g.id, doc.entities, doc.groups);
      return m.length > 0 && m.every((x) => inSet.has(x.id));
    });
    for (const g of full) groupMap.set(g.id, newId());
    const names = doc.groups.map((g) => g.name);
    const added: Group[] = [];
    for (const g of full) {
      const name = g.parentId && groupMap.has(g.parentId) ? g.name : copyName(g.name, [...names, ...added.map((a) => a.name)]);
      const parentId = g.parentId ? (groupMap.get(g.parentId) ?? g.parentId) : undefined;
      added.push({ id: groupMap.get(g.id)!, name, ...(parentId ? { parentId } : {}) });
    }
    newGroups = added;
  }
  const names = doc.entities.map((e) => e.name);
  const copies: Entity[] = [];
  for (const e of entities) {
    const c = structuredClone(e);
    c.id = newId();
    const mapped = e.groupId ? groupMap.get(e.groupId) : undefined;
    if (mapped) c.groupId = mapped;
    else c.name = copyName(e.name, [...names, ...copies.map((x) => x.name)]);
    place(c);
    copies.push(c);
  }
  for (const c of copies) doc.add(c);
  // Groups go in after their members exist (empty groups are pruned on write).
  if (newGroups.length) doc.setGroups([...doc.groups, ...newGroups]);
  return copies;
}

