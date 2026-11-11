import * as THREE from 'three';
import Module from 'manifold-3d';
import type { Manifold as ManifoldT, ManifoldToplevel } from 'manifold-3d';

/**
 * The Manifold geometry engine (ADR 0017): watertight booleans in WebAssembly, in the
 * browser and in Node. It must be loaded once with `initManifold()` before use; until then
 * (or if loading fails) callers fall back to the three-bvh-csg engine. DOM-free.
 *
 * Manifold objects live in WebAssembly memory and must be freed with `.delete()`; every
 * function here frees what it creates.
 */

let wasm: ManifoldToplevel | null = null;
let loading: Promise<boolean> | null = null;

/** Faces meeting at more than this angle (degrees) get a hard edge in the shading. */
const SHARP_ANGLE = 30;

/**
 * Load the WebAssembly module. In the browser, pass the URL of `manifold.wasm` (bundlers
 * move it); in Node it is found next to the module. Resolves false if it can't load.
 */
export function initManifold(wasmUrl?: string): Promise<boolean> {
  loading ??= (async () => {
    try {
      const m = await Module(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
      m.setup();
      wasm = m;
      return true;
    } catch (err) {
      console.warn('Manifold engine unavailable, using the fallback engine:', err);
      return false;
    }
  })();
  return loading;
}

export function manifoldReady(): boolean {
  return wasm !== null;
}

/** A closed three.js geometry (any vertex layout) as a Manifold, transformed by `matrix`. */
export function toManifold(geometry: THREE.BufferGeometry, matrix?: THREE.Matrix4): ManifoldT {
  const { Manifold, Mesh } = wasm!;
  const pos = geometry.getAttribute('position');
  const vertProperties = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    if (matrix) v.applyMatrix4(matrix);
    vertProperties[i * 3] = v.x;
    vertProperties[i * 3 + 1] = v.y;
    vertProperties[i * 3 + 2] = v.z;
  }
  const index = geometry.getIndex();
  const triVerts = index ? Uint32Array.from(index.array as ArrayLike<number>) : Uint32Array.from({ length: pos.count }, (_, i) => i);
  // A reflection (negative determinant) flips the winding; flip it back.
  if (matrix && matrix.determinant() < 0) {
    for (let i = 0; i < triVerts.length; i += 3) [triVerts[i + 1], triVerts[i + 2]] = [triVerts[i + 2], triVerts[i + 1]];
  }
  const mesh = new Mesh({ numProp: 3, vertProperties, triVerts });
  // three.js meshes repeat vertices along hard edges and seams; weld them by position.
  mesh.merge();
  return new Manifold(mesh);
}

/** A Manifold as an indexed three.js geometry with normals (hard edges stay hard). */
export function toGeometry(m: ManifoldT): THREE.BufferGeometry {
  const withNormals = m.calculateNormals(0, SHARP_ANGLE);
  const mesh = withNormals.getMesh();
  withNormals.delete();
  const n = mesh.numProp;
  const count = mesh.vertProperties.length / n;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      position[i * 3 + k] = mesh.vertProperties[i * n + k];
      normal[i * 3 + k] = mesh.vertProperties[i * n + 3 + k];
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  g.setIndex(new THREE.BufferAttribute(mesh.triVerts, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

export interface Operand {
  geometry: THREE.BufferGeometry;
  /** Placement of the operand in the result's frame. */
  matrix?: THREE.Matrix4;
}

function run<T>(operands: Operand[], fn: (ms: ManifoldT[]) => ManifoldT, out: (m: ManifoldT) => T): T {
  const ms: ManifoldT[] = [];
  let result: ManifoldT | null = null;
  try {
    for (const o of operands) ms.push(toManifold(o.geometry, o.matrix));
    for (const m of ms) if (m.status() !== 'NoError') throw new Error(`input is not a closed solid (${m.status()})`);
    result = fn(ms);
    return out(result);
  } finally {
    for (const m of ms) m.delete();
    if (result && !ms.includes(result)) result.delete();
  }
}

/** `solid` minus every cutter, in one batched operation. */
export function subtract(solid: Operand, cutters: Operand[]): THREE.BufferGeometry {
  return run([solid, ...cutters], (ms) => wasm!.Manifold.difference(ms), toGeometry);
}

/** All operands merged into one solid. */
export function union(operands: Operand[]): THREE.BufferGeometry {
  return run(operands, (ms) => wasm!.Manifold.union(ms), toGeometry);
}

/** Volume (mm³) of a closed geometry, computed by Manifold. */
export function manifoldVolume(geometry: THREE.BufferGeometry): number {
  return run([{ geometry }], (ms) => ms[0], (m) => m.volume());
}

// ---- cut sections (split for printing) ------------------------------------------------------

export type AxisName = 'x' | 'y' | 'z';

/** World → a frame where `axis` is Z (a cyclic swap, so no mirroring). */
function axisToZ(axis: AxisName): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (axis === 'x') m.set(0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1); // (y, z, x)
  else if (axis === 'y') m.set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1); // (z, x, y)
  return m;
}

export interface Section {
  /** Area of the cut face, mm². */
  area: number;
  /** Width and height of the cut face's bounding rectangle, mm. */
  size: [number, number];
  /** Well-spread world points inside the face, at least `inset` from its edges. */
  points: THREE.Vector3[];
}

function inside(polys: [number, number][][], x: number, y: number): boolean {
  let odd = false;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
    }
  }
  return odd;
}

/**
 * The cross-section of the (world-space) solids at `axis = at`, and up to `count` points
 * inside it that are at least `inset` from every edge and as far apart as possible.
 */
export function sectionAt(geometries: THREE.BufferGeometry[], axis: AxisName, at: number, inset: number, count: number): Section {
  const { Manifold } = wasm!;
  const toZ = axisToZ(axis);
  const parts = geometries.map((g) => toManifold(g, toZ));
  const all = Manifold.union(parts);
  const section = all.slice(at);
  const shrunk = section.offset(-inset, 'Round');
  try {
    const b = section.bounds();
    const size: [number, number] = [b.max[0] - b.min[0], b.max[1] - b.min[1]];
    const polys = shrunk.toPolygons() as unknown as [number, number][][];
    const sb = shrunk.bounds();
    const candidates: [number, number][] = [];
    if (!shrunk.isEmpty()) {
      const steps = 40;
      const dx = (sb.max[0] - sb.min[0]) / steps;
      const dy = (sb.max[1] - sb.min[1]) / steps;
      for (let i = 0; i <= steps; i++) {
        for (let j = 0; j <= steps; j++) {
          const x = sb.min[0] + i * dx;
          const y = sb.min[1] + j * dy;
          if (inside(polys, x, y)) candidates.push([x, y]);
        }
      }
    }
    // Farthest-point sampling: start far from the middle, keep adding the point farthest from those chosen.
    const chosen: [number, number][] = [];
    if (candidates.length && count > 0) {
      const cx = candidates.reduce((s, p) => s + p[0], 0) / candidates.length;
      const cy = candidates.reduce((s, p) => s + p[1], 0) / candidates.length;
      const d2 = (a: [number, number], b: [number, number]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
      const near = (p: [number, number]) => d2(p, [cx, cy]);
      chosen.push(count === 1 ? candidates.reduce((a, b) => (near(a) <= near(b) ? a : b)) : candidates.reduce((a, b) => (near(a) >= near(b) ? a : b)));
      while (chosen.length < count) {
        const next = candidates.reduce((a, b) => (Math.min(...chosen.map((c) => d2(a, c))) >= Math.min(...chosen.map((c) => d2(b, c))) ? a : b));
        // Pegs must not overlap: keep them at least four insets apart.
        if (Math.min(...chosen.map((c) => d2(next, c))) < (4 * inset) ** 2) break;
        chosen.push(next);
      }
    }
    const fromZ = toZ.clone().invert();
    return { area: section.area(), size, points: chosen.map(([x, y]) => new THREE.Vector3(x, y, at).applyMatrix4(fromZ)) };
  } finally {
    for (const p of parts) p.delete();
    all.delete();
    section.delete();
    shrunk.delete();
  }
}
