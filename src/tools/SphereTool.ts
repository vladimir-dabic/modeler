import * as THREE from 'three';
import { newId } from '../model/Document';
import { cleanNumber, cleanVec, intersectRayPlane, type DrawPlane } from '../model/geometry';
import type { SphereEntity } from '../model/types';
import { parseLength } from '../model/units';
import { makeLabel, setLabel } from '../viewport/overlay';
import { planeForInference, Tool, type ToolEvent } from './Tool';

const TINY = 0.01;

/**
 * Sphere tool: click a point on the ground or a face, move out to set the size, click.
 * The ball rests on that surface (touching it at the clicked point). Type a radius,
 * or d40 for a diameter, at any time.
 */
export class SphereTool extends Tool {
  readonly id = 'sphere' as const;
  readonly label = 'Sphere';
  override readonly vcbStarters = 'dDøØ⌀';
  private state: 'idle' | 'radius' = 'idle';
  private plane: DrawPlane | null = null;
  private base = new THREE.Vector3();
  private radius = 0;
  private entityId: string | null = null;
  private readonly dimLabel = makeLabel('', 'vp-label vp-label-measure');

  hint(): string {
    return this.state === 'idle'
      ? 'Sphere: click where it should sit (the ground or any face).'
      : 'Move to set the size and click, or type a radius (d40 for a 40 mm diameter).';
  }

  protected override reset() {
    this.state = 'idle';
    this.entityId = null;
    this.plane = null;
    super.reset();
  }

  pointerMove(e: ToolEvent) {
    if (this.state === 'idle') {
      const inf = this.ctx.snapper.freePoint(e.px);
      this.showInference(inf);
      return;
    }
    const plane = this.plane!;
    const p = intersectRayPlane(this.viewport.rayAt(e.px), plane);
    if (!p) return;
    this.radius = this.ctx.snapper.round(p.distanceTo(this.base) / 2) || this.radius;
    this.apply();
  }

  pointerDown(e: ToolEvent) {
    if (e.button !== 0) return;
    if (this.state === 'idle') {
      const inf = this.ctx.snapper.freePoint(e.px);
      if (!inf) return;
      this.plane = planeForInference(inf, null);
      this.base.copy(inf.point);
      this.radius = 0;
      const sphere: SphereEntity = {
        id: newId(),
        name: this.doc.nextName('sphere'),
        kind: 'sphere',
        position: cleanVec(this.base),
        rotation: [0, 0, 0],
        color: this.ctx.defaultColor(),
        hole: false,
        visible: true,
        radii: [TINY, TINY, TINY],
        segments: 48,
      };
      this.doc.begin();
      this.doc.add(sphere);
      this.entityId = sphere.id;
      this.overlay.add(this.dimLabel);
      this.state = 'radius';
      this.viewport.setSnapMarker(null);
      this.updateHint();
      return;
    }
    if (this.radius >= TINY) this.finish();
  }

  private apply() {
    if (!this.entityId || !this.plane) return;
    const r = Math.max(this.radius, TINY);
    // Centre one radius out from the surface, so the ball sits on it.
    const center = this.base.clone().addScaledVector(this.plane.n, r);
    this.doc.update(this.entityId, (x) => {
      if (x.kind !== 'sphere') return;
      x.radii = [cleanNumber(r), cleanNumber(r), cleanNumber(r)];
      x.position = cleanVec(center);
    });
    this.dimLabel.position.copy(center);
    setLabel(this.dimLabel, `Ø${this.fmt(r * 2)}`);
    this.ctx.setMeasurement('Radius', this.fmtValue(r));
    this.viewport.requestRender();
  }

  private finish() {
    this.doc.commit('Sphere');
    const id = this.entityId;
    this.reset();
    if (id) this.doc.setSelection([id]);
  }

  value(text: string): boolean {
    if (this.state !== 'radius') return false;
    const m = /^\s*(d|ø|⌀)\s*(.+)$/i.exec(text);
    const v = parseLength(m ? m[2] : text, this.units);
    if (v === null || Math.abs(v) < TINY) return false;
    this.radius = Math.abs(m ? v / 2 : v);
    this.apply();
    this.finish();
    return true;
  }
}
