import { describe, expect, it } from 'vitest';
import { ModelerApi } from '../src/api';
import { ModelDocument } from '../src/model/Document';
import { copyParts, parseClip } from '../src/model/clipboard';

const ok = (r: any) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.data;
};

function source() {
  const api = new ModelerApi(new ModelDocument());
  ok(api.call('apply_operations', {
    operations: [
      { name: 'add_box', input: { name: 'Side', size: [18, 300, 600] }, as: 's1' },
      { name: 'add_box', input: { name: 'Side', size: [18, 300, 600], position: [582, 0, 0] }, as: 's2' },
      { name: 'add_box', input: { name: 'Top', size: [600, 300, 18], position: [0, 0, 600] }, as: 't' },
      { name: 'add_cylinder', input: { name: 'Hole', position: [300, 150, 600], radius: 5, height: 18, hole: true }, as: 'h' },
      { name: 'group', input: { target: { ids: ['$s1', '$s2', '$t', '$h'] }, name: 'Cabinet' } },
      { name: 'add_box', input: { name: 'Lamp', size: [100, 100, 100], position: [250, 100, 618] }, as: 'lamp' },
      { name: 'add_note', input: { text: 'Oak', at: { part: '$t' } } },
      { name: 'add_dimension', input: { from: { part: '$lamp', at: [0, 0, 0] }, to: [900, 0, 0] } },
    ],
  }));
  return api;
}

const copyAll = (api: ModelerApi) => JSON.stringify(copyParts(api.doc.entities, api.doc.entities, api.doc.groups, api.doc.annotations));

describe('copy and paste', () => {
  it('pastes into another document with new ids, groups and attached notes, in place', () => {
    const from = source();
    const text = copyAll(from);
    const to = new ModelerApi(new ModelDocument());
    const data = ok(to.call('paste', { data: text }));
    expect(data).toMatchObject({ parts: 5, groups: 1, annotations: 2, moved: [0, 0, 0] });
    expect(to.doc.entities.map((e) => e.name)).toEqual(['Side', 'Side', 'Top', 'Hole', 'Lamp']);
    const fromIds = new Set(from.doc.entities.map((e) => e.id));
    expect(to.doc.entities.some((e) => fromIds.has(e.id))).toBe(false);
    // The group came along, with the parts inside it; the hole stays a hole.
    expect(to.doc.groups.map((g) => g.name)).toEqual(['Cabinet']);
    expect(to.doc.entities.filter((e) => e.groupId === to.doc.groups[0].id)).toHaveLength(4);
    expect(to.doc.entities.find((e) => e.name === 'Hole')!.hole).toBe(true);
    // The note on the top follows the new top; the dimension from the lamp to a fixed point comes along too.
    const note = to.doc.annotations.find((a) => a.kind === 'note') as any;
    expect(note.kind).toBe('note');
    expect(note.anchor.entity).toBe(to.doc.entities.find((e) => e.name === 'Top')!.id);
    expect(to.doc.undoLabel).toBe('Paste');
  });

  it('goes beside the model when its own place is taken (pasting into the same model)', () => {
    const api = source();
    const text = copyAll(api);
    const data = ok(api.call('paste', { data: text }));
    // Right of the 600 mm wide model, with a gap of a tenth of its width.
    expect(data.moved).toEqual([660, 0, 0]);
    expect(api.doc.entities).toHaveLength(10);
    // An explicit offset wins.
    expect(ok(api.call('paste', { data: text, offset: [0, 1000, 0] })).moved).toEqual([0, 1000, 0]);
  });

  it('keeps only whole groups: parts of a partly copied group come loose', () => {
    const api = source();
    const tops = api.doc.entities.filter((e) => e.name === 'Top');
    const clip = copyParts(tops, api.doc.entities, api.doc.groups, api.doc.annotations);
    expect(clip.groups).toEqual([]);
    expect(clip.entities[0].groupId).toBeUndefined();
    expect(clip.annotations.map((a) => a.kind)).toEqual(['note']);
  });

  it('pastes into the open group', () => {
    const api = source();
    const lamp = api.doc.entities.filter((e) => e.name === 'Lamp');
    const text = JSON.stringify(copyParts(lamp, api.doc.entities, api.doc.groups, api.doc.annotations));
    api.doc.setOpenGroup(api.doc.groups[0].id);
    const data = ok(api.call('paste', { data: text }));
    expect(api.doc.get(data.ids[0])!.groupId).toBe(api.doc.groups[0].id);
  });

  it('refuses text that is not copied parts, and drops unusable parts', () => {
    const api = new ModelerApi(new ModelDocument());
    expect(parseClip('hello')).toBeNull();
    expect(parseClip('{"format":"other","entities":[]}')).toBeNull();
    const r = api.call('paste', { data: 'hello' }) as any;
    expect(r.ok).toBe(false);
    expect(r.error.hint).toMatch(/Copy parts/);
    const bad = JSON.stringify({ format: 'modeler-clipboard', version: 1, entities: [{ kind: 'box', size: [-1, 2, 3] }], groups: [], annotations: [] });
    expect((api.call('paste', { data: bad }) as any).error.message).toMatch(/no usable parts/);
  });
});
