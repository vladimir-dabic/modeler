import type { EdgeBanding, Entity } from './types';

/**
 * Part properties and components (ADR 0025). DOM-free.
 *
 * A component is a set of linked copies of one part: same shape, size, colour and
 * properties, each with its own place (position, rotation), name, visibility and group.
 * Editing the shape of one copy updates the others when the change is committed, so it
 * works the same for the API, the tools (push/pull) and the AI.
 */

/** Fields every copy keeps for itself; everything else is the shared definition. */
const OWN_FIELDS = new Set(['id', 'name', 'position', 'rotation', 'visible', 'groupId', 'component']);

export const PROPERTY_FIELDS = ['material', 'finish', 'banding', 'partNo', 'note'] as const;
export type PropertyField = (typeof PROPERTY_FIELDS)[number];

/** The shared part of an entity, as a stable string (for comparing copies). */
export function definitionKey(e: Entity): string {
  const def: Record<string, unknown> = {};
  for (const k of Object.keys(e).sort()) if (!OWN_FIELDS.has(k)) def[k] = (e as unknown as Record<string, unknown>)[k];
  return JSON.stringify(def);
}

/** Copy the definition of `from` onto `to` (keeping `to`'s own fields). */
export function applyDefinition(from: Entity, to: Entity): void {
  const target = to as unknown as Record<string, unknown>;
  const source = from as unknown as Record<string, unknown>;
  for (const k of Object.keys(target)) if (!OWN_FIELDS.has(k) && !(k in source)) delete target[k];
  for (const k of Object.keys(source)) if (!OWN_FIELDS.has(k)) target[k] = structuredClone(source[k]);
}

/** True when these parts could be linked as they are: two or more, all with the same shape and properties. */
export function canLink(parts: Entity[]): boolean {
  if (parts.length < 2) return false;
  const key = (e: Entity) => definitionKey({ ...e, component: undefined } as Entity);
  const first = key(parts[0]);
  return parts.every((e) => key(e) === first) && !(parts[0].component && parts.every((e) => e.component === parts[0].component));
}

export function componentInstances(entities: Entity[], component: string): Entity[] {
  return entities.filter((e) => e.component === component);
}

/**
 * Bring linked copies back in line after a change. `before` maps ids to the entities'
 * JSON before the change. For each component, the first copy whose definition changed is
 * the source and the others follow it. A copy that is *new* and differs from its existing
 * siblings (a mirrored copy, a split piece) is detached instead: it's a different part now.
 * Returns the ids it changed.
 */
export function syncComponents(entities: Entity[], before: Map<string, string>): string[] {
  const byComponent = new Map<string, Entity[]>();
  for (const e of entities) if (e.component) byComponent.set(e.component, [...(byComponent.get(e.component) ?? []), e]);
  const changed: string[] = [];
  for (const list of byComponent.values()) {
    if (list.length < 2) continue;
    const prevKey = (e: Entity) => {
      const json = before.get(e.id);
      return json === undefined ? undefined : definitionKey(JSON.parse(json));
    };
    const existing = list.filter((e) => before.has(e.id));
    const source = existing.find((e) => prevKey(e) !== definitionKey(e));
    if (source) {
      const key = definitionKey(source);
      for (const e of list) {
        if (e === source || definitionKey(e) === key) continue;
        applyDefinition(source, e);
        changed.push(e.id);
      }
      continue;
    }
    // No existing copy changed: new copies that differ are separate parts now.
    const reference = existing[0];
    if (!reference) continue;
    const key = definitionKey(reference);
    for (const e of list) {
      if (!before.has(e.id) && definitionKey(e) !== key) {
        delete e.component;
        changed.push(e.id);
      }
    }
  }
  return changed;
}

/** "2 long, 1 short, 1 mm" (or '' when there is no banding). */
export function bandingText(b: EdgeBanding | undefined): string {
  if (!b || (!b.long && !b.short)) return '';
  const parts = [b.long ? `${b.long} long` : '', b.short ? `${b.short} short` : ''].filter(Boolean);
  return `${parts.join(', ')}${b.thickness ? `, ${b.thickness} mm` : ''}`;
}

/** Validate part properties from untrusted JSON (project files, clipboard). */
export function parsePartFields(raw: Record<string, unknown>): Partial<Entity> {
  const text = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const out: Record<string, unknown> = {};
  const component = text(raw.component, 64);
  if (component) out.component = component;
  for (const k of ['material', 'finish', 'partNo'] as const) {
    const v = text(raw[k], 120);
    if (v) out[k] = v;
  }
  const note = text(raw.note, 600);
  if (note) out.note = note;
  const b = raw.banding as Record<string, unknown> | undefined;
  const count = (v: unknown) => (v === 0 || v === 1 || v === 2 ? v : 0);
  if (b && typeof b === 'object' && (count(b.long) || count(b.short))) {
    const t = typeof b.thickness === 'number' && b.thickness > 0 && b.thickness <= 10 ? b.thickness : undefined;
    out.banding = { long: count(b.long), short: count(b.short), ...(t ? { thickness: t } : {}) };
  }
  return out as Partial<Entity>;
}
