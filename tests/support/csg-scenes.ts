import type { Entity } from '../../src/model/types';

/** Representative CSG scenes for the engine comparison (tests/csg.test.ts, tests/csg.bench.ts). */

let n = 0;
const part = (p: Partial<Entity> & { kind: Entity['kind'] }): Entity =>
  ({ id: `p${++n}`, name: `P${n}`, position: [0, 0, 0], rotation: [0, 0, 0], color: '#cccccc', hole: false, visible: true, ...p }) as Entity;
const hole = (p: Partial<Entity> & { kind: Entity['kind'] }) => part({ ...p, hole: true });

export interface Scene {
  name: string;
  solid: Entity;
  holes: Entity[];
  /** Exact expected volume when it has a closed form. */
  volume?: number;
  /** three-bvh-csg never finishes this one (measured: killed after 45 s). */
  fallbackHangs?: boolean;
}

export function scenes(): Scene[] {
  const plate = part({ kind: 'box', size: [100, 60, 5] });
  const grid: Entity[] = [];
  for (let i = 0; i < 8; i++) for (let j = 0; j < 5; j++) grid.push(hole({ kind: 'cylinder', position: [8 + i * 12, 8 + j * 11, -1], radius: 1.7, height: 7, segments: 32 }));
  const engraving: Entity[] = [];
  for (let i = 0; i < 20; i++) for (let j = 0; j < 10; j++) engraving.push(hole({ kind: 'box', position: [2 + i * 4.8, 2 + j * 5.6, 4], size: [3, 4, 1] }));
  const ball = part({ kind: 'sphere', radii: [30, 30, 30], segments: 64 });
  const ballHoles: Entity[] = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * 360;
    ballHoles.push(hole({ kind: 'cylinder', position: [0, 0, 0], rotation: [90, 0, a], radius: 3, height: 40, segments: 32 }));
  }
  return [
    {
      name: 'plate, one hole (a typical edit)',
      solid: plate,
      holes: [hole({ kind: 'cylinder', position: [50, 30, -1], radius: 1.7, height: 7, segments: 64 })],
    },
    { name: 'plate, 40 M3 holes', solid: plate, holes: grid },
    { name: 'flush pocket (coplanar top)', solid: part({ kind: 'box', size: [10, 10, 10] }), holes: [hole({ kind: 'box', position: [3, 3, 6], size: [4, 4, 4] })], volume: 1000 - 64 },
    { name: '200-cell engraving (like text)', solid: plate, holes: engraving, volume: 100 * 60 * 5 - 200 * 12 },
    { name: 'sphere, 12 radial holes', solid: ball, holes: ballHoles, fallbackHangs: true },
    {
      name: 'tube cut by a box',
      solid: part({ kind: 'tube', path: [[0, 0, 0], [40, 0, 20], [80, 30, 0], [100, 80, 20]], radius: 6, smooth: true, segments: 24 }),
      holes: [hole({ kind: 'box', position: [30, -20, -20], size: [30, 80, 60] })],
    },
  ];
}
