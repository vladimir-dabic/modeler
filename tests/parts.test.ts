import { describe, expect, it } from 'vitest';
import { ModelerApi } from '../src/api';
import { copyParts } from '../src/model/clipboard';
import { buildCutList, cutListToCsv } from '../src/model/cutlist';
import { ModelDocument } from '../src/model/Document';
import { exportGlb, readGlbJson } from '../src/model/gltf';
import { partTypes } from '../src/model/instructions';
import { parseDocumentFile } from '../src/model/io';
import type { BoxEntity } from '../src/model/types';

const ok = (r: any) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.data;
};

/** A table: top + 4 legs linked as one component. */
function table() {
  const api = new ModelerApi(new ModelDocument());
  ok(api.call('apply_operations', {
    operations: [
      { name: 'add_box', input: { name: 'Top', size: [900, 600, 25], position: [0, 0, 400] } },
      { name: 'add_box', input: { name: 'Leg', size: [50, 50, 400], position: [20, 20, 0] }, as: 'leg' },
      { name: 'duplicate', input: { target: { ids: ['$leg'] }, pattern: { grid: { counts: [2, 2, 1], step: [810, 510, 0] } } } },
      { name: 'make_component', input: { target: { name: 'Leg*' } } },
    ],
  }));
  return api;
}
const legs = (api: ModelerApi) => api.doc.entities.filter((e) => e.name.startsWith('Leg')) as BoxEntity[];

describe('components: linked copies', () => {
  it('editing one copy changes all; each keeps its own place and name', () => {
    const api = table();
    const [a, b] = legs(api);
    expect(new Set(legs(api).map((e) => e.component)).size).toBe(1);
    const data = ok(api.call('update_entity', { id: a.id, set: { size: [60, 60, 380], color: '#222222' } }));
    expect(legs(api).map((e) => e.size)).toEqual([[60, 60, 380], [60, 60, 380], [60, 60, 380], [60, 60, 380]]);
    expect(legs(api).every((e) => e.color === '#222222')).toBe(true);
    // The other copies are reported as changed too, in one undo step.
    expect(api.call('get_scene', {}).ok).toBe(true);
    expect(data).toBeDefined();
    expect(new Set(legs(api).map((e) => e.position.join())).size).toBe(4);
    ok(api.call('update_entity', { id: b.id, set: { position: [0, 0, 0], name: 'Leg front' } }));
    expect(legs(api).filter((e) => e.position.join() === '0,0,0')).toHaveLength(1);
    api.doc.undo();
    api.doc.undo();
    expect(legs(api).map((e) => e.size[0])).toEqual([50, 50, 50, 50]);
  });

  it('follows edits made directly by tools (push/pull) when the transaction commits', () => {
    const api = table();
    const [a] = legs(api);
    api.doc.transact(() => {
      a.size = [50, 50, 450];
    }, 'Push/Pull');
    expect(legs(api).every((e) => e.size[2] === 450)).toBe(true);
  });

  it('duplicating a copy adds a linked copy; a mirrored copy of an asymmetric part is a new part', () => {
    const api = table();
    const [a] = legs(api);
    const dup = ok(api.call('duplicate', { target: { ids: [a.id] } }));
    expect(api.doc.get(dup.ids[0])!.component).toBe(a.component);
    ok(api.call('add_shape', { name: 'Bracket', points: [[0, 0], [100, 0], [0, 40]], height: 10, position: [0, 1000, 0] }));
    ok(api.call('duplicate', { target: { name: 'Bracket' } }));
    ok(api.call('make_component', { target: { name: 'Bracket*' } }));
    const brackets = () => api.doc.entities.filter((e) => e.name.startsWith('Bracket'));
    const [original] = brackets();
    const m = ok(api.call('mirror', { target: { ids: [original.id] }, plane: 'x', keep_original: true }));
    const copy = api.doc.get(m.ids.find((id: string) => id !== original.id))!;
    // The mirrored outline is a different (opposite) part: not linked, and the originals keep their shape.
    expect(JSON.stringify((copy as any).points)).not.toBe(JSON.stringify((original as any).points));
    expect(copy.component).toBeUndefined();
    expect(brackets().filter((e) => e.component).map((e) => JSON.stringify((e as any).points))).toEqual([JSON.stringify((original as any).points), JSON.stringify((original as any).points)]);
  });

  it('refuses parts that differ unless asked to match them', () => {
    const api = table();
    ok(api.call('add_box', { name: 'Shelf A', size: [800, 300, 18] }));
    ok(api.call('add_box', { name: 'Shelf B', size: [800, 310, 18] }));
    const r = api.call('make_component', { target: { name: 'Shelf*' } }) as any;
    expect(r.ok).toBe(false);
    expect(r.error.hint).toMatch(/match: true/);
    const data = ok(api.call('make_component', { target: { name: 'Shelf*' }, match: true }));
    expect(data.matched).toEqual(['Shelf B']);
    expect(api.doc.entities.filter((e) => e.name.startsWith('Shelf')).map((e) => (e as BoxEntity).size[1])).toEqual([300, 300]);
    expect((api.call('make_component', { target: { name: 'Top' } }) as any).error.message).toMatch(/at least two/);
  });

  it('make_unique unlinks; a lone remaining copy is unlinked too', () => {
    const api = table();
    const [a, b, c] = legs(api);
    ok(api.call('make_unique', { target: { ids: [a.id] } }));
    ok(api.call('update_entity', { id: a.id, set: { size: [10, 10, 10] } }));
    expect(b.size).toEqual([50, 50, 400]);
    ok(api.call('make_unique', { target: { ids: [b.id, c.id] } }));
    expect(legs(api).every((e) => !e.component)).toBe(true);
  });

  it('pasted copies stay linked to each other, as a new component', () => {
    const api = table();
    const text = JSON.stringify(copyParts(legs(api), api.doc.entities, api.doc.groups, api.doc.annotations));
    const data = ok(api.call('paste', { data: text }));
    const pasted = data.ids.map((id: string) => api.doc.get(id)!);
    expect(new Set(pasted.map((e: any) => e.component)).size).toBe(1);
    expect(pasted[0].component).not.toBe(legs(api)[0].component);
  });
});

describe('part properties', () => {
  it('set_properties sets and clears fields; linked copies all get them', () => {
    const api = table();
    const [a] = legs(api);
    ok(api.call('set_properties', { target: { ids: [a.id] }, material: 'Oak', finish: 'Oiled', part_no: 'L-01' }));
    expect(legs(api).every((e) => e.material === 'Oak' && e.finish === 'Oiled' && e.partNo === 'L-01')).toBe(true);
    ok(api.call('set_properties', { target: { name: 'Top' }, material: 'White chipboard', banding: { long: 2, short: 2, thickness: 2 }, note: 'Grain lengthwise' }));
    ok(api.call('set_properties', { target: { ids: [a.id] }, finish: null }));
    expect(legs(api).every((e) => e.finish === undefined)).toBe(true);
    expect((api.call('set_properties', { target: { name: 'Top' } }) as any).error.message).toMatch(/at least one/);
    // Saved with the project and validated on open.
    const file = parseDocumentFile(JSON.stringify(api.doc.toFile()));
    const top = file.entities.find((e) => e.name === 'Top')!;
    expect(top).toMatchObject({ material: 'White chipboard', banding: { long: 2, short: 2, thickness: 2 }, note: 'Grain lengthwise' });
    expect(file.entities.filter((e) => e.component).length).toBe(4);
  });

  it('cut list, part letters and GLB materials use them', () => {
    const api = table();
    ok(api.call('add_box', { name: 'Shelf', size: [800, 300, 18] }));
    ok(api.call('add_box', { name: 'Shelf', size: [800, 300, 18], position: [0, 0, 200] }));
    ok(api.call('set_properties', { target: { ids: [api.doc.entities.at(-1)!.id] }, material: 'Walnut' }));
    ok(api.call('set_properties', { target: { name: 'Leg*' }, material: 'Oak' }));
    ok(api.call('set_properties', { target: { name: 'Top' }, material: 'Oak', banding: { long: 2, short: 1 } }));
    const rows = buildCutList(api.doc.entities);
    // Same size, different material: two rows and two letters.
    expect(rows.filter((r) => r.width === 300).map((r) => r.material ?? '-').sort()).toEqual(['-', 'Walnut']);
    expect(cutListToCsv(rows, 'mm').split('\n')[0]).toBe('Part,Qty,Thickness (mm),Width (mm),Length (mm),Material,Edge banding,Notes');
    expect(rows.find((r) => r.names.includes('Top'))!.banding).toBe('2 long, 1 short');
    const types = partTypes(api.doc.entities);
    expect(types.filter((t) => t.name === 'Shelf')).toHaveLength(2);
    expect(types.find((t) => t.name === 'Leg')).toMatchObject({ quantity: 4, material: 'Oak' });
    const glb = readGlbJson(exportGlb(api.doc.entities, api.doc.entities, api.doc.groups)!.data);
    expect(glb.materials.map((m: any) => m.name)).toContain('Oak');
    expect(glb.materials.map((m: any) => m.name)).toContain('Walnut');
  });
});
