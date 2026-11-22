import * as THREE from 'three';
import { localBounds, worldBounds } from './geometry';
import { bandingText } from './parts';
import type { EdgeBanding, Entity } from './types';

/**
 * Build instructions (ADR 0021): an IKEA-style booklet made from the model. DOM-free.
 * - Identical parts share a letter (A, B, C…), like the cut list: same size, shape and colour.
 * - Steps say which parts are added when, with an optional plain-language text. Without
 *   stored steps they are suggested bottom-up, one step per letter.
 * Only the step list, title and texts are stored (`doc.instructions`); letters, quantities
 * and images are derived, so the booklet always matches the model.
 */

export type InstructionsLanguage = 'en' | 'sr';
export const INSTRUCTION_LANGUAGES: InstructionsLanguage[] = ['en', 'sr'];

export interface InstructionStep {
  /** Part ids added in this step. */
  parts: string[];
  text?: string;
}

/** What the document stores. */
export interface Instructions {
  title?: string;
  /** A short intro under the title (what it is, who it's for). */
  intro?: string;
  language?: InstructionsLanguage;
  /** Absent: steps are suggested from the model. */
  steps?: InstructionStep[];
}

export interface PartType {
  letter: string;
  name: string;
  quantity: number;
  /** Sorted thickness ≤ width ≤ length, mm. */
  dims: [number, number, number];
  kind: Entity['kind'];
  color: string;
  ids: string[];
  /** Part properties (ADR 0025), when set. */
  material?: string;
  finish?: string;
  banding?: EdgeBanding;
}

export interface ResolvedStep {
  number: number;
  /** Parts added in this step. */
  add: string[];
  /** Parts already in place before this step. */
  before: string[];
  /** Letters added, in letter order, with counts. */
  letters: { letter: string; count: number }[];
  text?: string;
}

export interface ResolvedInstructions {
  title: string;
  intro?: string;
  language: InstructionsLanguage;
  /** True when the steps were suggested, not stored. */
  suggested: boolean;
  parts: PartType[];
  steps: ResolvedStep[];
  /** Overall size of the assembly, mm (x, y, z). */
  size: [number, number, number];
  /** Problems with stored steps, e.g. parts missing from every step. */
  warnings: string[];
}

const round = (v: number) => Math.round(v * 10) / 10;

/** Sorted dimensions of a part in its own frame, mm. */
export function partDims(e: Entity): [number, number, number] {
  const dims = e.kind === 'box' ? [...e.size] : localBounds(e).getSize(new THREE.Vector3()).toArray();
  return dims.map(round).sort((a, b) => a - b) as [number, number, number];
}

/** "Leg 3" → "Leg", "Side (left)" stays. Copies of one part share a base name. */
function baseName(name: string): string {
  return name.replace(/\s+\d+$/, '').trim() || name;
}

/** A, B, …, Z, AA, AB, … */
export function letterFor(index: number): string {
  let s = '';
  let n = index;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** The parts a booklet shows: visible solids (holes are cut, not assembled). */
export function instructionSolids(entities: Entity[]): Entity[] {
  return entities.filter((e) => e.visible && !e.hole);
}

/**
 * Identical parts grouped under one letter. Bigger parts get earlier letters (thickest,
 * then longest, then widest), so A is usually the top or a side.
 */
export function partTypes(entities: Entity[]): PartType[] {
  const byKey = new Map<string, PartType>();
  for (const e of instructionSolids(entities)) {
    const dims = partDims(e);
    const shape = e.kind === 'box' ? (e.edgeRadius ? `box r${round(e.edgeRadius)}` : 'box') : e.kind === 'extrusion' ? `extrusion ${JSON.stringify(e.points)}` : e.kind;
    const banding = bandingText(e.banding);
    const key = `${dims.join('×')}|${shape}|${e.color.toLowerCase()}|${e.material ?? ''}|${e.finish ?? ''}|${banding}`;
    const t = byKey.get(key);
    if (t) {
      t.quantity++;
      t.ids.push(e.id);
    } else {
      byKey.set(key, {
        letter: '', name: baseName(e.name), quantity: 1, dims, kind: e.kind, color: e.color, ids: [e.id],
        ...(e.material ? { material: e.material } : {}), ...(e.finish ? { finish: e.finish } : {}), ...(banding ? { banding: e.banding } : {}),
      });
    }
  }
  const list = [...byKey.values()].sort(
    (a, b) => b.dims[0] - a.dims[0] || b.dims[2] - a.dims[2] || b.dims[1] - a.dims[1] || a.name.localeCompare(b.name),
  );
  list.forEach((t, i) => (t.letter = letterFor(i)));
  return list;
}

/**
 * Suggested steps: one per letter, bottom-up (by the lowest point of that letter's parts),
 * larger parts first at the same height. A starting point that Claude or the user refines.
 */
export function suggestSteps(entities: Entity[], types = partTypes(entities)): InstructionStep[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const lowest = (t: PartType) => Math.min(...t.ids.map((id) => worldBounds(byId.get(id)!).min.z));
  return [...types]
    .map((t) => ({ t, z: Math.round(lowest(t)) }))
    .sort((a, b) => a.z - b.z || b.t.dims[2] * b.t.dims[1] - a.t.dims[2] * a.t.dims[1])
    .map(({ t }) => ({ parts: [...t.ids] }));
}

/** The booklet: part letters plus stored (or suggested) steps, checked against the model. */
export function resolveInstructions(entities: Entity[], stored: Instructions | null, fallbackTitle = 'Model'): ResolvedInstructions {
  const types = partTypes(entities);
  const letterOf = new Map<string, string>();
  for (const t of types) for (const id of t.ids) letterOf.set(id, t.letter);
  const warnings: string[] = [];
  const suggested = !stored?.steps?.length;
  const raw = suggested ? suggestSteps(entities, types) : stored!.steps!;

  const placed = new Set<string>();
  const steps: ResolvedStep[] = [];
  for (const s of raw) {
    const add = s.parts.filter((id) => letterOf.has(id) && !placed.has(id));
    if (!add.length && !s.text) continue;
    const before = [...placed];
    add.forEach((id) => placed.add(id));
    steps.push({ number: steps.length + 1, add, before, letters: countLetters(add, letterOf), ...(s.text ? { text: s.text } : {}) });
  }
  const missing = [...letterOf.keys()].filter((id) => !placed.has(id));
  if (missing.length) {
    const byId = new Map(entities.map((e) => [e.id, e]));
    warnings.push(`Not in any step (added as a last step): ${missing.map((id) => byId.get(id)!.name).join(', ')}`);
    steps.push({ number: steps.length + 1, add: missing, before: [...placed], letters: countLetters(missing, letterOf) });
  }

  const solids = instructionSolids(entities);
  const box = new THREE.Box3();
  for (const e of solids) box.union(worldBounds(e));
  const size = box.isEmpty() ? [0, 0, 0] : box.getSize(new THREE.Vector3()).toArray().map(round);
  return {
    title: stored?.title || fallbackTitle,
    ...(stored?.intro ? { intro: stored.intro } : {}),
    language: stored?.language ?? 'en',
    suggested,
    parts: types,
    steps,
    size: size as [number, number, number],
    warnings,
  };
}

function countLetters(ids: string[], letterOf: Map<string, string>): { letter: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(letterOf.get(id)!, (counts.get(letterOf.get(id)!) ?? 0) + 1);
  return [...counts].sort((a, b) => a[0].length - b[0].length || a[0].localeCompare(b[0])).map(([letter, count]) => ({ letter, count }));
}

const MAX_TEXT = 600;

/** Validate stored instructions from untrusted JSON. */
export function parseInstructions(raw: unknown): Instructions | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown, max = MAX_TEXT) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const steps = Array.isArray(r.steps)
    ? r.steps.flatMap((s: any) => {
        if (!s || typeof s !== 'object' || !Array.isArray(s.parts)) return [];
        const parts = s.parts.filter((p: unknown): p is string => typeof p === 'string' && !!p);
        const t = text(s.text);
        return parts.length || t ? [{ parts, ...(t ? { text: t } : {}) }] : [];
      })
    : undefined;
  const out: Instructions = {
    ...(text(r.title, 120) ? { title: text(r.title, 120) } : {}),
    ...(text(r.intro) ? { intro: text(r.intro) } : {}),
    ...(INSTRUCTION_LANGUAGES.includes(r.language as InstructionsLanguage) ? { language: r.language as InstructionsLanguage } : {}),
    ...(steps?.length ? { steps } : {}),
  };
  return Object.keys(out).length ? out : null;
}
