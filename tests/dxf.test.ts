import { describe, expect, it } from 'vitest';
import { DxfError, parseDxf } from '../src/model/dxf';
import type { DrawingPath, Vec2 } from '../src/model/types';

/** Build an ASCII DXF from group-code/value pairs per entity. */
function dxf(opts: { entities: (string | number)[][]; blocks?: (string | number)[][]; layers?: (string | number)[][]; insunits?: number }): string {
  const lines: (string | number)[] = [];
  const pairs = (list: (string | number)[]) => lines.push(...list);
  if (opts.insunits !== undefined) pairs([0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, opts.insunits, 0, 'ENDSEC']);
  if (opts.layers) {
    pairs([0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER']);
    for (const l of opts.layers) pairs([0, 'LAYER', ...l]);
    pairs([0, 'ENDTAB', 0, 'ENDSEC']);
  }
  if (opts.blocks) {
    pairs([0, 'SECTION', 2, 'BLOCKS']);
    for (const b of opts.blocks) pairs(b);
    pairs([0, 'ENDSEC']);
  }
  pairs([0, 'SECTION', 2, 'ENTITIES']);
  for (const e of opts.entities) pairs(e);
  pairs([0, 'ENDSEC', 0, 'EOF']);
  return lines.join('\n');
}

const near = (a: Vec2, b: Vec2, eps = 1e-3) => Math.hypot(a[0] - b[0], a[1] - b[1]) < eps;
const has = (p: DrawingPath, q: Vec2) => p.points.some((x) => near(x, q));
const bbox = (paths: DrawingPath[]) => {
  const xs = paths.flatMap((p) => p.points.map((q) => q[0]));
  const ys = paths.flatMap((p) => p.points.map((q) => q[1]));
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

describe('parseDxf', () => {
  it('reads lines and units, and moves the drawing to the origin', () => {
    const r = parseDxf(
      dxf({
        insunits: 4,
        entities: [
          [0, 'LINE', 8, 'Walls', 10, 1000, 20, 2000, 30, 0, 11, 5000, 21, 2000, 31, 0],
          [0, 'LINE', 8, 'Walls', 10, 5000, 20, 2000, 11, 5000, 21, 6000],
        ],
      }),
    );
    expect(r.units).toBe('mm');
    expect(r.offset).toEqual([1000, 2000]);
    expect(r.geometry.layers).toEqual(['Walls']);
    expect(r.geometry.paths.map((p) => p.points)).toEqual([
      [[0, 0], [4000, 0]],
      [[4000, 0], [4000, 4000]],
    ]);
  });

  it('reads closed LWPOLYLINEs with bulges (arc segments)', () => {
    // A 2 × 1 slot: straight bottom, semicircle (bulge 1) on the right, straight top, semicircle back.
    const r = parseDxf(
      dxf({
        entities: [[0, 'LWPOLYLINE', 8, '0', 90, 4, 70, 1, 10, 0, 20, 0, 10, 2, 20, 0, 42, 1, 10, 2, 20, 1, 10, 0, 20, 1, 42, 1]],
      }),
    );
    const [p] = r.geometry.paths;
    expect(p.closed).toBe(true);
    // The right arc bulges out to x = 2.5, the left one to x = -0.5 (then shifted by +0.5).
    expect(bbox([p])).toEqual([0, 0, 3, 1]);
    expect(has(p, [3, 0.5])).toBe(true);
    expect(has(p, [0, 0.5])).toBe(true);
  });

  it('negative bulges turn clockwise', () => {
    const r = parseDxf(dxf({ entities: [[0, 'LWPOLYLINE', 90, 2, 70, 0, 10, 0, 20, 0, 42, -1, 10, 2, 20, 0]] }));
    // Clockwise from (0,0) to (2,0) goes over the top: y up to 1.
    expect(bbox(r.geometry.paths)).toEqual([0, 0, 2, 1]);
  });

  it('tessellates circles and arcs and keeps their centres', () => {
    const r = parseDxf(
      dxf({
        entities: [
          [0, 'CIRCLE', 8, 'Holes', 10, 10, 20, 10, 40, 5],
          [0, 'ARC', 8, 'Doors', 10, 100, 20, 0, 40, 50, 50, 0, 51, 90],
        ],
      }),
    );
    const [circle, arc] = r.geometry.paths;
    expect(circle.closed).toBe(true);
    expect(circle.points.length).toBeGreaterThanOrEqual(32);
    expect(circle.center).toEqual([5, 10]); // shifted by the bounds' min: x 5 (circle), y 0 (arc)
    expect(arc.closed).toBeUndefined();
    expect(near(arc.points[0], [145, 0])).toBe(true);
    expect(near(arc.points[arc.points.length - 1], [95, 50])).toBe(true);
    expect(r.geometry.layers).toEqual(['Holes', 'Doors']);
  });

  it('expands block INSERTs with scale, rotation, arrays and nesting', () => {
    const blocks = [
      // A 10 × 10 square with its base point at (5, 5) (the centre).
      [0, 'BLOCK', 2, 'SQ', 10, 5, 20, 5, 0, 'LWPOLYLINE', 8, '0', 90, 4, 70, 1, 10, 0, 20, 0, 10, 10, 20, 0, 10, 10, 20, 10, 10, 0, 20, 10, 0, 'ENDBLK'],
      // A block that inserts SQ twice.
      [0, 'BLOCK', 2, 'PAIR', 10, 0, 20, 0, 0, 'INSERT', 2, 'SQ', 10, 0, 20, 0, 0, 'INSERT', 2, 'SQ', 10, 100, 20, 0, 0, 'ENDBLK'],
    ];
    const r = parseDxf(
      dxf({
        blocks,
        entities: [
          [0, 'INSERT', 8, 'Furniture', 2, 'SQ', 10, 1000, 20, 1000, 41, 2, 42, 2, 50, 45],
          [0, 'INSERT', 8, 'Grid', 2, 'SQ', 10, 0, 20, 0, 70, 3, 71, 2, 44, 20, 45, 30],
          [0, 'INSERT', 8, 'Pairs', 2, 'PAIR', 10, 0, 20, 500],
        ],
      }),
    );
    const byLayer = (name: string) => r.geometry.paths.filter((p) => r.geometry.layers[p.layer] === name);
    // Scaled 2× (20 × 20) and rotated 45° about its centre at (1000, 1000): a diamond.
    const [diamond] = byLayer('Furniture');
    const h = Math.SQRT2 * 10;
    const [ox, oy] = r.offset;
    expect(has(diamond, [1000 - ox, 1000 + h - oy])).toBe(true);
    expect(has(diamond, [1000 + h - ox, 1000 - oy])).toBe(true);
    // A 3 × 2 array; layer-0 block entities inherit the INSERT's layer.
    expect(byLayer('Grid')).toHaveLength(6);
    expect(byLayer('Pairs')).toHaveLength(2);
    expect(r.geometry.layers).not.toContain('0');
  });

  it('flips entities with extrusion direction -Z (mirrored in AutoCAD)', () => {
    // In OCS with N = (0,0,-1), x is mirrored: an arc centred at OCS (10, 0) is at WCS (-10, 0).
    const r = parseDxf(
      dxf({
        entities: [
          [0, 'ARC', 10, 10, 20, 0, 40, 5, 50, 0, 51, 90, 210, 0, 220, 0, 230, -1],
          [0, 'LINE', 10, -20, 20, 0, 11, 0, 21, 0],
        ],
      }),
    );
    const arc = r.geometry.paths[0];
    // Offset x is -20 (the line), so WCS -10 → 10.
    expect(arc.center).toEqual([10, 0]);
    expect(near(arc.points[0], [5, 0])).toBe(true); // OCS (15,0) → WCS (-15,0)
  });

  it('reads old-style POLYLINE/VERTEX/SEQEND, ellipses and splines', () => {
    const r = parseDxf(
      dxf({
        entities: [
          [0, 'POLYLINE', 8, 'P', 66, 1, 70, 1],
          [0, 'VERTEX', 8, 'P', 10, 0, 20, 0],
          [0, 'VERTEX', 8, 'P', 10, 10, 20, 0],
          [0, 'VERTEX', 8, 'P', 10, 10, 20, 10],
          [0, 'SEQEND'],
          [0, 'ELLIPSE', 8, 'E', 10, 50, 20, 0, 11, 20, 21, 0, 40, 0.5, 41, 0, 42, 6.283185307179586],
          // Clamped cubic with 4 control points: passes through the first and last.
          [0, 'SPLINE', 8, 'S', 70, 8, 71, 3, 72, 8, 73, 4, 40, 0, 40, 0, 40, 0, 40, 0, 40, 1, 40, 1, 40, 1, 40, 1, 10, 0, 20, 100, 10, 10, 20, 120, 10, 20, 20, 120, 10, 30, 20, 100],
        ],
      }),
    );
    const [poly, ellipse, spline] = r.geometry.paths;
    expect(r.offset).toEqual([0, -10]); // the ellipse reaches y = -10
    const [ox, oy] = r.offset;
    expect(poly.points).toHaveLength(3);
    expect(poly.closed).toBe(true);
    expect(ellipse.closed).toBe(true);
    const eb = bbox([ellipse]);
    expect(eb[2] - eb[0]).toBeCloseTo(40, 1);
    expect(eb[3] - eb[1]).toBeCloseTo(20, 1);
    expect(near(spline.points[0], [0 - ox, 100 - oy])).toBe(true);
    expect(near(spline.points[spline.points.length - 1], [30 - ox, 100 - oy])).toBe(true);
    expect(Math.max(...spline.points.map((p) => p[1])) + oy).toBeCloseTo(115, 0);
  });

  it('skips annotation and paper space, and reports hidden layers', () => {
    const r = parseDxf(
      dxf({
        layers: [
          [2, 'Walls', 70, 0, 62, 7],
          [2, 'Furniture', 70, 0, 62, -3],
          [2, 'Old', 70, 1, 62, 7],
        ],
        entities: [
          [0, 'LINE', 8, 'Walls', 10, 0, 20, 0, 11, 1, 21, 0],
          [0, 'LINE', 8, 'Furniture', 10, 0, 20, 1, 11, 1, 21, 1],
          [0, 'LINE', 8, 'Old', 10, 0, 20, 2, 11, 1, 21, 2],
          [0, 'LINE', 8, 'Walls', 67, 1, 10, 0, 20, 0, 11, 9, 21, 9],
          [0, 'TEXT', 8, 'Walls', 1, 'Kitchen'],
          [0, 'TEXT', 8, 'Walls', 1, 'Living'],
          [0, 'HATCH', 8, 'Walls'],
        ],
      }),
    );
    expect(r.geometry.paths).toHaveLength(3);
    expect(r.hiddenLayers.sort()).toEqual(['Furniture', 'Old']);
    expect(r.skipped).toEqual({ TEXT: 2, HATCH: 1 });
    expect(r.units).toBeUndefined();
  });

  it('explains files it cannot read', () => {
    expect(() => parseDxf('AC1032\u0000\u0000binary')).toThrow(/DWG file.*ODA File Converter/);
    expect(() => parseDxf('AutoCAD Binary DXF\r\n\u001a\u0000')).toThrow(/Binary DXF/);
    expect(() => parseDxf('hello\nworld')).toThrow(DxfError);
    expect(() => parseDxf(dxf({ entities: [[0, 'TEXT', 1, 'only text']] }))).toThrow(/only TEXT/);
  });

  it('handles CRLF line endings and indented group codes', () => {
    const text = dxf({ entities: [[0, 'LINE', 10, 0, 20, 0, 11, 3, 21, 4]] })
      .split('\n')
      .map((l, i) => (i % 2 === 0 ? `  ${l}` : l))
      .join('\r\n');
    expect(parseDxf(text).geometry.paths[0].points).toEqual([[0, 0], [3, 4]]);
  });
});
