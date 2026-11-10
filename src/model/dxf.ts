import { MAX_DRAWING_POINTS } from './references';
import type { DrawingGeometry, DrawingPath, DrawingUnit, Vec2 } from './types';

/**
 * ASCII DXF → reference-drawing geometry (ADR 0014). Reads the 2D plan view: lines,
 * polylines with bulges, circles, arcs, ellipses, splines, solids/3D faces as outlines,
 * and block INSERTs (nested, scaled, rotated, arrayed). Z is ignored. Text, hatches,
 * dimensions and other annotation are skipped and counted. DOM-free.
 */

export interface DxfImport {
  /** Lines in drawing units, shifted so the drawing's bounds start at (0, 0). */
  geometry: DrawingGeometry;
  /** From $INSUNITS, when the file says. */
  units?: DrawingUnit;
  /** Layers switched off or frozen in the file. */
  hiddenLayers: string[];
  /** The shift applied to bring the drawing to the origin (drawing units). */
  offset: Vec2;
  /** Entity types that were not imported, with counts. */
  skipped: Record<string, number>;
}

export class DxfError extends Error {}

type Pair = [number, string];
interface Rec {
  type: string;
  pairs: Pair[];
}
interface Block {
  base: Vec2;
  records: Rec[];
}
/** 2D affine transform [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
type M = [number, number, number, number, number, number];

const IDENTITY: M = [1, 0, 0, 1, 0, 0];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: M, [x, y]: Vec2): Vec2 => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const translate = (x: number, y: number): M => [1, 0, 0, 1, x, y];
const rotate = (deg: number): M => {
  const a = (deg * Math.PI) / 180;
  return [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
};
const scale = (sx: number, sy: number): M => [sx, 0, 0, sy, 0, 0];
/** Entities with extrusion direction −Z (mirrored in AutoCAD) have x flipped in their OCS. */
const MIRROR_X: M = [-1, 0, 0, 1, 0, 0];

const INSUNITS: Record<number, DrawingUnit> = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };
const SEGMENTS_PER_CIRCLE = 64;
const MAX_DEPTH = 16;


function tokenize(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isInteger(code)) throw new DxfError(`Malformed DXF near line ${i + 1}`);
    pairs.push([code, lines[i + 1].trim()]);
  }
  return pairs;
}

/** Split a section's pairs into records, each starting at a group code 0. */
function records(pairs: Pair[], from: number, to: number): Rec[] {
  const out: Rec[] = [];
  let cur: Rec | null = null;
  for (let i = from; i < to; i++) {
    const [code, value] = pairs[i];
    if (code === 0) {
      cur = { type: value.toUpperCase(), pairs: [] };
      out.push(cur);
    } else cur?.pairs.push(pairs[i]);
  }
  return out;
}

const num = (r: Rec, code: number, fallback = 0): number => {
  const p = r.pairs.find((x) => x[0] === code);
  const v = p ? Number(p[1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
};
const str = (r: Rec, code: number, fallback = ''): string => r.pairs.find((x) => x[0] === code)?.[1] ?? fallback;
const pt = (r: Rec, xCode: number): Vec2 => [num(r, xCode), num(r, xCode + 10)];

export function parseDxf(text: string): DxfImport {
  const head = text.slice(0, 32);
  if (/^AC10\d\d/.test(head)) {
    throw new DxfError('This is a DWG file, not DXF. Save it as DXF in your CAD program, or convert it with the free ODA File Converter.');
  }
  if (head.startsWith('AutoCAD Binary DXF')) throw new DxfError('Binary DXF is not supported. Save as ASCII DXF.');
  const pairs = tokenize(text);

  // ---- sections
  const sections = new Map<string, [number, number]>();
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === 0 && pairs[i][1] === 'SECTION' && pairs[i + 1]?.[0] === 2) {
      const name = pairs[i + 1][1].toUpperCase();
      let j = i + 2;
      while (j < pairs.length && !(pairs[j][0] === 0 && pairs[j][1] === 'ENDSEC')) j++;
      sections.set(name, [i + 2, j]);
      i = j;
    }
  }
  if (!sections.has('ENTITIES')) throw new DxfError('Not a DXF file (no ENTITIES section).');

  // ---- header: units
  let units: DrawingUnit | undefined;
  const header = sections.get('HEADER');
  if (header) {
    for (let i = header[0]; i < header[1]; i++) {
      if (pairs[i][0] === 9 && pairs[i][1] === '$INSUNITS' && pairs[i + 1]?.[0] === 70) units = INSUNITS[Number(pairs[i + 1][1])];
    }
  }

  // ---- tables: layers that are off (negative colour) or frozen (flag 1)
  const hidden = new Set<string>();
  const tables = sections.get('TABLES');
  if (tables) {
    for (const r of records(pairs, tables[0], tables[1])) {
      if (r.type !== 'LAYER') continue;
      if (num(r, 62, 7) < 0 || (num(r, 70) & 1) === 1) hidden.add(str(r, 2, '0'));
    }
  }

  // ---- blocks
  const blocks = new Map<string, Block>();
  const blockSec = sections.get('BLOCKS');
  if (blockSec) {
    let cur: Block | null = null;
    for (const r of records(pairs, blockSec[0], blockSec[1])) {
      if (r.type === 'BLOCK') {
        cur = { base: pt(r, 10), records: [] };
        blocks.set(str(r, 2), cur);
      } else if (r.type === 'ENDBLK') cur = null;
      else cur?.records.push(r);
    }
  }

  // ---- entities
  const layerIndex = new Map<string, number>();
  const layers: string[] = [];
  const paths: DrawingPath[] = [];
  const skipped: Record<string, number> = {};
  let total = 0;

  const layerOf = (name: string) => {
    let i = layerIndex.get(name);
    if (i === undefined) {
      i = layers.length;
      layers.push(name);
      layerIndex.set(name, i);
    }
    return i;
  };

  const emit = (layer: string, m: M, local: Vec2[], closed: boolean, center?: Vec2) => {
    const points: Vec2[] = [];
    for (const p of local) {
      const [x, y] = apply(m, p);
      const last = points[points.length - 1];
      if (!last || Math.abs(last[0] - x) > 1e-9 || Math.abs(last[1] - y) > 1e-9) points.push([x, y]);
    }
    if (closed && points.length > 2) {
      const [a, b] = [points[0], points[points.length - 1]];
      if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) points.pop();
    }
    if (points.length < 2) return;
    total += points.length;
    if (total > MAX_DRAWING_POINTS) throw new DxfError(`The drawing is too large (over ${MAX_DRAWING_POINTS.toLocaleString('en')} points). Remove detail or split it.`);
    paths.push({ layer: layerOf(layer), points, ...(closed ? { closed: true } : {}), ...(center ? { center: apply(m, center) } : {}) });
  };

  const walk = (recs: Rec[], m: M, parentLayer: string | null, depth: number) => {
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (num(r, 67) === 1) continue; // paper space
      let layer = str(r, 8, '0');
      if (parentLayer !== null && layer === '0') layer = parentLayer; // block entities on layer 0 inherit
      const ocs: M = num(r, 230, 1) < 0 ? mul(m, MIRROR_X) : m;
      switch (r.type) {
        case 'LINE':
          emit(layer, m, [pt(r, 10), pt(r, 11)], false);
          break;
        case 'LWPOLYLINE': {
          const verts: { p: Vec2; bulge: number }[] = [];
          for (const [code, value] of r.pairs) {
            if (code === 10) verts.push({ p: [Number(value), 0], bulge: 0 });
            else if (code === 20 && verts.length) verts[verts.length - 1].p[1] = Number(value);
            else if (code === 42 && verts.length) verts[verts.length - 1].bulge = Number(value);
          }
          const closed = (num(r, 70) & 1) === 1;
          emit(layer, ocs, bulgePolyline(verts, closed), closed);
          break;
        }
        case 'POLYLINE': {
          const flags = num(r, 70);
          const verts: { p: Vec2; bulge: number }[] = [];
          let j = i + 1;
          for (; j < recs.length && recs[j].type === 'VERTEX'; j++) {
            // Flag 16 = spline frame control point, not on the curve.
            if ((num(recs[j], 70) & 16) === 0) verts.push({ p: pt(recs[j], 10), bulge: num(recs[j], 42) });
          }
          if (recs[j]?.type === 'SEQEND') j++;
          i = j - 1;
          if (flags & (16 | 64)) {
            skipped['POLYLINE (mesh)'] = (skipped['POLYLINE (mesh)'] ?? 0) + 1;
            break;
          }
          const closed = (flags & 1) === 1;
          emit(layer, flags & 8 ? m : ocs, bulgePolyline(verts, closed), closed);
          break;
        }
        case 'CIRCLE': {
          const c = pt(r, 10);
          emit(layer, ocs, arcPoints(c, num(r, 40), 0, 360, true), true, c);
          break;
        }
        case 'ARC': {
          const c = pt(r, 10);
          emit(layer, ocs, arcPoints(c, num(r, 40), num(r, 50), num(r, 51), false), false, c);
          break;
        }
        case 'ELLIPSE': {
          const c = pt(r, 10);
          const [ax, ay] = pt(r, 11);
          // The minor axis is N × major; with N = −Z it points the other way.
          const k = num(r, 40, 1) * (num(r, 230, 1) < 0 ? -1 : 1);
          let t0 = num(r, 41, 0);
          let t1 = num(r, 42, Math.PI * 2);
          const full = Math.abs(t1 - t0 - Math.PI * 2) < 1e-6 || Math.abs(t1 - t0) < 1e-9;
          if (t1 <= t0) t1 += Math.PI * 2;
          if (full) [t0, t1] = [0, Math.PI * 2];
          const n = Math.max(8, Math.ceil(((t1 - t0) / (Math.PI * 2)) * SEGMENTS_PER_CIRCLE));
          const pts: Vec2[] = [];
          for (let s = 0; s <= (full ? n - 1 : n); s++) {
            const t = t0 + ((t1 - t0) * s) / n;
            pts.push([c[0] + ax * Math.cos(t) - k * ay * Math.sin(t), c[1] + ay * Math.cos(t) + k * ax * Math.sin(t)]);
          }
          emit(layer, m, pts, full, c);
          break;
        }
        case 'SPLINE':
          emit(layer, m, splinePoints(r), (num(r, 70) & 1) === 1);
          break;
        case 'SOLID':
        case 'TRACE':
        case '3DFACE': {
          const q = [pt(r, 10), pt(r, 11), pt(r, 12), pt(r, 13)];
          // SOLID/TRACE store corners as 1, 2, 4, 3.
          const outline = r.type === '3DFACE' ? q : [q[0], q[1], q[3], q[2]];
          emit(layer, r.type === '3DFACE' ? m : ocs, outline, true);
          break;
        }
        case 'INSERT': {
          const block = blocks.get(str(r, 2));
          if (!block || depth >= MAX_DEPTH) break;
          const [ix, iy] = pt(r, 10);
          const sx = num(r, 41, 1);
          const sy = num(r, 42, 1);
          const rot = num(r, 50);
          const cols = Math.max(1, Math.min(1000, num(r, 70, 1)));
          const rows = Math.max(1, Math.min(1000, num(r, 71, 1)));
          const [dc, dr] = [num(r, 44), num(r, 45)];
          for (let c = 0; c < cols; c++) {
            for (let rr = 0; rr < rows; rr++) {
              const local = mul(mul(mul(mul(translate(ix, iy), rotate(rot)), translate(c * dc, rr * dr)), scale(sx, sy)), translate(-block.base[0], -block.base[1]));
              walk(block.records, mul(ocs, local), layer, depth + 1);
            }
          }
          break;
        }
        case 'VERTEX':
        case 'SEQEND':
          break;
        default:
          // Text, hatches, dimensions, points, images, 3D solids…: counted, not imported.
          skipped[r.type] = (skipped[r.type] ?? 0) + 1;
      }
    }
  };

  const ent = sections.get('ENTITIES')!;
  walk(records(pairs, ent[0], ent[1]), IDENTITY, null, 0);
  if (!paths.length) {
    const other = Object.keys(skipped);
    throw new DxfError(`The DXF has no lines, arcs or polylines to import${other.length ? ` (only ${other.join(', ')})` : ''}.`);
  }

  // Bring the drawing to the origin (CAD files often use survey coordinates far away).
  let minX = Infinity;
  let minY = Infinity;
  for (const p of paths) for (const [x, y] of p.points) [minX, minY] = [Math.min(minX, x), Math.min(minY, y)];
  const round = (v: number) => Math.round(v * 1e4) / 1e4;
  const shift = ([x, y]: Vec2): Vec2 => [round(x - minX), round(y - minY)];
  for (const p of paths) {
    p.points = p.points.map(shift);
    if (p.center) p.center = shift(p.center);
  }
  return {
    geometry: { layers, paths },
    ...(units ? { units } : {}),
    hiddenLayers: layers.filter((l) => hidden.has(l)),
    offset: [round(minX), round(minY)],
    skipped,
  };
}

// ---- curves ---------------------------------------------------------------------------------

function arcPoints(c: Vec2, r: number, startDeg: number, endDeg: number, full: boolean): Vec2[] {
  let sweep = full ? 360 : endDeg - startDeg;
  if (!full && sweep <= 0) sweep += 360;
  const n = Math.max(full ? 16 : 2, Math.ceil((sweep / 360) * SEGMENTS_PER_CIRCLE));
  const out: Vec2[] = [];
  for (let i = 0; i <= (full ? n - 1 : n); i++) {
    const a = ((startDeg + (sweep * i) / n) * Math.PI) / 180;
    out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
  }
  return out;
}

/** Polyline vertices with bulges (arc segments): bulge = tan(angle/4), positive = CCW. */
function bulgePolyline(verts: { p: Vec2; bulge: number }[], closed: boolean): Vec2[] {
  const out: Vec2[] = [];
  const n = closed ? verts.length : verts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % verts.length];
    out.push(a.p);
    if (Math.abs(a.bulge) > 1e-9) out.push(...bulgeArc(a.p, b.p, a.bulge));
  }
  if (!closed && verts.length) out.push(verts[verts.length - 1].p);
  return out;
}

/** Interior points of the arc from p1 to p2 with the given bulge. */
function bulgeArc([x1, y1]: Vec2, [x2, y2]: Vec2, bulge: number): Vec2[] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12) return [];
  const theta = 4 * Math.atan(bulge);
  const r = chord / (2 * Math.sin(theta / 2));
  const dist = r * Math.cos(theta / 2);
  const cx = (x1 + x2) / 2 - (dy / chord) * dist;
  const cy = (y1 + y2) / 2 + (dx / chord) * dist;
  const radius = Math.abs(r);
  const a0 = Math.atan2(y1 - cy, x1 - cx);
  const n = Math.max(2, Math.ceil((Math.abs(theta) / (Math.PI * 2)) * SEGMENTS_PER_CIRCLE));
  const out: Vec2[] = [];
  for (let i = 1; i < n; i++) {
    const a = a0 + (theta * i) / n;
    out.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  return out;
}

/** Sample a (rational) B-spline; falls back to its fit or control points. */
function splinePoints(r: Rec): Vec2[] {
  const degree = num(r, 71, 3);
  const knots: number[] = [];
  const weights: number[] = [];
  const ctrl: Vec2[] = [];
  const fit: Vec2[] = [];
  for (const [code, value] of r.pairs) {
    const v = Number(value);
    if (code === 40) knots.push(v);
    else if (code === 41) weights.push(v);
    else if (code === 10) ctrl.push([v, 0]);
    else if (code === 20 && ctrl.length) ctrl[ctrl.length - 1][1] = v;
    else if (code === 11) fit.push([v, 0]);
    else if (code === 21 && fit.length) fit[fit.length - 1][1] = v;
  }
  const n = ctrl.length;
  if (n < 2 || knots.length !== n + degree + 1 || degree < 1) return fit.length >= 2 ? fit : ctrl;
  const w = weights.length === n ? weights : ctrl.map(() => 1);
  const u0 = knots[degree];
  const u1 = knots[n];
  const samples = Math.min(2000, Math.max(16, n * 8));
  const out: Vec2[] = [];
  for (let s = 0; s <= samples; s++) {
    const u = s === samples ? u1 - 1e-10 * (u1 - u0) : u0 + ((u1 - u0) * s) / samples;
    // Find the knot span.
    let k = degree;
    while (k < n - 1 && u >= knots[k + 1]) k++;
    // de Boor in homogeneous coordinates.
    const d: [number, number, number][] = [];
    for (let j = 0; j <= degree; j++) {
      const idx = k - degree + j;
      d.push([ctrl[idx][0] * w[idx], ctrl[idx][1] * w[idx], w[idx]]);
    }
    for (let rr = 1; rr <= degree; rr++) {
      for (let j = degree; j >= rr; j--) {
        const idx = k - degree + j;
        const denom = knots[idx + degree - rr + 1] - knots[idx];
        const alpha = denom === 0 ? 0 : (u - knots[idx]) / denom;
        d[j] = [(1 - alpha) * d[j - 1][0] + alpha * d[j][0], (1 - alpha) * d[j - 1][1] + alpha * d[j][1], (1 - alpha) * d[j - 1][2] + alpha * d[j][2]];
      }
    }
    const [hx, hy, hw] = d[degree];
    out.push(hw ? [hx / hw, hy / hw] : [hx, hy]);
  }
  return out;
}
