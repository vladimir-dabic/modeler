import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildWorldGeometries } from './csg';
import { newId } from './Document';
import type { DocumentFile, Entity, Unit, Vec2, Vec3 } from './types';
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
    visible: raw.visible !== false,
  };
  switch (raw.kind) {
    case 'box':
      return isVec3(raw.size) && raw.size.every((s: number) => s > 0) ? { ...base, kind: 'box', size: raw.size } : null;
    case 'cylinder':
      return isNum(raw.radius) && isNum(raw.height) && raw.radius > 0 && raw.height > 0
        ? { ...base, kind: 'cylinder', radius: raw.radius, height: raw.height, segments: isNum(raw.segments) ? Math.max(3, Math.min(256, Math.round(raw.segments))) : 64 }
        : null;
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
  return {
    format: 'modeler',
    version: 1,
    units: UNITS.includes(raw.units) ? raw.units : 'mm',
    workspace: isWorkspaceId(raw.workspace) ? raw.workspace : 'print',
    printer: parsePrinter(raw.printer),
    entities,
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
export function exportStl(targets: Entity[], all: Entity[]): ArrayBuffer | null {
  const parts = buildWorldGeometries(targets, all);
  if (!parts.length) return null;
  const geometries = parts.map(({ geometry }) => {
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

export function saveAutosave(file: DocumentFile): void {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(file));
  } catch {
    // Storage may be unavailable (private mode, quota); autosave is best-effort.
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
