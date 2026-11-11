import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { annotationVisible, dimensionGeometry, dimensionText, noteLabelPoint, resolveAnchor, type DimensionGeometry } from '../model/annotations';
import type { ModelDocument } from '../model/Document';
import type { Annotation } from '../model/types';
import { formatLength } from '../model/units';
import { disposeObject } from './overlay';

/** What the layer needs from the viewport. */
export interface AnnotationHost {
  worldPerPixel(p: THREE.Vector3): number;
  toScreen(p: THREE.Vector3): { x: number; y: number; inFront: boolean };
  readonly canvas: HTMLCanvasElement;
}

interface Item {
  annotation: Annotation;
  group: THREE.Group;
  label: CSS2DObject;
  /** World segments used for hit-testing (leader, dimension line, extension lines). */
  segments: [THREE.Vector3, THREE.Vector3][];
  dim?: { g: DimensionGeometry; side: THREE.Vector3; ticks: THREE.LineSegments; ext: THREE.LineSegments };
}

const INK = 0x27303b;
const SELECTED = 0x1d6ce0;
const TICK_PX = 6;
const EXT_OVERSHOOT_PX = 5;

/**
 * Draws annotations (ADR 0015): HTML labels (constant size, always readable) and lines on
 * top of the model; dimension ticks keep a constant on-screen size. Not pickable by the
 * mesh raycaster: tools hit-test with `hitTest`.
 */
export class AnnotationLayer {
  readonly root = new THREE.Group();
  private items: Item[] = [];
  private selected = new Set<string>();

  constructor(
    private readonly doc: ModelDocument,
    private readonly host: AnnotationHost,
  ) {
    this.root.renderOrder = 20;
  }

  private userVisible = true;
  private isSuppressed = false;

  /** The user's show/hide choice. */
  get visible(): boolean {
    return this.userVisible;
  }

  set visible(v: boolean) {
    this.userVisible = v;
    this.root.visible = this.userVisible && !this.isSuppressed;
  }

  /** Hidden for now regardless of the user's choice (e.g. while the view is exploded). */
  set suppressed(v: boolean) {
    this.isSuppressed = v;
    this.root.visible = this.userVisible && !this.isSuppressed;
  }

  /** Rebuild everything (annotations are few; anchors depend on any part changing). */
  sync() {
    for (const item of this.items) {
      this.root.remove(item.group);
      disposeObject(item.group);
    }
    this.items = [];
    const get = (id: string) => this.doc.get(id);
    for (const a of this.doc.annotations) {
      if (!annotationVisible(a, get)) continue;
      const item = a.kind === 'note' ? this.buildNote(a, get) : this.buildDimension(a, get);
      if (!item) continue;
      this.items.push(item);
      this.root.add(item.group);
    }
    this.applySelection();
    this.updateScale();
  }

  setSelected(ids: Iterable<string>) {
    this.selected = new Set(ids);
    this.applySelection();
  }

  /** Keep ticks and extension overshoots a constant size on screen (call before rendering). */
  updateScale() {
    for (const item of this.items) {
      if (!item.dim) continue;
      const { g, side, ticks, ext } = item.dim;
      const mid = g.a2.clone().add(g.b2).multiplyScalar(0.5);
      const wpp = this.host.worldPerPixel(mid);
      // 45° architectural ticks in the plane of the dimension.
      const t = g.dir.clone().add(side).normalize().multiplyScalar(TICK_PX * wpp);
      const pos = ticks.geometry.getAttribute('position') as THREE.BufferAttribute;
      [g.a2, g.b2].forEach((p, i) => {
        pos.setXYZ(i * 2, p.x - t.x, p.y - t.y, p.z - t.z);
        pos.setXYZ(i * 2 + 1, p.x + t.x, p.y + t.y, p.z + t.z);
      });
      pos.needsUpdate = true;
      ticks.geometry.computeBoundingSphere();
      const over = side.clone().multiplyScalar(EXT_OVERSHOOT_PX * wpp);
      const e = ext.geometry.getAttribute('position') as THREE.BufferAttribute;
      [
        [g.a, g.a2],
        [g.b, g.b2],
      ].forEach(([from, to], i) => {
        e.setXYZ(i * 2, from.x, from.y, from.z);
        e.setXYZ(i * 2 + 1, to.x + over.x, to.y + over.y, to.z + over.z);
      });
      e.needsUpdate = true;
      ext.geometry.computeBoundingSphere();
    }
  }

  /** The annotation under a canvas pixel: its label, or within 5 px of its lines. */
  hitTest(px: THREE.Vector2): string | null {
    if (!this.root.visible) return null;
    const rect = this.host.canvas.getBoundingClientRect();
    const cx = rect.left + px.x;
    const cy = rect.top + px.y;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const r = this.items[i].label.element.getBoundingClientRect();
      if (r.width && cx >= r.left - 2 && cx <= r.right + 2 && cy >= r.top - 2 && cy <= r.bottom + 2) return this.items[i].annotation.id;
    }
    let best: string | null = null;
    let bestD = 5;
    for (const item of this.items) {
      for (const [p, q] of item.segments) {
        const a = this.host.toScreen(p);
        const b = this.host.toScreen(q);
        if (!a.inFront || !b.inFront) continue;
        const d = distToSegment(px.x, px.y, a.x, a.y, b.x, b.y);
        if (d < bestD) {
          bestD = d;
          best = item.annotation.id;
        }
      }
    }
    return best;
  }

  /** The world point an annotation's label is drawn at (for dragging it). */
  labelPoint(id: string): THREE.Vector3 | null {
    return this.items.find((i) => i.annotation.id === id)?.label.position.clone() ?? null;
  }

  /** Labels drawn into a 2D canvas (for render_views images, which have no HTML overlay). */
  drawLabels(ctx: CanvasRenderingContext2D, camera: THREE.Camera, size: number) {
    if (!this.root.visible) return;
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (const item of this.items) {
      const p = item.label.position.clone().project(camera);
      if (p.z < -1 || p.z > 1) continue;
      const x = ((p.x + 1) / 2) * size;
      const y = ((1 - p.y) / 2) * size;
      const text = item.label.element.textContent ?? '';
      const w = ctx.measureText(text).width + 10;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fillRect(x - w / 2, y - 10, w, 20);
      ctx.strokeStyle = '#27303b';
      ctx.strokeRect(x - w / 2, y - 10, w, 20);
      ctx.fillStyle = '#1b2129';
      ctx.fillText(text, x, y);
    }
  }

  // ---- building ----------------------------------------------------------------------

  private buildNote(a: Extract<Annotation, { kind: 'note' }>, get: (id: string) => ReturnType<ModelDocument['get']>): Item | null {
    const anchor = resolveAnchor(a.anchor, get);
    if (!anchor) return null;
    const at = noteLabelPoint(anchor, a.offset);
    const group = new THREE.Group();
    const segments: Item['segments'] = [];
    if (a.offset.some((v) => v !== 0)) {
      group.add(lines([anchor, at]));
      group.add(dot(anchor));
      segments.push([anchor, at]);
    }
    const label = makeAnnotationLabel(a.text, 'vp-note');
    label.position.copy(at);
    group.add(label);
    return { annotation: a, group, label, segments };
  }

  private buildDimension(a: Extract<Annotation, { kind: 'dimension' }>, get: (id: string) => ReturnType<ModelDocument['get']>): Item | null {
    const g = dimensionGeometry(a, get);
    if (!g) return null;
    const offset = new THREE.Vector3(...a.offset);
    const side = offset.lengthSq() > 1e-12 ? offset.clone().normalize() : new THREE.Vector3(0, 0, 1);
    const group = new THREE.Group();
    group.add(lines([g.a2, g.b2]));
    const ext = segmentsObject(4);
    const ticks = segmentsObject(4);
    group.add(ext, ticks);
    const label = makeAnnotationLabel(dimensionText(a, formatLength(g.value, this.doc.units)), 'vp-dim');
    label.position.copy(g.a2).add(g.b2).multiplyScalar(0.5);
    group.add(label);
    return {
      annotation: a,
      group,
      label,
      segments: [
        [g.a2, g.b2],
        [g.a, g.a2],
        [g.b, g.b2],
      ],
      dim: { g, side, ticks, ext },
    };
  }

  private applySelection() {
    for (const item of this.items) {
      const on = this.selected.has(item.annotation.id);
      item.label.element.classList.toggle('selected', on);
      item.group.traverse((o) => {
        const m = (o as THREE.Line).material as THREE.LineBasicMaterial | THREE.PointsMaterial | undefined;
        if (m && 'color' in m) m.color.setHex(on ? SELECTED : INK);
      });
    }
  }
}

function lineMaterial() {
  return new THREE.LineBasicMaterial({ color: INK, depthTest: false, transparent: true });
}

function lines(points: THREE.Vector3[]): THREE.Line {
  const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), lineMaterial());
  l.renderOrder = 20;
  return l;
}

function segmentsObject(vertices: number): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices * 3), 3));
  const s = new THREE.LineSegments(geometry, lineMaterial());
  s.renderOrder = 20;
  s.frustumCulled = false;
  return s;
}

function dot(p: THREE.Vector3): THREE.Points {
  const pts = new THREE.Points(
    new THREE.BufferGeometry().setFromPoints([p]),
    new THREE.PointsMaterial({ color: INK, size: 6, sizeAttenuation: false, depthTest: false, transparent: true }),
  );
  pts.renderOrder = 20;
  return pts;
}

function makeAnnotationLabel(text: string, className: string): CSS2DObject {
  const el = document.createElement('div');
  el.className = `vp-annotation ${className}`;
  el.textContent = text;
  return new CSS2DObject(el);
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
