import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { anchorFor, AXIS_VECTORS } from '../model/annotations';
import type { Entity } from '../model/types';
import { makeLabel, makeLine, setLabel, COLORS } from '../viewport/overlay';
import type { Viewport } from '../viewport/Viewport';
import { arrowAxis, axisName, sameAxis, Tool, type ToolEvent } from './Tool';

/** A point picked by a tool, with the part it lies on (annotations attach to it). */
interface Picked {
  point: THREE.Vector3;
  entity?: Entity;
}

/** A Modeler API point: { part, at } on a part, else [x, y, z]. */
function pointRef(p: Picked): unknown {
  const a = anchorFor(p.point, p.entity);
  return 'entity' in a ? { part: a.entity, at: a.at } : a.point;
}

/** Point under the cursor on the camera-facing plane through `through`. */
export function screenPlanePoint(viewport: Viewport, px: THREE.Vector2, through: THREE.Vector3, normal?: THREE.Vector3): THREE.Vector3 | null {
  const n = normal ?? viewport.camera.getWorldDirection(new THREE.Vector3());
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, through);
  return viewport.rayAt(px).intersectPlane(plane, new THREE.Vector3());
}

/**
 * An inline text box in the viewport at a world point. Enter (without Shift) or leaving
 * the box finishes; Escape cancels. Returns a function that closes it without a result.
 */
export function openTextEditor(
  viewport: Viewport,
  at: THREE.Vector3,
  initial: string,
  placeholder: string,
  done: (text: string | null, how: 'enter' | 'blur' | 'cancel') => void,
): () => void {
  const input = document.createElement('textarea');
  input.className = 'vp-annotation-editor';
  input.value = initial;
  input.placeholder = placeholder;
  input.rows = Math.max(1, initial.split('\n').length);
  input.spellcheck = false;
  const obj = new CSS2DObject(input);
  obj.position.copy(at);
  viewport.overlayRoot.add(obj);
  viewport.requestRender();
  let open = true;
  const close = (text: string | null, how: 'enter' | 'blur' | 'cancel') => {
    if (!open) return;
    open = false;
    viewport.overlayRoot.remove(obj);
    input.remove();
    viewport.requestRender();
    if (how !== 'blur') viewport.canvas.focus({ preventScroll: true });
    done(text, how);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') close(null, 'cancel');
    else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      close(input.value, 'enter');
    } else requestAnimationFrame(() => (input.rows = Math.max(1, input.value.split('\n').length)));
  });
  input.addEventListener('blur', () => close(input.value, 'blur'));
  // Let the label renderer place it first, then focus and select.
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
  return () => close(null, 'cancel');
}

/**
 * Text tool (ADR 0015): click a part to attach a note (then move and click to place the
 * label with a leader, or click the same spot for no leader), or click empty space for a
 * free label. Type the text in place; Enter finishes.
 */
export class TextTool extends Tool {
  readonly id = 'text' as const;
  readonly label = 'Text';
  private state: 'idle' | 'placing' | 'typing' = 'idle';
  private anchor: Picked | null = null;
  private downPx = new THREE.Vector2();
  private closeEditor: (() => void) | null = null;
  /** A click outside the text box finishes the note; it shouldn't also start a new one. */
  private swallowDown = false;
  private readonly preview = makeLabel('', 'vp-annotation vp-note preview');

  override get busy() {
    return this.state !== 'idle';
  }

  hint(): string {
    if (this.state === 'placing') return 'Move to place the text and click (click the same spot for no leader line).';
    if (this.state === 'typing') return 'Type the note. Enter finishes, Shift+Enter adds a line, Esc cancels.';
    return 'Text: click a part to attach a note to it, or anywhere for a free label.';
  }

  protected override reset() {
    this.closeEditor?.();
    this.closeEditor = null;
    this.state = 'idle';
    this.anchor = null;
    super.reset();
  }

  private pick(e: ToolEvent): Picked | null {
    const inf = this.ctx.snapper.freePoint(e.px);
    if (!inf) return null;
    this.showInference(inf);
    return { point: inf.point, entity: inf.sourceId ? this.doc.get(inf.sourceId) : undefined };
  }

  pointerMove(e: ToolEvent) {
    if (this.state === 'idle') {
      const p = this.pick(e);
      this.viewport.setHover(p?.entity?.id ?? null);
      return;
    }
    if (this.state !== 'placing' || !this.anchor) return;
    const at = e.px.distanceTo(this.downPx) < 4 ? this.anchor.point : screenPlanePoint(this.viewport, e.px, this.anchor.point);
    if (!at) return;
    this.overlay.clear();
    if (at !== this.anchor.point) this.overlay.add(makeLine([this.anchor.point, at], COLORS.measure));
    setLabel(this.preview, this.anchor.entity?.name ?? 'Text');
    this.preview.position.copy(at);
    this.overlay.add(this.preview);
    this.viewport.requestRender();
  }

  pointerDown(e: ToolEvent) {
    if (e.button !== 0) return;
    if (this.swallowDown) {
      this.swallowDown = false;
      return;
    }
    if (this.state === 'idle') {
      const p = this.pick(e);
      if (!p) return;
      this.anchor = p;
      this.downPx.copy(e.px);
      this.state = 'placing';
      this.viewport.setSnapMarker(null);
      this.viewport.setHover(null);
      this.updateHint();
      this.pointerMove(e);
      return;
    }
    if (this.state !== 'placing' || !this.anchor) return;
    const anchor = this.anchor;
    const at = e.px.distanceTo(this.downPx) < 4 ? anchor.point.clone() : screenPlanePoint(this.viewport, e.px, anchor.point);
    if (!at) return;
    this.state = 'typing';
    this.updateHint();
    this.overlay.clear();
    if (!at.equals(anchor.point)) this.overlay.add(makeLine([anchor.point, at], COLORS.measure));
    this.closeEditor = openTextEditor(this.viewport, at, '', anchor.entity?.name ?? 'Text', (text, how) => {
      this.closeEditor = null;
      // Blur from a click in the viewport: that pointerdown arrives right after.
      if (how === 'blur') {
        this.swallowDown = true;
        setTimeout(() => (this.swallowDown = false), 300);
      }
      const value = text?.trim();
      if (value) {
        // Label positions don't need sub-millimetre precision.
        const offset = at.clone().sub(anchor.point).round();
        this.ctx.call('add_note', { text: value, at: pointRef(anchor), label_offset: [offset.x, offset.y, offset.z] }, 'Add text');
      }
      this.reset();
    });
  }
}

/**
 * Dimension tool (ADR 0015): click two points (corners snap; arrow keys lock an axis),
 * then move to set how far the dimension line sits from them, and click. Dimensions on
 * parts follow them when they move or change size.
 */
export class DimensionTool extends Tool {
  readonly id = 'dimension' as const;
  readonly label = 'Dimension';
  private state: 'idle' | 'second' | 'offset' = 'idle';
  private p1: Picked | null = null;
  private p2: Picked | null = null;
  private axisLock: THREE.Vector3 | null = null;
  private offset = new THREE.Vector3();
  private readonly valueLabel = makeLabel('', 'vp-annotation vp-dim preview');

  override get busy() {
    return this.state !== 'idle';
  }

  hint(): string {
    const lock = this.axisLock ? ` Measuring along ${axisName(this.axisLock)}.` : ' Arrow keys measure along one axis.';
    if (this.state === 'second') return 'Click the second point.' + lock;
    if (this.state === 'offset') return 'Move to place the dimension line, then click.' + lock;
    return 'Dimension: click the first point (corners, midpoints and centres snap).';
  }

  protected override reset() {
    this.state = 'idle';
    this.p1 = this.p2 = null;
    this.axisLock = null;
    super.reset();
  }

  private pick(e: ToolEvent): Picked | null {
    const inf = this.ctx.snapper.freePoint(e.px);
    if (!inf) return null;
    this.showInference(inf);
    return { point: inf.point, entity: inf.sourceId ? this.doc.get(inf.sourceId) : undefined };
  }

  /** Direction and value of what is measured. */
  private measure(a: THREE.Vector3, b: THREE.Vector3): { dir: THREE.Vector3; value: number } {
    if (this.axisLock) {
      const along = b.clone().sub(a).dot(this.axisLock);
      return { dir: this.axisLock.clone().multiplyScalar(along < 0 ? -1 : 1), value: Math.abs(along) };
    }
    const ab = b.clone().sub(a);
    const value = ab.length();
    return { dir: value > 1e-9 ? ab.normalize() : new THREE.Vector3(1, 0, 0), value };
  }

  private draw(a: THREE.Vector3, b: THREE.Vector3, offset: THREE.Vector3) {
    const { dir, value } = this.measure(a, b);
    const a2 = a.clone().add(offset);
    const b2 = this.axisLock ? a2.clone().addScaledVector(dir, value) : b.clone().add(offset);
    this.overlay.clear();
    if (offset.lengthSq() > 0) {
      this.overlay.add(makeLine([a, a2], COLORS.measure, { opacity: 0.6 }));
      this.overlay.add(makeLine([b, b2], COLORS.measure, { opacity: 0.6 }));
    }
    this.overlay.add(makeLine([a2, b2], COLORS.measure));
    setLabel(this.valueLabel, this.fmt(value));
    this.valueLabel.position.copy(a2).add(b2).multiplyScalar(0.5);
    this.overlay.add(this.valueLabel);
    this.ctx.setMeasurement('Dimension', this.fmtValue(value));
    this.viewport.requestRender();
  }

  pointerMove(e: ToolEvent) {
    if (this.state === 'idle') {
      this.pick(e);
      return;
    }
    if (this.state === 'second' && this.p1) {
      const p = this.pick(e);
      if (p) this.draw(this.p1.point, p.point, new THREE.Vector3());
      return;
    }
    if (this.state === 'offset' && this.p1 && this.p2) {
      const a = this.p1.point;
      const { dir } = this.measure(a, this.p2.point);
      // The plane that contains the dimension direction and faces the camera most.
      const cam = this.viewport.camera.getWorldDirection(new THREE.Vector3());
      const n = cam.addScaledVector(dir, -cam.dot(dir));
      if (n.lengthSq() < 1e-9) return;
      const p = screenPlanePoint(this.viewport, e.px, a, n.normalize());
      if (!p) return;
      const off = p.sub(a);
      off.addScaledVector(dir, -off.dot(dir));
      // Snap the direction to a world axis when close, so dimensions sit square.
      for (const axis of Object.values(AXIS_VECTORS)) {
        const len = off.length();
        if (len > 0 && Math.abs(off.dot(axis)) / len > 0.97) off.copy(axis).multiplyScalar(Math.sign(off.dot(axis)) * len);
      }
      off.set(this.ctx.snapper.round(off.x), this.ctx.snapper.round(off.y), this.ctx.snapper.round(off.z));
      this.offset.copy(off);
      this.viewport.setSnapMarker(null);
      this.draw(a, this.p2.point, off);
    }
  }

  pointerDown(e: ToolEvent) {
    if (e.button !== 0) return;
    if (this.state === 'idle') {
      const p = this.pick(e);
      if (!p) return;
      this.p1 = p;
      this.state = 'second';
      this.updateHint();
      return;
    }
    if (this.state === 'second' && this.p1) {
      const p = this.pick(e);
      if (!p || this.measure(this.p1.point, p.point).value < 1e-6) return;
      this.p2 = p;
      this.offset.set(0, 0, 0);
      this.state = 'offset';
      this.updateHint();
      return;
    }
    if (this.state === 'offset' && this.p1 && this.p2) {
      const axis = this.axisLock ? (['x', 'y', 'z'] as const).find((k) => Math.abs(AXIS_VECTORS[k].dot(this.axisLock!)) > 0.99) : undefined;
      this.ctx.call(
        'add_dimension',
        { from: pointRef(this.p1), to: pointRef(this.p2), ...(axis ? { axis } : {}), offset: [this.offset.x, this.offset.y, this.offset.z] },
        'Add dimension',
      );
      this.reset();
    }
  }

  keyDown(e: KeyboardEvent): boolean {
    const axis = arrowAxis(e);
    if (axis && this.state !== 'idle') {
      this.axisLock = sameAxis(this.axisLock, axis) ? null : axis;
      this.updateHint();
      return true;
    }
    return false;
  }
}
