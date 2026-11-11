import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ModelerApi } from '../src/api';
import { buildCutList } from '../src/model/cutlist';
import { ModelDocument } from '../src/model/Document';
import { buildLocalGeometry, localBounds, mirrorEntity, snapPoints } from '../src/model/geometry';
import { exportStl, parseDocumentFile } from '../src/model/io';
import { solidVolumes } from '../src/model/quantities';
import { lathePath, signedVolume, tubeSamples } from '../src/model/shapes';
import type { Entity } from '../src/model/types';

const base = { id: 'x', name: 'X', position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], color: '#cccccc', hole: false, visible: true };
const volume = (e: Entity) => signedVolume(buildLocalGeometry(e));
const PI = Math.PI;

describe('round and smooth shapes are closed, outward solids', () => {
  it('cones and frusta', () => {
    const cone: Entity = { ...base, kind: 'cylinder', radius: 10, radiusTop: 0, height: 30, segments: 128 };
    expect(volume(cone)).toBeCloseTo((PI * 100 * 30) / 3, -1);
    const frustum: Entity = { ...base, kind: 'cylinder', radius: 10, radiusTop: 5, height: 30, segments: 128 };
    expect(volume(frustum)).toBeCloseTo((PI * 30 * (100 + 50 + 25)) / 3, -1);
    // Pointed at the base (a mirrored cone) is valid too.
    expect(volume({ ...base, kind: 'cylinder', radius: 0, radiusTop: 10, height: 30, segments: 128 })).toBeCloseTo((PI * 100 * 30) / 3, -1);
    expect(snapPoints(cone).some((p) => p.point.equals(new THREE.Vector3(0, 0, 30)) && p.kind === 'endpoint')).toBe(true);
    expect(localBounds({ ...frustum, radius: 4, radiusTop: 12 }).max.x).toBe(12);
  });

  it('spheres and ellipsoids', () => {
    const v = volume({ ...base, kind: 'sphere', radii: [10, 10, 10], segments: 96 });
    expect(v / ((4 / 3) * PI * 1000)).toBeGreaterThan(0.99);
    expect(v / ((4 / 3) * PI * 1000)).toBeLessThanOrEqual(1);
    const egg: Entity = { ...base, kind: 'sphere', radii: [10, 20, 30], segments: 96 };
    expect(volume(egg) / ((4 / 3) * PI * 6000)).toBeGreaterThan(0.99);
    expect(localBounds(egg).max.toArray()).toEqual([10, 20, 30]);
  });

  it('revolves: closed at the axis, rings without it, either winding', () => {
    // A 10 × 20 cylinder drawn as a profile, both ways round.
    const ccw: Entity = { ...base, kind: 'revolve', profile: [[0, 0], [10, 0], [10, 20], [0, 20]], segments: 128 };
    const cw: Entity = { ...ccw, profile: [[0, 20], [10, 20], [10, 0], [0, 0]] };
    for (const e of [ccw, cw]) expect(volume(e)).toBeCloseTo(PI * 100 * 20, -1);
    // The axis edge is opened: the lathe runs axis → outside → axis.
    expect(lathePath([[0, 0], [10, 0], [10, 20], [0, 20]])).toEqual([[0, 0], [10, 0], [10, 20], [0, 20]]);
    expect(lathePath([[10, 0], [10, 20], [0, 20], [0, 0]])).toEqual([[0, 0], [10, 0], [10, 20], [0, 20]]);
    // A square cross-section off the axis: a ring (washer), volume = 2π·R·A.
    const ring: Entity = { ...base, kind: 'revolve', profile: [[20, 0], [30, 0], [30, 10], [20, 10]], segments: 256 };
    expect(volume(ring)).toBeCloseTo(PI * (900 - 400) * 10, -1);
  });

  it('tubes: straight volume, smooth through every point, tapering', () => {
    const straight: Entity = { ...base, kind: 'tube', path: [[0, 0, 0], [0, 0, 100]], radius: 5, smooth: true, segments: 128 };
    expect(volume(straight)).toBeCloseTo(PI * 25 * 100, -1);
    const curve: Entity = { ...base, kind: 'tube', path: [[0, 0, 0], [50, 0, 20], [100, 30, 0], [120, 80, 10]], radius: 3, smooth: true, segments: 24 };
    const { points } = tubeSamples(curve);
    for (const p of curve.path) expect(points.some((q) => q.distanceTo(new THREE.Vector3(...p)) < 1e-6)).toBe(true);
    expect(volume(curve)).toBeGreaterThan(0);
    const cone: Entity = { ...base, kind: 'tube', path: [[0, 0, 0], [0, 0, 90]], radius: 9, radii: [9, 0.001], smooth: false, segments: 128 };
    expect(volume(cone)).toBeCloseTo((PI * 81 * 90) / 3, -1);
    // A sharp L-bend with straight segments is still a closed, outward solid.
    expect(volume({ ...base, kind: 'tube', path: [[0, 0, 0], [50, 0, 0], [50, 50, 0]], radius: 4, smooth: false, segments: 32 })).toBeGreaterThan(0);
  });

  it('rounded boxes keep their bounds and lose a little volume', () => {
    const sharp: Entity = { ...base, kind: 'box', size: [40, 30, 20] };
    const round: Entity = { ...sharp, edgeRadius: 3 };
    expect(localBounds(round).max.toArray()).toEqual([40, 30, 20]);
    const geo = buildLocalGeometry(round);
    geo.computeBoundingBox();
    expect(geo.boundingBox!.min.toArray().map((v) => Math.abs(v) < 1e-6)).toEqual([true, true, true]);
    const v = signedVolume(geo);
    expect(v).toBeLessThan(24000);
    expect(v).toBeGreaterThan(24000 - 1000);
  });
});

describe('API for round and smooth parts', () => {
  const setup = () => new ModelerApi(new ModelDocument());
  const ok = (r: any) => {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r;
  };

  it('adds each kind with compact descriptions', () => {
    const api = setup();
    ok(api.call('add_cylinder', { name: 'Countersink', position: [0, 0, 0], diameter: 3.4, diameter_top: 6.5, height: 2, hole: true }));
    ok(api.call('add_cylinder', { name: 'Spike', radius: 5, radius_top: 0, height: 20 }));
    ok(api.call('add_sphere', { name: 'Head', position: [0, 0, 50], diameter: 40 }));
    ok(api.call('add_sphere', { name: 'Body', position: [0, 0, 0], radii: [30, 20, 15] }));
    ok(api.call('add_revolve', { name: 'Cup', profile: [[0, 0], [40, 0], [45, 90], [42, 90], [37, 4], [0, 4]] }));
    ok(api.call('add_tube', { name: 'Tail', path: [[100, 0, 10], [130, 0, 30], [150, 20, 50]], radii: [6, 4, 1] }));
    ok(api.call('add_box', { name: 'Case', size: [60, 40, 20], edge_radius: 3 }));
    const lines = (api.call('get_scene') as any).data.lines.join('\n');
    expect(lines).toMatch(/"Countersink" cone ø3.4→ø6.5×2 at 0,0,0 \[hole\]/);
    expect(lines).toMatch(/"Spike" cone ø10→ø0×20/);
    expect(lines).toMatch(/"Head" sphere ø40 at 0,0,50/);
    expect(lines).toMatch(/"Body" ellipsoid 60×40×30/);
    expect(lines).toMatch(/"Cup" revolve ø90×90 6pt/);
    expect(lines).toMatch(/"Tail" tube ø2–12 \d+(\.\d+)? long 3pt at 100,0,10/);
    expect(lines).toMatch(/"Case" box 60×40×20 r3/);
    // Tube paths are stored relative to their first point.
    const tail = api.doc.entities.find((e) => e.name === 'Tail')!;
    expect(tail.kind === 'tube' && tail.path[0]).toEqual([0, 0, 0]);
  });

  it('validates with clear errors', () => {
    const api = setup();
    const bad = (name: string, input: unknown, pattern: RegExp) => {
      const r = api.call(name, input);
      expect(r.ok, name).toBe(false);
      expect(!r.ok && `${r.error.message} ${r.error.hint ?? ''}`).toMatch(pattern);
    };
    bad('add_box', { size: [10, 10, 4], edge_radius: 3 }, /too large/);
    bad('add_revolve', { profile: [[0, 0], [-5, 0], [0, 10]] }, /radius ≥ 0/);
    bad('add_tube', { path: [[0, 0, 0], [0, 0, 0]], radius: 2 }, /same/);
    bad('add_tube', { path: [[0, 0, 0], [0, 0, 10]], radii: [1, 2, 3] }, /one radius per point/);
    bad('add_sphere', { radius: 5, radii: [1, 2, 3] }, /exactly one/);
    ok(api.call('add_sphere', { name: 'Ball', radius: 5 }));
    const ball = api.doc.entities[0].id;
    bad('update_entity', { id: ball, set: { height: 3 } }, /height only applies to cylinders and shapes/);
    bad('update_entity', { id: ball, set: { radii: [1, 2] } }, /\[x, y, z\]/);
    expect(api.doc.entities).toHaveLength(1);
  });

  it('updates each kind', () => {
    const api = setup();
    ok(api.call('add_cylinder', { name: 'C', radius: 10, height: 20 }));
    ok(api.call('add_sphere', { name: 'S', radius: 10 }));
    ok(api.call('add_tube', { name: 'T', path: [[0, 0, 0], [0, 0, 50]], radius: 3 }));
    ok(api.call('add_box', { name: 'B', size: [20, 20, 20], edge_radius: 2 }));
    const id = (n: string) => api.doc.entities.find((e) => e.name === n)!.id;
    const get = (n: string) => api.doc.entities.find((e) => e.name === n) as any;
    ok(api.call('update_entity', { id: id('C'), set: { diameter_top: 0 } }));
    expect(get('C').radiusTop).toBe(0);
    ok(api.call('update_entity', { id: id('C'), set: { radius: 12 } })); // keeps the cone
    expect(get('C')).toMatchObject({ radius: 12, radiusTop: 0 });
    ok(api.call('update_entity', { id: id('C'), set: { radius_top: 12 } })); // equal → plain cylinder
    expect(get('C').radiusTop).toBeUndefined();
    ok(api.call('update_entity', { id: id('S'), set: { radii: [10, 10, 20] } }));
    expect(get('S').radii).toEqual([10, 10, 20]);
    ok(api.call('update_entity', { id: id('T'), set: { path: [[10, 10, 0], [10, 10, 40], [30, 10, 60]], radii: [3, 2, 1] } }));
    expect(get('T')).toMatchObject({ position: [10, 10, 0], path: [[0, 0, 0], [0, 0, 40], [20, 0, 60]], radii: [3, 2, 1] });
    ok(api.call('update_entity', { id: id('B'), set: { size: [20, 20, 3] } })); // shrinks the rounding to fit
    expect(get('B').edgeRadius).toBeLessThan(1.5);
    ok(api.call('update_entity', { id: id('B'), set: { edge_radius: 0 } }));
    expect(get('B').edgeRadius).toBeUndefined();
  });

  it('round-trips through files; mirroring a cone flips it', () => {
    const api = setup();
    ok(api.call('add_cylinder', { name: 'Cone', radius: 10, radius_top: 0, height: 30 }));
    ok(api.call('add_sphere', { name: 'S', radii: [5, 6, 7] }));
    ok(api.call('add_revolve', { name: 'R', profile: [[0, 0], [10, 0], [5, 10], [0, 10]] }));
    ok(api.call('add_tube', { name: 'T', path: [[0, 0, 0], [10, 0, 0], [10, 10, 5]], radii: [2, 3, 1], smooth: false }));
    ok(api.call('add_box', { name: 'B', size: [10, 10, 10], edge_radius: 1 }));
    const file = parseDocumentFile(JSON.stringify(api.doc.toFile()));
    expect(file.entities.map((e) => e.kind)).toEqual(['cylinder', 'sphere', 'revolve', 'tube', 'box']);
    expect(JSON.stringify(file.entities)).toBe(JSON.stringify(api.doc.entities));

    const cone = structuredClone(api.doc.entities[0]);
    mirrorEntity(cone, 2, 0);
    expect(cone.kind === 'cylinder' && [cone.radius, cone.radiusTop]).toEqual([0, 10]);
    expect(volume(cone) / ((PI * 100 * 30) / 3)).toBeGreaterThan(0.99);
  });

  it('cut, export and list like any other part', () => {
    const api = setup();
    ok(api.call('add_box', { name: 'Block', size: [40, 40, 20] }));
    ok(api.call('add_sphere', { name: 'Dimple', position: [20, 20, 20], radius: 10, hole: true }));
    ok(api.call('add_tube', { name: 'Handle', path: [[0, 20, 20], [20, 20, 40], [40, 20, 20]], radius: 3 }));
    const block = api.doc.entities[0];
    const v = solidVolumes([block], api.doc.entities, api.doc.groups).get(block.id)!;
    // A half-sphere is cut out of the top.
    expect(v).toBeCloseTo(40 * 40 * 20 - (2 / 3) * PI * 1000, -2);
    const stl = exportStl(api.doc.entities, api.doc.entities, api.doc.groups);
    expect(stl!.byteLength).toBeGreaterThan(84);
    const rows = buildCutList(api.doc.entities);
    expect(rows.some((r) => r.note === 'tube (bounding box)')).toBe(true);
  });
});
