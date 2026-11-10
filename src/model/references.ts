import * as THREE from 'three';
import type { SnapPoint } from './geometry';
import type { DrawingGeometry, DrawingPath, DrawingUnit, ReferenceDrawing, ReferenceFile, Vec2, Vec3 } from './types';

/**
 * Reference drawings (ADR 0014): imported plans to trace and snap to. Helpers to place
 * them in the world and to validate them from files. DOM-free.
 */

export const DRAWING_UNITS: DrawingUnit[] = ['mm', 'cm', 'm', 'in', 'ft'];

/** Millimetres per drawing unit. */
export const DRAWING_UNIT_MM: Record<DrawingUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

/** Limits that keep a project file, the snapper and the viewport responsive. */
export const MAX_DRAWING_POINTS = 2_000_000;

/** Drawing units → world mm: scale by units, rotate about Z, then translate. */
export function referenceMatrix(r: ReferenceDrawing): THREE.Matrix4 {
  const s = DRAWING_UNIT_MM[r.units];
  return new THREE.Matrix4()
    .makeRotationZ((r.rotation * Math.PI) / 180)
    .scale(new THREE.Vector3(s, s, 1))
    .setPosition(r.position[0], r.position[1], r.position[2]);
}

/** The paths on visible layers. */
export function visiblePaths(r: ReferenceDrawing, g: DrawingGeometry): DrawingPath[] {
  if (!r.hiddenLayers.length) return g.paths;
  const hidden = new Set(r.hiddenLayers);
  return g.paths.filter((p) => !hidden.has(g.layers[p.layer]));
}

/** Bounds in drawing units (local), over all paths. */
export function localBounds(g: DrawingGeometry): { min: Vec2; max: Vec2 } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of g.paths) {
    for (const [x, y] of p.points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return minX === Infinity ? null : { min: [minX, minY], max: [maxX, maxY] };
}

/** World bounds (mm) of the visible lines. */
export function referenceBounds(r: ReferenceDrawing, g: DrawingGeometry): THREE.Box3 {
  const box = new THREE.Box3();
  const local = localBounds({ layers: g.layers, paths: visiblePaths(r, g) });
  if (!local) return box;
  const m = referenceMatrix(r);
  for (const x of [local.min[0], local.max[0]]) for (const y of [local.min[1], local.max[1]]) box.expandByPoint(new THREE.Vector3(x, y, 0).applyMatrix4(m));
  return box;
}

/**
 * Snap points in world space: polyline corners and segment midpoints; for arcs and
 * circles their ends and centre (not every tessellation vertex).
 */
export function referenceSnapPoints(r: ReferenceDrawing, g: DrawingGeometry): SnapPoint[] {
  const m = referenceMatrix(r);
  const out: SnapPoint[] = [];
  const add = (x: number, y: number, kind: SnapPoint['kind']) => out.push({ point: new THREE.Vector3(x, y, 0).applyMatrix4(m), kind, entityId: r.id });
  for (const p of visiblePaths(r, g)) {
    const pts = p.points;
    if (p.center) {
      add(p.center[0], p.center[1], 'center');
      if (!p.closed) {
        add(pts[0][0], pts[0][1], 'endpoint');
        add(pts[pts.length - 1][0], pts[pts.length - 1][1], 'endpoint');
      }
      continue;
    }
    for (const [x, y] of pts) add(x, y, 'endpoint');
    const n = p.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      add((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 'midpoint');
    }
  }
  return out;
}

/** World-space line segments (pairs of points, flattened xyz) for rendering. */
export function referenceSegments(r: ReferenceDrawing, g: DrawingGeometry): Float32Array {
  const paths = visiblePaths(r, g);
  let count = 0;
  for (const p of paths) count += p.closed ? p.points.length : p.points.length - 1;
  const out = new Float32Array(count * 6);
  let i = 0;
  // Geometry stays in drawing units; the object's matrix places it.
  for (const p of paths) {
    const pts = p.points;
    const n = p.closed ? pts.length : pts.length - 1;
    for (let k = 0; k < n; k++) {
      const a = pts[k];
      const b = pts[(k + 1) % pts.length];
      out[i++] = a[0];
      out[i++] = a[1];
      out[i++] = 0;
      out[i++] = b[0];
      out[i++] = b[1];
      out[i++] = 0;
    }
  }
  return out;
}

export function countPoints(g: DrawingGeometry): number {
  let n = 0;
  for (const p of g.paths) n += p.points.length;
  return n;
}

// ---- validation (untrusted files) ------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec2 = (v: unknown): v is Vec2 => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNum);

/** Validate a reference drawing from a project file. Returns null if unusable. */
export function parseReferenceFile(raw: any, newId: () => string): ReferenceFile | null {
  if (!raw || typeof raw !== 'object' || raw.kind !== 'drawing') return null;
  const g = raw.geometry;
  if (!g || !Array.isArray(g.layers) || !Array.isArray(g.paths)) return null;
  const layers: string[] = g.layers.map((l: unknown) => (typeof l === 'string' ? l : '0'));
  const paths: DrawingPath[] = [];
  let total = 0;
  for (const p of g.paths) {
    if (!p || !Array.isArray(p.points) || p.points.length < 2 || !p.points.every(isVec2)) continue;
    if (!Number.isInteger(p.layer) || p.layer < 0 || p.layer >= layers.length) continue;
    total += p.points.length;
    if (total > MAX_DRAWING_POINTS) return null;
    paths.push({ layer: p.layer, points: p.points, ...(p.closed === true ? { closed: true } : {}), ...(isVec2(p.center) ? { center: p.center } : {}) });
  }
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Drawing',
    kind: 'drawing',
    units: DRAWING_UNITS.includes(raw.units) ? raw.units : 'mm',
    position: isVec3(raw.position) ? raw.position : [0, 0, 0],
    rotation: isNum(raw.rotation) ? raw.rotation : 0,
    visible: raw.visible !== false,
    hiddenLayers: Array.isArray(raw.hiddenLayers) ? raw.hiddenLayers.filter((l: unknown) => typeof l === 'string') : [],
    geometry: { layers, paths },
  };
}
