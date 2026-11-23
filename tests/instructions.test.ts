import { describe, expect, it } from 'vitest';
import { ModelerApi } from '../src/api';
import { ModelDocument } from '../src/model/Document';
import { letterFor, parseInstructions, partTypes, resolveInstructions } from '../src/model/instructions';
import { parseDocumentFile } from '../src/model/io';

const ok = (r: any) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.data;
};

/** A small coffee table: top, 4 legs, 2 + 2 aprons, a shelf. */
function table() {
  const api = new ModelerApi(new ModelDocument());
  ok(api.call('apply_operations', {
    operations: [
      { name: 'add_box', input: { name: 'Top', size: [1000, 600, 25], position: [0, 0, 400], color: '#c8a165' } },
      { name: 'add_box', input: { name: 'Leg', size: [50, 50, 400], position: [30, 30, 0], color: '#8b5a2b' }, as: 'leg' },
      { name: 'duplicate', input: { target: { ids: ['$leg'] }, pattern: { grid: { counts: [2, 2, 1], step: [890, 490, 0] } } } },
      { name: 'add_box', input: { name: 'Long apron', size: [840, 20, 80], position: [80, 45, 320], color: '#8b5a2b' }, as: 'a1' },
      { name: 'duplicate', input: { target: { ids: ['$a1'] }, pattern: { offsets: [[0, 490, 0]] } } },
      // Same size as the long aprons, but rotated: still the same letter.
      { name: 'add_box', input: { name: 'Short apron', size: [440, 20, 80], position: [65, 80, 320], rotation: [0, 0, 90], color: '#8b5a2b' }, as: 'a2' },
      { name: 'duplicate', input: { target: { ids: ['$a2'] }, pattern: { offsets: [[890, 0, 0]] } } },
      { name: 'add_box', input: { name: 'Shelf', size: [890, 490, 18], position: [55, 55, 120], color: '#c8a165' } },
      { name: 'add_cylinder', input: { name: 'Dowel hole', position: [500, 300, 400], radius: 4, height: 10, hole: true } },
    ],
  }));
  return api;
}

describe('build instructions: parts', () => {
  it('letters identical parts (size, shape, colour), biggest first, copies share a base name', () => {
    const api = table();
    const types = partTypes(api.doc.entities);
    expect(types.map((t) => [t.letter, t.name, t.quantity, t.dims])).toEqual([
      ['A', 'Leg', 4, [50, 50, 400]],
      ['B', 'Top', 1, [25, 600, 1000]],
      ['C', 'Long apron', 2, [20, 80, 840]],
      ['D', 'Short apron', 2, [20, 80, 440]],
      ['E', 'Shelf', 1, [18, 490, 890]],
    ]);
    // Holes are not parts.
    expect(types.flatMap((t) => t.ids)).toHaveLength(10);
  });

  it('counts letters past Z', () => {
    expect([0, 25, 26, 27, 51, 52].map(letterFor)).toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA']);
  });
});

describe('build instructions: steps', () => {
  it('suggests steps bottom-up, one per letter, each listing what is already in place', () => {
    const api = table();
    const r = resolveInstructions(api.doc.entities, null, 'Coffee table');
    expect(r.suggested).toBe(true);
    expect(r.title).toBe('Coffee table');
    expect(r.size).toEqual([1000, 600, 425]);
    expect(r.steps.map((s) => s.letters.map((l) => `${l.count}${l.letter}`).join())).toEqual(['4A', '1E', '2C', '2D', '1B']);
    expect(r.steps[2].before).toHaveLength(5);
    expect(r.warnings).toEqual([]);
  });

  it('stores steps through the API as one undo step, with targets and texts', () => {
    const api = table();
    const data = ok(api.call('set_instructions', {
      title: 'Klub sto',
      language: 'sr',
      steps: [
        { parts: { name: 'Leg*' }, text: 'Postavite noge A.' },
        { text: 'Okrenite sto naopako.' },
        { parts: { name: '*apron*' }, text: 'Spojite štikle C i D.' },
      ],
    }));
    expect(data).toMatchObject({ title: 'Klub sto', language: 'sr', suggested: false });
    expect(data.steps).toEqual([
      { n: 1, add: '4×A Leg', text: 'Postavite noge A.' },
      { n: 2, add: '', text: 'Okrenite sto naopako.' },
      { n: 3, add: '2×C Long apron, 2×D Short apron', text: 'Spojite štikle C i D.' },
      { n: 4, add: '1×B Top, 1×E Shelf' },
    ]);
    expect(data.warnings[0]).toMatch(/Not in any step.*Top.*Shelf|Not in any step.*Shelf.*Top/);
    expect(api.doc.undoLabel).toBe('Set instructions');

    // Only given fields change; steps: null goes back to suggestions.
    ok(api.call('set_instructions', { intro: 'Za dnevnu sobu.' }));
    expect(api.doc.instructions).toMatchObject({ title: 'Klub sto', intro: 'Za dnevnu sobu.', language: 'sr' });
    ok(api.call('set_instructions', { steps: null, intro: null }));
    expect(api.doc.instructions).toEqual({ title: 'Klub sto', language: 'sr' });

    api.doc.undo();
    api.doc.undo();
    expect(api.doc.instructions?.steps).toHaveLength(3);
  });

  it('drops deleted parts from stored steps and rejects empty steps', () => {
    const api = table();
    ok(api.call('set_instructions', { steps: [{ parts: { name: 'Shelf' }, text: 'Shelf first.' }, { parts: { all: true } }] }));
    ok(api.call('delete_entities', { target: { name: 'Shelf' } }));
    const r = resolveInstructions(api.doc.entities, api.doc.instructions);
    // The shelf's step keeps its text, without parts.
    expect(r.steps[0]).toMatchObject({ add: [], text: 'Shelf first.' });
    expect(r.steps[1].add).toHaveLength(9);
    const bad = api.call('set_instructions', { steps: [{}] }) as any;
    expect(bad.ok).toBe(false);
    expect(bad.error.message).toMatch(/neither parts nor text/);
  });

  it('is saved with the project and validated on open', () => {
    const api = table();
    ok(api.call('set_instructions', { title: 'Table', steps: [{ parts: { name: 'Leg*' }, text: 'Legs.' }] }));
    const file = parseDocumentFile(JSON.stringify(api.doc.toFile()));
    expect(file.instructions).toEqual(api.doc.instructions);
    expect(parseInstructions({ title: 5, language: 'xx', steps: [{ parts: 'no' }, { parts: [], text: '  ' }] })).toBeNull();
  });

  it('get_instructions hints when the steps are only suggested', () => {
    const api = table();
    const data = ok(api.call('get_instructions', {}));
    expect(data.suggested).toBe(true);
    expect(data.hint).toMatch(/set_instructions/);
    expect(data.parts[0]).toMatchObject({ letter: 'A', name: 'Leg', qty: 4, t_w_l: [50, 50, 400] });
  });
});

/** Two pieces of furniture in one project: the table as one group, a stool beside it as another. */
function tableAndStool() {
  const api = table();
  ok(api.call('apply_operations', {
    operations: [
      { name: 'group', input: { name: 'Table', target: { all: true } } },
      { name: 'add_box', input: { name: 'Seat', size: [350, 350, 25], position: [1500, 0, 425], color: '#c8a165' }, as: 'seat' },
      { name: 'add_box', input: { name: 'Stool leg', size: [40, 40, 425], position: [1510, 10, 0], color: '#8b5a2b' }, as: 'sl' },
      { name: 'duplicate', input: { target: { ids: ['$sl'] }, pattern: { grid: { counts: [2, 2, 1], step: [290, 290, 0] } } }, as: 'sls' },
      { name: 'group', input: { name: 'Stool', target: { ids: ['$seat', '$sl', '$sls'] } } },
    ],
  }));
  return api;
}

describe('build instructions: one booklet per piece of furniture', () => {
  it('get_instructions for a group covers only its parts, titled after it', () => {
    const api = tableAndStool();
    const all = ok(api.call('get_instructions', {}));
    expect(all.booklets).toMatch(/"Table", "Stool"/);
    const stool = ok(api.call('get_instructions', { group: 'Stool' }));
    expect(stool).toMatchObject({ group: 'Stool', title: 'Stool', size_mm: [350, 350, 450] });
    expect(stool.parts.map((p: any) => `${p.qty}×${p.name}`)).toEqual(['4×Stool leg', '1×Seat']);
    expect(stool.booklets).toBeUndefined();
  });

  it('set_instructions with group stores that booklet apart, inherits the language and keeps to its parts', () => {
    const api = tableAndStool();
    ok(api.call('set_instructions', { title: 'Sto i stolica', language: 'sr' }));
    const data = ok(api.call('set_instructions', { group: 'Stool', steps: [{ parts: { name: '*leg*' }, text: 'Noge.' }, { parts: { name: 'Seat' } }] }));
    expect(data.language).toBe('sr');
    expect(data.steps).toEqual([{ n: 1, add: '4×A Stool leg', text: 'Noge.' }, { n: 2, add: '1×B Seat' }]);
    const stoolId = api.doc.groups.find((g) => g.name === 'Stool')!.id;
    expect(api.doc.instructions).toMatchObject({ title: 'Sto i stolica', language: 'sr', groups: { [stoolId]: { steps: [{ text: 'Noge.' }, {}] } } });
    expect(api.doc.instructions!.steps).toBeUndefined(); // the whole-model booklet is untouched
    // Survives save and open.
    expect(parseDocumentFile(JSON.stringify(api.doc.toFile())).instructions).toEqual(api.doc.instructions);
    // A step whose parts are all in another piece is an error.
    const bad = api.call('set_instructions', { group: 'Stool', steps: [{ parts: { name: 'Shelf' } }] }) as any;
    expect(bad.ok).toBe(false);
    expect(bad.error.message).toMatch(/none of its parts are in "Stool"/);
    // steps: null on the group goes back to suggested steps and drops the empty entry.
    ok(api.call('set_instructions', { group: 'Stool', steps: null }));
    expect(api.doc.instructions).toEqual({ title: 'Sto i stolica', language: 'sr' });
  });

  it('booklets are for top-level groups only', () => {
    const api = tableAndStool();
    ok(api.call('group', { name: 'Legs', target: { name: 'Leg*' } }));
    const bad = api.call('get_instructions', { group: 'Legs' }) as any;
    expect(bad.ok).toBe(false);
    expect(bad.error.hint).toMatch(/"Table"/);
  });
});
