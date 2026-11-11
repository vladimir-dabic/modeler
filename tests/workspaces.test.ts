import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buildWorldGeometries } from '../src/model/csg';
import type { BoxEntity, CylinderEntity } from '../src/model/types';
import {
  checkPrintFit,
  meshVolume,
  placeOnPlateDelta,
  printerVolume,
  WORKSPACES,
} from '../src/model/workspaces';

const box = (id: string, position: [number, number, number], size: [number, number, number]): BoxEntity => ({
  id, name: id, kind: 'box', position, rotation: [0, 0, 0], size, color: '#fff', hole: false, visible: true,
});

const BED: [number, number, number] = [256, 256, 256];

describe('workspaces', () => {
  it('every workspace offers its default snap step and starts with properties', () => {
    for (const ws of Object.values(WORKSPACES)) {
      expect(ws.snapSteps).toContain(ws.snapStep);
      expect(ws.panels[0]).toBe('properties');
      expect(ws.swatches.map((s) => s.color)).toContain(ws.defaultColor);
    }
  });

  it('printer volume falls back to a custom size', () => {
    expect(printerVolume({ profile: 'prusa-mk4', custom: [1, 1, 1] })).toEqual([250, 210, 220]);
    expect(printerVolume({ profile: 'custom', custom: [100, 120, 130] })).toEqual([100, 120, 130]);
    expect(printerVolume({ profile: 'nope', custom: [1, 1, 1] })).toEqual([256, 256, 256]);
  });
});

describe('checkPrintFit', () => {
  it('accepts a part on the bed', () => {
    expect(checkPrintFit([box('a', [10, 10, 0], [50, 50, 20])], BED)).toEqual([]);
  });

  it('flags parts off the bed, too big, too tall, below and floating', () => {
    const problems = (b: BoxEntity) => checkPrintFit([b], BED).map((i) => i.problem);
    expect(problems(box('a', [230, 10, 0], [50, 50, 20]))).toEqual(['outside']);
    expect(checkPrintFit([box('a', [0, 0, 0], [300, 50, 20])], BED)[0].message).toMatch(/larger than/);
    expect(problems(box('a', [0, 0, 0], [50, 50, 300]))).toEqual(['too-tall']);
    expect(problems(box('a', [0, 0, -5], [50, 50, 20]))).toEqual(['below']);
    expect(problems(box('a', [0, 0, 5], [50, 50, 20]))).toEqual(['floating']);
  });

  it('a part resting on another part is supported', () => {
    expect(checkPrintFit([box('base', [0, 0, 0], [50, 50, 10]), box('top', [10, 10, 10], [10, 10, 10])], BED)).toEqual([]);
  });

  it('ignores holes and hidden parts', () => {
    const hole = { ...box('h', [0, 0, -50], [10, 10, 10]), hole: true };
    const hidden = { ...box('x', [-100, 0, 0], [10, 10, 10]), visible: false };
    expect(checkPrintFit([hole, hidden], BED)).toEqual([]);
  });
});

describe('placeOnPlateDelta', () => {
  it('centres on the bed and drops to z = 0', () => {
    const d = placeOnPlateDelta([box('a', [-100, 0, 30], [40, 20, 10])], BED);
    expect(d.toArray()).toEqual([128 - -80, 128 - 10, -30]);
  });
});

describe('meshVolume', () => {
  it('measures a box and a box with a hole through it', () => {
    expect(meshVolume(new THREE.BoxGeometry(10, 20, 30))).toBeCloseTo(6000, 6);
    const solid = box('s', [0, 0, 0], [20, 20, 10]);
    const hole: CylinderEntity = {
      id: 'h', name: 'h', kind: 'cylinder', position: [10, 10, -1], rotation: [0, 0, 0],
      radius: 5, height: 12, segments: 128, color: '#fff', hole: true, visible: true,
    };
    const [{ geometry }] = buildWorldGeometries([solid], [solid, hole], []);
    const expected = 20 * 20 * 10 - Math.PI * 25 * 10;
    // Faceted cylinder + the 0.01 mm cutter growth: within 0.5 %.
    expect(meshVolume(geometry)).toBeGreaterThan(expected * 0.995);
    expect(meshVolume(geometry)).toBeLessThan(expected * 1.005);
  });
});
