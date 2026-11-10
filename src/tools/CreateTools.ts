import * as THREE from 'three';
import { newId } from '../model/Document';
import {
  boxFromRect,
  cylinderFromPlane,
  extrusionFromPlane,
  fromPlane,
  polygonArea,
  toPlane,
  type DrawPlane,
  type SnapPoint,
} from '../model/geometry';
import type { BoxEntity, CylinderEntity, Entity, ExtrusionEntity } from '../model/types';
import { parseLength, parseLengthList } from '../model/units';
import { axisColor, COLORS, makeLabel, makeLine, setLabel } from '../viewport/overlay';
import type { Inference } from '../viewport/Snapper';
import { arrowAxis, axisName, planeForInference, sameAxis, Tool, type ToolEvent } from './Tool';

const TINY = 0.01;

/** Keep the sign of the current drag direction when the user types a positive value. */
function withSign(typed: number, current: number): number {
  return typed < 0 ? typed : current < 0 ? -typed : typed;
}

/**
 * Shared behaviour for tools that draw a 2D footprint on a plane and then extrude it:
 * plane selection (face under cursor / arrow-key lock), the height phase with snapping,
 * and automatic holes when pushing into the face you started on.
 */
abstract class ExtrudingTool extends Tool {
  protected plane!: DrawPlane;
  protected entityId: string | null = null;
  protected height = 0;
  protected anchorPx = new THREE.Vector2();
  protected startedOnSolid = false;
  protected holeOverride: boolean | null = null;
  protected forcedNormal: THREE.Vector3 | null = null;
  protected readonly dimLabel = makeLabel('');

  protected get isHole(): boolean {
    return this.holeOverride ?? (this.startedOnSolid && this.height < 0);
  }

  protected entity<T extends Entity>(): T | undefined {
    return this.entityId ? (this.doc.get(this.entityId) as T | undefined) : undefined;
  }

  protected planeHint(): string {
    return this.forcedNormal ? ` Plane locked to ${axisName(this.forcedNormal)} — press the arrow again to unlock.` : ' Arrow keys lock the drawing plane.';
  }

  protected beginOn(inf: Inference) {
    this.plane = planeForInference(inf, this.forcedNormal);
    const hit = inf.hit;
    this.startedOnSolid =
      !this.forcedNormal && !!hit && !hit.entity.hole && Math.abs(inf.point.clone().sub(hit.point).dot(hit.normal)) < 1e-3;
    this.holeOverride = null;
    this.height = 0;
    this.doc.begin();
  }

  /** While the footprint is still flat, float it ~1px above the face to avoid z-fighting. */
  protected previewHeight(): number {
    if (Math.abs(this.height) > 0) return this.height;
    return this.viewport.worldPerPixel(this.plane.origin) * 0.75;
  }

  protected exclude(): Set<string> {
    return new Set(this.entityId ? [this.entityId] : []);
  }

  protected moveHeight(e: ToolEvent) {
    const { distance } = this.ctx.snapper.distanceAlong(e.px, this.plane.origin, this.plane.n, this.anchorPx, this.exclude());
    this.height = distance;
  }

  protected toggleHole(): boolean {
    if (!this.entityId) return false;
    this.holeOverride = !this.isHole;
    this.apply();
    this.ctx.toast(this.isHole ? 'Creating a hole (cuts solids)' : 'Creating a solid');
    return true;
  }

  protected finish() {
    const id = this.entityId;
    this.doc.commit();
    this.markRetype();
    this.entityId = null;
    if (id) this.doc.setSelection([id]);
    this.afterFinish();
  }

  protected afterFinish() {
    this.reset();
  }

  protected idleMove(e: ToolEvent) {
    const inf = this.ctx.snapper.freePoint(e.px);
    this.showInference(inf);
    this.viewport.highlightFace(inf?.hit && !this.forcedNormal ? inf.hit : null);
  }

  protected toggleForcedPlane(e: KeyboardEvent): boolean {
    const axis = arrowAxis(e);
    if (!axis) return false;
    this.forcedNormal = sameAxis(this.forcedNormal, axis) ? null : axis;
    this.updateHint();
    return true;
  }

  /** Write the current state into the transient entity. */
  protected abstract apply(): void;

  override cancel() {
    super.cancel();
    this.entityId = null;
  }
}

// ---------------------------------------------------------------------------

export class BoxTool extends ExtrudingTool {
  readonly id = 'box' as const;
  readonly label = 'Box';
  private state: 'idle' | 'rect' | 'height' = 'idle';
  private p1 = new THREE.Vector3();
  private a = 0;
  private b = 0;
  /** Last finished box, so typed values can still adjust it (like SketchUp). */
  private last: { id: string; plane: DrawPlane; p1: THREE.Vector3; a: number; b: number; h: number } | null = null;

  hint(): string {
    switch (this.state) {
      case 'idle':
        return 'Box: click the first corner (on the ground or on any face).' + this.planeHint();
      case 'rect':
        return 'Click the opposite corner, or type width, depth (e.g. 600,400) and press Enter.';
      case 'height':
        return 'Move to set the height and click, or type a height. Push into a face to make a hole. Tap Alt: toggle hole.';
    }
  }

  protected override reset() {
    this.state = 'idle';
    super.reset();
    if (this.last) this.ctx.setMeasurement('Dimensions', [this.last.a, this.last.b, this.last.h].map((v) => this.fmtValue(Math.abs(v))).join(', '));
  }

  pointerMove(e: ToolEvent) {
    if (this.state === 'idle') return this.idleMove(e);
    if (this.state === 'rect') {
      const inf = this.ctx.snapper.pointOnPlane(e.px, this.plane, this.exclude());
      this.showInference(inf);
      if (!inf) return;
      const uv = toPlane(this.plane, inf.point);
      this.a = uv.x;
      this.b = uv.y;
    } else {
      this.moveHeight(e);
      this.viewport.setSnapMarker(null);
    }
    this.apply();
  }

  pointerDown(e: ToolEvent) {
    if (e.button !== 0) return;
    if (this.state === 'idle') {
      const inf = this.ctx.snapper.freePoint(e.px);
      if (!inf) return;
      this.beginOn(inf);
      this.p1 = inf.point.clone();
      this.a = this.b = 0;
      const box: BoxEntity = {
        id: newId(),
        name: this.doc.nextName('box'),
        kind: 'box',
        color: this.ctx.defaultColor(),
        hole: false,
        visible: true,
        ...boxFromRect(this.plane, this.p1, 0, 0, 0),
      };
      this.entityId = box.id;
      this.doc.add(box);
      this.overlay.add(this.dimLabel);
      this.state = 'rect';
      this.viewport.highlightFace(null);
      this.updateHint();
    } else if (this.state === 'rect') {
      if (Math.abs(this.a) < TINY || Math.abs(this.b) < TINY) return;
      this.state = 'height';
      this.anchorPx.copy(e.px);
      this.updateHint();
    } else if (Math.abs(this.height) >= TINY) {
      this.finishBox();
    }
  }

  protected apply() {
    const e = this.entity<BoxEntity>();
    if (!e) return;
    Object.assign(e, boxFromRect(this.plane, this.p1, this.a, this.b, this.previewHeight()));
    e.hole = this.isHole;
    this.doc.touch();
    const center = fromPlane(this.plane, this.a / 2, this.b / 2, this.height);
    this.dimLabel.position.copy(center);
    const dims = [this.a, this.b].map((v) => this.fmtValue(Math.abs(v)));
    if (this.state === 'height') dims.push(this.fmtValue(Math.abs(this.height)));
    setLabel(this.dimLabel, `${dims.join(' × ')} ${this.units}${this.isHole ? ' (hole)' : ''}`);
    this.ctx.setMeasurement(this.state === 'height' ? 'Height' : 'Dimensions', this.state === 'height' ? this.fmtValue(Math.abs(this.height)) : dims.join(', '));
  }

  private finishBox() {
    this.last = { id: this.entityId!, plane: this.plane, p1: this.p1.clone(), a: this.a, b: this.b, h: this.height };
    this.finish();
  }

  value(text: string): boolean {
    const list = parseLengthList(text, this.units);
    if (!list) return false;
    if (this.state === 'rect') {
      const [va, vb, vh] = list;
      if (va != null) this.a = withSign(va, this.a);
      if (vb != null) this.b = withSign(vb, this.b);
      if (Math.abs(this.a) < TINY || Math.abs(this.b) < TINY) return false;
      if (vh != null) {
        this.height = withSign(vh, this.height || 1);
        this.apply();
        this.finishBox();
      } else {
        this.state = 'height';
        this.apply();
        this.updateHint();
      }
      return true;
    }
    if (this.state === 'height') {
      const v = list[0];
      if (v == null || Math.abs(v) < TINY) return false;
      this.height = withSign(v, this.height || 1);
      this.apply();
      this.finishBox();
      return true;
    }
    // Idle: adjust the box that was just drawn.
    const last = this.last;
    if (!last || !this.doc.get(last.id) || !this.canRetype()) return false;
    if (list.length === 1 && list[0] != null) last.h = withSign(list[0], last.h);
    else {
      if (list[0] != null) last.a = withSign(list[0], last.a);
      if (list[1] != null) last.b = withSign(list[1], last.b);
      if (list[2] != null) last.h = withSign(list[2], last.h);
    }
    this.doc.update(last.id, (e) => Object.assign(e, boxFromRect(last.plane, last.p1, last.a, last.b, last.h)));
    this.markRetype();
    this.reset();
    return true;
  }

  keyDown(e: KeyboardEvent): boolean {
    if (e.key === 'Alt' && this.state !== 'idle') return this.toggleHole();
    if (this.state === 'idle') return this.toggleForcedPlane(e);
    return false;
  }
}

// ---------------------------------------------------------------------------

export class CylinderTool extends ExtrudingTool {
  readonly id = 'cylinder' as const;
  readonly label = 'Cylinder';
  override readonly vcbStarters = 'dDøØ⌀';
  private state: 'idle' | 'radius' | 'height' = 'idle';
  private center = new THREE.Vector3();
  private radius = 0;
  private last: { id: string; plane: DrawPlane; center: THREE.Vector3; r: number; h: number } | null = null;

  hint(): string {
    switch (this.state) {
      case 'idle':
        return 'Cylinder: click the centre.' + this.planeHint();
      case 'radius':
        return 'Click to set the radius, or type a radius (or d5 for a 5 mm diameter).';
      case 'height':
        return 'Move to set the height and click, or type it. Push into a face to make a hole. Tap Alt: toggle hole.';
    }
  }

  protected override reset() {
    this.state = 'idle';
    super.reset();
    if (this.last) this.ctx.setMeasurement('Radius, height', `${this.fmtValue(this.last.r)}, ${this.fmtValue(Math.abs(this.last.h))}`);
  }

  pointerMove(e: ToolEvent) {
    if (this.state === 'idle') return this.idleMove(e);
    if (this.state === 'radius') {
      const inf = this.ctx.snapper.pointOnPlane(e.px, this.plane, this.exclude());
      this.showInference(inf);
      if (!inf) return;
      const r = inf.point.distanceTo(this.center);
      this.radius = inf.kind === 'plane' ? this.ctx.snapper.round(r) : r;
    } else {
      this.moveHeight(e);
      this.viewport.setSnapMarker(null);
    }
    this.apply();
  }

  pointerDown(e: ToolEvent) {
    if (e.button !== 0) return;
    if (this.state === 'idle') {
      const inf = this.ctx.snapper.freePoint(e.px);
      if (!inf) return;
      this.beginOn(inf);
      this.center = inf.point.clone();
      this.radius = 0;
      const cyl: CylinderEntity = {
        id: newId(),
        name: this.doc.nextName('cylinder'),
        kind: 'cylinder',
        color: this.ctx.defaultColor(),
        hole: false,
        visible: true,
        segments: this.ctx.workspace().cylinderSegments,
        ...cylinderFromPlane(this.plane, this.center, 0, 0),
      };
      this.entityId = cyl.id;
      this.doc.add(cyl);
      this.overlay.add(this.dimLabel);
      this.state = 'radius';
      this.viewport.highlightFace(null);
      this.updateHint();
    } else if (this.state === 'radius') {
      if (this.radius < TINY) return;
      this.state = 'height';
      this.anchorPx.copy(e.px);
      this.updateHint();
    } else if (Math.abs(this.height) >= TINY) {
      this.finishCylinder();
    }
  }

  protected apply() {
    const e = this.entity<CylinderEntity>();
    if (!e) return;
    Object.assign(e, cylinderFromPlane(this.plane, this.center, this.radius, this.previewHeight()));
    e.hole = this.isHole;
    this.doc.touch();
    this.dimLabel.position.copy(this.center).addScaledVector(this.plane.n, this.height);
    const text =
      this.state === 'height'
        ? `Ø${this.fmtValue(this.radius * 2)} × ${this.fmtValue(Math.abs(this.height))} ${this.units}`
        : `r ${this.fmt(this.radius)}`;
    setLabel(this.dimLabel, text + (this.isHole ? ' (hole)' : ''));
    this.ctx.setMeasurement(this.state === 'height' ? 'Height' : 'Radius', this.fmtValue(this.state === 'height' ? Math.abs(this.height) : this.radius));
  }

  private finishCylinder() {
    this.last = { id: this.entityId!, plane: this.plane, center: this.center.clone(), r: this.radius, h: this.height };
    this.finish();
  }

  /** "d10" / "Ø10" means diameter. */
  private parseRadius(text: string): number | null {
    const m = /^\s*(d|ø|⌀)\s*(.+)$/i.exec(text);
    const v = parseLength(m ? m[2] : text, this.units);
    if (v === null) return null;
    return Math.abs(m ? v / 2 : v);
  }

  value(text: string): boolean {
    if (this.state === 'radius') {
      const parts = text.split(/\s*[;,]\s*/);
      const r = this.parseRadius(parts[0]);
      if (!r || r < TINY) return false;
      this.radius = r;
      const h = parts[1] ? parseLength(parts[1], this.units) : null;
      if (h != null && Math.abs(h) >= TINY) {
        this.height = withSign(h, this.height || 1);
        this.state = 'height';
        this.apply();
        this.finishCylinder();
      } else {
        this.state = 'height';
        this.apply();
        this.updateHint();
      }
      return true;
    }
    if (this.state === 'height') {
      const v = parseLength(text, this.units);
      if (v == null || Math.abs(v) < TINY) return false;
      this.height = withSign(v, this.height || 1);
      this.apply();
      this.finishCylinder();
      return true;
    }
    const last = this.last;
    if (!last || !this.doc.get(last.id) || !this.canRetype()) return false;
    const parts = text.split(/\s*[;,]\s*/);
    if (parts.length === 1) {
      const v = parseLength(parts[0], this.units);
      if (v == null) return false;
      last.h = withSign(v, last.h);
    } else {
      const r = parts[0] ? this.parseRadius(parts[0]) : last.r;
      const h = parts[1] ? parseLength(parts[1], this.units) : last.h;
      if (!r || h == null) return false;
      last.r = r;
      last.h = withSign(h, last.h);
    }
    this.doc.update(last.id, (e) => Object.assign(e, cylinderFromPlane(last.plane, last.center, last.r, last.h)));
    this.markRetype();
    this.reset();
    return true;
  }

  keyDown(e: KeyboardEvent): boolean {
    if (e.key === 'Alt' && this.state !== 'idle') return this.toggleHole();
    if (this.state === 'idle') return this.toggleForcedPlane(e);
    return false;
  }
}

// ---------------------------------------------------------------------------

/** Draw a closed polygon point by point, then extrude it into a solid. */
export class LineTool extends ExtrudingTool {
  readonly id = 'line' as const;
  readonly label = 'Line / Shape';
  override get busy() {
    return this.state !== 'idle';
  }
  private state: 'idle' | 'drawing' | 'height' = 'idle';
  private points: THREE.Vector2[] = [];
  private cursor2 = new THREE.Vector2();
  private draft: THREE.Line | null = null;
  private lastPx = new THREE.Vector2();

  hint(): string {
    switch (this.state) {
      case 'idle':
        return 'Line: click to start an outline.' + this.planeHint();
      case 'drawing':
        return 'Click to add points; click the first point (or press Enter) to close. Type a length, or dx,dy. Backspace removes the last point.';
      case 'height':
        return 'Move to set the thickness and click, or type it. Tap Alt: toggle hole.';
    }
  }

  protected override reset() {
    this.state = 'idle';
    this.points = [];
    this.draft = null;
    super.reset();
  }

  private draftSnapPoints(): SnapPoint[] {
    return this.points.map((p) => ({ point: fromPlane(this.plane, p.x, p.y), kind: 'endpoint' as const, entityId: '__draft' }));
  }

  private redrawDraft() {
    if (this.draft) {
      this.overlay.group.remove(this.draft);
      this.draft.geometry.dispose();
      (this.draft.material as THREE.Material).dispose();
    }
    const pts = [...this.points, this.cursor2].map((p) => fromPlane(this.plane, p.x, p.y));
    let color: number = COLORS.preview;
    if (this.points.length) {
      const last = this.points[this.points.length - 1];
      const d = this.cursor2.clone().sub(last);
      if (d.lengthSq() > 1e-9) {
        const world = this.plane.u.clone().multiplyScalar(d.x).addScaledVector(this.plane.v, d.y).normalize();
        const c = axisColor(world);
        if (c !== COLORS.measure) color = c;
      }
    }
    this.draft = this.overlay.add(makeLine(pts, color));
    this.viewport.requestRender();
  }

  pointerMove(e: ToolEvent) {
    this.lastPx.copy(e.px);
    if (this.state === 'idle') return this.idleMove(e);
    if (this.state === 'drawing') {
      const inf = this.ctx.snapper.pointOnPlane(e.px, this.plane, undefined, this.draftSnapPoints());
      this.showInference(inf);
      if (!inf) return;
      this.cursor2 = toPlane(this.plane, inf.point);
      this.redrawDraft();
      const last = this.points[this.points.length - 1];
      const len = this.cursor2.distanceTo(last);
      this.dimLabel.position.copy(fromPlane(this.plane, this.cursor2.x, this.cursor2.y));
      setLabel(this.dimLabel, this.fmt(len));
      this.ctx.setMeasurement('Length', this.fmtValue(len));
      return;
    }
    this.moveHeight(e);
    this.apply();
  }

  pointerDown(e: ToolEvent) {
    if (e.button !== 0) return;
    if (this.state === 'idle') {
      const inf = this.ctx.snapper.freePoint(e.px);
      if (!inf) return;
      this.beginOn(inf);
      this.points = [new THREE.Vector2(0, 0)];
      this.cursor2 = new THREE.Vector2(0, 0);
      this.overlay.add(this.dimLabel);
      this.state = 'drawing';
      this.viewport.highlightFace(null);
      this.updateHint();
      return;
    }
    if (this.state === 'drawing') {
      this.addPoint(this.cursor2.clone());
      return;
    }
    if (Math.abs(this.height) >= TINY) this.finish();
  }

  doubleClick() {
    if (this.state === 'drawing') this.close();
  }

  private addPoint(p: THREE.Vector2) {
    const first = this.points[0];
    if (this.points.length >= 3 && p.distanceTo(first) < 1e-3) {
      this.close();
      return;
    }
    if (p.distanceTo(this.points[this.points.length - 1]) < 1e-3) return;
    this.points.push(p);
    this.redrawDraft();
  }

  private close() {
    // Drop a trailing point that duplicates the first one.
    const pts = this.points.filter((p, i) => i === 0 || p.distanceTo(this.points[i - 1]) > 1e-3);
    if (pts.length >= 3 && pts[pts.length - 1].distanceTo(pts[0]) < 1e-3) pts.pop();
    if (pts.length < 3 || Math.abs(polygonArea(pts)) < 1e-3) {
      this.ctx.toast('Need at least 3 points that enclose an area');
      return;
    }
    this.points = pts;
    if (this.draft) {
      this.overlay.group.remove(this.draft);
      this.draft = null;
    }
    const shape: ExtrusionEntity = {
      id: newId(),
      name: this.doc.nextName('extrusion'),
      kind: 'extrusion',
      color: this.ctx.defaultColor(),
      hole: false,
      visible: true,
      ...extrusionFromPlane(this.plane, pts, 0),
    };
    this.entityId = shape.id;
    this.doc.add(shape);
    this.state = 'height';
    this.anchorPx.copy(this.lastPx);
    this.updateHint();
  }

  protected apply() {
    const e = this.entity<ExtrusionEntity>();
    if (!e) return;
    Object.assign(e, extrusionFromPlane(this.plane, this.points, this.height));
    e.hole = this.isHole;
    this.doc.touch();
    const c = this.points.reduce((acc, p) => acc.add(p), new THREE.Vector2()).divideScalar(this.points.length);
    this.dimLabel.position.copy(fromPlane(this.plane, c.x, c.y, this.height));
    setLabel(this.dimLabel, this.fmt(Math.abs(this.height)) + (this.isHole ? ' (hole)' : ''));
    this.ctx.setMeasurement('Thickness', this.fmtValue(Math.abs(this.height)));
  }

  value(text: string): boolean {
    if (this.state === 'drawing') {
      const list = parseLengthList(text, this.units);
      if (!list || list.some((v) => v == null)) return false;
      const last = this.points[this.points.length - 1];
      if (list.length === 1) {
        let dir = this.cursor2.clone().sub(last);
        if (dir.lengthSq() < 1e-9) dir = new THREE.Vector2(1, 0);
        this.addPoint(last.clone().addScaledVector(dir.normalize(), list[0]!));
      } else {
        this.addPoint(last.clone().add(new THREE.Vector2(list[0]!, list[1]!)));
      }
      this.cursor2 = this.points[this.points.length - 1].clone();
      return true;
    }
    if (this.state === 'height') {
      const v = parseLength(text, this.units);
      if (v == null || Math.abs(v) < TINY) return false;
      this.height = withSign(v, this.height || 1);
      this.apply();
      this.finish();
      return true;
    }
    return false;
  }

  keyDown(e: KeyboardEvent): boolean {
    if (this.state === 'drawing') {
      if (e.key === 'Enter') {
        this.close();
        return true;
      }
      if (e.key === 'Backspace') {
        if (this.points.length > 1) {
          this.points.pop();
          this.redrawDraft();
        } else this.cancel();
        return true;
      }
    }
    if (e.key === 'Alt' && this.state === 'height') return this.toggleHole();
    if (this.state === 'idle') return this.toggleForcedPlane(e);
    return false;
  }
}
