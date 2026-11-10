import * as THREE from 'three';
import type { ModelDocument } from '../model/Document';
import { groundPlane, planeFromFace, planeFromNormal, type DrawPlane } from '../model/geometry';
import { selectionUnit } from '../model/groups';
import type { Entity, Unit } from '../model/types';
import type { WorkspaceConfig } from '../model/workspaces';
import { formatLength } from '../model/units';
import { Overlay } from '../viewport/overlay';
import { INFERENCE_LABEL, type Inference, type SnapSettings, type Snapper } from '../viewport/Snapper';
import type { Viewport } from '../viewport/Viewport';

export type ToolId =
  | 'select'
  | 'box'
  | 'cylinder'
  | 'line'
  | 'pushpull'
  | 'move'
  | 'rotate'
  | 'tape'
  | 'erase'
  | 'orbit'
  | 'pan';

export interface ToolContext {
  doc: ModelDocument;
  viewport: Viewport;
  snapper: Snapper;
  settings: SnapSettings;
  /** Status bar hint for the current tool step. */
  setHint(text: string): void;
  /** Measurement box (bottom right): label + current value. */
  setMeasurement(label: string, value: string): void;
  toast(text: string): void;
  setTool(id: ToolId): void;
  defaultColor(): string;
  workspace(): WorkspaceConfig;
}

export interface ToolEvent {
  /** Canvas-relative pixel position. */
  px: THREE.Vector2;
  button: number;
  shift: boolean;
  /** Ctrl on Windows/Linux, Cmd on macOS. */
  mod: boolean;
  alt: boolean;
}

/**
 * Base class for interactive tools. Tools receive viewport pointer events,
 * key presses, and values typed into the measurement box.
 */
export abstract class Tool {
  abstract readonly id: ToolId;
  abstract readonly label: string;
  readonly cursor: string = 'crosshair';
  /** Extra characters (besides digits and symbols) that start typing into the measurement box. */
  readonly vcbStarters: string = '';
  protected readonly overlay = new Overlay();

  constructor(protected readonly ctx: ToolContext) {}

  protected get doc() {
    return this.ctx.doc;
  }

  protected get viewport() {
    return this.ctx.viewport;
  }

  protected get units(): Unit {
    return this.ctx.doc.units;
  }

  protected fmt(mm: number): string {
    return formatLength(mm, this.units);
  }

  protected fmtValue(mm: number): string {
    return formatLength(mm, this.units, false);
  }

  activate(): void {
    this.viewport.overlayRoot.add(this.overlay.group);
    this.reset();
  }

  deactivate(): void {
    this.cancel();
    this.viewport.overlayRoot.remove(this.overlay.group);
    this.viewport.setSnapMarker(null);
    this.viewport.highlightFace(null);
    this.viewport.setHover(null);
  }

  /** Abort the current operation (Escape). */
  cancel(): void {
    if (this.doc.inTransaction) this.doc.cancel();
    this.reset();
  }

  /** Return to the tool's initial state, clearing temporary graphics. */
  protected reset(): void {
    this.overlay.clear();
    this.viewport.setSnapMarker(null);
    this.viewport.highlightFace(null);
    this.ctx.setMeasurement('', '');
    this.ctx.setHint(this.hint());
    this.viewport.requestRender();
  }

  abstract hint(): string;

  /** True while an operation is in progress (Escape cancels it instead of clearing selection). */
  get busy(): boolean {
    return this.doc.inTransaction;
  }

  pointerDown(_e: ToolEvent): void {}
  pointerMove(_e: ToolEvent): void {}
  pointerUp(_e: ToolEvent): void {}
  doubleClick(_e: ToolEvent): void {}
  /** Return true if the key was handled. */
  keyDown(_e: KeyboardEvent): boolean {
    return false;
  }
  keyUp(_e: KeyboardEvent): void {}
  /** A value typed into the measurement box. Return true if accepted. */
  value(_text: string): boolean {
    return false;
  }

  /** What clicking `e` selects: its whole group (or the part, inside an open group). ADR 0011. */
  protected unitOf(e: Entity): string[] {
    return selectionUnit(e, this.doc.entities, this.doc.groups, this.doc.openGroupId);
  }

  private retypeVersion = -1;

  /** Remember the document version right after an operation, so it can be retyped. */
  protected markRetype() {
    this.retypeVersion = this.doc.version;
  }

  /** Typed values may adjust the last operation only if nothing else changed since. */
  protected canRetype(): boolean {
    return this.retypeVersion === this.doc.version;
  }

  protected updateHint() {
    this.ctx.setHint(this.hint());
  }

  protected showInference(inf: Inference | null) {
    if (!inf || inf.kind === 'free') {
      this.viewport.setSnapMarker(null);
      return;
    }
    this.viewport.setSnapMarker(inf.point, inf.kind, INFERENCE_LABEL[inf.kind]);
  }
}

/**
 * Drawing plane for a first click: the face under the cursor if the point lies on it,
 * otherwise a horizontal plane through the point. `forcedNormal` (from arrow keys) wins.
 */
export function planeForInference(inf: Inference, forcedNormal: THREE.Vector3 | null): DrawPlane {
  if (forcedNormal) return planeFromNormal(inf.point, forcedNormal);
  const hit = inf.hit;
  if (hit && Math.abs(inf.point.clone().sub(hit.point).dot(hit.normal)) < 1e-3) {
    return planeFromFace(hit.entity, hit.localNormal, inf.point);
  }
  const plane = groundPlane(inf.point.z);
  plane.origin.copy(inf.point);
  return plane;
}

/** Arrow keys pick an axis, SketchUp-style: → red (X), ← green (Y), ↑/↓ blue (Z). */
export function arrowAxis(e: KeyboardEvent): THREE.Vector3 | null {
  switch (e.key) {
    case 'ArrowRight':
      return new THREE.Vector3(1, 0, 0);
    case 'ArrowLeft':
      return new THREE.Vector3(0, 1, 0);
    case 'ArrowUp':
    case 'ArrowDown':
      return new THREE.Vector3(0, 0, 1);
    default:
      return null;
  }
}

export function axisName(v: THREE.Vector3): string {
  if (Math.abs(v.x) > 0.999) return 'red (X)';
  if (Math.abs(v.y) > 0.999) return 'green (Y)';
  if (Math.abs(v.z) > 0.999) return 'blue (Z)';
  return 'custom';
}

export function sameAxis(a: THREE.Vector3 | null, b: THREE.Vector3 | null): boolean {
  return !!a && !!b && Math.abs(a.dot(b)) > 0.999;
}
