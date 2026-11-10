import * as THREE from 'three';

const PRECISION = 1e4;

interface EdgeInfo {
  a: THREE.Vector3;
  b: THREE.Vector3;
  normals: THREE.Vector3[];
}

/**
 * SketchUp-style outline edges: creases sharper than `thresholdDeg` plus open boundaries.
 *
 * Unlike THREE.EdgesGeometry this tolerates T-junctions (common in CSG output): an edge
 * with only one adjacent triangle is dropped if another unmatched, collinear, overlapping
 * edge from a coplanar triangle covers it, i.e. it's just a seam inside a flat face.
 */
export function featureEdges(geometry: THREE.BufferGeometry, thresholdDeg = 25): THREE.BufferGeometry {
  const pos = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : pos.count / 3;
  const cosT = Math.cos((thresholdDeg * Math.PI) / 180);
  const vi = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
  const key = (v: THREE.Vector3) => `${Math.round(v.x * PRECISION)},${Math.round(v.y * PRECISION)},${Math.round(v.z * PRECISION)}`;

  const edges = new Map<string, EdgeInfo>();
  const tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) tri[k].fromBufferAttribute(pos, vi(t, k));
    ab.subVectors(tri[1], tri[0]);
    ac.subVectors(tri[2], tri[0]);
    const n = new THREE.Vector3().crossVectors(ab, ac);
    if (n.lengthSq() < 1e-14) continue; // degenerate sliver
    n.normalize();
    const keys = tri.map(key);
    for (let k = 0; k < 3; k++) {
      const k1 = keys[k];
      const k2 = keys[(k + 1) % 3];
      if (k1 === k2) continue;
      const id = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
      let e = edges.get(id);
      if (!e) {
        e = { a: tri[k].clone(), b: tri[(k + 1) % 3].clone(), normals: [] };
        edges.set(id, e);
      }
      e.normals.push(n);
    }
  }

  const out: number[] = [];
  const push = (e: { a: THREE.Vector3; b: THREE.Vector3 }) => out.push(e.a.x, e.a.y, e.a.z, e.b.x, e.b.y, e.b.z);
  const open: { a: THREE.Vector3; b: THREE.Vector3; n: THREE.Vector3; dir: THREE.Vector3; len: number }[] = [];

  for (const e of edges.values()) {
    if (e.normals.length >= 2) {
      // Crease if any pair of adjacent faces bends more than the threshold.
      if (e.normals[0].dot(e.normals[1]) < cosT) push(e);
    } else {
      const dir = e.b.clone().sub(e.a);
      const len = dir.length();
      if (len > 1e-9) open.push({ a: e.a, b: e.b, n: e.normals[0], dir: dir.divideScalar(len), len });
    }
  }

  // Resolve T-junction seams among unmatched edges.
  const eps = 1e-3;
  const tmp = new THREE.Vector3();
  const distToLine = (p: THREE.Vector3, o: THREE.Vector3, d: THREE.Vector3) => {
    tmp.subVectors(p, o);
    return tmp.sub(d.clone().multiplyScalar(tmp.dot(d))).length();
  };
  for (const u of open) {
    let seam = false;
    for (const w of open) {
      if (w === u || u.n.dot(w.n) < cosT) continue;
      if (Math.abs(u.dir.dot(w.dir)) < 0.9999) continue;
      if (distToLine(w.a, u.a, u.dir) > eps || distToLine(w.b, u.a, u.dir) > eps) continue;
      const ta = tmp.subVectors(w.a, u.a).dot(u.dir);
      const tb = tmp.subVectors(w.b, u.a).dot(u.dir);
      const overlap = Math.min(u.len, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb));
      if (overlap > eps) {
        seam = true;
        break;
      }
    }
    if (!seam) push(u);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  return g;
}
