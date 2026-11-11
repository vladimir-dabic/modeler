import { describe, expect, it } from 'vitest';
import { ModelerApi } from '../src/api';
import { ModelDocument } from '../src/model/Document';
import { explodeOffsets } from '../src/model/explode';

function scene() {
  const api = new ModelerApi(new ModelDocument());
  const r = api.call('apply_operations', {
    operations: [
      { name: 'add_box', input: { name: 'Left', size: [20, 300, 600] }, as: 'l' },
      { name: 'add_box', input: { name: 'Right', size: [20, 300, 600], position: [580, 0, 0] }, as: 'r' },
      { name: 'add_box', input: { name: 'Top', size: [560, 300, 20], position: [20, 0, 580] }, as: 't' },
      { name: 'group', input: { target: { ids: ['$l', '$r', '$t'] }, name: 'Cabinet' } },
      { name: 'add_box', input: { name: 'Lamp', size: [100, 100, 100], position: [250, 100, 800] } },
    ],
  });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return api;
}

describe('explodeOffsets', () => {
  it('moves top-level units apart from the centre; groups move as one', () => {
    const { doc } = scene();
    const byName = (n: string) => doc.entities.find((e) => e.name === n)!.id;
    const off = explodeOffsets(doc.entities, doc.groups, null, 1);
    // The cabinet is the base: it stays on the floor, all three parts together; the lamp lifts off.
    expect(['Left', 'Right', 'Top'].map((n) => off.get(byName(n)))).toEqual([undefined, undefined, undefined]);
    expect(off.get(byName('Lamp'))!.z).toBeGreaterThan(100);
    expect(explodeOffsets(doc.entities, doc.groups, null, 0).size).toBe(0);
  });

  it('inside an open group, its parts come apart and the rest stays', () => {
    const { doc } = scene();
    const byName = (n: string) => doc.entities.find((e) => e.name === n)!.id;
    const cabinet = doc.groups[0].id;
    const off = explodeOffsets(doc.entities, doc.groups, cabinet, 1);
    expect(off.get(byName('Left'))!.x).toBeLessThan(0);
    expect(off.get(byName('Right'))!.x).toBeGreaterThan(0);
    expect(off.get(byName('Top'))!.z).toBeGreaterThan(0);
    // Nothing sinks below the cabinet's base.
    for (const [id, o] of off) {
      const e = doc.get(id)!;
      expect(e.position[2] + o.z).toBeGreaterThanOrEqual(-1e-6);
    }
    expect(off.has(byName('Lamp'))).toBe(false);
  });

  it('can be limited to one axis, and grows with the factor', () => {
    const { doc } = scene();
    const cabinet = doc.groups[0].id;
    const half = explodeOffsets(doc.entities, doc.groups, cabinet, 0.5, 'z');
    const full = explodeOffsets(doc.entities, doc.groups, cabinet, 1, 'z');
    for (const v of half.values()) expect([v.x, v.y]).toEqual([0, 0]);
    // Along z the sides (at mid-height) only rise with the lift; the top rises the most.
    const byName = (n: string) => doc.entities.find((e) => e.name === n)!.id;
    const gap = (m: typeof half) => m.get(byName('Top'))!.z - (m.get(byName('Left'))?.z ?? 0);
    expect(gap(half)).toBeGreaterThan(0);
    expect(gap(full)).toBeCloseTo(2 * gap(half));
  });
});

describe('explode_view / render_views explode', () => {
  it('needs the app; passes through to the host without touching the model', async () => {
    const headless = scene();
    const r = await headless.callAsync('explode_view', { factor: 0.5 });
    expect(!r.ok && r.error.code).toBe('unsupported');

    const calls: unknown[] = [];
    const doc = new ModelDocument();
    const api = new ModelerApi(doc, {
      setExplode: (f, a) => calls.push(['explode', f, a]),
      renderViews: async (views, size, opts) => {
        calls.push(['render', views, size, opts]);
        return [];
      },
    });
    api.call('add_box', { size: [10, 10, 10] });
    const before = doc.version;
    expect((await api.callAsync('explode_view', { factor: 0.7, axis: 'z' })).ok).toBe(true);
    expect((await api.callAsync('render_views', { views: ['front'], explode: 1 })).ok).toBe(true);
    expect(calls).toEqual([
      ['explode', 0.7, 'z'],
      ['render', ['front'], 768, { explode: 1, axis: undefined }],
    ]);
    expect(doc.version).toBe(before);
  });
});
