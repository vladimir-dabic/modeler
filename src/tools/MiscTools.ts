import * as THREE from 'three';
import { axisColor, COLORS, makeLabel, makeLine, setLabel } from '../viewport/overlay';
import { arrowAxis, axisName, sameAxis, Tool, type ToolEvent } from './Tool';

/** Measure the distance between two points. Results stay visible until the next one. */
export class TapeTool extends Tool {
  readonly id = 'tape' as const;
  readonly label = 'Tape Measure';
  override get busy() {
    return this.state !== 'idle' || this.overlay.group.children.length > 0;
  }
  private state: 'idle' | 'measuring' = 'idle';
  private p1 = new THREE.Vector3();
  private downPx = new THREE.Vector2();
  private axisLock: THREE.Vector3 | null = null;
  private readonly dimLabel = makeLabel('', 'vp-label vp-label-measure');

  hint(): string {
    if (this.state === 'measuring') {
      const lock = this.axisLock ? ` Locked to ${axisName(this.axisLock)}.` : ' Arrow keys lock an axis.';
      return 'Click the second point.' + lock;
    }
    return 'Tape measure: click the first point (corners and midpoints snap).';
  }

  protected override reset() {
    this.state = 'idle';
    this.axisLock = null;
    super.reset();
  }

  pointerMove(e: ToolEvent) {
    if (this.state === 'idle') {
      this.showInference(this.ctx.snapper.freePoint(e.px));
      return;
    }
    let p2: THREE.Vector3 | null;
    if (this.axisLock) {
      const { distance } = this.ctx.snapper.distanceAlong(e.px, this.p1, this.axisLock, this.downPx);
      p2 = this.p1.clone().addScaledVector(this.axisLock, distance);
      this.viewport.setSnapMarker(p2, 'axis', 'On axis');
    } else {
      const inf = this.ctx.snapper.freePoint(e.px);
      this.showInference(inf);
      p2 = inf?.point ?? null;
    }
    if (p2) this.drawMeasure(p2);
  }

  private drawMeasure(p2: THREE.Vector3) {
    this.overlay.clear();
    const d = p2.clone().sub(this.p1);
    const color = d.lengthSq() > 0 ? axisColor(d.clone().normalize()) : COLORS.measure;
    this.overlay.add(makeLine([this.p1, p2], color, { dashed: true }));
    this.overlay.add(this.dimLabel);
    this.dimLabel.position.copy(this.p1).add(p2).multiplyScalar(0.5);
    setLabel(this.dimLabel, this.fmt(d.length()));
    this.ctx.setMeasurement('Length', this.fmtValue(d.length()));
    this.ctx.setHint(`Δx ${this.fmt(Math.abs(d.x))}   Δy ${this.fmt(Math.abs(d.y))}   Δz ${this.fmt(Math.abs(d.z))}`);
    this.viewport.requestRender();
  }

  pointerDown(e: ToolEvent) {
    if (e.button !== 0) return;
    if (this.state === 'idle') {
      const inf = this.ctx.snapper.freePoint(e.px);
      if (!inf) return;
      this.overlay.clear();
      this.p1.copy(inf.point);
      this.downPx.copy(e.px);
      this.state = 'measuring';
      this.updateHint();
    } else {
      // Keep the finished measurement on screen.
      this.state = 'idle';
      this.axisLock = null;
      this.viewport.setSnapMarker(null);
    }
  }

  keyDown(e: KeyboardEvent): boolean {
    const axis = arrowAxis(e);
    if (axis && this.state === 'measuring') {
      this.axisLock = sameAxis(this.axisLock, axis) ? null : axis;
      this.updateHint();
      return true;
    }
    return false;
  }
}

/** Click objects to delete them. */
export class EraseTool extends Tool {
  readonly id = 'erase' as const;
  readonly label = 'Eraser';
  override readonly cursor = 'pointer';

  hint(): string {
    return 'Eraser: click an object to delete it.';
  }

  pointerMove(e: ToolEvent) {
    const hit = this.viewport.pick(e.px);
    this.viewport.setHover(hit?.entity.id ?? null, COLORS.erase);
  }

  pointerDown(e: ToolEvent) {
    if (e.button !== 0) return;
    const hit = this.viewport.pick(e.px);
    if (!hit) return;
    this.doc.remove([hit.entity.id]);
    this.viewport.setHover(null);
  }
}

/** Left-drag orbits (handy on a trackpad without a middle button). */
export class OrbitTool extends Tool {
  readonly id = 'orbit' as const;
  readonly label = 'Orbit';
  override readonly cursor = 'grab';

  hint(): string {
    return 'Orbit: drag to rotate the view. Scroll to zoom.';
  }

  override activate() {
    super.activate();
    this.viewport.setNavigationMode('orbit');
  }

  override deactivate() {
    super.deactivate();
    this.viewport.setNavigationMode('default');
  }
}

export class PanTool extends Tool {
  readonly id = 'pan' as const;
  readonly label = 'Pan';
  override readonly cursor = 'move';

  hint(): string {
    return 'Pan: drag to slide the view. Scroll to zoom.';
  }

  override activate() {
    super.activate();
    this.viewport.setNavigationMode('pan');
  }

  override deactivate() {
    super.deactivate();
    this.viewport.setNavigationMode('default');
  }
}
