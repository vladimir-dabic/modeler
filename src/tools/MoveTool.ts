import * as THREE from 'three';
import { copyEntities } from '../model/editing';
import { cleanVec, groundPlane, intersectRayPlane } from '../model/geometry';
import type { Entity, Vec3 } from '../model/types';
import { parseLengthList } from '../model/units';
import { axisColor, COLORS, makeLabel, makeLine, setLabel } from '../viewport/overlay';
import { arrowAxis, axisName, sameAxis, Tool, type ToolEvent } from './Tool';

/**
 * Move (and copy) the selection: pick a base point, then a destination.
 * Snaps to corners of other objects; arrow keys lock an axis; tapping Alt/Option toggles copy.
 * After a copy, type `5x` for an array of 5 copies, or `/5` to divide the distance.
 */
export class MoveTool extends Tool {
  readonly id = 'move' as const;
  readonly label = 'Move / Copy';
  override readonly vcbStarters = 'xX';
  private state: 'idle' | 'moving' = 'idle';
  private base = new THREE.Vector3();
  private delta = new THREE.Vector3();
  private sourceIds: string[] = [];
  private originals = new Map<string, Vec3>();
  private cloneIds: string[] = [];
  private copy = false;
  private axisLock: THREE.Vector3 | null = null;
  private downPx = new THREE.Vector2();
  private dragged = false;
  private autoSelected = false;
  private readonly dimLabel = makeLabel('');
  private last: { sourceIds: string[]; delta: THREE.Vector3; copies: string[] } | null = null;

  hint(): string {
    if (this.state === 'moving') {
      const lock = this.axisLock ? ` Locked to ${axisName(this.axisLock)}.` : ' Arrow keys lock an axis.';
      return `${this.copy ? 'Copying' : 'Moving'}: click the destination or type a distance (or x,y,z).${lock} Tap Alt/Option: toggle copy.`;
    }
    const sel = this.doc.selection.size;
    return sel
      ? `Move ${sel} selected: click a base point (corners snap). After a copy, type 5x for an array or /5 to divide.`
      : 'Move: click an object to pick it up at that point (or select first).';
  }

  protected override reset() {
    this.state = 'idle';
    this.cloneIds = [];
    this.copy = false;
    this.axisLock = null;
    this.originals.clear();
    super.reset();
  }

  private get movingIds(): string[] {
    return this.copy ? this.cloneIds : this.sourceIds;
  }

  pointerMove(e: ToolEvent) {
    if (this.state === 'idle') {
      const inf = this.ctx.snapper.freePoint(e.px);
      this.showInference(inf);
      if (!this.doc.selection.size) this.viewport.setHighlighted(inf?.hit ? this.unitOf(inf.hit.entity) : []);
      return;
    }
    if (e.px.distanceTo(this.downPx) > 4) this.dragged = true;
    this.computeDelta(e);
    this.applyDelta();
  }

  private computeDelta(e: ToolEvent) {
    const exclude = new Set(this.movingIds);
    if (this.axisLock) {
      const { distance } = this.ctx.snapper.distanceAlong(e.px, this.base, this.axisLock, this.downPx, exclude);
      this.delta.copy(this.axisLock).multiplyScalar(distance);
      this.viewport.setSnapMarker(this.base.clone().add(this.delta), 'axis', 'On axis');
      return;
    }
    const inf = this.ctx.snapper.freePoint(e.px, exclude);
    let target: THREE.Vector3 | null = null;
    if (inf && inf.kind !== 'ground') {
      target = inf.point;
      this.showInference(inf);
    } else {
      // Free movement happens in the horizontal plane through the base point.
      const plane = groundPlane(this.base.z);
      const p = intersectRayPlane(this.viewport.rayAt(e.px), plane);
      if (p) {
        p.x = this.base.x + this.ctx.snapper.round(p.x - this.base.x);
        p.y = this.base.y + this.ctx.snapper.round(p.y - this.base.y);
        p.z = this.base.z;
        target = p;
      }
      this.viewport.setSnapMarker(null);
    }
    if (target) this.delta.copy(target).sub(this.base);
  }

  private applyDelta() {
    for (const [id, pos] of this.originals) {
      const e = this.doc.get(id);
      if (e) e.position = [...pos];
    }
    const ids = this.movingIds;
    ids.forEach((id, i) => {
      const e = this.doc.get(id);
      const src = this.originals.get(this.sourceIds[i]);
      if (e && src) e.position = cleanVec(new THREE.Vector3(...src).add(this.delta));
    });
    this.doc.touch();

    this.overlay.clear();
    const end = this.base.clone().add(this.delta);
    const dir = this.delta.clone().normalize();
    const color = this.axisLock ? axisColor(this.axisLock) : this.delta.lengthSq() > 0 ? axisColor(dir) : COLORS.measure;
    this.overlay.add(makeLine([this.base, end], color, { dashed: color === COLORS.measure }));
    this.overlay.add(this.dimLabel);
    this.dimLabel.position.copy(end);
    setLabel(this.dimLabel, this.fmt(this.delta.length()));
    this.ctx.setMeasurement('Distance', this.fmtValue(this.delta.length()));
    this.viewport.requestRender();
  }

  pointerDown(e: ToolEvent) {
    if (e.button !== 0) return;
    if (this.state === 'moving') {
      this.finish();
      return;
    }
    const inf = this.ctx.snapper.freePoint(e.px);
    if (!inf) return;
    this.autoSelected = false;
    if (!this.doc.selection.size || (inf.hit && !this.doc.selection.has(inf.hit.entity.id) && !e.mod)) {
      if (!inf.hit) return;
      this.doc.setSelection(this.unitOf(inf.hit.entity));
      this.autoSelected = true;
    }
    this.viewport.setHighlighted([]);
    this.sourceIds = this.doc.selected().map((s) => s.id);
    this.originals = new Map(this.doc.selected().map((s) => [s.id, [...s.position] as Vec3]));
    this.base.copy(inf.point);
    this.delta.set(0, 0, 0);
    this.downPx.copy(e.px);
    this.dragged = false;
    this.copy = e.alt;
    this.doc.begin();
    if (this.copy) this.makeClones();
    this.state = 'moving';
    this.updateHint();
  }

  pointerUp(e: ToolEvent) {
    if (this.state === 'moving' && this.dragged && e.button === 0) this.finish();
  }

  private sources(): Entity[] {
    return this.sourceIds.map((id) => this.doc.get(id)).filter((e): e is Entity => !!e);
  }

  /** Copies come back in source order, which applyDelta relies on. Whole groups copy as new groups. */
  private makeClones() {
    this.cloneIds = copyEntities(this.doc, this.sources(), () => {}).map((c) => c.id);
  }

  private setCopy(on: boolean) {
    if (on === this.copy || this.state !== 'moving') return;
    this.copy = on;
    if (on) this.makeClones();
    else {
      this.doc.remove(this.cloneIds);
      this.cloneIds = [];
    }
    this.applyDelta();
    this.updateHint();
  }

  private finish() {
    if (this.delta.lengthSq() < 1e-12) {
      this.doc.cancel();
      if (this.autoSelected) this.doc.clearSelection();
      this.reset();
      return;
    }
    const copies = this.copy ? [...this.cloneIds] : [];
    this.last = { sourceIds: [...this.sourceIds], delta: this.delta.clone(), copies };
    this.doc.commit();
    this.markRetype();
    if (copies.length) this.doc.setSelection(copies);
    else if (this.autoSelected) this.doc.clearSelection();
    this.reset();
    this.ctx.setMeasurement('Distance', this.fmtValue(this.last.delta.length()));
  }

  value(text: string): boolean {
    const array = /^\s*(?:[x*]\s*(\d+)|(\d+)\s*[x*])\s*$/i.exec(text);
    const divide = /^\s*\/\s*(\d+)\s*$/.exec(text);
    if (array || divide) return this.makeArray(array ? parseInt(array[1] ?? array[2], 10) : parseInt(divide![1], 10), !!divide);

    const list = parseLengthList(text, this.units);
    if (!list || list.some((v) => v == null)) return false;
    let delta: THREE.Vector3;
    if (list.length === 3) delta = new THREE.Vector3(list[0]!, list[1]!, list[2]!);
    else if (list.length === 1) {
      const dir = this.axisLock?.clone() ?? (this.state === 'moving' ? this.delta.clone() : this.last?.delta.clone() ?? new THREE.Vector3());
      if (this.axisLock && this.delta.dot(this.axisLock) < 0) dir.negate();
      if (dir.lengthSq() < 1e-12) return false;
      delta = dir.normalize().multiplyScalar(list[0]!);
    } else return false;

    if (this.state === 'moving') {
      this.delta.copy(delta);
      this.applyDelta();
      this.finish();
      return true;
    }
    // Retype the last move.
    const last = this.last;
    if (!last || !this.canRetype()) return false;
    const moved = last.copies.length ? last.copies : last.sourceIds;
    this.doc.transact(() => {
      moved.forEach((id) => {
        const e = this.doc.get(id);
        if (!e) return;
        const p = new THREE.Vector3(...e.position).sub(last.delta).add(delta);
        e.position = cleanVec(p);
      });
    });
    last.delta.copy(delta);
    this.markRetype();
    this.ctx.setMeasurement('Distance', this.fmtValue(delta.length()));
    return true;
  }

  /** Replace the last copy with an array of `count` copies (or `count` divisions). */
  private makeArray(count: number, divide: boolean): boolean {
    const last = this.last;
    if (!last || !last.copies.length || !this.canRetype() || count < 1 || count > 500) {
      this.ctx.toast('Arrays work right after a copy (Move, then tap Alt/Option)');
      return false;
    }
    const step = divide ? last.delta.clone().divideScalar(count) : last.delta.clone();
    const created: string[] = [];
    this.doc.transact(() => {
      this.doc.remove(last.copies);
      const sources = last.sourceIds.map((id) => this.doc.get(id)).filter((e): e is Entity => !!e);
      for (let k = 1; k <= count; k++) {
        const copies = copyEntities(this.doc, sources, (c) => {
          c.position = cleanVec(new THREE.Vector3(...c.position).addScaledVector(step, k));
        });
        created.push(...copies.map((c) => c.id));
      }
    });
    last.copies = created;
    this.markRetype();
    this.doc.setSelection(created);
    this.ctx.toast(`${count} ${divide ? 'divisions' : 'copies'}`);
    return true;
  }

  keyDown(e: KeyboardEvent): boolean {
    if (e.key === 'Alt') {
      if (this.state === 'moving') {
        this.setCopy(!this.copy);
        return true;
      }
      return false;
    }
    const axis = arrowAxis(e);
    if (axis && this.state === 'moving') {
      this.axisLock = sameAxis(this.axisLock, axis) ? null : axis;
      this.updateHint();
      return true;
    }
    return false;
  }
}
