import { buildWorldGeometries, fuseGeometries } from './csg';
import * as THREE from 'three';
import { localBounds, polygonArea } from './geometry';
import type { Entity, Group } from './types';
import { meshVolume } from './workspaces';

/** Area seen from above in the entity's own frame, in mm². */
export function footprintMm2(e: Entity): number {
  if (e.kind === 'box') return e.size[0] * e.size[1];
  if (e.kind === 'cylinder') return Math.PI * e.radius * e.radius;
  if (e.kind === 'sphere') return Math.PI * e.radii[0] * e.radii[1];
  if (e.kind === 'extrusion') return Math.abs(polygonArea(e.points.map(([x, y]) => ({ x, y }))));
  // Revolve, tube: the area of their bounding box seen from above.
  const s = localBounds(e).getSize(new THREE.Vector3());
  return s.x * s.y;
}

/**
 * Volume (mm³) of the targets as one fused solid, so overlapping parts count once (what a
 * printer actually uses). Falls back to the sum of the parts without the Manifold engine.
 */
export function fusedVolume(targets: Entity[], all: Entity[], groups: Group[]): number {
  const parts = buildWorldGeometries(targets, all, groups);
  const fused = fuseGeometries(parts.map((p) => p.geometry));
  const volume = fused ? meshVolume(fused) : parts.reduce((sum, p) => sum + meshVolume(p.geometry), 0);
  fused?.dispose();
  for (const p of parts) p.geometry.dispose();
  return volume;
}

/** Volume (mm³) of each visible solid in `targets`, with every visible hole in `all` subtracted. */
export function solidVolumes(targets: Entity[], all: Entity[], groups: Group[]): Map<string, number> {
  const byId = new Map<string, number>();
  for (const { entity, geometry } of buildWorldGeometries(targets, all, groups)) {
    byId.set(entity.id, meshVolume(geometry));
    geometry.dispose();
  }
  return byId;
}
