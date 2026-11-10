import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  applyPushPull,
  boxFromRect,
  classifyFace,
  closestOnLineToRay,
  cylinderFromPlane,
  groundPlane,
  planeFromFace,
  snapPoints,
  worldBounds,
} from '../src/model/geometry';
import type { BoxEntity, CylinderEntity } from '../src/model/types';

const box = (over: Partial<BoxEntity> = {}): BoxEntity => ({
  id: 'b',
  name: 'Box 1',
  kind: 'box',
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  size: [100, 50, 20],
  color: '#ffffff',
  hole: false,
  visible: true,
  ...over,
});

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('boxFromRect', () => {
  it('normalises negative drags on the ground', () => {
    const r = boxFromRect(groundPlane(), v(10, 10, 0), -30, 20, 5);
    expect(r.position).toEqual([-20, 10, 0]);
    expect(r.size).toEqual([30, 20, 5]);
    expect(r.rotation).toEqual([0, 0, 0]);
  });

  it('builds an axis-aligned box when drawing on a side face', () => {
    const b = box();
    // +X face at x = 100
    const plane = planeFromFace(b, v(1, 0, 0), v(100, 10, 5));
    const r = boxFromRect(plane, v(100, 10, 5), 20, 10, 30);
    expect(r.rotation).toEqual([0, 0, 0]);
    expect(r.position).toEqual([100, 10, 5]);
    expect(r.size).toEqual([30, 20, 10]);
  });

  it('drawing downward into a top face goes below it', () => {
    const plane = planeFromFace(box(), v(0, 0, 1), v(10, 10, 20));
    const r = boxFromRect(plane, v(10, 10, 20), 5, 5, -8);
    expect(r.position[2]).toBe(12);
    expect(r.size[2]).toBe(8);
  });
});

describe('planeFromFace', () => {
  it('produces a right-handed basis for every box face', () => {
    const b = box({ rotation: [0, 0, 30] });
    for (const n of [v(1, 0, 0), v(-1, 0, 0), v(0, 1, 0), v(0, -1, 0), v(0, 0, 1), v(0, 0, -1)]) {
      const p = planeFromFace(b, n, v(0, 0, 0));
      const cross = p.u.clone().cross(p.v);
      expect(cross.distanceTo(p.n)).toBeLessThan(1e-9);
      const expectedN = n.clone().applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, (30 * Math.PI) / 180)));
      expect(p.n.distanceTo(expectedN)).toBeLessThan(1e-9);
    }
  });
});

describe('classifyFace + applyPushPull', () => {
  it('identifies outer faces of a box and rejects interior ones', () => {
    const b = box();
    expect(classifyFace(b, v(1, 0, 0), v(100, 10, 10))).toEqual({ kind: 'box', axis: 0, sign: 1 });
    expect(classifyFace(b, v(0, 0, -1), v(10, 10, 0))).toEqual({ kind: 'box', axis: 2, sign: -1 });
    // A hole wall facing +X but inside the box is not push/pullable.
    expect(classifyFace(b, v(1, 0, 0), v(40, 10, 10))).toBeNull();
  });

  it('grows the positive face in place', () => {
    const orig = box();
    const target = structuredClone(orig);
    applyPushPull(orig, target, { kind: 'box', axis: 0, sign: 1 }, 25);
    expect(target.size).toEqual([125, 50, 20]);
    expect(target.position).toEqual([0, 0, 0]);
  });

  it('moves the origin when pulling a negative face', () => {
    const orig = box();
    const target = structuredClone(orig);
    applyPushPull(orig, target, { kind: 'box', axis: 2, sign: -1 }, 10);
    expect(target.size).toEqual([100, 50, 30]);
    expect(target.position).toEqual([0, 0, -10]);
  });

  it('respects rotation when shifting the origin', () => {
    const orig = box({ rotation: [0, 0, 90] });
    const target = structuredClone(orig);
    applyPushPull(orig, target, { kind: 'box', axis: 0, sign: -1 }, 10);
    // Local -X is world -Y after a 90° turn about Z.
    expect(target.position[0]).toBeCloseTo(0);
    expect(target.position[1]).toBeCloseTo(-10);
  });

  it('never collapses below the minimum size', () => {
    const orig = box();
    const target = structuredClone(orig);
    applyPushPull(orig, target, { kind: 'box', axis: 1, sign: 1 }, -500);
    expect(target.size[1]).toBeGreaterThan(0);
  });

  it('handles cylinder caps and sides', () => {
    const cyl: CylinderEntity = {
      id: 'c', name: 'Cylinder 1', kind: 'cylinder', position: [0, 0, 0], rotation: [0, 0, 0],
      radius: 10, height: 30, segments: 64, color: '#fff', hole: false, visible: true,
    };
    expect(classifyFace(cyl, v(0, 0, 1), v(2, 2, 30))).toEqual({ kind: 'cap', top: true });
    expect(classifyFace(cyl, v(1, 0, 0), v(10, 0, 15))).toEqual({ kind: 'side' });
    const t = structuredClone(cyl);
    applyPushPull(cyl, t, { kind: 'cap', top: false }, 5);
    expect(t.height).toBe(35);
    expect(t.position).toEqual([0, 0, -5]);
    applyPushPull(cyl, t, { kind: 'side' }, 2);
    expect(t.radius).toBe(12);
  });
});

describe('cylinderFromPlane', () => {
  it('flips a negative height below the plane', () => {
    const r = cylinderFromPlane(groundPlane(20), v(5, 5, 20), 3, -10);
    expect(r.position).toEqual([5, 5, 10]);
    expect(r.height).toBe(10);
    expect(r.rotation).toEqual([0, 0, 0]);
  });
});

describe('bounds and snap points', () => {
  it('rotated bounds are correct', () => {
    const b = worldBounds(box({ rotation: [0, 0, 90] }));
    expect(b.min.x).toBeCloseTo(-50);
    expect(b.max.y).toBeCloseTo(100);
  });

  it('a box has 8 corners, 12 midpoints and 2 face centres', () => {
    const pts = snapPoints(box());
    expect(pts.filter((p) => p.kind === 'endpoint')).toHaveLength(8);
    expect(pts.filter((p) => p.kind === 'midpoint')).toHaveLength(12);
    expect(pts.filter((p) => p.kind === 'center')).toHaveLength(2);
  });
});

describe('closestOnLineToRay', () => {
  it('finds the parameter along the line', () => {
    const ray = new THREE.Ray(v(10, -100, 25), v(0, 1, 0));
    expect(closestOnLineToRay(v(10, 0, 0), v(0, 0, 1), ray)).toBeCloseTo(25);
  });

  it('returns null for parallel lines', () => {
    const ray = new THREE.Ray(v(0, 0, 100), v(0, 0, -1));
    expect(closestOnLineToRay(v(0, 0, 0), v(0, 0, 1), ray)).toBeNull();
  });
});
