import * as THREE from 'three';
import { worldBounds } from './geometry';
import type { Entity, Unit } from './types';

/**
 * Workspaces tune the whole app for a scale of work. They are configuration only:
 * the model is always millimetres underneath, so parts can move between workspaces.
 */
export type WorkspaceId = 'print' | 'workshop' | 'build';
export type PanelId = 'properties' | 'objects' | 'cutlist' | 'print' | 'quantities';

export interface Swatch {
  name: string;
  color: string;
}

export interface WorkspaceConfig {
  id: WorkspaceId;
  name: string;
  tagline: string;
  icon: string;
  units: Unit;
  /** Default snap step (mm) and the suggestions offered in the top bar. */
  snapStep: number;
  snapSteps: number[];
  /** Finest grid spacing (mm); the grid coarsens by ×10 as you zoom out. */
  gridBase: number;
  /** What an empty model frames (mm, min/max corners). */
  homeView: [[number, number, number], [number, number, number]];
  defaultColor: string;
  swatches: Swatch[];
  cylinderSegments: number;
  /** Sidebar tabs in order. */
  panels: PanelId[];
  /** Show a 1.75 m person for scale. */
  scaleFigure: boolean;
  /** Show the 3D printer bed and build volume. */
  printPlate: boolean;
}

const NEUTRALS: Swatch[] = [
  { name: 'Light grey', color: '#d4dae3' },
  { name: 'White', color: '#f4f4f2' },
  { name: 'Graphite', color: '#4b5563' },
];

const FILAMENT: Swatch[] = [
  { name: 'White', color: '#f4f4f2' },
  { name: 'Light grey', color: '#d4dae3' },
  { name: 'Black', color: '#2b2d31' },
  { name: 'Red', color: '#e05252' },
  { name: 'Orange', color: '#f08c3a' },
  { name: 'Yellow', color: '#f2c94c' },
  { name: 'Green', color: '#5bb974' },
  { name: 'Blue', color: '#4a86e8' },
  { name: 'Purple', color: '#8e6cd8' },
  { name: 'Pink', color: '#ef8fb8' },
  { name: 'Silver', color: '#a9b0b8' },
  { name: 'Wood fill', color: '#b88a5a' },
];

const WOOD: Swatch[] = [
  { name: 'Pine', color: '#e9c98f' },
  { name: 'Birch plywood', color: '#e6d3ad' },
  { name: 'Oak', color: '#c69a5d' },
  { name: 'Beech', color: '#ddb27f' },
  { name: 'Cherry', color: '#a8643f' },
  { name: 'Walnut', color: '#6e4b33' },
  { name: 'MDF', color: '#b79d78' },
  { name: 'OSB', color: '#cfa96a' },
  { name: 'White laminate', color: '#f1f0ec' },
  { name: 'Black laminate', color: '#34363a' },
  { name: 'Steel', color: '#9aa3ad' },
];

const BUILDING: Swatch[] = [
  { name: 'Plaster', color: '#ece8e0' },
  { name: 'Concrete', color: '#b8b8b0' },
  { name: 'Brick', color: '#b5543c' },
  { name: 'Roof tile', color: '#8a4b3a' },
  { name: 'Timber', color: '#c69a5d' },
  { name: 'Glass', color: '#bcd9e8' },
  { name: 'Metal', color: '#7d8791' },
  { name: 'Stone', color: '#9c9486' },
  { name: 'Grass', color: '#7fae5a' },
  { name: 'Dark grey', color: '#4b5563' },
];

export const WORKSPACES: Record<WorkspaceId, WorkspaceConfig> = {
  print: {
    id: 'print',
    name: 'Print',
    tagline: '3D printing: small parts on your printer’s bed, fine snapping, STL export.',
    icon: 'print',
    units: 'mm',
    snapStep: 0.5,
    snapSteps: [0.1, 0.2, 0.5, 1, 2, 5, 10],
    gridBase: 1,
    homeView: [[0, 0, 0], [256, 256, 60]],
    defaultColor: '#d4dae3',
    swatches: FILAMENT,
    cylinderSegments: 64,
    panels: ['properties', 'print', 'objects'],
    scaleFigure: false,
    printPlate: true,
  },
  workshop: {
    id: 'workshop',
    name: 'Workshop',
    tagline: 'Woodworking & furniture: boards in real sizes, cut list.',
    icon: 'saw',
    units: 'mm',
    snapStep: 1,
    snapSteps: [0.5, 1, 5, 10, 25, 50, 100],
    gridBase: 1,
    homeView: [[-200, -200, 0], [1000, 600, 900]],
    defaultColor: '#e9c98f',
    swatches: [...WOOD, ...NEUTRALS],
    cylinderSegments: 48,
    panels: ['properties', 'cutlist', 'objects'],
    scaleFigure: false,
    printPlate: false,
  },
  build: {
    id: 'build',
    name: 'Build',
    tagline: 'Houses, rooms & gardens: metres, coarse snapping, a person for scale.',
    icon: 'house',
    units: 'cm',
    snapStep: 10,
    snapSteps: [1, 5, 10, 50, 100, 500],
    gridBase: 10,
    homeView: [[-3000, -3000, 0], [8000, 6000, 3000]],
    defaultColor: '#ece8e0',
    swatches: BUILDING,
    cylinderSegments: 32,
    panels: ['properties', 'quantities', 'cutlist', 'objects'],
    scaleFigure: true,
    printPlate: false,
  },
};

export const WORKSPACE_IDS = Object.keys(WORKSPACES) as WorkspaceId[];

export function isWorkspaceId(v: unknown): v is WorkspaceId {
  return typeof v === 'string' && v in WORKSPACES;
}

// ---- 3D printers ------------------------------------------------------------

export interface PrinterProfile {
  id: string;
  name: string;
  /** Build volume in mm: X (width), Y (depth), Z (height). */
  volume: [number, number, number];
}

export const PRINTERS: PrinterProfile[] = [
  { id: 'bambu-x1-p1', name: 'Bambu Lab X1 / P1 series', volume: [256, 256, 256] },
  { id: 'bambu-a1', name: 'Bambu Lab A1', volume: [256, 256, 256] },
  { id: 'bambu-a1-mini', name: 'Bambu Lab A1 mini', volume: [180, 180, 180] },
  { id: 'prusa-mk4', name: 'Prusa MK4 / MK4S / MK3S', volume: [250, 210, 220] },
  { id: 'prusa-core-one', name: 'Prusa CORE One', volume: [250, 220, 270] },
  { id: 'prusa-mini', name: 'Prusa MINI+', volume: [180, 180, 180] },
  { id: 'prusa-xl', name: 'Prusa XL', volume: [360, 360, 360] },
  { id: 'ender3-v3', name: 'Creality Ender-3 V3 / V3 SE', volume: [220, 220, 250] },
  { id: 'creality-k1', name: 'Creality K1 / K1C', volume: [220, 220, 250] },
  { id: 'creality-k1-max', name: 'Creality K1 Max', volume: [300, 300, 300] },
  { id: 'elegoo-neptune4', name: 'Elegoo Neptune 4 / 4 Pro', volume: [225, 225, 265] },
  { id: 'anycubic-kobra3', name: 'Anycubic Kobra 3', volume: [250, 250, 260] },
  { id: 'voron-350', name: 'Voron 2.4 (350)', volume: [350, 350, 340] },
];

export const DEFAULT_PRINTER = PRINTERS[0].id;

/** Printer chosen for a document: a known profile, or a custom build volume. */
export interface PrinterSetting {
  profile: string; // a PRINTERS id or 'custom'
  custom: [number, number, number];
}

export const DEFAULT_PRINTER_SETTING: PrinterSetting = { profile: DEFAULT_PRINTER, custom: [220, 220, 250] };

export function printerVolume(setting: PrinterSetting): [number, number, number] {
  if (setting.profile === 'custom') return setting.custom;
  return PRINTERS.find((p) => p.id === setting.profile)?.volume ?? PRINTERS[0].volume;
}

export function printerName(setting: PrinterSetting): string {
  if (setting.profile === 'custom') return `Custom ${setting.custom.join(' × ')} mm`;
  return PRINTERS.find((p) => p.id === setting.profile)?.name ?? PRINTERS[0].name;
}

// ---- print checks -------------------------------------------------------------

export type FitProblem = 'outside' | 'too-tall' | 'below' | 'floating';

export interface FitIssue {
  id: string;
  name: string;
  problem: FitProblem;
  message: string;
}

const EPS = 0.01;

/**
 * Check every visible solid against the build volume (bed from (0,0) to (W,D), height H).
 * "Floating" means neither on the bed nor resting on/inside another solid.
 */
export function checkPrintFit(entities: Entity[], volume: [number, number, number]): FitIssue[] {
  const [W, D, H] = volume;
  const solids = entities.filter((e) => e.visible && !e.hole);
  const bounds = new Map(solids.map((e) => [e.id, worldBounds(e)]));
  const issues: FitIssue[] = [];
  const r = (v: number) => Math.round(v * 10) / 10;

  for (const e of solids) {
    const b = bounds.get(e.id)!;
    if (b.min.z < -EPS) {
      issues.push({ id: e.id, name: e.name, problem: 'below', message: `goes ${r(-b.min.z)} mm below the bed` });
    }
    if (b.min.x < -EPS || b.min.y < -EPS || b.max.x > W + EPS || b.max.y > D + EPS) {
      const size = b.getSize(new THREE.Vector3());
      const tooBig = size.x > W + EPS || size.y > D + EPS;
      issues.push({
        id: e.id,
        name: e.name,
        problem: 'outside',
        message: tooBig ? `is ${r(size.x)} × ${r(size.y)} mm — larger than the ${W} × ${D} mm bed` : 'is partly off the bed',
      });
    }
    if (b.max.z > H + EPS) {
      issues.push({ id: e.id, name: e.name, problem: 'too-tall', message: `is ${r(b.max.z)} mm tall — the printer reaches ${H} mm` });
    }
    if (b.min.z > EPS) {
      const supported = solids.some((o) => {
        if (o.id === e.id) return false;
        const ob = bounds.get(o.id)!;
        const xyOverlap = ob.min.x < b.max.x - EPS && ob.max.x > b.min.x + EPS && ob.min.y < b.max.y - EPS && ob.max.y > b.min.y + EPS;
        return xyOverlap && ob.min.z < b.min.z + EPS && ob.max.z > b.min.z - EPS;
      });
      if (!supported) {
        issues.push({ id: e.id, name: e.name, problem: 'floating', message: `floats ${r(b.min.z)} mm above the bed` });
      }
    }
  }
  return issues;
}

/** Translation that centres `entities` on the bed and sets them down on it. */
export function placeOnPlateDelta(entities: Entity[], volume: [number, number, number]): THREE.Vector3 {
  const box = new THREE.Box3();
  for (const e of entities) if (e.visible && !e.hole) box.union(worldBounds(e));
  if (box.isEmpty()) return new THREE.Vector3();
  const center = box.getCenter(new THREE.Vector3());
  return new THREE.Vector3(volume[0] / 2 - center.x, volume[1] / 2 - center.y, -box.min.z);
}

// ---- volume & weight ----------------------------------------------------------

/** Volume (mm³) enclosed by a closed triangle mesh, via signed tetrahedra. */
export function meshVolume(geometry: THREE.BufferGeometry): number {
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const count = index ? index.count : pos.count;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let sum = 0;
  for (let i = 0; i < count; i += 3) {
    a.fromBufferAttribute(pos, index ? index.getX(i) : i);
    b.fromBufferAttribute(pos, index ? index.getX(i + 1) : i + 1);
    c.fromBufferAttribute(pos, index ? index.getX(i + 2) : i + 2);
    sum += a.dot(b.cross(c));
  }
  return Math.abs(sum / 6);
}

export const FILAMENTS: { id: string; name: string; density: number }[] = [
  { id: 'pla', name: 'PLA', density: 1.24 },
  { id: 'petg', name: 'PETG', density: 1.27 },
  { id: 'abs', name: 'ABS', density: 1.04 },
  { id: 'asa', name: 'ASA', density: 1.07 },
  { id: 'tpu', name: 'TPU', density: 1.21 },
  { id: 'pa', name: 'PA / Nylon', density: 1.14 },
];
