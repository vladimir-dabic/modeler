import * as THREE from 'three';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import { buildLocalGeometry, entityMatrix, worldBounds } from './geometry';
import { manifoldReady, subtract as manifoldSubtract, union as manifoldUnion } from './manifold';
import { isInsideGroup } from './groups';
import type { Entity, Group } from './types';

/**
 * Which boolean engine cuts holes (ADR 0017). Manifold is preferred once its WebAssembly
 * module is loaded; three-bvh-csg is the fallback (before loading, if loading fails, or if
 * Manifold rejects an input).
 */
export type CsgEngine = 'manifold' | 'bvh';
let preferred: CsgEngine = 'manifold';

export function setCsgEngine(engine: CsgEngine) {
  preferred = engine;
}

/** The engine that will actually run. */
export function activeCsgEngine(): CsgEngine {
  return preferred === 'manifold' && manifoldReady() ? 'manifold' : 'bvh';
}

let evaluator: Evaluator | null = null;

function getEvaluator(): Evaluator {
  if (!evaluator) {
    evaluator = new Evaluator();
    evaluator.attributes = ['position', 'normal'];
    evaluator.useGroups = false;
  }
  return evaluator;
}

/**
 * Cutters are grown by this much (mm) on every side so faces that are exactly flush
 * with the solid (a hole drawn on a face and pushed in) cut cleanly instead of leaving
 * a coplanar skin. Far below any printer's resolution.
 */
const CUTTER_GROW = 0.01;

function grownCutter(e: Entity): Entity {
  const g = CUTTER_GROW;
  const c = structuredClone(e);
  if (c.kind === 'box') {
    c.size = [c.size[0] + 2 * g, c.size[1] + 2 * g, c.size[2] + 2 * g];
  } else if (c.kind === 'cylinder' || c.kind === 'extrusion') {
    c.height += 2 * g;
    if (c.kind === 'cylinder') {
      c.radius += g;
      if (c.radiusTop !== undefined) c.radiusTop += g;
    }
  } else if (c.kind === 'sphere') {
    c.radii = [c.radii[0] + g, c.radii[1] + g, c.radii[2] + g];
  } else if (c.kind === 'tube') {
    c.radius += g;
    if (c.radii) c.radii = c.radii.map((r) => r + g);
  } else {
    c.profile = c.profile.map(([r, z]) => [r > 0 ? r + g : 0, z]);
  }
  return c;
}

function brushFor(e: Entity, cutter = false): Brush {
  const source = cutter ? grownCutter(e) : e;
  const geometry = buildLocalGeometry(source);
  if (cutter) {
    // Re-centre the growth: shift by -g along every local axis that grew on both ends.
    const g = CUTTER_GROW;
    if (e.kind === 'box') geometry.translate(-g, -g, -g);
    else if (e.kind === 'cylinder' || e.kind === 'extrusion') geometry.translate(0, 0, -g);
  }
  // CSG needs matching attribute sets on all operands.
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== 'position' && name !== 'normal') geometry.deleteAttribute(name);
  }
  const brush = new Brush(geometry);
  entityMatrix(e).decompose(brush.position, brush.quaternion, brush.scale);
  brush.updateMatrixWorld(true);
  return brush;
}

/** Does `hole` apply to `solid`? A group-scoped hole only cuts parts inside its group. */
export function holeAppliesTo(hole: Entity, solid: Entity, groups: Group[]): boolean {
  if (hole.holeScope !== 'group' || !hole.groupId) return true;
  return isInsideGroup(solid, hole.groupId, groups);
}

/** Holes whose bounds overlap the solid (and whose scope includes it). */
export function cuttersFor(solid: Entity, holes: Entity[], groups: Group[], boundsCache?: Map<string, THREE.Box3>): Entity[] {
  if (solid.hole) return [];
  const bounds = (e: Entity) => {
    let b = boundsCache?.get(e.id);
    if (!b) {
      b = worldBounds(e);
      boundsCache?.set(e.id, b);
    }
    return b;
  };
  const sb = bounds(solid);
  return holes.filter((h) => h.id !== solid.id && h.visible && holeAppliesTo(h, solid, groups) && bounds(h).intersectsBox(sb));
}

/**
 * Geometry for a solid in its own local frame, with all `holes` subtracted.
 * Falls back to the uncut geometry if the boolean operation fails.
 */
export function buildCutGeometry(solid: Entity, holes: Entity[]): { geometry: THREE.BufferGeometry; failed: boolean } {
  if (!holes.length) return { geometry: buildLocalGeometry(solid), failed: false };
  if (activeCsgEngine() === 'manifold') {
    try {
      // Exact booleans: flush faces cut cleanly, so cutters aren't grown (unlike below).
      const toLocal = entityMatrix(solid).invert();
      const geometry = manifoldSubtract(
        { geometry: buildLocalGeometry(solid) },
        holes.map((h) => ({ geometry: buildLocalGeometry(h), matrix: toLocal.clone().multiply(entityMatrix(h)) })),
      );
      return { geometry, failed: false };
    } catch (err) {
      console.warn('Manifold could not cut', solid.name, '- using the fallback engine:', (err as Error).message);
    }
  }
  try {
    const ev = getEvaluator();
    let result = brushFor(solid);
    for (const hole of holes) {
      result = ev.evaluate(result, brushFor(hole, true), SUBTRACTION);
      result.updateMatrixWorld(true);
    }
    // The result is in world space; bring it back to the solid's local frame.
    const geometry = result.geometry.clone();
    geometry.applyMatrix4(result.matrixWorld);
    geometry.applyMatrix4(entityMatrix(solid).invert());
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return { geometry, failed: false };
  } catch (err) {
    console.warn('CSG failed for', solid.name, err);
    return { geometry: buildLocalGeometry(solid), failed: true };
  }
}

/**
 * Fuse world-space solids into one watertight solid (overlaps merged, touching parts joined,
 * separate parts kept as separate pieces). Null when the Manifold engine isn't available
 * or fails; callers then use the parts as they are.
 */
export function fuseGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (activeCsgEngine() !== 'manifold' || !geometries.length) return null;
  try {
    return manifoldUnion(geometries.map((geometry) => ({ geometry })));
  } catch (err) {
    console.warn('Could not fuse the parts into one solid:', (err as Error).message);
    return null;
  }
}

/**
 * World-space geometry for export: each visible solid in `targets`, with every visible
 * hole in `all` subtracted.
 */
export function buildWorldGeometries(targets: Entity[], all: Entity[], groups: Group[]): { entity: Entity; geometry: THREE.BufferGeometry }[] {
  const holes = all.filter((e) => e.hole && e.visible);
  const cache = new Map<string, THREE.Box3>();
  return targets
    .filter((e) => !e.hole && e.visible)
    .map((entity) => {
      const { geometry } = buildCutGeometry(entity, cuttersFor(entity, holes, groups, cache));
      geometry.applyMatrix4(entityMatrix(entity));
      return { entity, geometry };
    });
}
