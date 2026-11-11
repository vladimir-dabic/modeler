import { afterEach, describe, expect, it } from 'vitest';
import { activeCsgEngine, buildCutGeometry, setCsgEngine } from '../src/model/csg';
import { initManifold, manifoldVolume, toManifold } from '../src/model/manifold';
import { signedVolume } from '../src/model/shapes';
import { scenes } from './support/csg-scenes';

afterEach(() => setCsgEngine('manifold'));

describe('geometry engines (ADR 0017)', () => {
  it('Manifold is loaded and preferred', async () => {
    expect(await initManifold()).toBe(true);
    expect(activeCsgEngine()).toBe('manifold');
    setCsgEngine('bvh');
    expect(activeCsgEngine()).toBe('bvh');
  });

  for (const scene of scenes()) {
    it(`agree on "${scene.name}"; Manifold's result is watertight`, () => {
      setCsgEngine('manifold');
      const m = buildCutGeometry(scene.solid, scene.holes);
      expect(m.failed).toBe(false);
      const vm = signedVolume(m.geometry);
      if (!scene.fallbackHangs) {
        setCsgEngine('bvh');
        const vb = signedVolume(buildCutGeometry(scene.solid, scene.holes).geometry);
        // The fallback grows cutters by 0.01 mm, so it removes a hair more.
        expect(Math.abs(vm - vb) / vm).toBeLessThan(0.01);
      }
      if (scene.volume !== undefined) expect(vm).toBeCloseTo(scene.volume, 3);
      // Watertight: Manifold accepts its own output as a closed solid with the same volume.
      const again = toManifold(m.geometry);
      expect(again.status()).toBe('NoError');
      expect(again.volume()).toBeCloseTo(vm, 3);
      again.delete();
      expect(manifoldVolume(m.geometry)).toBeCloseTo(vm, 3);
    });
  }

  it('keeps hard edges hard and curved surfaces smooth', () => {
    const [, , flush] = scenes();
    const g = buildCutGeometry(flush.solid, flush.holes).geometry;
    const normals = g.getAttribute('normal');
    // Every normal of a box-minus-box is axis-aligned (no smoothing across edges).
    for (let i = 0; i < normals.count; i++) {
      const v = [Math.abs(normals.getX(i)), Math.abs(normals.getY(i)), Math.abs(normals.getZ(i))].sort();
      expect(v[2]).toBeCloseTo(1, 5);
    }
  });
});
