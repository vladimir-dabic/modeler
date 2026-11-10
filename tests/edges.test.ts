import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildCutGeometry } from '../src/model/csg';
import type { BoxEntity, CylinderEntity } from '../src/model/types';
import { featureEdges } from '../src/viewport/edges';

const board: BoxEntity = {
  id: 'b', name: 'Board', kind: 'box', position: [0, 0, 0], rotation: [0, 0, 0],
  size: [300, 300, 18], color: '#fff', hole: false, visible: true,
};
// Flush with the top face, exactly what "push a circle into a face" creates.
const hole: CylinderEntity = {
  id: 'h', name: 'Hole', kind: 'cylinder', position: [150, 150, -40], rotation: [0, 0, 0],
  radius: 5, height: 58, segments: 32, color: '#fff', hole: true, visible: true,
};

function segments(g: THREE.BufferGeometry): [THREE.Vector3, THREE.Vector3][] {
  const p = g.getAttribute('position');
  const out: [THREE.Vector3, THREE.Vector3][] = [];
  for (let i = 0; i < p.count; i += 2) out.push([new THREE.Vector3().fromBufferAttribute(p, i), new THREE.Vector3().fromBufferAttribute(p, i + 1)]);
  return out;
}

describe('featureEdges', () => {
  it('a plain box has exactly its 12 edges', () => {
    const g = new THREE.BoxGeometry(10, 20, 30);
    expect(segments(featureEdges(g))).toHaveLength(12);
  });

  it('a smooth cylinder shows only its two rims', () => {
    const g = new THREE.CylinderGeometry(5, 5, 10, 48);
    expect(segments(featureEdges(g))).toHaveLength(96);
  });

  it('CSG seams inside flat faces are not drawn', () => {
    const { geometry, failed } = buildCutGeometry(board, [hole]);
    expect(failed).toBe(false);
    const segs = segments(featureEdges(geometry));
    const onOutline = (p: THREE.Vector3) =>
      [0, 300].some((v) => Math.abs(p.x - v) < 1e-3 || Math.abs(p.y - v) < 1e-3);
    const onRim = (p: THREE.Vector3) => Math.abs(Math.hypot(p.x - 150, p.y - 150) - 5) < 0.05;
    for (const [a, b] of segs) {
      const mid = a.clone().add(b).multiplyScalar(0.5);
      // Every edge is either the board outline or the hole's rim / wall.
      expect(onOutline(mid) || onRim(a) || onRim(b)).toBe(true);
    }
    // The hole goes all the way through: rim edges on both faces.
    expect(segs.some(([a]) => onRim(a) && Math.abs(a.z - 18) < 1e-3)).toBe(true);
    expect(segs.some(([a]) => onRim(a) && Math.abs(a.z) < 1e-3)).toBe(true);
  });
});
