import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ModelerApi } from '../src/api';
import { buildWorldGeometries } from '../src/model/csg';
import { ModelDocument } from '../src/model/Document';
import { groupMembers } from '../src/model/groups';
import { exportStl } from '../src/model/io';
import { fusedVolume } from '../src/model/quantities';
import { meshVolume } from '../src/model/workspaces';

const ok = (r: any) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.data;
};
const setup = () => new ModelerApi(new ModelDocument());
const PI = Math.PI;

/** Volume of an STL buffer (binary), mm³. */
function stlVolume(buf: ArrayBuffer): number {
  const v = new DataView(buf);
  const n = v.getUint32(80, true);
  let vol = 0;
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12;
    const p = [0, 1, 2].map((k) => new THREE.Vector3(v.getFloat32(o + k * 12, true), v.getFloat32(o + k * 12 + 4, true), v.getFloat32(o + k * 12 + 8, true)));
    vol += p[0].dot(p[1].clone().cross(p[2])) / 6;
  }
  return vol;
}

describe('holes scoped to their group', () => {
  it('cut only parts in their own group', () => {
    const api = setup();
    ok(api.call('apply_operations', {
      operations: [
        { name: 'add_box', input: { name: 'Lid', size: [40, 40, 10], position: [0, 0, 10] }, as: 'lid' },
        { name: 'add_box', input: { name: 'Base', size: [40, 40, 10] }, as: 'base' },
        { name: 'add_cylinder', input: { name: 'Pocket', position: [20, 20, 5], radius: 5, height: 10, hole: true }, as: 'pocket' },
        { name: 'group', input: { target: { ids: ['$lid', '$pocket'] }, name: 'Lid assembly' } },
      ],
    }));
    const doc = api.doc;
    const vol = (name: string) => {
      const e = doc.entities.find((x) => x.name === name)!;
      const [{ geometry }] = buildWorldGeometries([e], doc.entities, doc.groups);
      return meshVolume(geometry);
    };
    // Unscoped: the pocket cuts both the lid and the base it overlaps.
    expect(vol('Base')).toBeLessThan(16000 - 100);
    ok(api.call('set_hole', { target: { name: 'Pocket' }, hole: true, only_own_group: true }));
    expect(vol('Base')).toBeCloseTo(16000, 3);
    expect(vol('Lid')).toBeCloseTo(16000 - PI * 25 * 5, -1);
    expect(ok(api.call('get_scene')).lines.join('\n')).toMatch(/"Pocket" cylinder .*\[hole, own group only\]/);
    // A loose hole has no group to be scoped to.
    ok(api.call('add_cylinder', { name: 'Loose', radius: 1, height: 1, hole: true }));
    const r = api.call('set_hole', { target: { name: 'Loose' }, hole: true, only_own_group: true });
    expect(!r.ok && r.error.hint).toMatch(/Group it/);
  });
});

describe('fused export and volumes', () => {
  it('overlapping parts count once and export as one watertight solid', () => {
    const api = setup();
    ok(api.call('add_box', { name: 'A', size: [20, 20, 20] }));
    ok(api.call('add_box', { name: 'B', size: [20, 20, 20], position: [10, 0, 0] }));
    const { doc } = api;
    expect(fusedVolume(doc.entities, doc.entities, doc.groups)).toBeCloseTo(30 * 20 * 20, 3);
    expect(ok(api.call('check_print')).volume_cm3).toBeCloseTo(12, 3);
    const stl = exportStl(doc.entities, doc.entities, doc.groups)!;
    expect(stlVolume(stl)).toBeCloseTo(12000, 0);
  });
});

describe('split_for_print', () => {
  it('cuts a block into two pieces with pegs and clearance holes, as one undo step', () => {
    const api = setup();
    ok(api.call('add_box', { name: 'Block', size: [60, 40, 40] }));
    const original = api.doc.entities[0].id;
    const r = ok(api.call('split_for_print', { target: { name: 'Block' } }));
    expect(r).toMatchObject({ pieces: ['Block 1', 'Block 2'], pegs: 2, peg: { diameter: 5, depth: 6, hole_diameter: 5.4 } });
    const { doc } = api;
    expect(doc.get(original)).toBeUndefined();
    const piece = (name: string) => {
      const g = doc.groups.find((x) => x.name === name)!;
      return groupMembers(g.id, doc.entities, doc.groups);
    };
    const volume = (name: string) => fusedVolume(piece(name), doc.entities, doc.groups);
    const peg = PI * 2.5 ** 2 * 6; // the part of each peg above the cut
    const hole = PI * 2.7 ** 2 * 6.2; // clearance hole, depth + clearance
    expect(volume('Block 1')).toBeCloseTo(60 * 40 * 20 + 2 * peg, -1);
    expect(volume('Block 2')).toBeCloseTo(60 * 40 * 20 - 2 * hole, -1);
    // The upper piece moved 10 mm up; its pegs line up with the holes.
    const bounds2 = new THREE.Box3();
    for (const { geometry } of buildWorldGeometries(piece('Block 2').filter((e) => !e.hole), doc.entities, doc.groups)) {
      geometry.computeBoundingBox();
      bounds2.union(geometry.boundingBox!);
    }
    expect(bounds2.min.z).toBeCloseTo(30, 3);
    const pegs = doc.entities.filter((e) => e.name.startsWith('Peg ') && !e.hole);
    const holes = doc.entities.filter((e) => e.name.startsWith('Peg hole'));
    expect(pegs.map((p) => [p.position[0], p.position[1]])).toEqual(holes.map((h) => [h.position[0], h.position[1]]));
    expect(doc.undoLabel).toBe('Split for print');
    doc.undo();
    expect(doc.entities.map((e) => e.name)).toEqual(['Block']);
  });

  it('copies holes into both pieces and keeps them out of each other', () => {
    const api = setup();
    ok(api.call('add_box', { name: 'Post', size: [30, 30, 60] }));
    ok(api.call('add_cylinder', { name: 'Bore', position: [15, 15, -1], radius: 4, height: 62, hole: true }));
    ok(api.call('add_box', { name: 'Neighbour', size: [10, 10, 10], position: [100, 0, 0] }));
    const r = ok(api.call('split_for_print', { target: { name: 'Post' }, at: 25, gap: 5 }));
    // The bore leaves no room in the middle: pegs go around it.
    expect(r.pegs).toBeGreaterThan(0);
    const { doc } = api;
    expect(doc.entities.filter((e) => e.name === 'Bore')).toHaveLength(3); // the original + one per piece
    expect(doc.entities.filter((e) => e.name === 'Bore' && e.holeScope === 'group')).toHaveLength(2);
    // Each piece: its half of the post, minus the bore, plus/minus pegs. Bottom half is 25 tall.
    const g1 = doc.groups.find((g) => g.name === 'Post 1')!;
    const v1 = fusedVolume(groupMembers(g1.id, doc.entities, doc.groups), doc.entities, doc.groups);
    expect(v1).toBeGreaterThan(30 * 30 * 25 - PI * 16 * 25);
    expect(v1).toBeLessThan(30 * 30 * 25);
    expect(doc.entities.find((e) => e.name === 'Neighbour')).toBeDefined();
  });

  it('explains bad cuts and tiny faces', () => {
    const api = setup();
    ok(api.call('add_box', { name: 'Thin', size: [4, 4, 20] }));
    const out = api.call('split_for_print', { target: { name: 'Thin' }, at: 30 });
    expect(!out.ok && out.error.hint).toMatch(/between/);
    const r = ok(api.call('split_for_print', { target: { name: 'Thin' }, axis: 'z' }));
    expect(r.pegs).toBe(0);
    expect(r.notes.join(' ')).toMatch(/too small for pegs/);
  });

  it('splits along x and y too', () => {
    const api = setup();
    ok(api.call('add_box', { name: 'Bar', size: [120, 30, 30] }));
    const r = ok(api.call('split_for_print', { target: { name: 'Bar' }, axis: 'x', pegs: 1 }));
    expect(r.pegs).toBe(1);
    const peg = api.doc.entities.find((e) => e.name === 'Peg 1')!;
    // Rotated to point along +x, starting depth before the cut at x = 60.
    expect(peg.rotation).toEqual([0, 90, 0]);
    expect(peg.position[0]).toBeCloseTo(60 - 6, 6);
  });
});
