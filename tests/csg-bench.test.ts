/// <reference types="node" />
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildCutGeometry, setCsgEngine, type CsgEngine } from '../src/model/csg';
import { scenes } from './support/csg-scenes';

/**
 * Old vs new geometry engine on the same scenes (ADR 0017). Opt-in: `npm run bench:csg`
 * writes test-results/csg-bench.md. Each run builds the cut solid from scratch, as the
 * viewport does after an edit; the table shows the median of warm runs.
 */
it.skipIf(!process.env.BENCH)('benchmark: manifold vs three-bvh-csg', () => {
  const time = (engine: CsgEngine, run: () => void) => {
    setCsgEngine(engine);
    run(); // warm up (JIT, WebAssembly)
    const times: number[] = [];
    const end = performance.now() + 1500;
    while (times.length < 3 || (performance.now() < end && times.length < 50)) {
      const t = performance.now();
      run();
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)];
  };
  const rows = ['| Scene | Manifold (ms) | three-bvh-csg (ms) | Speed-up |', '|---|---|---|---|'];
  for (const s of scenes()) {
    const run = () => buildCutGeometry(s.solid, s.holes).geometry.dispose();
    const m = time('manifold', run);
    const b = s.fallbackHangs ? null : time('bvh', run);
    rows.push(`| ${s.name} | ${m.toFixed(1)} | ${b === null ? 'does not finish' : b.toFixed(1)} | ${b === null ? '—' : `${(b / m).toFixed(1)}×`} |`);
  }
  setCsgEngine('manifold');
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/csg-bench.md', rows.join('\n') + '\n');
  expect(rows.length).toBeGreaterThan(2);
}, 600_000);
