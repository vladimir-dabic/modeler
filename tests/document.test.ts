import { describe, expect, it } from 'vitest';
import { ModelDocument } from '../src/model/Document';
import { buildCutList, cutListToCsv } from '../src/model/cutlist';
import { exportStl, parseDocumentFile } from '../src/model/io';
import type { BoxEntity, CylinderEntity } from '../src/model/types';

const board = (id: string, size: [number, number, number], name = id): BoxEntity => ({
  id, name, kind: 'box', position: [0, 0, 0], rotation: [0, 0, 0], size, color: '#e9c98f', hole: false, visible: true,
});

describe('ModelDocument', () => {
  it('records one undo step per transaction', () => {
    const doc = new ModelDocument();
    doc.begin();
    doc.add(board('a', [10, 10, 10]));
    doc.update('a', (e) => ((e as BoxEntity).size[0] = 20));
    doc.commit();
    expect(doc.entities).toHaveLength(1);
    doc.undo();
    expect(doc.entities).toHaveLength(0);
    doc.redo();
    expect((doc.entities[0] as BoxEntity).size[0]).toBe(20);
  });

  it('cancel rolls back a transaction', () => {
    const doc = new ModelDocument();
    doc.add(board('a', [10, 10, 10]));
    doc.begin();
    doc.remove(['a']);
    doc.cancel();
    expect(doc.entities).toHaveLength(1);
    expect(doc.canRedo).toBe(false);
  });

  it('empty transactions do not create undo steps', () => {
    const doc = new ModelDocument();
    doc.begin();
    doc.commit();
    expect(doc.canUndo).toBe(false);
  });

  it('undo drops deleted entities from the selection', () => {
    const doc = new ModelDocument();
    doc.add(board('a', [10, 10, 10]));
    doc.setSelection(['a']);
    doc.undo();
    expect(doc.selection.size).toBe(0);
  });

  it('names entities sequentially', () => {
    const doc = new ModelDocument();
    doc.add(board('a', [1, 1, 1], 'Box 1'));
    doc.add(board('b', [1, 1, 1], 'Box 7'));
    expect(doc.nextName('box')).toBe('Box 8');
    expect(doc.nextName('cylinder')).toBe('Cylinder 1');
  });
});

describe('cut list', () => {
  it('groups identical parts regardless of orientation', () => {
    const rows = buildCutList([
      board('side1', [18, 300, 720], 'Side'),
      board('side2', [300, 720, 18], 'Side'),
      board('shelf', [564, 300, 18], 'Shelf'),
      { ...board('hole', [5, 5, 5]), hole: true },
    ]);
    expect(rows).toHaveLength(2);
    const sides = rows.find((r) => r.names.includes('Side'))!;
    expect(sides.quantity).toBe(2);
    expect([sides.thickness, sides.width, sides.length]).toEqual([18, 300, 720]);
  });

  it('exports CSV with escaping', () => {
    const csv = cutListToCsv(buildCutList([board('a', [18, 100, 200], 'Top, front')]), 'mm');
    expect(csv.split('\n')[1]).toBe('"Top, front",1,18,100,200,,,');
  });
});

describe('file io', () => {
  it('round-trips and drops invalid entities', () => {
    const doc = new ModelDocument();
    doc.add(board('a', [10, 20, 30]));
    const text = JSON.stringify({ ...doc.toFile(), entities: [...doc.toFile().entities, { kind: 'box', size: [-1, 2, 3] }, { kind: 'teapot' }] });
    const parsed = parseDocumentFile(text);
    expect(parsed.entities).toHaveLength(1);
    expect(parsed.entities[0]).toMatchObject({ id: 'a', size: [10, 20, 30] });
  });

  it('rejects foreign files', () => {
    expect(() => parseDocumentFile('{"hello": 1}')).toThrow();
  });

  it('exports binary STL with holes subtracted', () => {
    const solid = board('a', [20, 20, 10]);
    const hole: CylinderEntity = {
      id: 'h', name: 'Hole', kind: 'cylinder', position: [10, 10, -1], rotation: [0, 0, 0],
      radius: 3, height: 12, segments: 32, color: '#ff0000', hole: true, visible: true,
    };
    const plain = exportStl([solid], [solid], [])!;
    const cut = exportStl([solid], [solid, hole], [])!;
    const triangles = (buf: ArrayBuffer) => new DataView(buf).getUint32(80, true);
    expect(triangles(plain)).toBe(12);
    // The cut part has the box faces split around the hole plus the hole wall.
    expect(triangles(cut)).toBeGreaterThan(12 + 32);
    expect(cut.byteLength).toBe(84 + triangles(cut) * 50);
  });
});
