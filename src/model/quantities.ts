import { buildWorldGeometries } from './csg';
import { polygonArea } from './geometry';
import type { Entity } from './types';
import { meshVolume } from './workspaces';

/** Area seen from above in the entity's own frame, in mm². */
export function footprintMm2(e: Entity): number {
  if (e.kind === 'box') return e.size[0] * e.size[1];
  if (e.kind === 'cylinder') return Math.PI * e.radius * e.radius;
  return Math.abs(polygonArea(e.points.map(([x, y]) => ({ x, y }))));
}

/** Volume (mm³) of each visible solid in `targets`, with every visible hole in `all` subtracted. */
export function solidVolumes(targets: Entity[], all: Entity[]): Map<string, number> {
  const byId = new Map<string, number>();
  for (const { entity, geometry } of buildWorldGeometries(targets, all)) {
    byId.set(entity.id, meshVolume(geometry));
    geometry.dispose();
  }
  return byId;
}
