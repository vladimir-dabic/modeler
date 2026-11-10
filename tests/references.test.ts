import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ModelerApi } from '../src/api';
import { ModelDocument } from '../src/model/Document';
import { parseDocumentFile } from '../src/model/io';
import { referenceBounds, referenceSnapPoints } from '../src/model/references';

/** A 4000 × 3000 room (Walls), a door arc (Doors) and a table (Furniture), in mm or none. */
function plan(insunits?: number): string {
  const p: (string | number)[] = [];
  if (insunits !== undefined) p.push(0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, insunits, 0, 'ENDSEC');
  p.push(0, 'SECTION', 2, 'ENTITIES');
  p.push(0, 'LWPOLYLINE', 8, 'Walls', 90, 4, 70, 1, 10, 0, 20, 0, 10, 4000, 20, 0, 10, 4000, 20, 3000, 10, 0, 20, 3000);
  p.push(0, 'ARC', 8, 'Doors', 10, 1000, 20, 0, 40, 900, 50, 0, 51, 90);
  p.push(0, 'CIRCLE', 8, 'Furniture', 10, 2500, 20, 1500, 40, 500);
  p.push(0, 'TEXT', 8, 'Notes', 1, 'Kitchen');
  p.push(0, 'ENDSEC', 0, 'EOF');
  return p.join('\n');
}

async function setup(text = plan(4)) {
  const api = new ModelerApi(new ModelDocument());
  const r = await api.callAsync('import_dxf', { text, name: 'Ground floor' });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return { api, doc: api.doc, data: r.data as any };
}

describe('import_dxf', () => {
  it('adds a reference drawing as one undo step, not as model parts', async () => {
    const { api, doc, data } = await setup();
    expect(data).toMatchObject({ name: 'Ground floor', units: 'mm', units_from: 'file', size_mm: [4000, 3000], skipped: { TEXT: 1 } });
    expect(data.layers).toEqual(['Walls: 1', 'Doors: 1', 'Furniture: 1']);
    expect(doc.references).toHaveLength(1);
    expect(doc.entities).toHaveLength(0);
    expect(doc.undoLabel).toBe('Import Ground floor');

    const scene = api.call('get_scene');
    expect(scene.ok && (scene.data as any).references[0]).toMatch(/"Ground floor" drawing 4000×3000 mm at 0,0,0 \(3 layers\)/);
    expect(scene.ok && (scene.data as any).counts.parts).toBe(0);
    expect(api.call('get_cut_list').ok).toBe(true);

    doc.undo();
    expect(doc.references).toHaveLength(0);
    doc.redo();
    expect(doc.geometryOf(doc.references[0].id)?.paths).toHaveLength(3);
  });

  it('keeps line geometry out of undo snapshots', async () => {
    const big: (string | number)[] = [0, 'SECTION', 2, 'ENTITIES'];
    for (let i = 0; i < 2000; i++) big.push(0, 'LINE', 8, 'L', 10, i, 20, 0, 11, i, 21, 100);
    big.push(0, 'ENDSEC', 0, 'EOF');
    const { doc } = await setup(big.join('\n'));
    expect(JSON.stringify(doc.toFile()).length).toBeGreaterThan(40_000);
    expect(doc.checkpoint().length).toBeLessThan(500);
  });

  it('assumes mm when the file has no units, and hints when that looks wrong', async () => {
    const metres = [0, 'SECTION', 2, 'ENTITIES', 0, 'LINE', 10, 0, 20, 0, 11, 12.5, 21, 0, 0, 'LINE', 10, 0, 20, 0, 11, 0, 21, 9.8, 0, 'ENDSEC', 0, 'EOF'].join('\n');
    const { api, doc, data } = await setup(metres);
    expect(data.units_from).toMatch(/assumed/);
    expect(data.hint).toMatch(/probably in metres/);
    const fixed = api.call('update_reference', { reference: 'Ground floor', units: 'm' });
    expect(fixed.ok).toBe(true);
    const b = referenceBounds(doc.references[0], doc.geometryOf(doc.references[0].id)!);
    expect(b.max.x).toBeCloseTo(12500);
    expect(b.max.y).toBeCloseTo(9800);
    // Units given explicitly win over the file.
    const given = await api.callAsync('import_dxf', { text: plan(4), units: 'cm' });
    expect(given.ok && (given.data as any).size_mm).toEqual([40000, 30000]);
  });

  it('explains bad input', async () => {
    const api = new ModelerApi(new ModelDocument());
    const both = await api.callAsync('import_dxf', { text: plan(), path: 'a.dxf' });
    expect(!both.ok && both.error.message).toMatch(/exactly one of path or text/);
    const noHost = await api.callAsync('import_dxf', { path: 'a.dxf' });
    expect(!noHost.ok && noHost.error.code).toBe('unsupported');
    const dwg = await api.callAsync('import_dxf', { text: 'AC1027 binary' });
    expect(!dwg.ok && dwg.error.message).toMatch(/DWG/);
    expect(api.doc.canUndo).toBe(false);
  });
});

describe('get_reference', () => {
  it('lists paths compactly in world mm, by layer, with a limit', async () => {
    const { api } = await setup();
    api.call('update_reference', { reference: 'Ground floor', position: [1000, 0, 0], units: 'cm' });
    const r = api.call('get_reference', { reference: 'Ground floor' });
    expect(r.ok).toBe(true);
    const data = (r as any).data;
    expect(data.layers).toEqual(['Walls: 1', 'Doors: 1', 'Furniture: 1']);
    // Shifted to the origin, ×10 for cm, then moved +1000 in x. The door arc's centre was at the drawing's min x.
    expect(data.paths[0]).toBe('Walls: closed 1000,0 41000,0 41000,30000 1000,30000');
    expect(data.paths[1]).toBe('Doors: arc centre 11000,0 r 9000 from 20000,0 to 11000,9000');
    expect(data.paths[2]).toBe('Furniture: circle centre 26000,15000 ø10000');
    const walls = api.call('get_reference', { reference: 'Ground floor', layers: ['walls'], limit: 1 });
    expect((walls as any).data.paths).toHaveLength(1);
    const limited = api.call('get_reference', { reference: 'Ground floor', limit: 1 });
    expect((limited as any).data.truncated).toMatch(/2 more paths/);
  });
});

describe('update_reference / delete_reference', () => {
  it('moves, rotates, rescales and hides as undoable steps', async () => {
    const { api, doc } = await setup();
    const id = doc.references[0].id;
    expect(api.call('update_reference', { reference: id, position: [100, 200, 0], rotation: 90, name: 'Plan' }).ok).toBe(true);
    const r = doc.references[0];
    expect(r).toMatchObject({ name: 'Plan', position: [100, 200, 0], rotation: 90 });
    const b = referenceBounds(r, doc.geometryOf(id)!);
    // 4000 × 3000 rotated 90° about its corner at (100, 200).
    expect([b.min.x, b.min.y, b.max.x, b.max.y].map(Math.round)).toEqual([-2900, 200, 100, 4200]);
    doc.undo();
    expect(doc.references[0]).toMatchObject({ name: 'Ground floor', position: [0, 0, 0], rotation: 0 });
  });

  it('switches layers by name, "*" for all', async () => {
    const { api, doc } = await setup();
    expect(api.call('update_reference', { reference: 'ground floor', hide_layers: ['furniture', 'Doors'] }).ok).toBe(true);
    expect(doc.references[0].hiddenLayers).toEqual(['Furniture', 'Doors']);
    api.call('update_reference', { reference: 'Ground floor', hide_layers: ['*'], show_layers: ['Walls'] });
    expect(doc.references[0].hiddenLayers.sort()).toEqual(['Doors', 'Furniture']);
    const bad = api.call('update_reference', { reference: 'Ground floor', hide_layers: ['Electrical'] });
    expect(!bad.ok && bad.error.hint).toMatch(/Walls, Doors, Furniture/);
    const missing = api.call('update_reference', { reference: 'First floor', visible: false });
    expect(!missing.ok && missing.error.hint).toMatch(/"Ground floor"/);
  });

  it('deletes, and undo brings the geometry back', async () => {
    const { api, doc } = await setup();
    const id = doc.references[0].id;
    expect(api.call('delete_reference', { reference: id }).ok).toBe(true);
    expect(doc.references).toHaveLength(0);
    doc.undo();
    expect(doc.geometryOf(doc.references[0].id)?.layers).toEqual(['Walls', 'Doors', 'Furniture']);
  });

  it('works inside apply_operations', async () => {
    const { api, doc } = await setup();
    const r = api.call('apply_operations', {
      label: 'trace',
      operations: [
        { name: 'update_reference', input: { reference: 'Ground floor', hide_layers: ['Furniture'] } },
        { name: 'add_box', input: { name: 'Wall', size: [4000, 250, 2500] } },
      ],
    });
    expect(r.ok).toBe(true);
    doc.undo();
    expect(doc.entities).toHaveLength(0);
    expect(doc.references[0].hiddenLayers).toEqual([]);
  });
});

describe('reference drawings in files and snapping', () => {
  it('round-trips through a project file, and undoing an open restores the old drawing', async () => {
    const { doc } = await setup();
    doc.updateReference(doc.references[0].id, (r) => (r.hiddenLayers = ['Doors']));
    const file = parseDocumentFile(JSON.stringify(doc.toFile()));
    expect(file.references?.[0]).toMatchObject({ name: 'Ground floor', units: 'mm', hiddenLayers: ['Doors'] });
    expect(file.references?.[0].geometry.paths).toHaveLength(3);

    const other = new ModelDocument();
    other.load(file, true);
    expect(other.geometryOf(other.references[0].id)?.paths).toHaveLength(3);

    // Replacing the model (undoably) and undoing brings back the old drawing with its lines.
    other.load({ format: 'modeler', version: 1, units: 'mm', entities: [] }, false, 'New');
    expect(other.references).toHaveLength(0);
    other.undo();
    expect(other.geometryOf(other.references[0].id)?.paths).toHaveLength(3);
  });

  it('drops malformed references from files', () => {
    const file = parseDocumentFile(
      JSON.stringify({
        format: 'modeler',
        entities: [],
        references: [
          { kind: 'drawing', name: 'ok', geometry: { layers: ['A'], paths: [{ layer: 0, points: [[0, 0], [1, 1]] }, { layer: 5, points: [[0, 0], [1, 1]] }, { layer: 0, points: [[0, 'x']] }] } },
          { kind: 'drawing', name: 'no geometry' },
          { kind: 'image' },
        ],
      }),
    );
    expect(file.references).toHaveLength(1);
    expect(file.references![0].geometry.paths).toHaveLength(1);
    expect(file.references![0].units).toBe('mm');
  });

  it('offers corners, midpoints and centres as snap points, in world space', async () => {
    const { doc } = await setup();
    const r = doc.references[0];
    doc.updateReference(r.id, (x) => {
      x.units = 'cm';
      x.position = [0, 0, 100];
    });
    const pts = referenceSnapPoints(doc.references[0], doc.geometryOf(r.id)!);
    const has = (x: number, y: number, kind: string) => pts.some((p) => p.kind === kind && p.point.distanceTo(new THREE.Vector3(x, y, 100)) < 1e-6);
    expect(has(40000, 30000, 'endpoint')).toBe(true); // room corner, ×10 for cm
    expect(has(20000, 0, 'midpoint')).toBe(true);
    expect(has(25000, 15000, 'center')).toBe(true); // table (circle)
    expect(has(10000, 0, 'center')).toBe(true); // door arc
    expect(has(19000, 0, 'endpoint')).toBe(true); // door arc end
    expect(pts.every((p) => p.entityId === r.id)).toBe(true);
    // A full circle gives only its centre, not 64 tessellation corners.
    expect(pts.length).toBeLessThan(15);

    doc.updateReference(r.id, (x) => (x.hiddenLayers = ['Walls', 'Doors', 'Furniture']));
    expect(referenceSnapPoints(doc.references[0], doc.geometryOf(r.id)!)).toHaveLength(0);
  });
});
