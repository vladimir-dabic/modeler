import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { ModelerApi } from '../src/api';
import { ModelDocument } from '../src/model/Document';
import { exportGlb, readGlbJson } from '../src/model/gltf';

const ok = (r: any) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.data;
};
const setup = () => new ModelerApi(new ModelDocument());

function load(data: Uint8Array): Promise<THREE.Group> {
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  return new Promise((resolve, reject) => new GLTFLoader().parse(buffer, '', (gltf) => resolve(gltf.scene), reject));
}

/** Signed volume of every mesh in a loaded scene, in world space (m³). */
function sceneVolume(scene: THREE.Object3D): number {
  let vol = 0;
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = (o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld);
    const p = g.attributes.position;
    const idx = g.index;
    const n = idx ? idx.count : p.count;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < n; i += 3) {
      const [i0, i1, i2] = idx ? [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)] : [i, i + 1, i + 2];
      a.fromBufferAttribute(p, i0); b.fromBufferAttribute(p, i1); c.fromBufferAttribute(p, i2);
      vol += a.dot(b.clone().cross(c)) / 6;
    }
  });
  return vol;
}

describe('GLB export', () => {
  it('converts mm Z-up to metres Y-up and keeps the part transform', async () => {
    const api = setup();
    ok(api.call('add_box', { name: 'Leg', size: [10, 20, 30], position: [100, 50, 0], rotation: [0, 0, 90] }));
    const result = exportGlb(api.doc.entities, api.doc.entities, api.doc.groups)!;
    const json = readGlbJson(result.data);
    expect(json.asset.version).toBe('2.0');
    expect(json.nodes[0]).toMatchObject({ name: 'Leg', translation: [0.1, 0, -0.05] });
    // 90° about our Z (up) is 90° about glTF's Y (up).
    expect(json.nodes[0].rotation.map((v: number) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0.707107, 0, 0.707107]);

    const scene = await load(result.data);
    const box = new THREE.Box3().setFromObject(scene);
    // In our frame the rotated leg spans x 80..100, y 50..60, z 0..30.
    expect(box.min.toArray().map((v) => +v.toFixed(6))).toEqual([0.08, 0, -0.06]);
    expect(box.max.toArray().map((v) => +v.toFixed(6))).toEqual([0.1, 0.03, -0.05]);
    expect(sceneVolume(scene)).toBeCloseTo(10 * 20 * 30 * 1e-9, 12);
  });

  it('cuts holes, nests groups and shares one material per colour', async () => {
    const api = setup();
    ok(api.call('apply_operations', {
      operations: [
        { name: 'add_box', input: { name: 'Top', size: [100, 100, 10], position: [0, 0, 40], color: '#c8a165' }, as: 'top' },
        { name: 'add_box', input: { name: 'Shelf', size: [100, 100, 10], color: '#C8A165' }, as: 'shelf' },
        { name: 'add_box', input: { name: 'Plinth', size: [20, 20, 20], position: [200, 0, 0], color: '#333333' } },
        { name: 'add_cylinder', input: { name: 'Hole', position: [50, 50, 40], radius: 10, height: 10, hole: true } },
        { name: 'group', input: { target: { ids: ['$top', '$shelf'] }, name: 'Furniture' }, as: 'furniture' },
        { name: 'group', input: { target: { ids: ['$top', '$shelf'] }, name: 'Table' } },
      ],
    }));
    const result = exportGlb(api.doc.entities, api.doc.entities, api.doc.groups, { name: 'Living room' })!;
    expect(result).toMatchObject({ parts: 3, groups: 2, materials: 2 });
    const json = readGlbJson(result.data);
    expect(json.scenes[0].name).toBe('Living room');
    expect(json.materials.map((m: any) => m.name)).toEqual(['Colour #c8a165', 'Colour #333333']);
    // sRGB → linear.
    expect(json.materials[1].pbrMetallicRoughness.baseColorFactor[0]).toBeCloseTo(0.0331, 4);
    expect(json.nodes.some((n: any) => n.name === 'Hole')).toBe(false);

    const scene = await load(result.data);
    const furniture = scene.getObjectByName('Furniture')!;
    const table = furniture.getObjectByName('Table')!;
    expect(table.parent).toBe(furniture);
    expect(table.children.map((c) => c.name).sort()).toEqual(['Shelf', 'Top']);
    expect(scene.getObjectByName('Plinth')!.parent).toBe(scene);

    const top = new THREE.Group().add(scene.getObjectByName('Top')!.clone());
    const expected = (100 * 100 * 10 - Math.PI * 100 * 10) * 1e-9;
    expect(sceneVolume(top) / expected).toBeCloseTo(1, 3);
  });

  it('exports only the target, and nothing without solids', () => {
    const api = setup();
    ok(api.call('add_box', { name: 'A', size: [10, 10, 10] }));
    ok(api.call('add_box', { name: 'B', size: [10, 10, 10], position: [20, 0, 0] }));
    const [a] = api.doc.entities;
    expect(exportGlb([a], api.doc.entities, [])!.parts).toBe(1);
    expect(readGlbJson(exportGlb([a], api.doc.entities, [])!.data).nodes.map((n: any) => n.name)).toEqual(['A']);
    expect(exportGlb([], api.doc.entities, [])).toBeNull();
  });

  it('is a well-formed GLB container', () => {
    const api = setup();
    ok(api.call('add_sphere', { name: 'Ball', radii: [10, 10, 10] }));
    const { data } = exportGlb(api.doc.entities, api.doc.entities, [])!;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(dv.getUint32(8, true)).toBe(data.byteLength);
    expect(data.byteLength % 4).toBe(0);
    const json = readGlbJson(data);
    const binAt = 20 + dv.getUint32(12, true);
    expect(dv.getUint32(binAt, true)).toBe(json.buffers[0].byteLength);
    for (const v of json.bufferViews) expect(v.byteOffset % 4).toBe(0);
  });
});
