import * as THREE from 'three';
import { applyPushPull, classifyFace, faceLabel, type FaceRef } from '../model/geometry';
import type { Entity } from '../model/types';
import { parseLength } from '../model/units';
import { makeLabel, setLabel } from '../viewport/overlay';
import type { PickHit } from '../viewport/Viewport';
import { Tool, type ToolEvent } from './Tool';

function sameFace(a: FaceRef | null, b: FaceRef | null): boolean {
  return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Push/Pull: grab a flat face and drag it along its normal. Boxes resize on any face,
 * cylinders on caps (height) or the round side (radius), shapes on top/bottom.
 */
export class PushPullTool extends Tool {
  readonly id = 'pushpull' as const;
  readonly label = 'Push/Pull';
  private state: 'idle' | 'dragging' = 'idle';
  private hover: { hit: PickHit; face: FaceRef } | null = null;
  private drag: {
    id: string;
    orig: Entity;
    face: FaceRef;
    start: THREE.Vector3;
    normal: THREE.Vector3;
    downPx: THREE.Vector2;
    dragged: boolean;
  } | null = null;
  private distance = 0;
  private last: { id: string; orig: Entity; face: FaceRef; distance: number } | null = null;
  private readonly dimLabel = makeLabel('');

  hint(): string {
    if (this.state === 'dragging') return 'Move to push or pull, click to finish — or type an exact distance and press Enter.';
    return 'Push/Pull: click a face (or drag it). Boxes: any face. Cylinders: caps or side. Shapes: top or bottom.';
  }

  protected override reset() {
    this.state = 'idle';
    this.drag = null;
    super.reset();
    if (this.last) this.ctx.setMeasurement('Distance', this.fmtValue(this.last.distance));
  }

  pointerMove(e: ToolEvent) {
    if (this.state === 'idle') {
      this.updateHover(e);
      return;
    }
    const d = this.drag!;
    if (e.px.distanceTo(d.downPx) > 4) d.dragged = true;
    const res = this.ctx.snapper.distanceAlong(e.px, d.start, d.normal, d.downPx, new Set([d.id]));
    const snapped = this.ctx.snapper.findSnapPoint(e.px, new Set([d.id]));
    this.viewport.setSnapMarker(snapped?.point ?? null, snapped?.kind ?? '', snapped ? 'Align to ' + snapped.kind : '');
    this.setDistance(res.distance);
  }

  private updateHover(e: ToolEvent) {
    const hit = this.viewport.pick(e.px);
    const face = hit ? classifyFace(hit.entity, hit.localNormal, hit.localPoint) : null;
    if (!hit || !face) {
      this.hover = null;
      this.viewport.highlightFace(null);
      this.ctx.setHint(hit ? 'This face can’t be push/pulled (try a flat outer face).' : this.hint());
      return;
    }
    if (this.hover && this.hover.hit.entity.id === hit.entity.id && sameFace(this.hover.face, face)) {
      this.hover.hit = hit;
      return;
    }
    this.hover = { hit, face };
    const entity = hit.entity;
    this.viewport.highlightFace(hit, (n, c) => sameFace(classifyFace(entity, n, c), face));
    this.ctx.setHint(`${entity.name}: ${faceLabel(face)} — click or drag to push/pull.`);
  }

  pointerDown(e: ToolEvent) {
    if (e.button !== 0) return;
    if (this.state === 'dragging') {
      this.finish();
      return;
    }
    this.updateHover(e);
    if (!this.hover) return;
    const { hit, face } = this.hover;
    this.doc.begin();
    this.drag = {
      id: hit.entity.id,
      orig: structuredClone(hit.entity),
      face,
      start: hit.point.clone(),
      normal: hit.normal.clone().normalize(),
      downPx: e.px.clone(),
      dragged: false,
    };
    this.distance = 0;
    this.overlay.add(this.dimLabel);
    this.state = 'dragging';
    this.updateHint();
  }

  pointerUp(e: ToolEvent) {
    if (this.state === 'dragging' && this.drag?.dragged && e.button === 0) this.finish();
  }

  private setDistance(distance: number) {
    const d = this.drag;
    if (!d) return;
    this.distance = distance;
    const entity = this.doc.get(d.id);
    if (!entity) return;
    applyPushPull(d.orig, entity, d.face, distance);
    this.doc.touch();
    // Keep the face highlight glued to the moving face.
    this.viewport.highlightFace(null);
    this.dimLabel.position.copy(d.start).addScaledVector(d.normal, distance);
    setLabel(this.dimLabel, (distance >= 0 ? '+' : '') + this.fmt(distance));
    this.ctx.setMeasurement('Distance', this.fmtValue(distance));
  }

  private finish() {
    const d = this.drag;
    if (d) this.last = { id: d.id, orig: d.orig, face: d.face, distance: this.distance };
    this.doc.commit();
    this.markRetype();
    this.hover = null;
    this.reset();
  }

  value(text: string): boolean {
    const v = parseLength(text, this.units);
    if (v === null) return false;
    if (this.state === 'dragging') {
      this.setDistance(v);
      this.finish();
      return true;
    }
    // Retype the distance of the last push/pull.
    const last = this.last;
    if (!last || !this.doc.get(last.id) || !this.canRetype()) return false;
    last.distance = v;
    this.doc.update(last.id, (e) => applyPushPull(last.orig, e, last.face, v));
    this.markRetype();
    this.reset();
    return true;
  }

  override deactivate() {
    super.deactivate();
    this.hover = null;
  }
}
