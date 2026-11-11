import { describe, expect, it } from 'vitest';
import { ModelerApi } from '../src/api';
import { annotationVisible, anchorFor, dimensionGeometry, dimensionText, resolveAnchor } from '../src/model/annotations';
import { ModelDocument } from '../src/model/Document';
import { parseDocumentFile } from '../src/model/io';
import type { DimensionAnnotation, NoteAnnotation } from '../src/model/types';
import * as THREE from 'three';

function cabinet() {
  const api = new ModelerApi(new ModelDocument());
  const r = api.call('apply_operations', {
    operations: [
      { name: 'add_box', input: { name: 'Left side', size: [18, 300, 700] } },
      { name: 'add_box', input: { name: 'Right side', size: [18, 300, 700], position: [582, 0, 0] } },
      { name: 'add_box', input: { name: 'Top', size: [564, 300, 18], position: [18, 0, 682] } },
      { name: 'group', input: { target: { all: true }, name: 'Cabinet' } },
    ],
  });
  if (!r.ok) throw new Error(JSON.stringify(r));
  const doc = api.doc;
  const get = (id: string) => doc.get(id);
  const byName = (n: string) => doc.entities.find((e) => e.name === n)!;
  return { api, doc, get, byName };
}

const ok = (r: any) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.data;
};

describe('anchors', () => {
  it('follow a part through moves, rotations and resizes', () => {
    const { api, doc, get, byName } = cabinet();
    const top = byName('Top');
    // Top-centre by default.
    expect(ok(api.call('add_note', { text: 'Oak top, 18 mm', at: { part: 'Top' } })).annotation).toMatch(/note "Oak top, 18 mm" on "Top"/);
    const note = doc.annotations[0] as NoteAnnotation;
    expect(resolveAnchor(note.anchor, get)!.toArray()).toEqual([300, 150, 700]);
    api.call('move', { target: { ids: [top.id] }, by: [0, 0, 100] });
    expect(resolveAnchor(note.anchor, get)!.toArray()).toEqual([300, 150, 800]);
    ok(api.call('update_entity', { id: top.id, set: { size: [1000, 300, 18] } }));
    expect(resolveAnchor(note.anchor, get)!.x).toBeCloseTo(518);
    api.call('rotate', { target: { ids: [top.id] }, angle: 90, pivot: [18, 0, 782] });
    const p = resolveAnchor(note.anchor, get)!;
    expect([p.x, p.y, p.z].map(Math.round)).toEqual([-132, 500, 800]);
  });

  it('anchorFor inverts resolveAnchor, also on rotated parts', () => {
    const { doc, get, byName } = cabinet();
    doc.update(byName('Top').id, (e) => (e.rotation = [0, 0, 30]));
    const point = new THREE.Vector3(100, 50, 690);
    const a = anchorFor(point, byName('Top'));
    expect(resolveAnchor(a, get)!.distanceTo(point)).toBeLessThan(1e-3);
    expect(anchorFor(point)).toEqual({ point: [100, 50, 690] });
  });
});

describe('add_dimension / dimension_parts', () => {
  it('measures along an axis between parts and updates when they change', () => {
    const { api, doc, get, byName } = cabinet();
    const r = ok(api.call('add_dimension', { from: { part: 'Left side', at: [0, 0, 1] }, to: { part: 'Right side', at: [1, 0, 1] }, axis: 'x' }));
    expect(r.annotation).toMatch(/dimension 600 along x: "Left side" at 0,0,1 → "Right side" at 1,0,1, offset 0,0,90/);
    const d = doc.annotations[0] as DimensionAnnotation;
    // Default: 15% of the length, away from the parts' centre (up, from the top corners).
    expect(d.offset).toEqual([0, 0, 90]);
    api.call('move', { target: { name: 'Right side' }, by: [200, 0, 0] });
    expect(dimensionGeometry(d, get)!.value).toBe(800);
    expect(dimensionText({ ...d, text: 'W <> mm' }, '800')).toBe('W 800 mm');
    // Deleting a part deletes its dimension in the same undo step.
    api.call('delete_entities', { target: { ids: [byName('Right side').id] } });
    expect(doc.annotations).toHaveLength(0);
    doc.undo();
    expect(doc.annotations).toHaveLength(1);
    expect(doc.get(byName('Right side').id)).toBeDefined();
  });

  it('true-distance dimensions between world points, with a chosen side', () => {
    const api = new ModelerApi(new ModelDocument());
    const r = ok(api.call('add_dimension', { from: [0, 0, 0], to: [300, 400, 0], side: '+z', offset: 50, text: 'diag <>' }));
    expect(r.annotation).toMatch(/dimension 500: 0,0,0 → 300,400,0, offset 0,0,50 text "diag <>"/);
    const same = api.call('add_dimension', { from: [0, 0, 0], to: [0, 100, 0], axis: 'x' });
    expect(!same.ok && same.error.code).toBe('invalid_geometry');
    const along = api.call('add_dimension', { from: [0, 0, 0], to: [100, 0, 0], side: '-x' });
    expect(!along.ok && along.error.path).toBe('side');
  });

  it('dimension_parts gives overall sizes of a group, attached to its outermost parts', () => {
    const { api, doc, get, byName } = cabinet();
    const r = ok(api.call('dimension_parts', { target: { group: 'Cabinet' } }));
    expect(r.annotations).toHaveLength(3);
    const values = () => doc.annotations.map((a) => dimensionGeometry(a as DimensionAnnotation, get)!.value);
    expect(values()).toEqual([600, 300, 700]);
    expect(doc.undoLabel).toBe('Dimension parts');
    // Widen the cabinet: the width dimension follows.
    api.call('move', { target: { name: 'Right side' }, by: [100, 0, 0] });
    ok(api.call('update_entity', { id: byName('Top').id, set: { size: [664, 300, 18] } }));
    expect(values()).toEqual([700, 300, 700]);
    expect((ok(api.call('get_scene')) as any).annotations).toHaveLength(3);
  });
});

describe('update_annotation / delete_annotations', () => {
  it('edits text and offsets with clear errors', () => {
    const { api, doc } = cabinet();
    api.call('add_note', { text: 'A', at: [0, 0, 0] });
    api.call('add_dimension', { from: [0, 0, 0], to: [600, 0, 0], axis: 'x' });
    const [note, dim] = doc.annotations;
    ok(api.call('update_annotation', { id: note.id, text: 'Front', label_offset: [0, -100, 50] }));
    expect(doc.getAnnotation(note.id)).toMatchObject({ text: 'Front', offset: [0, -100, 50] });
    ok(api.call('update_annotation', { id: dim.id, offset: 40, side: '-y', text: '<> mm' }));
    expect(doc.getAnnotation(dim.id)).toMatchObject({ offset: [0, -40, 0], text: '<> mm' });
    ok(api.call('update_annotation', { id: dim.id, text: '' }));
    expect((doc.getAnnotation(dim.id) as DimensionAnnotation).text).toBeUndefined();
    const bad = api.call('update_annotation', { id: note.id, offset: 5 });
    expect(!bad.ok && bad.error.message).toMatch(/label_offset/);
    const empty = api.call('update_annotation', { id: note.id, text: '  ' });
    expect(!empty.ok && empty.error.hint).toMatch(/delete_annotations/);
    expect(!api.call('update_annotation', { id: 'nope' }).ok).toBe(true);
    expect(ok(api.call('delete_annotations', { all: true })).removed).toBe(2);
    doc.undo();
    expect(doc.annotations).toHaveLength(2);
  });

  it('notes need text and a known part', () => {
    const api = new ModelerApi(new ModelDocument());
    expect(api.call('add_note', { text: '', at: [0, 0, 0] }).ok).toBe(false);
    const missing = api.call('add_note', { text: 'x', at: { part: 'Shelf' } });
    expect(!missing.ok && missing.error.code).toBe('not_found');
  });
});

describe('annotations in the document', () => {
  it('round-trip through files; dangling anchors are dropped', () => {
    const { api, doc, byName } = cabinet();
    api.call('dimension_parts', { target: { all: true }, axes: ['x'] });
    api.call('add_note', { text: 'Top', at: { part: 'Top' }, label_offset: [0, 0, 100] });
    const file = parseDocumentFile(JSON.stringify(doc.toFile()));
    expect(file.annotations).toHaveLength(2);
    const raw = doc.toFile();
    raw.entities = raw.entities.filter((e) => e.id !== byName('Top').id);
    raw.annotations!.push({ id: 'zz', kind: 'note', text: '', anchor: { point: [0, 0, 0] }, offset: [0, 0, 0] });
    expect(parseDocumentFile(JSON.stringify(raw)).annotations?.map((a) => a.kind)).toEqual(['dimension']);
  });

  it('hidden parts hide their annotations; part and annotation selections are exclusive', () => {
    const { api, doc, get, byName } = cabinet();
    api.call('add_note', { text: 'Top', at: { part: 'Top' } });
    const note = doc.annotations[0];
    api.call('set_visible', { target: { name: 'Top' }, visible: false });
    expect(annotationVisible(note, get)).toBe(false);
    doc.setSelection([byName('Top').id]);
    doc.selectAnnotations([note.id]);
    expect(doc.selection.size).toBe(0);
    expect([...doc.annotationSelection]).toEqual([note.id]);
    doc.setSelection([byName('Left side').id]);
    expect(doc.annotationSelection.size).toBe(0);
  });
});
