import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildWorldGeometries, fuseGeometries } from './csg';
import { newId } from './Document';
import { pruneGroups } from './groups';
import { parseAnnotation, pruneAnnotations } from './annotations';
import { parseReferenceFile } from './references';
import type { DocumentFile, Entity, Group, ReferenceFile, Unit, Vec2, Vec3 } from './types';
import { DEFAULT_PRINTER_SETTING, isWorkspaceId, PRINTERS, type PrinterSetting, type WorkspaceId } from './workspaces';

const UNITS: Unit[] = ['mm', 'cm', 'm', 'in'];

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNum);
const isVec2 = (v: unknown): v is Vec2 => Array.isArray(v) && v.length === 2 && v.every(isNum);

/** Validate and normalise an entity from untrusted JSON. Returns null if unusable. */
function parseEntity(raw: any): Entity | null {
  if (!raw || typeof raw !== 'object') return null;
  const base = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    name: typeof raw.name === 'string' ? raw.name : 'Object',
    position: isVec3(raw.position) ? raw.position : ([0, 0, 0] as Vec3),
    rotation: isVec3(raw.rotation) ? raw.rotation : ([0, 0, 0] as Vec3),
    color: typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : '#cfd8e3',
    hole: raw.hole === true,
    ...(raw.holeScope === 'group' ? { holeScope: 'group' as const } : {}),
    ...(raw.quiet === true ? { quiet: true } : {}),
    visible: raw.visible !== false,
    ...(typeof raw.groupId === 'string' && raw.groupId ? { groupId: raw.groupId } : {}),
  };
  const segments = (min: number, max: number, fallback: number) => (isNum(raw.segments) ? Math.max(min, Math.min(max, Math.round(raw.segments))) : fallback);
  switch (raw.kind) {
    case 'box': {
      if (!isVec3(raw.size) || !raw.size.every((s: number) => s > 0)) return null;
      const r = isNum(raw.edgeRadius) && raw.edgeRadius > 0 ? Math.min(raw.edgeRadius, Math.min(...raw.size) / 2 - 0.001) : 0;
      return { ...base, kind: 'box', size: raw.size, ...(r > 0 ? { edgeRadius: r } : {}) };
    }
    case 'cylinder': {
      if (!isNum(raw.height) || raw.height <= 0 || !isNum(raw.radius) || raw.radius < 0) return null;
      const top = isNum(raw.radiusTop) && raw.radiusTop >= 0 ? raw.radiusTop : undefined;
      if (top === undefined ? raw.radius <= 0 : Math.max(raw.radius, top) <= 0) return null;
      return { ...base, kind: 'cylinder', radius: raw.radius, height: raw.height, segments: segments(3, 256, 64), ...(top !== undefined ? { radiusTop: top } : {}) };
    }
    case 'sphere':
      return isVec3(raw.radii) && raw.radii.every((r: number) => r > 0) ? { ...base, kind: 'sphere', radii: raw.radii, segments: segments(8, 256, 48) } : null;
    case 'revolve':
      return Array.isArray(raw.profile) && raw.profile.length >= 3 && raw.profile.every((p: unknown) => isVec2(p) && (p as Vec2)[0] >= 0)
        ? { ...base, kind: 'revolve', profile: raw.profile, segments: segments(3, 256, 64) }
        : null;
    case 'tube': {
      if (!Array.isArray(raw.path) || raw.path.length < 2 || !raw.path.every(isVec3) || !isNum(raw.radius) || raw.radius <= 0) return null;
      const radii = Array.isArray(raw.radii) && raw.radii.length === raw.path.length && raw.radii.every((r: unknown) => isNum(r) && r > 0) ? raw.radii : undefined;
      return { ...base, kind: 'tube', path: raw.path, radius: raw.radius, ...(radii ? { radii } : {}), smooth: raw.smooth !== false, segments: segments(3, 128, 24) };
    }
    case 'extrusion':
      return Array.isArray(raw.points) && raw.points.length >= 3 && raw.points.every(isVec2) && isNum(raw.height) && raw.height > 0
        ? { ...base, kind: 'extrusion', points: raw.points, height: raw.height }
        : null;
    default:
      return null;
  }
}

export function parseDocumentFile(text: string): DocumentFile {
  const raw = JSON.parse(text);
  if (!raw || raw.format !== 'modeler' || !Array.isArray(raw.entities)) {
    throw new Error('Not a modeler project file');
  }
  const seen = new Set<string>();
  const entities: Entity[] = [];
  for (const item of raw.entities) {
    const e = parseEntity(item);
    if (!e) continue;
    if (seen.has(e.id)) e.id = newId();
    seen.add(e.id);
    entities.push(e);
  }
  // Groups: keep well-formed ones, drop dangling references, then prune empties.
  const groups: Group[] = [];
  const groupIds = new Set<string>();
  for (const g of Array.isArray(raw.groups) ? raw.groups : []) {
    if (!g || typeof g.id !== 'string' || !g.id || groupIds.has(g.id)) continue;
    groupIds.add(g.id);
    groups.push({
      id: g.id,
      name: typeof g.name === 'string' && g.name ? g.name : 'Group',
      ...(typeof g.parentId === 'string' && g.parentId ? { parentId: g.parentId } : {}),
    });
  }
  for (const e of entities) if (e.groupId && !groupIds.has(e.groupId)) delete e.groupId;
  const references: ReferenceFile[] = [];
  for (const item of Array.isArray(raw.references) ? raw.references : []) {
    const r = parseReferenceFile(item, newId);
    if (!r) continue;
    if (seen.has(r.id)) r.id = newId();
    seen.add(r.id);
    references.push(r);
  }
  const annotationIds = new Set<string>();
  const parsedAnnotations = (Array.isArray(raw.annotations) ? raw.annotations : []).flatMap((item: unknown) => {
    const a = parseAnnotation(item, newId);
    if (!a) return [];
    if (annotationIds.has(a.id) || seen.has(a.id)) a.id = newId();
    annotationIds.add(a.id);
    return [a];
  });
  const byId = new Map(entities.map((e) => [e.id, e]));
  const annotations = pruneAnnotations(parsedAnnotations, (id) => byId.get(id));
  return {
    format: 'modeler',
    version: 1,
    units: UNITS.includes(raw.units) ? raw.units : 'mm',
    workspace: isWorkspaceId(raw.workspace) ? raw.workspace : 'print',
    printer: parsePrinter(raw.printer),
    entities,
    groups: pruneGroups(entities, groups),
    ...(references.length ? { references } : {}),
    ...(annotations.length ? { annotations } : {}),
  };
}

function parsePrinter(raw: any): PrinterSetting {
  const fallback = structuredClone(DEFAULT_PRINTER_SETTING);
  if (!raw || typeof raw !== 'object') return fallback;
  const profile = raw.profile === 'custom' || PRINTERS.some((p) => p.id === raw.profile) ? raw.profile : fallback.profile;
  const custom = isVec3(raw.custom) && raw.custom.every((v: number) => v > 0 && v < 10000) ? raw.custom : fallback.custom;
  return { profile, custom };
}

export function downloadBlob(data: BlobPart, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** Binary STL in millimetres (what every slicer expects), Z-up. */
export function exportStl(targets: Entity[], all: Entity[], groups: Group[]): ArrayBuffer | null {
  const parts = buildWorldGeometries(targets, all, groups);
  if (!parts.length) return null;
  // One watertight solid: overlapping and touching parts are merged (ADR 0017).
  const fused = fuseGeometries(parts.map((p) => p.geometry));
  const geometries = (fused ? [fused] : parts.map((p) => p.geometry)).map((geometry) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    return g;
  });
  const merged = mergeGeometries(geometries, false);
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged);
  const result = new STLExporter().parse(mesh, { binary: true }) as DataView;
  return result.buffer as ArrayBuffer;
}

// ---- local persistence ----------------------------------------------------

const AUTOSAVE_KEY = 'modeler.autosave.v1';
const SETTINGS_KEY = 'modeler.settings.v1';

/**
 * Best-effort autosave. If the file is over the storage quota (usually a large reference
 * drawing), the model is saved without reference drawings and 'partial' is returned.
 */
export function saveAutosave(file: DocumentFile): 'ok' | 'partial' | 'failed' {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(file));
    return 'ok';
  } catch {
    // Storage may be unavailable (private mode) or full.
  }
  if (!file.references?.length) return 'failed';
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ ...file, references: [] }));
    return 'partial';
  } catch {
    return 'failed';
  }
}

export function loadAutosave(): DocumentFile | null {
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    return text ? parseDocumentFile(text) : null;
  } catch {
    return null;
  }
}

export interface Settings {
  snapEnabled: boolean;
  /** Active snap step (mm); follows the current workspace. */
  snapStep: number;
  /** Remembered snap step per workspace. */
  snapByWorkspace: Partial<Record<WorkspaceId, number>>;
  showCuts: boolean;
  /** Filament used for weight estimates. */
  filament: string;
}

export const DEFAULT_SETTINGS: Settings = { snapEnabled: true, snapStep: 1, snapByWorkspace: {}, showCuts: true, filament: 'pla' };

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    return {
      snapEnabled: typeof raw.snapEnabled === 'boolean' ? raw.snapEnabled : DEFAULT_SETTINGS.snapEnabled,
      snapStep: isNum(raw.snapStep) && raw.snapStep > 0 ? raw.snapStep : DEFAULT_SETTINGS.snapStep,
      showCuts: typeof raw.showCuts === 'boolean' ? raw.showCuts : DEFAULT_SETTINGS.showCuts,
      snapByWorkspace: Object.fromEntries(
        Object.entries(raw.snapByWorkspace ?? {}).filter(([k, v]) => isWorkspaceId(k) && isNum(v) && v > 0),
      ),
      filament: typeof raw.filament === 'string' ? raw.filament : DEFAULT_SETTINGS.filament,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // best-effort
  }
}
