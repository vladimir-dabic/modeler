import { describe, expect, it } from 'vitest';
import { ModelerApi, type ApiResult } from '../src/api';
import { ModelDocument } from '../src/model/Document';
import { worldBounds } from '../src/model/geometry';
import { groupMembers } from '../src/model/groups';
import { parseDocumentFile } from '../src/model/io';
import type { BoxEntity, CylinderEntity } from '../src/model/types';

function setup(workspace: 'print' | 'workshop' | 'build' = 'workshop') {
  const doc = new ModelDocument();
  doc.workspace = workspace;
  const api = new ModelerApi(doc);
  const ok = (name: string, input: unknown = {}) => {
    const r = api.call(name, input, { source: 'test' });
    if (!r.ok) throw new Error(`${name} failed: ${r.error.code} ${r.error.message} ${r.error.hint ?? ''}`);
    return r as Extract<ApiResult, { ok: true }> & { data: any };
  };
  const err = (name: string, input: unknown = {}) => {
    const r = api.call(name, input, { source: 'test' });
    if (r.ok) throw new Error(`${name} unexpectedly succeeded`);
    return r.error;
  };
  const byName = (name: string) => doc.entities.find((e) => e.name === name)!;
  const bounds = (name: string) => worldBounds(byName(name));
  return { doc, api, ok, err, byName, bounds };
}

describe('create & validate', () => {
  it('adds a box with workspace defaults and returns its id', () => {
    const { doc, ok } = setup('workshop');
    const r = ok('add_box', { size: [18, 300, 720] });
    expect(r.data.ids).toHaveLength(1);
    const e = doc.get(r.data.ids[0]) as BoxEntity;
    expect(e).toMatchObject({ name: 'Box 1', position: [0, 0, 0], size: [18, 300, 720], color: '#e9c98f' });
    expect(r.changes?.added[0]).toContain('box 18×300×720');
    expect(doc.canUndo).toBe(true);
  });

  it('rejects bad input without touching the model, with a usable message', () => {
    const { doc, err } = setup();
    const e = err('add_box', { size: [18, -5, 720] });
    expect(e.code).toBe('invalid_input');
    expect(e.path).toBe('size.1');
    expect(doc.entities).toHaveLength(0);
    expect(doc.canUndo).toBe(false);
    expect(err('add_bx', {}).code).toBe('not_found');
  });

  it('cylinder by diameter along an axis', () => {
    const { doc, ok } = setup('print');
    const id = ok('add_cylinder', { diameter: 3.4, height: 12, axis: 'x', hole: true }).data.ids[0];
    const c = doc.get(id) as CylinderEntity;
    expect(c.radius).toBe(1.7);
    expect(c.segments).toBe(64);
    expect(c.rotation).toEqual([0, 90, 0]);
    const b = worldBounds(c);
    expect(b.max.x).toBeCloseTo(12);
  });

  it('update_entity checks that keys fit the part', () => {
    const { ok, err } = setup();
    const id = ok('add_cylinder', { radius: 5, height: 10 }).data.ids[0];
    const e = err('update_entity', { id, set: { size: [1, 2, 3] } });
    expect(e.message).toMatch(/only applies to boxes/);
    ok('update_entity', { id, set: { diameter: 20 } });
  });
});

describe('selectors', () => {
  it('resolves names, wildcards, filters and reports ambiguity with ids', () => {
    const { ok, err } = setup();
    ok('add_box', { name: 'Shelf', size: [500, 250, 18] });
    ok('add_box', { name: 'Shelf', size: [500, 250, 18], position: [0, 0, 200] });
    ok('add_box', { name: 'Side', size: [18, 250, 700] });
    ok('add_cylinder', { name: 'Pin hole', radius: 2, height: 20, hole: true });
    const amb = err('set_color', { target: { name: 'shelf' }, color: '#ff0000' });
    expect(amb.code).toBe('ambiguous');
    expect(amb.hint).toMatch(/wildcard/);
    expect(ok('set_color', { target: { name: 'Shelf*' }, color: '#ff0000' }).data.ids).toHaveLength(2);
    expect(ok('get_entities', { target: { hole: true } }).data.parts).toHaveLength(1);
    expect(ok('get_entities', { target: { kind: 'box' } }).data.parts).toHaveLength(3);
    const nf = err('move', { target: { name: 'Lid' }, by: [0, 0, 1] });
    expect(nf.code).toBe('not_found');
    expect(nf.hint).toMatch(/"Shelf"/);
  });
});

describe('atomic batches with $aliases', () => {
  it('builds the documented bookcase in one call and one undo step', () => {
    const { doc, ok, bounds } = setup('workshop');
    const r = ok('apply_operations', {
      operations: [
        { name: 'add_box', as: 'bottom', input: { name: 'Bottom', position: [0, 0, 0], size: [600, 300, 18] } },
        { name: 'add_box', as: 'left', input: { name: 'Side', position: [0, 0, 18], size: [18, 300, 700] } },
        { name: 'mirror', as: 'right', input: { target: { ids: ['$left'] }, plane: 'x', about: '$bottom', keep_original: true } },
        { name: 'add_box', as: 'top', input: { name: 'Top', size: [600, 300, 18] } },
        { name: 'place', input: { target: { ids: ['$top'] }, relative_to: { ids: ['$left'] }, side: 'top', align: 'min' } },
        { name: 'add_box', as: 'shelf', input: { name: 'Shelf', position: [18, 0, 0], size: [564, 280, 18] } },
        { name: 'distribute', as: 'shelves', input: { target: { ids: ['$shelf'] }, count: 4, between: [{ ids: ['$bottom'] }, { ids: ['$top'] }], axis: 'z', mode: 'even' } },
        { name: 'group', input: { target: { ids: ['$bottom', '$left', '$right', '$top', '$shelves'] }, name: 'Bookcase' } },
      ],
    });
    expect(r.data.steps).toBe(8);
    expect(doc.entities).toHaveLength(8);
    // Right side mirrored about the bottom's centre (x = 300): spans 582..600.
    const sides = doc.entities.filter((e) => e.name.startsWith('Side')).map((e) => worldBounds(e));
    expect(sides.map((b) => [b.min.x, b.max.x]).sort()).toEqual([[0, 18], [582, 600]]);
    // Top sits on the sides.
    expect(bounds('Top').min.z).toBe(718);
    // Four shelves with equal gaps between bottom (z 18) and top (z 718).
    const shelves = doc.entities.filter((e) => e.name.startsWith('Shelf')).map((e) => worldBounds(e).min.z).sort((a, b) => a - b);
    expect(shelves).toHaveLength(4);
    const gap = (700 - 4 * 18) / 5;
    shelves.forEach((z, i) => expect(z).toBeCloseTo(18 + gap * (i + 1) + 18 * i, 6));
    // All in one group, one undo step.
    expect(doc.groups).toEqual([expect.objectContaining({ name: 'Bookcase' })]);
    expect(doc.entities.every((e) => e.groupId === doc.groups[0].id)).toBe(true);
    doc.undo();
    expect(doc.entities).toHaveLength(0);
    expect(doc.groups).toHaveLength(0);
  });

  it('rolls everything back when a later step fails, and says which step', () => {
    const { doc, err } = setup();
    const e = err('apply_operations', {
      operations: [
        { name: 'add_box', as: 'a', input: { size: [10, 10, 10] } },
        { name: 'move', input: { target: { ids: ['$a'] }, by: [5, 0, 0] } },
        { name: 'add_box', input: { size: [10, 0, 10] } },
      ],
    });
    expect(e.message).toMatch(/^step 3 \(add_box\)/);
    expect(e.path).toBe('operations.2.input.size.1');
    expect(doc.entities).toHaveLength(0);
    expect(doc.canUndo).toBe(false);
  });

  it('rejects unknown aliases and history ops inside a batch', () => {
    const { err } = setup();
    expect(err('apply_operations', { operations: [{ name: 'move', input: { target: { ids: ['$nope'] }, by: [1, 0, 0] } }] }).message).toMatch(/Unknown alias/);
    expect(err('apply_operations', { operations: [{ name: 'undo', input: {} }] }).message).toMatch(/inside a batch/);
  });
});

describe('patterns, mirror, place, distribute', () => {
  it('duplicate patterns: counts include the original', () => {
    const { doc, ok } = setup('print');
    const id = ok('add_cylinder', { name: 'Bolt hole', radius: 2, height: 10, position: [80, 50, 0], hole: true }).data.ids[0];
    ok('duplicate', { target: { ids: [id] }, pattern: { radial: { count: 6, center: [50, 50, 0] } } });
    const holes = doc.entities.filter((e) => e.hole);
    expect(holes).toHaveLength(6);
    for (const h of holes) expect(Math.hypot(h.position[0] - 50, h.position[1] - 50)).toBeCloseTo(30, 6);

    ok('add_box', { name: 'Slat', size: [10, 100, 2] });
    ok('duplicate', { target: { name: 'Slat' }, pattern: { linear: { count: 5, span: [400, 0, 0] } } });
    const slats = doc.entities.filter((e) => e.name.startsWith('Slat')).map((e) => e.position[0]).sort((a, b) => a - b);
    expect(slats).toEqual([0, 100, 200, 300, 400]);

    ok('add_box', { name: 'Peg', size: [5, 5, 5], position: [0, 0, 100] });
    expect(ok('duplicate', { target: { name: 'Peg' }, pattern: { grid: { counts: [3, 2], step: [20, 20, 0] } } }).data.ids).toHaveLength(5);
  });

  it('mirror keeps boxes rotation-free and handles outlines', () => {
    const { doc, ok } = setup();
    ok('add_box', { name: 'A', position: [10, 0, 0], size: [20, 5, 5] });
    const copy = doc.get(ok('mirror', { target: { name: 'A' }, plane: 'x', about: 0 }).data.ids[0]) as BoxEntity;
    expect(copy.position).toEqual([-30, 0, 0]);
    expect(copy.rotation).toEqual([0, 0, 0]);
    ok('add_shape', { name: 'L', points: [[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]], height: 5, position: [0, 100, 0] });
    const m = doc.get(ok('mirror', { target: { name: 'L' }, plane: 'y', about: 90 }).data.ids[0])!;
    const b = worldBounds(m);
    expect([b.min.y, b.max.y]).toEqual([50, 80]);
  });

  it('place puts a lid on top, centred', () => {
    const { ok, bounds } = setup('print');
    ok('add_box', { name: 'Box', position: [20, 20, 0], size: [60, 40, 30] });
    ok('add_box', { name: 'Lid', size: [64, 44, 3] });
    ok('place', { target: { name: 'Lid' }, relative_to: { name: 'Box' }, side: 'top' });
    const lid = bounds('Lid');
    expect([lid.min.x, lid.min.y, lid.min.z]).toEqual([18, 18, 30]);
  });

  it('distribute reports parts that do not fit', () => {
    const { ok, err } = setup();
    ok('add_box', { name: 'Bottom', size: [100, 100, 10] });
    ok('add_box', { name: 'Top', position: [0, 0, 50], size: [100, 100, 10] });
    ok('add_box', { name: 'Shelf', size: [100, 100, 10] });
    const e = err('distribute', { target: { name: 'Shelf' }, count: 5, between: [{ name: 'Bottom' }, { name: 'Top' }], axis: 'z' });
    expect(e.code).toBe('invalid_geometry');
  });
});

describe('groups', () => {
  it('group, select as unit, duplicate as a new group, ungroup', () => {
    const { doc, ok } = setup();
    ok('add_box', { name: 'Front', size: [400, 18, 150] });
    ok('add_box', { name: 'Back', position: [0, 400, 0], size: [400, 18, 150] });
    const g = ok('group', { target: { name: '*' }, name: 'Drawer' }).data.group;
    expect(groupMembers(g, doc.entities, doc.groups)).toHaveLength(2);

    const copies = ok('duplicate', { target: { group: 'Drawer' }, pattern: { offsets: [[0, 0, 200]] } }).data.ids;
    expect(copies).toHaveLength(2);
    expect(doc.groups).toHaveLength(2);
    expect(doc.groups[1].name).toBe('Drawer 2');
    // Copies inside a copied group keep their names.
    expect(copies.map((id: string) => doc.get(id)!.name).sort()).toEqual(['Back', 'Front']);

    // Nested: group the two drawers into a chest.
    const chest = ok('group', { target: { name: 'Drawer*' }, name: 'Chest' }).data.group;
    expect(doc.groups.filter((x) => x.parentId === chest)).toHaveLength(2);
    expect(ok('get_scene', { detail: 'outline' }).data.lines).toEqual([expect.stringMatching(/"Chest" \[group, 4 parts\]/)]);

    ok('ungroup', { group: 'Chest' });
    expect(doc.groups.every((x) => !x.parentId)).toBe(true);
    ok('delete_entities', { target: { group: 'Drawer 2' } });
    expect(doc.groups.map((x) => x.name)).toEqual(['Drawer']);
  });

  it('groups survive save/load', () => {
    const { doc, ok } = setup();
    ok('add_box', { name: 'A', size: [1, 1, 1] });
    ok('group', { target: { name: 'A' }, name: 'G' });
    const loaded = parseDocumentFile(JSON.stringify(doc.toFile()));
    expect(loaded.groups).toEqual([expect.objectContaining({ name: 'G' })]);
    expect(loaded.entities[0].groupId).toBe(loaded.groups![0].id);
  });
});

describe('workspace awareness and tool definitions', () => {
  it('warns about print problems on the parts it touched', () => {
    const { ok } = setup('print');
    const r = ok('add_box', { name: 'Arm', position: [200, 0, 0], size: [120, 20, 10] });
    expect(r.warnings?.[0]).toMatch(/off the bed/);
    expect(ok('check_print').data.problems).toHaveLength(1);
  });

  it('set_workspace changes display units and notifies listeners', () => {
    const { doc, ok } = setup('print');
    const seen: string[] = [];
    doc.onSettingsChange((c) => seen.push(c));
    ok('set_workspace', { workspace: 'build' });
    expect(doc.units).toBe('cm');
    expect(seen).toEqual(['units', 'workspace']);
  });

  it('every operation has a description and a JSON Schema', () => {
    const { api } = setup();
    const tools = api.toolDefinitions();
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    expect(tools.length).toBeGreaterThan(30);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.input_schema.type).toBe('object');
      expect(() => JSON.stringify(t)).not.toThrow();
    }
    const box = tools.find((t) => t.name === 'add_box')!;
    expect(box.input_schema.required).toEqual(['size']);
  });
});
