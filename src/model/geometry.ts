import * as THREE from 'three';
import type { BoxEntity, CylinderEntity, Entity, ExtrusionEntity, Vec3 } from './types';

export const DEG = Math.PI / 180;
/** Smallest allowed dimension (mm); keeps geometry valid while dragging through zero. */
export const MIN_SIZE = 0.1;

const EPS = 1e-6;

export function entityQuaternion(e: Entity, target = new THREE.Quaternion()): THREE.Quaternion {
  return target.setFromEuler(new THREE.Euler(e.rotation[0] * DEG, e.rotation[1] * DEG, e.rotation[2] * DEG, 'XYZ'));
}

export function entityMatrix(e: Entity, target = new THREE.Matrix4()): THREE.Matrix4 {
  return target.compose(new THREE.Vector3(...e.position), entityQuaternion(e), new THREE.Vector3(1, 1, 1));
}

export function rotationFromQuaternion(q: THREE.Quaternion): Vec3 {
  const euler = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return [cleanAngle(euler.x / DEG), cleanAngle(euler.y / DEG), cleanAngle(euler.z / DEG)];
}

function cleanAngle(deg: number): number {
  const rounded = Math.round(deg * 1e6) / 1e6;
  return Object.is(rounded, -0) || Math.abs(rounded) < 1e-6 ? 0 : rounded;
}

export function cleanNumber(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Math.abs(rounded) < 1e-9 ? 0 : rounded;
}

export function cleanVec(v: THREE.Vector3): Vec3 {
  return [cleanNumber(v.x), cleanNumber(v.y), cleanNumber(v.z)];
}

// ---- geometry -------------------------------------------------------------

/** Mesh geometry in the entity's local frame. */
export function buildLocalGeometry(e: Entity): THREE.BufferGeometry {
  switch (e.kind) {
    case 'box': {
      const [x, y, z] = e.size.map((s) => Math.max(s, 0.001));
      return new THREE.BoxGeometry(x, y, z).translate(x / 2, y / 2, z / 2);
    }
    case 'cylinder': {
      const r = Math.max(e.radius, 0.001);
      const h = Math.max(e.height, 0.001);
      return new THREE.CylinderGeometry(r, r, h, Math.max(3, Math.round(e.segments)))
        .rotateX(Math.PI / 2)
        .translate(0, 0, h / 2);
    }
    case 'extrusion': {
      const shape = new THREE.Shape(e.points.map(([x, y]) => new THREE.Vector2(x, y)));
      return new THREE.ExtrudeGeometry(shape, {
        depth: Math.max(e.height, 0.001),
        bevelEnabled: false,
        steps: 1,
      });
    }
  }
}

export function localBounds(e: Entity): THREE.Box3 {
  switch (e.kind) {
    case 'box':
      return new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(...e.size));
    case 'cylinder':
      return new THREE.Box3(
        new THREE.Vector3(-e.radius, -e.radius, 0),
        new THREE.Vector3(e.radius, e.radius, e.height),
      );
    case 'extrusion': {
      const box = new THREE.Box3();
      for (const [x, y] of e.points) {
        box.expandByPoint(new THREE.Vector3(x, y, 0));
        box.expandByPoint(new THREE.Vector3(x, y, e.height));
      }
      return box;
    }
  }
}

export function worldBounds(e: Entity): THREE.Box3 {
  return localBounds(e).applyMatrix4(entityMatrix(e));
}

export function worldBoundsOf(entities: Entity[]): THREE.Box3 {
  const box = new THREE.Box3();
  for (const e of entities) box.union(worldBounds(e));
  return box;
}

/** Corners of the local bounding box, transformed to world space. */
export function worldBoundsCorners(e: Entity): THREE.Vector3[] {
  const b = localBounds(e);
  const m = entityMatrix(e);
  const out: THREE.Vector3[] = [];
  for (const x of [b.min.x, b.max.x])
    for (const y of [b.min.y, b.max.y])
      for (const z of [b.min.z, b.max.z]) out.push(new THREE.Vector3(x, y, z).applyMatrix4(m));
  return out;
}

// ---- snapping -------------------------------------------------------------

export type SnapKind = 'endpoint' | 'midpoint' | 'center';

export interface SnapPoint {
  point: THREE.Vector3;
  kind: SnapKind;
  entityId: string;
}

/** Inference points (corners, edge midpoints, centres) in world space. */
export function snapPoints(e: Entity): SnapPoint[] {
  const local: { p: THREE.Vector3; kind: SnapKind }[] = [];
  const add = (x: number, y: number, z: number, kind: SnapKind) => local.push({ p: new THREE.Vector3(x, y, z), kind });

  if (e.kind === 'box') {
    const [sx, sy, sz] = e.size;
    const xs = [0, sx];
    const ys = [0, sy];
    const zs = [0, sz];
    for (const x of xs) for (const y of ys) for (const z of zs) add(x, y, z, 'endpoint');
    for (const y of ys) for (const z of zs) add(sx / 2, y, z, 'midpoint');
    for (const x of xs) for (const z of zs) add(x, sy / 2, z, 'midpoint');
    for (const x of xs) for (const y of ys) add(x, y, sz / 2, 'midpoint');
    add(sx / 2, sy / 2, sz, 'center');
    add(sx / 2, sy / 2, 0, 'center');
  } else if (e.kind === 'cylinder') {
    for (const z of [0, e.height]) {
      add(0, 0, z, 'center');
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2;
        add(Math.cos(a) * e.radius, Math.sin(a) * e.radius, z, 'endpoint');
      }
    }
  } else {
    const pts = e.points;
    for (const z of [0, e.height]) {
      for (let i = 0; i < pts.length; i++) {
        const [x, y] = pts[i];
        const [nx, ny] = pts[(i + 1) % pts.length];
        add(x, y, z, 'endpoint');
        add((x + nx) / 2, (y + ny) / 2, z, 'midpoint');
      }
    }
    for (const [x, y] of pts) add(x, y, e.height / 2, 'midpoint');
  }

  const m = entityMatrix(e);
  return local.map(({ p, kind }) => ({ point: p.applyMatrix4(m), kind, entityId: e.id }));
}

// ---- faces & push/pull ----------------------------------------------------

export type FaceRef =
  | { kind: 'box'; axis: 0 | 1 | 2; sign: 1 | -1 }
  | { kind: 'cap'; top: boolean }
  | { kind: 'side' };

/**
 * Identify which parametric face of an entity a local-space hit lies on.
 * Returns null for faces that can't be push/pulled (e.g. walls of a cut hole).
 */
export function classifyFace(e: Entity, localNormal: THREE.Vector3, localPoint: THREE.Vector3): FaceRef | null {
  const n = localNormal;
  const p = localPoint;
  const tol = 1e-3 + 1e-6 * Math.abs(p.length());
  if (e.kind === 'box') {
    const comps = [n.x, n.y, n.z];
    const axis = comps.reduce((best, v, i) => (Math.abs(v) > Math.abs(comps[best]) ? i : best), 0) as 0 | 1 | 2;
    if (Math.abs(comps[axis]) < 0.999) return null;
    const sign = comps[axis] > 0 ? 1 : -1;
    const coord = [p.x, p.y, p.z][axis];
    const expected = sign > 0 ? e.size[axis] : 0;
    return Math.abs(coord - expected) < tol ? { kind: 'box', axis, sign } : null;
  }
  if (n.z > 0.999 && Math.abs(p.z - e.height) < tol) return { kind: 'cap', top: true };
  if (n.z < -0.999 && Math.abs(p.z) < tol) return { kind: 'cap', top: false };
  if (e.kind === 'cylinder' && Math.abs(n.z) < 0.01) {
    const facetTol = e.radius * (1 - Math.cos(Math.PI / Math.max(3, e.segments))) + 1e-2;
    if (Math.abs(Math.hypot(p.x, p.y) - e.radius) <= facetTol) return { kind: 'side' };
  }
  return null;
}

export function faceLabel(face: FaceRef): string {
  if (face.kind === 'box') return `${face.sign > 0 ? '+' : '−'}${'XYZ'[face.axis]} face`;
  if (face.kind === 'cap') return face.top ? 'Top' : 'Bottom';
  return 'Radius';
}

/**
 * Apply a push/pull offset (mm, positive = outward) to `target`, starting from `orig`.
 * Both are the same entity; `orig` is an untouched copy taken at drag start.
 */
export function applyPushPull(orig: Entity, target: Entity, face: FaceRef, distance: number): void {
  const q = entityQuaternion(orig);
  const shiftAlongLocal = (axis: THREE.Vector3, amount: number) => {
    const offset = axis.clone().applyQuaternion(q).multiplyScalar(amount);
    target.position = cleanVec(new THREE.Vector3(...orig.position).add(offset));
  };

  if (face.kind === 'box' && orig.kind === 'box' && target.kind === 'box') {
    const size = Math.max(MIN_SIZE, orig.size[face.axis] + distance);
    const grown = size - orig.size[face.axis];
    target.size = [...orig.size] as Vec3;
    target.size[face.axis] = cleanNumber(size);
    const axis = new THREE.Vector3().setComponent(face.axis, 1);
    shiftAlongLocal(axis, face.sign < 0 ? -grown : 0);
  } else if (face.kind === 'cap' && orig.kind !== 'box' && target.kind !== 'box') {
    const height = Math.max(MIN_SIZE, orig.height + distance);
    target.height = cleanNumber(height);
    shiftAlongLocal(new THREE.Vector3(0, 0, 1), face.top ? 0 : -(height - orig.height));
  } else if (face.kind === 'side' && orig.kind === 'cylinder' && target.kind === 'cylinder') {
    target.radius = cleanNumber(Math.max(MIN_SIZE, orig.radius + distance));
  }
}

// ---- drawing planes -------------------------------------------------------

/** A plane with an orthonormal, right-handed basis (u × v = n). */
export interface DrawPlane {
  origin: THREE.Vector3;
  u: THREE.Vector3;
  v: THREE.Vector3;
  n: THREE.Vector3;
}

export function groundPlane(z = 0): DrawPlane {
  return {
    origin: new THREE.Vector3(0, 0, z),
    u: new THREE.Vector3(1, 0, 0),
    v: new THREE.Vector3(0, 1, 0),
    n: new THREE.Vector3(0, 0, 1),
  };
}

/** Plane through `origin` perpendicular to an arbitrary normal. */
export function planeFromNormal(origin: THREE.Vector3, normal: THREE.Vector3): DrawPlane {
  const n = normal.clone().normalize();
  const ref = Math.abs(n.z) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
  // Keep u horizontal for vertical planes, so drawing on a wall feels natural.
  const u = Math.abs(n.z) > 0.9 ? ref.clone().sub(n.clone().multiplyScalar(ref.dot(n))).normalize() : ref.clone().cross(n).normalize();
  const v = n.clone().cross(u).normalize();
  return { origin: origin.clone(), u, v, n };
}

/**
 * Plane of an entity face. For flat axis-aligned (local) faces the basis follows the
 * entity's own axes, so boxes drawn on a rotated object line up with it.
 */
export function planeFromFace(e: Entity, localNormal: THREE.Vector3, worldPoint: THREE.Vector3): DrawPlane {
  const q = entityQuaternion(e);
  const comps = [localNormal.x, localNormal.y, localNormal.z];
  const axis = comps.reduce((best, v, i) => (Math.abs(v) > Math.abs(comps[best]) ? i : best), 0);
  if (Math.abs(comps[axis]) < 0.999) {
    return planeFromNormal(worldPoint, localNormal.clone().applyQuaternion(q));
  }
  const sign = comps[axis] > 0 ? 1 : -1;
  const unit = (i: number) => new THREE.Vector3().setComponent(i, 1);
  let u = unit((axis + 1) % 3);
  let v = unit((axis + 2) % 3).multiplyScalar(sign);
  let n = unit(axis).multiplyScalar(sign);
  // Prefer a basis where u is horizontal-ish so "width" means what people expect.
  if (axis === 0) {
    // +X face: (Y, Z) is already natural.
  } else if (axis === 1) {
    // +Y face: default (Z, X); swap to (X, Z) with matching handedness.
    u = unit(0).multiplyScalar(-sign);
    v = unit(2);
  }
  u.applyQuaternion(q);
  v.applyQuaternion(q);
  n.applyQuaternion(q);
  return { origin: worldPoint.clone(), u: snapUnit(u), v: snapUnit(v), n: snapUnit(n) };
}

/** Remove floating-point noise from nearly axis-aligned unit vectors. */
function snapUnit(v: THREE.Vector3): THREE.Vector3 {
  const r = (x: number) => (Math.abs(x) < 1e-9 ? 0 : Math.abs(Math.abs(x) - 1) < 1e-9 ? Math.sign(x) : x);
  return new THREE.Vector3(r(v.x), r(v.y), r(v.z)).normalize();
}

export function isAxisAligned(v: THREE.Vector3): boolean {
  return Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)) > 1 - 1e-6;
}

export function planeIsAxisAligned(plane: DrawPlane): boolean {
  return isAxisAligned(plane.u) && isAxisAligned(plane.v) && isAxisAligned(plane.n);
}

export function rotationFromBasis(u: THREE.Vector3, v: THREE.Vector3, n: THREE.Vector3): Vec3 {
  const m = new THREE.Matrix4().makeBasis(u, v, n);
  return rotationFromQuaternion(new THREE.Quaternion().setFromRotationMatrix(m));
}

/** Convert a world point to (u, v) coordinates on the plane. */
export function toPlane(plane: DrawPlane, p: THREE.Vector3): THREE.Vector2 {
  const d = p.clone().sub(plane.origin);
  return new THREE.Vector2(d.dot(plane.u), d.dot(plane.v));
}

export function fromPlane(plane: DrawPlane, u: number, v: number, n = 0): THREE.Vector3 {
  return plane.origin
    .clone()
    .addScaledVector(plane.u, u)
    .addScaledVector(plane.v, v)
    .addScaledVector(plane.n, n);
}

export function projectToPlane(plane: DrawPlane, p: THREE.Vector3): THREE.Vector3 {
  const d = p.clone().sub(plane.origin).dot(plane.n);
  return p.clone().addScaledVector(plane.n, -d);
}

export function intersectRayPlane(ray: THREE.Ray, plane: DrawPlane): THREE.Vector3 | null {
  const p = new THREE.Plane().setFromNormalAndCoplanarPoint(plane.n, plane.origin);
  const denom = plane.n.dot(ray.direction);
  if (Math.abs(denom) < EPS) return null;
  return ray.intersectPlane(p, new THREE.Vector3());
}

/**
 * Box spanned by a rectangle on a plane (corner `p1`, extents `a` along u and `b` along v)
 * extruded `h` along the plane normal. Negative extents are fine.
 * If the plane is world-axis-aligned the result has zero rotation, which keeps the
 * numbers in the properties panel readable (important for cut lists).
 */
export function boxFromRect(
  plane: DrawPlane,
  p1: THREE.Vector3,
  a: number,
  b: number,
  h: number,
): Pick<BoxEntity, 'position' | 'size' | 'rotation'> {
  if (planeIsAxisAligned(plane)) {
    const box = new THREE.Box3();
    for (const da of [0, a])
      for (const db of [0, b])
        for (const dh of [0, h])
          box.expandByPoint(p1.clone().addScaledVector(plane.u, da).addScaledVector(plane.v, db).addScaledVector(plane.n, dh));
    const size = box.getSize(new THREE.Vector3());
    return { position: cleanVec(box.min), size: cleanVec(size), rotation: [0, 0, 0] };
  }
  const origin = p1
    .clone()
    .addScaledVector(plane.u, Math.min(a, 0))
    .addScaledVector(plane.v, Math.min(b, 0))
    .addScaledVector(plane.n, Math.min(h, 0));
  return {
    position: cleanVec(origin),
    size: [cleanNumber(Math.abs(a)), cleanNumber(Math.abs(b)), cleanNumber(Math.abs(h))],
    rotation: rotationFromBasis(plane.u, plane.v, plane.n),
  };
}

/** Cylinder standing on `plane` at `center`, extruded `h` along the normal (may be negative). */
export function cylinderFromPlane(
  plane: DrawPlane,
  center: THREE.Vector3,
  radius: number,
  h: number,
): Pick<CylinderEntity, 'position' | 'radius' | 'height' | 'rotation'> {
  const base = center.clone().addScaledVector(plane.n, Math.min(h, 0));
  const up = plane.n;
  const rotation: Vec3 =
    up.z > 1 - 1e-9 ? [0, 0, 0] : rotationFromBasis(plane.u, plane.v, plane.n);
  return {
    position: cleanVec(base),
    radius: cleanNumber(Math.abs(radius)),
    height: cleanNumber(Math.abs(h)),
    rotation,
  };
}

/** Extrusion of a polygon given in plane (u, v) coordinates, relative to `plane.origin`. */
export function extrusionFromPlane(
  plane: DrawPlane,
  points: THREE.Vector2[],
  h: number,
): Pick<ExtrusionEntity, 'position' | 'points' | 'height' | 'rotation'> {
  const base = plane.origin.clone().addScaledVector(plane.n, Math.min(h, 0));
  const rotation: Vec3 = plane.n.z > 1 - 1e-9 && plane.u.x > 1 - 1e-9 ? [0, 0, 0] : rotationFromBasis(plane.u, plane.v, plane.n);
  return {
    position: cleanVec(base),
    points: points.map((p) => [cleanNumber(p.x), cleanNumber(p.y)]),
    height: cleanNumber(Math.abs(h)),
    rotation,
  };
}

/** Signed area of a 2D polygon (positive = counter-clockwise). */
export function polygonArea(points: { x: number; y: number }[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

/**
 * Closest point on an infinite line (through `origin` along unit `dir`) to a ray.
 * Returns the signed distance along the line, or null if ray and line are parallel.
 */
export function closestOnLineToRay(origin: THREE.Vector3, dir: THREE.Vector3, ray: THREE.Ray): number | null {
  const w0 = ray.origin.clone().sub(origin);
  const b = ray.direction.dot(dir);
  const denom = 1 - b * b;
  if (denom < 1e-6) return null;
  const d = ray.direction.dot(w0);
  const e = dir.dot(w0);
  return (e - b * d) / denom;
}
