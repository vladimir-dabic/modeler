import * as THREE from 'three';
import { cleanVec, entityQuaternion, planeFromNormal, rotationFromQuaternion, type DrawPlane } from '../model/geometry';
import type { Vec3 } from '../model/types';
import { formatAngle, parseAngle } from '../model/units';
import { axisColor, COLORS, makeCircle, makeLabel, makeLine, setLabel } from '../viewport/overlay';
import { arrowAxis, axisName, sameAxis, Tool, type ToolEvent } from './Tool';

const SNAP_ANGLE = 15;

/**
 * Rotate the selection: click the pivot, click a reference direction, then the angle.
 * The rotation axis is the face normal under the pivot (or Z); arrow keys force an axis.
 */
export class RotateTool extends Tool {
  readonly id = 'rotate' as const;
  readonly label = 'Rotate';
  override get busy() {
    return this.state !== 'idle';
  }
  private state: 'idle' | 'reference' | 'rotating' = 'idle';
  private plane!: DrawPlane;
  private ref = new THREE.Vector3();
  private angle = 0;
  private axisLock: THREE.Vector3 | null = null;
  private originals = new Map<string, { position: Vec3; rotation: Vec3 }>();
  private autoSelected = false;
  private readonly dimLabel = makeLabel('');
  private last: { ids: string[]; plane: DrawPlane; angle: number } | null = null;

  hint(): string {
    const lock = this.axisLock ? ` Axis locked to ${axisName(this.axisLock)}.` : ' Arrow keys pick the axis.';
    switch (this.state) {
      case 'idle':
        return 'Rotate: click the pivot point (select objects first, or click one).' + lock;
      case 'reference':
        return 'Click a reference direction (where the angle starts).';
      case 'rotating':
        return `Click to set the angle (snaps every ${SNAP_ANGLE}°) or type degrees, e.g. 90 or -45.`;
    }
  }

  protected override reset() {
    this.state = 'idle';
    this.originals.clear();
    super.reset();
  }

  private pivotPlane(point: THREE.Vector3, hitNormal: THREE.Vector3 | null): DrawPlane {
    const axis = this.axisLock ?? hitNormal ?? new THREE.Vector3(0, 0, 1);
    return planeFromNormal(point, axis);
  }

  private drawProtractor(plane: DrawPlane, extra?: THREE.Vector3[]) {
    this.overlay.clear();
    const radius = this.viewport.worldPerPixel(plane.origin) * 60;
    this.overlay.add(makeCircle(plane.origin, plane.u, plane.v, radius, axisColor(plane.n)));
    if (extra) for (const p of extra) this.overlay.add(makeLine([plane.origin, p], COLORS.measure, { dashed: true }));
    this.viewport.requestRender();
  }

  pointerMove(e: ToolEvent) {
    if (this.state === 'idle') {
      const inf = this.ctx.snapper.freePoint(e.px);
      this.showInference(inf);
      if (inf) this.drawProtractor(this.pivotPlane(inf.point, inf.hit?.normal ?? null));
      return;
    }
    const exclude = new Set(this.state === 'rotating' ? this.originals.keys() : []);
    const inf = this.ctx.snapper.pointOnPlane(e.px, this.plane, exclude);
    if (!inf) return;
    this.showInference(inf);
    const dir = inf.point.clone().sub(this.plane.origin);
    if (this.state === 'reference') {
      this.drawProtractor(this.plane, [inf.point]);
      return;
    }
    if (dir.lengthSq() < 1e-9) return;
    dir.normalize();
    const cross = new THREE.Vector3().crossVectors(this.ref, dir);
    let angle = Math.atan2(cross.dot(this.plane.n), this.ref.dot(dir)) * (180 / Math.PI);
    if (this.ctx.settings.snapEnabled) {
      const snapped = Math.round(angle / SNAP_ANGLE) * SNAP_ANGLE;
      angle = Math.abs(snapped - angle) < 4 ? snapped : Math.round(angle);
    }
    this.setAngle(angle, inf.point);
  }

  private setAngle(angle: number, cursor?: THREE.Vector3) {
    this.angle = angle;
    const q = new THREE.Quaternion().setFromAxisAngle(this.plane.n, (angle * Math.PI) / 180);
    const pivot = this.plane.origin;
    for (const [id, orig] of this.originals) {
      const e = this.doc.get(id);
      if (!e) continue;
      const p = new THREE.Vector3(...orig.position).sub(pivot).applyQuaternion(q).add(pivot);
      e.position = cleanVec(p);
      const eq = entityQuaternion({ ...e, rotation: orig.rotation });
      e.rotation = rotationFromQuaternion(q.clone().multiply(eq));
    }
    this.doc.touch();
    const radius = this.viewport.worldPerPixel(pivot) * 60;
    const refEnd = pivot.clone().addScaledVector(this.ref, radius * 1.4);
    const curEnd = pivot.clone().addScaledVector(this.ref.clone().applyQuaternion(q), radius * 1.4);
    this.drawProtractor(this.plane, [refEnd, cursor ?? curEnd]);
    this.overlay.add(this.dimLabel);
    this.dimLabel.position.copy(curEnd);
    setLabel(this.dimLabel, formatAngle(angle));
    this.ctx.setMeasurement('Angle', String(Math.round(angle * 100) / 100));
  }

  pointerDown(e: ToolEvent) {
    if (e.button !== 0) return;
    if (this.state === 'idle') {
      const inf = this.ctx.snapper.freePoint(e.px);
      if (!inf) return;
      this.autoSelected = false;
      if (!this.doc.selection.size) {
        if (!inf.hit) return;
        this.doc.setSelection(this.unitOf(inf.hit.entity));
        this.autoSelected = true;
      }
      this.plane = this.pivotPlane(inf.point, inf.hit?.normal ?? null);
      this.state = 'reference';
      this.updateHint();
      return;
    }
    if (this.state === 'reference') {
      const inf = this.ctx.snapper.pointOnPlane(e.px, this.plane);
      if (!inf) return;
      const dir = inf.point.clone().sub(this.plane.origin);
      if (dir.lengthSq() < 1e-6) return;
      this.ref = dir.normalize();
      this.originals = new Map(this.doc.selected().map((s) => [s.id, { position: [...s.position] as Vec3, rotation: [...s.rotation] as Vec3 }]));
      this.doc.begin();
      this.state = 'rotating';
      this.updateHint();
      return;
    }
    this.finish();
  }

  private finish() {
    if (Math.abs(this.angle) < 1e-9) {
      this.doc.cancel();
    } else {
      this.last = { ids: [...this.originals.keys()], plane: this.plane, angle: this.angle };
      this.doc.commit();
      this.markRetype();
    }
    if (this.autoSelected) this.doc.clearSelection();
    this.reset();
    if (this.last) this.ctx.setMeasurement('Angle', String(this.last.angle));
  }

  value(text: string): boolean {
    const a = parseAngle(text);
    if (a === null) return false;
    if (this.state === 'rotating') {
      this.setAngle(a);
      this.finish();
      return true;
    }
    const last = this.last;
    if (this.state !== 'idle' || !last || !this.canRetype()) return false;
    // Retype: rotate by the difference from the previous angle.
    const q = new THREE.Quaternion().setFromAxisAngle(last.plane.n, ((a - last.angle) * Math.PI) / 180);
    const pivot = last.plane.origin;
    this.doc.transact(() => {
      for (const id of last.ids) {
        const e = this.doc.get(id);
        if (!e) continue;
        e.position = cleanVec(new THREE.Vector3(...e.position).sub(pivot).applyQuaternion(q).add(pivot));
        e.rotation = rotationFromQuaternion(q.clone().multiply(entityQuaternion(e)));
      }
    });
    last.angle = a;
    this.markRetype();
    this.ctx.setMeasurement('Angle', String(a));
    return true;
  }

  keyDown(e: KeyboardEvent): boolean {
    const axis = arrowAxis(e);
    if (axis && this.state === 'idle') {
      this.axisLock = sameAxis(this.axisLock, axis) ? null : axis;
      this.updateHint();
      return true;
    }
    return false;
  }
}
