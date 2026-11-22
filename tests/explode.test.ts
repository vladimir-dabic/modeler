import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ModelerApi } from '../src/api';
import { ModelDocument } from '../src/model/Document';
import { explodeOffsets } from '../src/model/explode';
import { worldBounds } from '../src/model/geometry';

const ok = (r: any) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.data;
};

function cabinet() {
  const api = new ModelerApi(new ModelDocument());
  ok(api.call('apply_operations', {
    operations: [
      { name: 'add_box', input: { name: 'Left', size: [20, 300, 600] }, as: 'l' },
      { name: 'add_box', input: { name: 'Right', size: [20, 300, 600], position: [580, 0, 0] }, as: 'r' },
      { name: 'add_box', input: { name: 'Top', size: [560, 300, 20], position: [20, 0, 580] }, as: 't' },
      { name: 'group', input: { target: { ids: ['$l', '$r', '$t'] }, name: 'Cabinet' } },
      { name: 'add_box', input: { name: 'Lamp', size: [100, 100, 100], position: [250, 100, 600] } },
    ],
  }));
  return api;
}

/** A round tray table: wood disc inside a steel rim, on a ledge ring, three legs. */
function trayTable(api: ModelerApi, x: number, name: string) {
  ok(api.call('apply_operations', {
    operations: [
      { name: 'add_cylinder', input: { name: `${name} wood`, position: [x, 0, 352], radius: 396, height: 18 }, as: 'w' },
      { name: 'add_revolve', input: { name: `${name} rim`, position: [x, 0, 0], profile: [[397, 347], [400, 347], [400, 380], [397, 380]] }, as: 'b' },
      { name: 'add_revolve', input: { name: `${name} ledge`, position: [x, 0, 0], profile: [[372, 347], [397, 347], [397, 352], [372, 352]] }, as: 'l' },
      { name: 'add_cylinder', input: { name: `${name} leg`, position: [x + 384, 0, 0], radius: 6, height: 347 }, as: 'g1' },
      { name: 'add_cylinder', input: { name: `${name} leg`, position: [x - 192, 332, 0], radius: 6, height: 347 }, as: 'g2' },
      { name: 'add_cylinder', input: { name: `${name} leg`, position: [x - 192, -332, 0], radius: 6, height: 347 }, as: 'g3' },
      { name: 'group', input: { target: { ids: ['$w', '$b', '$l', '$g1', '$g2', '$g3'] }, name } },
    ],
  }));
}

const exploded = (doc: ModelDocument, off: Map<string, THREE.Vector3>, name: string) => {
  const e = doc.entities.find((x) => x.name === name)!;
  return worldBounds(e).translate(off.get(e.id) ?? new THREE.Vector3());
};

describe('explodeOffsets', () => {
  it('takes every part apart, also inside groups, and stays on the floor', () => {
    const { doc } = cabinet();
    const id = (n: string) => doc.entities.find((e) => e.name === n)!.id;
    const off = explodeOffsets(doc.entities, doc.groups, null, 1);
    // The cabinet's sides move out sideways; nothing sinks below the floor.
    expect(off.get(id('Left'))!.x).toBeLessThan(-100);
    expect(off.get(id('Right'))!.x).toBeGreaterThan(100);
    for (const e of doc.entities) expect(exploded(doc, off, e.name).min.z).toBeGreaterThanOrEqual(-1e-6);
    // The lamp standing on the top lifts off it, with a gap.
    expect(exploded(doc, off, 'Lamp').min.z).toBeGreaterThan(exploded(doc, off, 'Top').max.z + 20);
    expect(explodeOffsets(doc.entities, doc.groups, null, 0).size).toBe(0);
  });

  it('separates parts that sit inside each other (a tray in its rim) by stacking them', () => {
    const api = new ModelerApi(new ModelDocument());
    trayTable(api, 0, 'Table');
    const { doc } = api;
    const off = explodeOffsets(doc.entities, doc.groups, null, 1);
    const [ledge, wood, rim] = ['Table ledge', 'Table wood', 'Table rim'].map((n) => exploded(doc, off, n));
    // Bottom-up by their height in the assembly, no overlaps.
    expect(wood.min.z).toBeGreaterThan(ledge.max.z);
    expect(rim.min.z).toBeGreaterThan(wood.max.z);
    // Legs move out from under the top.
    for (const leg of doc.entities.filter((e) => e.name === 'Table leg')) {
      const b = worldBounds(leg).translate(off.get(leg.id) ?? new THREE.Vector3());
      const c = b.getCenter(new THREE.Vector3());
      expect(Math.hypot(c.x, c.y)).toBeGreaterThan(Math.hypot(...leg.position.slice(0, 2)) + 50);
    }
  });

  it('moves assemblies apart sideways until their exploded clusters do not overlap', () => {
    const api = new ModelerApi(new ModelDocument());
    trayTable(api, 0, 'Big');
    trayTable(api, -510, 'Small');
    const { doc } = api;
    const off = explodeOffsets(doc.entities, doc.groups, null, 1);
    const cluster = (prefix: string) => {
      const b = new THREE.Box3();
      for (const e of doc.entities.filter((x) => x.name.startsWith(prefix))) b.union(exploded(doc, off, e.name));
      return b;
    };
    const big = cluster('Big');
    const small = cluster('Small');
    expect(small.max.x < big.min.x || small.max.y < big.min.y || small.min.y > big.max.y).toBe(true);
    // Both still stand on the floor.
    expect(Math.min(big.min.z, small.min.z)).toBeCloseTo(0, 6);
  });

  it('inside an open group, only its parts come apart', () => {
    const { doc } = cabinet();
    const id = (n: string) => doc.entities.find((e) => e.name === n)!.id;
    const off = explodeOffsets(doc.entities, doc.groups, doc.groups[0].id, 1);
    expect(off.get(id('Left'))!.x).toBeLessThan(0);
    expect(off.get(id('Right'))!.x).toBeGreaterThan(0);
    expect(off.has(id('Lamp'))).toBe(false);
  });

  it('can be limited to one axis, and grows with the factor', () => {
    const api = new ModelerApi(new ModelDocument());
    trayTable(api, 0, 'Table');
    const { doc } = api;
    const half = explodeOffsets(doc.entities, doc.groups, null, 0.5, 'z');
    const full = explodeOffsets(doc.entities, doc.groups, null, 1, 'z');
    for (const v of full.values()) expect([v.x, v.y]).toEqual([0, 0]);
    const rim = doc.entities.find((e) => e.name === 'Table rim')!.id;
    expect(full.get(rim)!.z).toBeGreaterThan(0);
    expect(full.get(rim)!.z).toBeCloseTo(2 * half.get(rim)!.z);
  });
});
