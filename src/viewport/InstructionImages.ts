import * as THREE from 'three';
import { buildCutGeometry, cuttersFor } from '../model/csg';
import { entityMatrix, localBounds, worldBounds } from '../model/geometry';
import type { PartType, ResolvedStep } from '../model/instructions';
import type { Entity, Group } from '../model/types';
import { featureEdges } from './edges';

/**
 * Pictures for the build-instructions booklet (ADR 0021), drawn off-screen with the
 * viewport's WebGL renderer in a separate, plain scene: white background, dark outlines,
 * orthographic like an assembly drawing. Parts added in a step are in colour and pulled
 * back along an axis with arrows showing where they go; parts already in place are grey.
 * Images are PNG data URLs at 2× for print.
 */

const VIEW_DIR = new THREE.Vector3(1, -1.25, 0.95).normalize();
const SCALE = 2;
const INK = '#1f2328';
const GREY_FILL = '#e6e8eb';
const GREY_EDGE = '#9aa0a8';
const ACCENT = '#e8590c';

interface Shown {
  entity: Entity;
  style: 'new' | 'old' | 'plain';
  offset?: THREE.Vector3;
}

export class InstructionImages {
  private readonly geometry = new Map<string, { mesh: THREE.BufferGeometry; edges: THREE.BufferGeometry }>();
  private readonly byId: Map<string, Entity>;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly entities: Entity[],
    private readonly groups: Group[],
  ) {
    this.byId = new Map(entities.map((e) => [e.id, e]));
  }

  /** The whole assembly. */
  overview(width: number, height: number): string {
    return this.render(this.solids().map((entity) => ({ entity, style: 'plain' as const })), width, height);
  }

  /** One part on its own, in its own frame (so a rotated board is still shown flat). */
  part(type: PartType, width: number, height: number): string {
    const e = this.byId.get(type.ids[0])!;
    const flat = { ...e, position: [0, 0, 0], rotation: [0, 0, 0] } as Entity;
    const b = localBounds(e);
    const size = b.getSize(new THREE.Vector3());
    // Lay boards down: the thinnest axis points up.
    const thin = size.x <= size.y && size.x <= size.z ? 'x' : size.y <= size.z ? 'y' : 'z';
    if (thin === 'x') flat.rotation = [0, 90, 0];
    if (thin === 'y') flat.rotation = [90, 0, 0];
    return this.render([{ entity: flat, style: 'new' }], width, height, { geometryOf: e.id });
  }

  /** One assembly step: what's in place (grey) and what is added (colour, with arrows and letters). */
  step(step: ResolvedStep, letterOf: Map<string, string>, width: number, height: number): string {
    const before = step.before.map((id) => this.byId.get(id)!).filter(Boolean);
    const added = step.add.map((id) => this.byId.get(id)!).filter(Boolean);
    const all = new THREE.Box3();
    for (const e of [...before, ...added]) all.union(worldBounds(e));
    const reach = Math.max(...all.getSize(new THREE.Vector3()).toArray()) * 0.3;
    const beforeBox = new THREE.Box3();
    for (const e of before) beforeBox.union(worldBounds(e));

    const shown: Shown[] = before.map((entity) => ({ entity, style: 'old' as const }));
    const arrows: { from: THREE.Vector3; to: THREE.Vector3 }[] = [];
    const labels: { at: THREE.Vector3; text: string }[] = [];
    for (const entity of added) {
      const box = worldBounds(entity);
      const centre = box.getCenter(new THREE.Vector3());
      const offset = beforeBox.isEmpty() ? null : pullBack(box, beforeBox, reach);
      shown.push({ entity, style: 'new', ...(offset ? { offset } : {}) });
      if (offset) {
        const dir = offset.clone().normalize();
        const half = Math.abs(box.getSize(new THREE.Vector3()).dot(dir)) / 2;
        const gap = Math.min(offset.length() * 0.12, half);
        arrows.push({
          from: centre.clone().add(offset).addScaledVector(dir, -(half + gap)),
          to: centre.clone().addScaledVector(dir, half + gap * 0.5),
        });
      }
      labels.push({ at: centre.clone().add(offset ?? new THREE.Vector3()), text: letterOf.get(entity.id) ?? '' });
    }
    return this.render(shown, width, height, { arrows, labels });
  }

  dispose() {
    for (const g of this.geometry.values()) {
      g.mesh.dispose();
      g.edges.dispose();
    }
    this.geometry.clear();
  }

  // ---- drawing ----------------------------------------------------------------------------

  private solids(): Entity[] {
    return this.entities.filter((e) => e.visible && !e.hole);
  }

  private geometryFor(e: Entity) {
    let g = this.geometry.get(e.id);
    if (!g) {
      const holes = this.entities.filter((x) => x.hole && x.visible);
      const { geometry } = buildCutGeometry(e, cuttersFor(e, holes, this.groups));
      g = { mesh: geometry, edges: featureEdges(geometry, 25) };
      this.geometry.set(e.id, g);
    }
    return g;
  }

  private render(
    shown: Shown[],
    width: number,
    height: number,
    extra: { arrows?: { from: THREE.Vector3; to: THREE.Vector3 }[]; labels?: { at: THREE.Vector3; text: string }[]; geometryOf?: string } = {},
  ): string {
    const w = width * SCALE;
    const h = height * SCALE;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#ffffff');
    scene.add(new THREE.HemisphereLight(0xffffff, 0xb8bec8, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(0.6, -0.9, 1.4);
    scene.add(sun);

    const disposables: { dispose(): void }[] = [];
    const box = new THREE.Box3();
    for (const s of shown) {
      const source = extra.geometryOf ? this.byId.get(extra.geometryOf)! : s.entity;
      const g = this.geometryFor(source);
      const fill = s.style === 'old' ? GREY_FILL : s.style === 'plain' ? s.entity.color : lighten(s.entity.color, 0.15);
      const material = new THREE.MeshStandardMaterial({ color: fill, roughness: 0.9, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide });
      const lineMaterial = new THREE.LineBasicMaterial({ color: s.style === 'old' ? GREY_EDGE : INK });
      disposables.push(material, lineMaterial);
      const object = new THREE.Group();
      object.add(new THREE.Mesh(g.mesh, material), new THREE.LineSegments(g.edges, lineMaterial));
      object.matrixAutoUpdate = false;
      object.matrix.copy(entityMatrix(s.entity));
      if (extra.geometryOf) {
        // A lone part: centre it on the origin.
        const local = localBounds(source).applyMatrix4(object.matrix);
        object.matrix.premultiply(new THREE.Matrix4().makeTranslation(local.getCenter(new THREE.Vector3()).negate()));
      }
      if (s.offset) object.matrix.premultiply(new THREE.Matrix4().makeTranslation(s.offset));
      object.updateMatrixWorld(true);
      scene.add(object);
      box.union(new THREE.Box3().setFromObject(object));
    }
    for (const a of extra.arrows ?? []) box.expandByPoint(a.from).expandByPoint(a.to);

    const camera = fitCamera(box, w / h);
    const target = new THREE.WebGLRenderTarget(w, h, { samples: 4 });
    target.texture.colorSpace = THREE.SRGBColorSpace;
    const pixels = new Uint8Array(w * h * 4);
    const previous = this.renderer.getRenderTarget();
    try {
      this.renderer.setRenderTarget(target);
      this.renderer.render(scene, camera);
      this.renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels);
    } finally {
      this.renderer.setRenderTarget(previous);
      target.dispose();
      disposables.forEach((d) => d.dispose());
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) img.data.set(pixels.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    ctx.putImageData(img, 0, 0);

    const toScreen = (p: THREE.Vector3) => {
      const v = p.clone().project(camera);
      return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
    };
    for (const a of extra.arrows ?? []) drawArrow(ctx, toScreen(a.from), toScreen(a.to));
    drawLabels(ctx, (extra.labels ?? []).map((l) => ({ ...toScreen(l.at), text: l.text })), w, h);
    return canvas.toDataURL('image/png');
  }
}

/** Which way a new part comes from: along the axis it sticks out most, away from what's built. */
function pullBack(part: THREE.Box3, built: THREE.Box3, reach: number): THREE.Vector3 {
  const c = part.getCenter(new THREE.Vector3());
  const bc = built.getCenter(new THREE.Vector3());
  const half = built.getSize(new THREE.Vector3()).multiplyScalar(0.5).max(new THREE.Vector3(1, 1, 1));
  const size = part.getSize(new THREE.Vector3());
  // On top of what's built, or inside its footprint (a shelf between legs, a rail between
  // sides): lower it in from above, clear of everything already there.
  const inside = c.x > built.min.x && c.x < built.max.x && c.y > built.min.y && c.y < built.max.y;
  if (part.min.z >= built.max.z - 1 || inside) {
    const clear = Math.max(0, built.max.z - part.min.z) + reach * 0.35;
    return new THREE.Vector3(0, 0, Math.max(reach, size.z * 1.5, clear));
  }
  // Outside the footprint: slide it in sideways along the axis it sticks out most.
  const rel = c.clone().sub(bc).divide(half).toArray();
  const axis = Math.abs(rel[0]) >= Math.abs(rel[1]) ? 0 : 1;
  const out = new THREE.Vector3();
  const sign = rel[axis] < 0 ? -1 : 1;
  out.setComponent(axis, sign * Math.max(reach, size.getComponent(axis) * 1.5));
  return out;
}

function fitCamera(box: THREE.Box3, aspect: number): THREE.OrthographicCamera {
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, radius * 0.01, radius * 10);
  camera.up.set(0, 0, 1);
  camera.position.copy(centre).addScaledVector(VIEW_DIR, radius * 4);
  camera.lookAt(centre);
  camera.updateMatrixWorld(true);
  // Extents of the box corners in camera space.
  const inv = camera.matrixWorldInverse;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const margin = 1.12;
  let halfW = ((maxX - minX) / 2) * margin;
  let halfH = ((maxY - minY) / 2) * margin;
  if (halfW / halfH > aspect) halfH = halfW / aspect;
  else halfW = halfH * aspect;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  camera.left = cx - halfW;
  camera.right = cx + halfW;
  camera.top = cy + halfH;
  camera.bottom = cy - halfH;
  camera.updateProjectionMatrix();
  return camera;
}

function lighten(hex: string, amount: number): string {
  const c = new THREE.Color(hex);
  return '#' + c.lerp(new THREE.Color('#ffffff'), amount).getHexString();
}

function drawArrow(ctx: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 12 * SCALE) return;
  const ux = dx / len;
  const uy = dy / len;
  const head = 11 * SCALE;
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.fillStyle = ACCENT;
  ctx.lineWidth = 2.2 * SCALE;
  ctx.setLineDash([6 * SCALE, 4 * SCALE]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x - ux * head, to.y - uy * head);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - ux * head - uy * head * 0.5, to.y - uy * head + ux * head * 0.5);
  ctx.lineTo(to.x - ux * head + uy * head * 0.5, to.y - uy * head - ux * head * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Letter callouts: a circle off to the upper right of each part, with a short leader. */
function drawLabels(ctx: CanvasRenderingContext2D, labels: { x: number; y: number; text: string }[], w: number, h: number) {
  const r = 15 * SCALE;
  const placed: { x: number; y: number }[] = [];
  ctx.save();
  ctx.font = `700 ${17 * SCALE}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const l of labels) {
    if (!l.text) continue;
    let x = l.x + 34 * SCALE;
    let y = l.y - 34 * SCALE;
    // Nudge apart callouts that would overlap.
    for (let tries = 0; tries < 8 && placed.some((p) => Math.hypot(p.x - x, p.y - y) < r * 2.2); tries++) y -= r * 1.6;
    x = Math.min(Math.max(x, r + 2), w - r - 2);
    y = Math.min(Math.max(y, r + 2), h - r - 2);
    placed.push({ x, y });
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.4 * SCALE;
    ctx.beginPath();
    ctx.moveTo(l.x, l.y);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = INK;
    ctx.fillText(l.text, x, y + SCALE);
  }
  ctx.restore();
}
