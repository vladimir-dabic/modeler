import * as THREE from 'three';
import type { ModelDocument } from '../model/Document';
import {
  closestOnLineToRay,
  groundPlane,
  intersectRayPlane,
  isAxisAligned,
  projectToPlane,
  snapPoints,
  toPlane,
  fromPlane,
  type DrawPlane,
  type SnapPoint,
} from '../model/geometry';
import { referenceSnapPoints } from '../model/references';
import type { PickHit, Viewport } from './Viewport';

export type InferenceKind = 'endpoint' | 'midpoint' | 'center' | 'face' | 'ground' | 'plane' | 'axis' | 'free';

export interface Inference {
  point: THREE.Vector3;
  kind: InferenceKind;
  /** Face under the cursor, if any (used to pick drawing planes). */
  hit: PickHit | null;
  /** The part (or reference drawing) a snap point belongs to; annotations attach to it. */
  sourceId?: string;
}

export interface SnapSettings {
  snapEnabled: boolean;
  snapStep: number;
}

const SNAP_RADIUS_PX = 14;

const KIND_PRIORITY: Record<string, number> = { endpoint: 0, center: 1, midpoint: 2 };

export const INFERENCE_LABEL: Record<InferenceKind, string> = {
  endpoint: 'Endpoint',
  midpoint: 'Midpoint',
  center: 'Center',
  face: 'On face',
  ground: 'On ground',
  plane: 'In plane',
  axis: 'On axis',
  free: '',
};

/**
 * Turns a cursor position into a "smart" 3D point, SketchUp-style:
 * corners/midpoints of existing geometry win, then faces, then the ground plane;
 * free positions are rounded to the snap step.
 */
export class Snapper {
  private cacheVersion = -1;
  private points: SnapPoint[] = [];

  constructor(
    private readonly viewport: Viewport,
    private readonly doc: ModelDocument,
    private readonly settings: SnapSettings,
  ) {}

  private allPoints(): SnapPoint[] {
    if (this.cacheVersion !== this.doc.version) {
      this.points = this.doc.entities.filter((e) => e.visible).flatMap(snapPoints);
      // Corners, midpoints and centres of visible reference drawings (ADR 0014).
      for (const r of this.doc.references) {
        const g = r.visible ? this.doc.geometryOf(r.id) : undefined;
        if (g) for (const sp of referenceSnapPoints(r, g)) this.points.push(sp);
      }
      this.cacheVersion = this.doc.version;
    }
    return this.points;
  }

  round(value: number): number {
    if (!this.settings.snapEnabled || this.settings.snapStep <= 0) return value;
    const step = this.settings.snapStep;
    return Math.round(value / step) * step;
  }

  /** Nearest inference point within the snap radius, preferring corners. */
  findSnapPoint(px: THREE.Vector2, exclude?: Set<string>, extra: SnapPoint[] = []): SnapPoint | null {
    let best: SnapPoint | null = null;
    let bestScore = Infinity;
    // Loops, not a spread: reference drawings can add tens of thousands of points.
    const check = (sp: SnapPoint) => {
      if (exclude?.has(sp.entityId)) return;
      const s = this.viewport.toScreen(sp.point);
      if (!s.inFront) return;
      const d = Math.hypot(s.x - px.x, s.y - px.y);
      if (d > SNAP_RADIUS_PX) return;
      // Small bias so corners win over nearby midpoints.
      const score = d + (KIND_PRIORITY[sp.kind] ?? 3) * 3;
      if (score < bestScore) {
        bestScore = score;
        best = sp;
      }
    };
    for (const sp of extra) check(sp);
    for (const sp of this.allPoints()) check(sp);
    return best;
  }

  /** An unconstrained point: snap point, else face, else ground (z = 0). */
  freePoint(px: THREE.Vector2, exclude?: Set<string>, extra?: SnapPoint[]): Inference | null {
    const hit = this.viewport.pick(px, exclude);
    const sp = this.findSnapPoint(px, exclude, extra);
    if (sp) return { point: sp.point.clone(), kind: sp.kind, hit, sourceId: sp.entityId };

    if (hit) {
      const p = hit.point.clone();
      if (isAxisAligned(hit.normal)) {
        // Round the in-plane coordinates to the world grid so faces snap nicely.
        const axis = Math.abs(hit.normal.x) > 0.5 ? 0 : Math.abs(hit.normal.y) > 0.5 ? 1 : 2;
        for (let i = 0; i < 3; i++) if (i !== axis) p.setComponent(i, this.round(p.getComponent(i)));
      }
      return { point: p, kind: 'face', hit, sourceId: hit.entity.id };
    }

    const ray = this.viewport.rayAt(px);
    const ground = intersectRayPlane(ray, groundPlane());
    if (ground && ground.distanceTo(ray.origin) < 1e6) {
      ground.x = this.round(ground.x);
      ground.y = this.round(ground.y);
      ground.z = 0;
      return { point: ground, kind: 'ground', hit: null };
    }
    return null;
  }

  /**
   * A point constrained to a drawing plane. Snap points are projected onto the plane,
   * so you can line things up with geometry that is elsewhere in the model.
   */
  pointOnPlane(px: THREE.Vector2, plane: DrawPlane, exclude?: Set<string>, extra?: SnapPoint[]): Inference | null {
    const sp = this.findSnapPoint(px, exclude, extra);
    if (sp) return { point: projectToPlane(plane, sp.point), kind: sp.kind, hit: null };
    const ray = this.viewport.rayAt(px);
    const p = intersectRayPlane(ray, plane);
    if (!p) return null;
    const uv = toPlane(plane, p);
    return { point: fromPlane(plane, this.round(uv.x), this.round(uv.y)), kind: 'plane', hit: null };
  }

  /**
   * Signed distance along a line (origin + t·dir) under the cursor. Used for heights,
   * push/pull and axis-locked moves. Falls back to vertical mouse travel when looking
   * straight down the line.
   */
  distanceAlong(
    px: THREE.Vector2,
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    anchorPx: THREE.Vector2,
    exclude?: Set<string>,
  ): { distance: number; kind: InferenceKind } {
    const sp = this.findSnapPoint(px, exclude);
    if (sp) return { distance: sp.point.clone().sub(origin).dot(dir), kind: sp.kind };

    const ray = this.viewport.rayAt(px);
    const a = this.viewport.toScreen(origin);
    const b = this.viewport.toScreen(origin.clone().add(dir.clone().multiplyScalar(this.viewport.worldPerPixel(origin) * 100)));
    const screenLen = Math.hypot(b.x - a.x, b.y - a.y);
    let t: number | null = null;
    if (screenLen > 8) t = closestOnLineToRay(origin, dir, ray);
    if (t === null) {
      // Looking along the axis: use vertical mouse movement instead.
      t = (anchorPx.y - px.y) * this.viewport.worldPerPixel(origin);
    }
    return { distance: this.round(t), kind: 'axis' };
  }
}
