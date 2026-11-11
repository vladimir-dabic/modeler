import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { BoxEntity, RevolveEntity, SphereEntity, TubeEntity, Vec2 } from './types';

/**
 * Meshes for the round and smooth part kinds: rounded boxes, spheres/ellipsoids, revolved
 * profiles and tubes. All are closed solids with outward faces (CSG and STL rely on it).
 * DOM-free.
 */

const AXIS_EPS = 1e-6;

/** Signed volume of a closed mesh; negative means its faces point inward. */
export function signedVolume(g: THREE.BufferGeometry): number {
  const pos = g.getAttribute('position');
  const index = g.getIndex();
  const count = index ? index.count : pos.count;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let v = 0;
  for (let i = 0; i < count; i += 3) {
    const ia = index ? index.getX(i) : i;
    const ib = index ? index.getX(i + 1) : i + 1;
    const ic = index ? index.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, ia);
    b.fromBufferAttribute(pos, ib);
    c.fromBufferAttribute(pos, ic);
    v += a.dot(b.cross(c)) / 6;
  }
  return v;
}

/** Flip the winding if the mesh is inside-out, then recompute normals. */
export function ensureOutward(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (signedVolume(g) < 0) {
    const index = g.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const b = index.getX(i + 1);
        index.setX(i + 1, index.getX(i + 2));
        index.setX(i + 2, b);
      }
      index.needsUpdate = true;
    } else {
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i += 3) {
        const x = pos.getX(i + 1);
        const y = pos.getY(i + 1);
        const z = pos.getZ(i + 1);
        pos.setXYZ(i + 1, pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
        pos.setXYZ(i + 2, x, y, z);
      }
      pos.needsUpdate = true;
    }
    g.computeVertexNormals();
  }
  return g;
}

/** Largest edge radius a box of this size allows. */
export function maxEdgeRadius(size: number[]): number {
  return Math.min(...size) / 2 - 0.001;
}

export function roundedBoxGeometry(e: BoxEntity): THREE.BufferGeometry {
  const [x, y, z] = e.size.map((s) => Math.max(s, 0.001));
  const r = Math.max(0, Math.min(e.edgeRadius ?? 0, maxEdgeRadius([x, y, z])));
  return new RoundedBoxGeometry(x, y, z, 4, r).translate(x / 2, y / 2, z / 2);
}

export function sphereGeometry(e: SphereEntity): THREE.BufferGeometry {
  const seg = Math.max(8, Math.round(e.segments));
  // three's sphere has its poles on Y; ours are on Z.
  return new THREE.SphereGeometry(1, seg, Math.max(4, Math.round(seg / 2)))
    .rotateX(Math.PI / 2)
    .scale(Math.max(e.radii[0], 0.001), Math.max(e.radii[1], 0.001), Math.max(e.radii[2], 0.001));
}

/**
 * The profile as a lathe path. If the outline runs along the axis somewhere, it is opened
 * there (axis → outside → axis) so the solid closes at its poles; otherwise it is a ring.
 */
export function lathePath(profile: Vec2[]): Vec2[] {
  const n = profile.length;
  for (let i = 0; i < n; i++) {
    const a = profile[i];
    const b = profile[(i + 1) % n];
    if (Math.abs(a[0]) < AXIS_EPS && Math.abs(b[0]) < AXIS_EPS) {
      // Start after the axis edge, end at its first point.
      return [...profile.slice(i + 1), ...profile.slice(0, i + 1)].map(([r, z]) => [Math.max(0, r), z] as Vec2);
    }
  }
  return [...profile, profile[0]].map(([r, z]) => [Math.max(0, r), z] as Vec2);
}

export function revolveGeometry(e: RevolveEntity): THREE.BufferGeometry {
  const path = lathePath(e.profile).map(([r, z]) => new THREE.Vector2(r, z));
  // three's lathe spins around Y; ours spins around Z.
  const g = new THREE.LatheGeometry(path, Math.max(3, Math.round(e.segments))).rotateX(Math.PI / 2);
  return ensureOutward(g);
}

export function revolveBounds(e: RevolveEntity): THREE.Box3 {
  const rMax = Math.max(...e.profile.map((p) => p[0]));
  const zs = e.profile.map((p) => p[1]);
  return new THREE.Box3(new THREE.Vector3(-rMax, -rMax, Math.min(...zs)), new THREE.Vector3(rMax, rMax, Math.max(...zs)));
}

/** Centre-line samples of a tube with the radius at each, local coordinates. */
export function tubeSamples(e: TubeEntity): { points: THREE.Vector3[]; radii: number[] } {
  const pts = e.path.map((p) => new THREE.Vector3(...p));
  const radiusAt = (u: number) => {
    if (!e.radii || e.radii.length !== pts.length) return e.radius;
    const i = Math.min(Math.floor(u), pts.length - 2);
    const t = u - i;
    return e.radii[i] * (1 - t) + e.radii[i + 1] * t;
  };
  if (!e.smooth || pts.length < 3) return { points: pts, radii: pts.map((_, i) => radiusAt(i)) };
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const n = Math.min(800, Math.max(24, (pts.length - 1) * 16));
  const points: THREE.Vector3[] = [];
  const radii: number[] = [];
  for (let s = 0; s <= n; s++) {
    const t = s / n;
    points.push(curve.getPoint(t));
    radii.push(radiusAt(t * (pts.length - 1)));
  }
  return { points, radii };
}

/**
 * A capped tube: rings around the centre line, oriented by parallel transport (no
 * twisting), joined by quads, closed by flat end caps.
 */
export function tubeGeometry(e: TubeEntity): THREE.BufferGeometry {
  const { points, radii } = tubeSamples(e);
  const seg = Math.max(3, Math.round(e.segments));
  const n = points.length;
  // Tangents: averaged at interior points, so sharp corners get a mitre-like ring.
  const tangents = points.map((_, i) => {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(n - 1, i + 1)];
    const t = next.clone().sub(prev);
    return t.lengthSq() > 0 ? t.normalize() : new THREE.Vector3(0, 0, 1);
  });
  const normals: THREE.Vector3[] = [];
  const first = tangents[0];
  const helper = Math.abs(first.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  normals.push(helper.clone().cross(first).normalize());
  for (let i = 1; i < n; i++) {
    const q = new THREE.Quaternion().setFromUnitVectors(tangents[i - 1], tangents[i]);
    normals.push(normals[i - 1].clone().applyQuaternion(q).normalize());
  }
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const b = tangents[i].clone().cross(normals[i]);
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const r = radii[i];
      const p = points[i].clone().addScaledVector(normals[i], Math.cos(a) * r).addScaledVector(b, Math.sin(a) * r);
      pos.push(p.x, p.y, p.z);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * seg + j;
      const b = i * seg + ((j + 1) % seg);
      const c = (i + 1) * seg + j;
      const d = (i + 1) * seg + ((j + 1) % seg);
      // Ring direction runs N → B = T × N, so (a, b, c) faces outward.
      idx.push(a, b, c, b, d, c);
    }
  }
  // Flat caps with their own vertices, so the side shading stays smooth.
  // The start cap faces −T, the end cap +T.
  for (const [ring, flip] of [
    [0, true],
    [n - 1, false],
  ] as const) {
    const start = pos.length / 3;
    for (let j = 0; j < seg; j++) pos.push(pos[(ring * seg + j) * 3], pos[(ring * seg + j) * 3 + 1], pos[(ring * seg + j) * 3 + 2]);
    const center = pos.length / 3;
    pos.push(points[ring].x, points[ring].y, points[ring].z);
    for (let j = 0; j < seg; j++) {
      const a = start + j;
      const b = start + ((j + 1) % seg);
      if (flip) idx.push(center, b, a);
      else idx.push(center, a, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return ensureOutward(g);
}

export function tubeBounds(e: TubeEntity): THREE.Box3 {
  const { points, radii } = tubeSamples(e);
  const box = new THREE.Box3();
  points.forEach((p, i) => {
    box.expandByPoint(p.clone().addScalar(-radii[i]));
    box.expandByPoint(p.clone().addScalar(radii[i]));
  });
  return box;
}

/** Length of a tube's centre line. */
export function tubeLength(e: TubeEntity): number {
  const { points } = tubeSamples(e);
  let len = 0;
  for (let i = 1; i < points.length; i++) len += points[i].distanceTo(points[i - 1]);
  return len;
}
