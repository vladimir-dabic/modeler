import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { buildCutGeometry, cuttersFor } from '../model/csg';
import type { ModelDocument } from '../model/Document';
import { entityMatrix, worldBoundsOf } from '../model/geometry';
import { isInsideGroup } from '../model/groups';
import { referenceBounds, referenceMatrix, referenceSegments } from '../model/references';
import type { Entity } from '../model/types';
import type { WorkspaceConfig } from '../model/workspaces';
import { featureEdges } from './edges';
import { Grid } from './Grid';
import { makeScaleFigure, PrintPlate } from './SceneHelpers';
import { COLORS, disposeObject } from './overlay';

export interface PickHit {
  entity: Entity;
  object: THREE.Mesh;
  /** World-space hit point. */
  point: THREE.Vector3;
  /** World-space face normal. */
  normal: THREE.Vector3;
  localPoint: THREE.Vector3;
  localNormal: THREE.Vector3;
  faceIndex: number;
}

interface EntityObject {
  key: string;
  group: THREE.Group;
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  material: THREE.MeshStandardMaterial;
  edgeMaterial: THREE.LineBasicMaterial | THREE.LineDashedMaterial;
  cutFailed: boolean;
}

export type ViewName = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

const VIEW_DIRS: Record<ViewName, THREE.Vector3> = {
  iso: new THREE.Vector3(1, -1.25, 0.95),
  top: new THREE.Vector3(0, -1e-4, 1),
  bottom: new THREE.Vector3(0, -1e-4, -1),
  front: new THREE.Vector3(0, -1, 0),
  back: new THREE.Vector3(0, 1, 0),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
};

const BACKGROUND = 0xeef1f5;
const FOV = 35;

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly perspCamera: THREE.PerspectiveCamera;
  readonly orthoCamera: THREE.OrthographicCamera;
  readonly controls: OrbitControls;
  readonly overlayRoot = new THREE.Group();
  /** Reference drawings (ADR 0014): lines only, never picked. */
  private readonly referenceRoot = new THREE.Group();
  private readonly referenceObjects = new Map<string, { key: string; lines: THREE.LineSegments }>();
  readonly canvas: HTMLCanvasElement;

  private readonly labelRenderer = new CSS2DRenderer();
  private readonly entityRoot = new THREE.Group();
  private readonly objects = new Map<string, EntityObject>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly faceHighlight: THREE.Mesh;
  private readonly snapMarker: CSS2DObject;
  private renderQueued = false;
  private readonly grid = new Grid();
  private readonly plate = new PrintPlate();
  private readonly scaleFigure = makeScaleFigure();
  /** What zoom-extents frames when the model is empty (set per workspace). */
  private homeBox = new THREE.Box3(new THREE.Vector3(-100, -100, 0), new THREE.Vector3(100, 100, 100));
  /** Entities with a print problem (drawn with red edges). */
  private warningIds = new Set<string>();
  private hoverId: string | null = null;
  private highlightIds = new Set<string>();
  private highlightColor = COLORS.hover;
  private _ortho = false;
  showCuts = true;
  xray = false;

  constructor(
    readonly container: HTMLElement,
    private readonly doc: ModelDocument,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(BACKGROUND);
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'vp-canvas';
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);

    this.labelRenderer.domElement.className = 'vp-labels';
    container.appendChild(this.labelRenderer.domElement);

    this.perspCamera = new THREE.PerspectiveCamera(FOV, 1, 1, 200000);
    this.perspCamera.up.set(0, 0, 1);
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -500000, 500000);
    this.orthoCamera.up.set(0, 0, 1);

    this.controls = new OrbitControls(this.perspCamera, this.canvas);
    this.controls.enableDamping = false;
    // Zoom is handled by onWheel (zooms around the point under the cursor).
    this.controls.enableZoom = false;
    this.controls.screenSpacePanning = true;
    this.setNavigationMode('default');
    this.controls.addEventListener('change', () => this.requestRender());

    this.scene.add(this.entityRoot, this.referenceRoot, this.overlayRoot);
    this.addLights();
    this.addGridAndAxes();

    // SketchUp-style dotted face highlight: readable on top of any face colour.
    this.faceHighlight = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.ShaderMaterial({
        uniforms: {
          color: { value: new THREE.Color(COLORS.selection) },
          spacing: { value: 3 * this.renderer.getPixelRatio() },
        },
        vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `
          uniform vec3 color;
          uniform float spacing;
          void main() {
            vec2 cell = mod(gl_FragCoord.xy, spacing);
            if (cell.x > spacing * 0.5 || cell.y > spacing * 0.5) discard;
            gl_FragColor = vec4(color, 1.0);
          }`,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    this.faceHighlight.matrixAutoUpdate = false;
    this.faceHighlight.visible = false;
    this.faceHighlight.renderOrder = 5;
    this.scene.add(this.faceHighlight);

    const marker = document.createElement('div');
    marker.className = 'snap-marker';
    this.snapMarker = new CSS2DObject(marker);
    this.snapMarker.visible = false;
    this.scene.add(this.snapMarker);

    this.setView('iso', false);
    this.perspCamera.position.set(400, -500, 380);
    this.controls.target.set(0, 0, 0);
    this.controls.update();

    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  // ---- scene setup --------------------------------------------------------

  private addLights() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.6, -0.9, 1.4);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-1, 0.6, 0.4);
    this.scene.add(fill);
  }

  private addGridAndAxes() {
    this.scene.add(this.grid.mesh, this.plate.group, this.scaleFigure);
    this.plate.group.visible = false;
    this.scaleFigure.visible = false;

    const L = 100000;
    const axes: [THREE.Vector3, number][] = [
      [new THREE.Vector3(1, 0, 0), COLORS.x],
      [new THREE.Vector3(0, 1, 0), COLORS.y],
      [new THREE.Vector3(0, 0, 1), COLORS.z],
    ];
    for (const [dir, color] of axes) {
      const pos = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir.clone().multiplyScalar(L)]),
        new THREE.LineBasicMaterial({ color }),
      );
      const negGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir.clone().multiplyScalar(-L)]);
      const neg = new THREE.Line(
        negGeom,
        new THREE.LineDashedMaterial({ color, dashSize: 20, gapSize: 15, transparent: true, opacity: 0.6 }),
      );
      neg.computeLineDistances();
      this.scene.add(pos, neg);
    }
  }

  // ---- camera -------------------------------------------------------------

  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this._ortho ? this.orthoCamera : this.perspCamera;
  }

  get isOrtho(): boolean {
    return this._ortho;
  }

  /**
   * Left button belongs to tools by default; middle = orbit (shift+middle = pan), right = pan.
   * 'orbit' / 'pan' give the left button to navigation (Orbit/Pan tools and hold keys).
   * OrbitControls swaps ROTATE↔PAN while Shift/Ctrl/Meta is held, so when the hold key
   * is one of those (`modifierSwaps`), the mapping is inverted to get the intended action.
   */
  setNavigationMode(mode: 'default' | 'orbit' | 'pan', modifierSwaps = false) {
    let left: THREE.MOUSE | null = null;
    if (mode === 'orbit') left = modifierSwaps ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    if (mode === 'pan') left = modifierSwaps ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    this.controls.mouseButtons = {
      LEFT: left as THREE.MOUSE,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: THREE.MOUSE.PAN,
    };
  }

  setOrtho(on: boolean) {
    if (on === this._ortho) return;
    const target = this.controls.target;
    if (on) {
      const p = this.perspCamera;
      const dist = p.position.distanceTo(target);
      const height = 2 * dist * Math.tan((FOV * Math.PI) / 360);
      const o = this.orthoCamera;
      o.position.copy(p.position);
      o.quaternion.copy(p.quaternion);
      o.zoom = 1;
      o.userData.height = height;
      this._ortho = true;
      this.controls.object = o;
    } else {
      const o = this.orthoCamera;
      const height = (o.userData.height as number) / o.zoom;
      const dist = height / (2 * Math.tan((FOV * Math.PI) / 360));
      const dir = o.position.clone().sub(target).normalize();
      this.perspCamera.position.copy(target).addScaledVector(dir, dist);
      this.perspCamera.quaternion.copy(o.quaternion);
      this._ortho = false;
      this.controls.object = this.perspCamera;
    }
    this.resize();
    this.controls.update();
    this.requestRender();
  }

  setView(name: ViewName, animate = true) {
    void animate;
    const target = this.controls.target;
    const dist = this.camera.position.distanceTo(target) || 1000;
    const dir = VIEW_DIRS[name].clone().normalize();
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.camera.lookAt(target);
    this.controls.update();
    this.requestRender();
  }

  /** World bounds of the visible reference drawings (empty box if none). */
  referencesBox(ids?: string[]): THREE.Box3 {
    const box = new THREE.Box3();
    for (const r of this.doc.references) {
      if (!r.visible || (ids && !ids.includes(r.id))) continue;
      const g = this.doc.geometryOf(r.id);
      if (g) box.union(referenceBounds(r, g));
    }
    return box;
  }

  /** Fit the view to the given entities (or everything visible, reference drawings included). */
  zoomExtents(entities?: Entity[]) {
    const list = (entities?.length ? entities : this.doc.entities).filter((e) => e.visible);
    const box = list.length ? worldBoundsOf(list) : new THREE.Box3();
    if (!entities?.length) box.union(this.referencesBox());
    this.fitBox(box.isEmpty() ? this.homeBox.clone() : box);
  }

  /** Fit the view to a world box, keeping the viewing direction. */
  fitBox(box: THREE.Box3) {
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 10);
    const target = this.controls.target;
    const dir = this.camera.position.clone().sub(target).normalize();
    target.copy(sphere.center);
    const aspect = this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight);
    const halfFov = (FOV * Math.PI) / 360;
    const fitFov = aspect < 1 ? Math.atan(Math.tan(halfFov) * aspect) : halfFov;
    const dist = (radius / Math.sin(fitFov)) * 1.1;
    if (this._ortho) {
      this.orthoCamera.position.copy(target).addScaledVector(dir, dist);
      this.orthoCamera.zoom = (this.orthoCamera.userData.height as number) / (2 * radius * 1.1 * (aspect < 1 ? 1 / aspect : 1));
      this.orthoCamera.updateProjectionMatrix();
    } else {
      this.perspCamera.position.copy(target).addScaledVector(dir, dist);
    }
    this.controls.update();
    this.requestRender();
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.labelRenderer.setSize(w, h);
    this.perspCamera.aspect = w / h;
    this.perspCamera.updateProjectionMatrix();
    const oh = (this.orthoCamera.userData.height as number | undefined) ?? 1000;
    this.orthoCamera.left = (-oh * (w / h)) / 2;
    this.orthoCamera.right = (oh * (w / h)) / 2;
    this.orthoCamera.top = oh / 2;
    this.orthoCamera.bottom = -oh / 2;
    this.orthoCamera.updateProjectionMatrix();
    this.requestRender();
  }

  /** Adapt the depth range to the zoom level so close-ups and big scenes both work. */
  private updateClipping() {
    if (this._ortho) return;
    const dist = this.perspCamera.position.distanceTo(this.controls.target);
    this.perspCamera.near = THREE.MathUtils.clamp(dist / 2000, 0.01, 50);
    this.perspCamera.far = Math.max(dist * 100, 200000);
    this.perspCamera.updateProjectionMatrix();
  }

  // ---- zoom -----------------------------------------------------------------

  /**
   * SketchUp-style zoom: scale the whole view about the point under the cursor.
   * The camera moves a fraction of the way toward that point each step, so it slows
   * down as it gets close and can never pass through the surface (or floor) you aim at.
   */
  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.canvas.clientHeight : 1;
    // Trackpad pinch arrives as ctrl+wheel with small deltas.
    const k = e.ctrlKey ? 0.01 : 0.0012;
    const exponent = THREE.MathUtils.clamp(e.deltaY * unit * k, -0.5, 0.5);
    if (!exponent) return;
    const rect = this.canvas.getBoundingClientRect();
    this.zoomAt(new THREE.Vector2(e.clientX - rect.left, e.clientY - rect.top), Math.exp(exponent));
  }

  /** `scale` < 1 zooms in, > 1 zooms out, keeping the point under `px` fixed on screen. */
  zoomAt(px: THREE.Vector2, scale: number) {
    const pivot = this.zoomPivot(px);
    const cam = this.camera;
    const target = this.controls.target;
    if (this._ortho) {
      const o = this.orthoCamera;
      const view = target.clone().sub(o.position).normalize();
      const offset = pivot.clone().sub(target);
      offset.addScaledVector(view, -offset.dot(view));
      const newZoom = THREE.MathUtils.clamp(o.zoom / scale, 1e-4, 1e4);
      const applied = o.zoom / newZoom; // actual scale after clamping
      const shift = offset.multiplyScalar(1 - applied);
      o.position.add(shift);
      target.add(shift);
      o.zoom = newZoom;
      o.updateProjectionMatrix();
    } else {
      const dist = cam.position.distanceTo(pivot);
      // Stop at 0.5 mm from the surface; cap zoom-out at 1 km.
      if (scale < 1 && dist * scale < 0.5) return;
      if (scale > 1 && cam.position.distanceTo(target) * scale > 1e6) return;
      cam.position.sub(pivot).multiplyScalar(scale).add(pivot);
      target.sub(pivot).multiplyScalar(scale).add(pivot);
    }
    this.controls.update();
    this.requestRender();
  }

  /** What's under the cursor: a face, else the ground, else a point at the orbit-target depth. */
  private zoomPivot(px: THREE.Vector2): THREE.Vector3 {
    const hit = this.pick(px);
    if (hit) return hit.point;
    const ray = this.rayAt(px);
    const targetDist = this.camera.position.distanceTo(this.controls.target);
    if (Math.abs(ray.direction.z) > 1e-6) {
      const t = -ray.origin.z / ray.direction.z;
      // Only use the ground if it's in front of us and not absurdly far toward the horizon.
      if (t > 0 && t < targetDist * 20) return ray.at(t, new THREE.Vector3());
    }
    return ray.at(this._ortho ? 0 : targetDist, new THREE.Vector3());
  }

  /** Adapt grid spacing to the zoom; hide it from below, where it would read as a ceiling. */
  private updateGridFade() {
    const target = this.controls.target;
    this.grid.update(target, this.camera.position.distanceTo(target), this.worldPerPixel(target));
    this.grid.mesh.visible = this.camera.position.z >= 0;
  }

  // ---- workspace helpers ----------------------------------------------------

  applyWorkspace(ws: WorkspaceConfig) {
    this.grid.base = ws.gridBase;
    this.homeBox = new THREE.Box3(new THREE.Vector3(...ws.homeView[0]), new THREE.Vector3(...ws.homeView[1]));
    this.plate.group.visible = ws.printPlate;
    this.scaleFigure.visible = ws.scaleFigure;
    this.requestRender();
  }

  setPlate(volume: [number, number, number], name: string) {
    this.plate.setVolume(volume, name);
    this.homeBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(volume[0], volume[1], Math.min(volume[2], 60)));
    this.requestRender();
  }

  setWarnings(ids: Iterable<string>, volumeAlert = false) {
    this.plate.setAlert(volumeAlert);
    const next = new Set(ids);
    if (next.size === this.warningIds.size && [...next].every((id) => this.warningIds.has(id))) return;
    this.warningIds = next;
    this.updateStyles();
  }

  // ---- off-screen images (Modeler API render_views) -------------------------

  /**
   * Render PNGs (base64, no data: prefix) of the visible model from standard views,
   * off-screen, without touching the user's camera or canvas size.
   */
  async renderViewImages(views: ViewName[], size: number): Promise<{ view: ViewName; png: string }[]> {
    const target = new THREE.WebGLRenderTarget(size, size, { samples: 4 });
    target.texture.colorSpace = THREE.SRGBColorSpace;
    const cam = new THREE.PerspectiveCamera(FOV, 1, 1, 1e6);
    cam.up.set(0, 0, 1);
    const list = this.doc.entities.filter((e) => e.visible);
    const box = (list.length ? worldBoundsOf(list) : new THREE.Box3()).union(this.referencesBox());
    if (box.isEmpty()) box.copy(this.homeBox);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 10);
    const hidden = [this.overlayRoot, this.faceHighlight].filter((o) => o.visible);
    hidden.forEach((o) => (o.visible = false));
    const pixels = new Uint8Array(size * size * 4);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx2d = canvas.getContext('2d')!;
    const out: { view: ViewName; png: string }[] = [];
    try {
      for (const view of views) {
        const dir = VIEW_DIRS[view].clone().normalize();
        const dist = (radius / Math.sin((FOV * Math.PI) / 360)) * 1.1;
        cam.position.copy(sphere.center).addScaledVector(dir, dist);
        cam.lookAt(sphere.center);
        cam.near = dist / 100;
        cam.far = dist * 10;
        cam.updateProjectionMatrix();
        this.renderer.setRenderTarget(target);
        this.renderer.render(this.scene, cam);
        this.renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
        // WebGL rows are bottom-up; flip into the 2D canvas.
        const img = ctx2d.createImageData(size, size);
        for (let y = 0; y < size; y++) img.data.set(pixels.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
        ctx2d.putImageData(img, 0, 0);
        out.push({ view, png: canvas.toDataURL('image/png').split(',')[1] });
      }
    } finally {
      this.renderer.setRenderTarget(null);
      hidden.forEach((o) => (o.visible = true));
      target.dispose();
      this.requestRender();
    }
    return out;
  }

  // ---- rendering ----------------------------------------------------------

  requestRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.updateClipping();
      this.updateGridFade();
      this.renderer.render(this.scene, this.camera);
      this.labelRenderer.render(this.scene, this.camera);
    });
  }

  /** Rebuild meshes for entities that changed since the last sync. */
  sync() {
    const entities = this.doc.entities;
    const holes = entities.filter((e) => e.hole && e.visible);
    const bounds = new Map<string, THREE.Box3>();
    const seen = new Set<string>();

    for (const e of entities) {
      seen.add(e.id);
      const cutters = this.showCuts ? cuttersFor(e, holes, bounds) : [];
      const key = JSON.stringify(e) + '|' + cutters.map((h) => JSON.stringify(h)).join('|');
      const existing = this.objects.get(e.id);
      if (existing && existing.key === key) continue;
      if (existing) this.disposeEntityObject(existing);
      this.objects.set(e.id, this.buildEntityObject(e, cutters, key));
    }
    for (const [id, obj] of this.objects) {
      if (!seen.has(id)) {
        this.disposeEntityObject(obj);
        this.objects.delete(id);
      }
    }
    this.syncReferences();
    this.updateStyles();
  }

  /** Lines are rebuilt only when the visible layers change; placement is just a matrix. */
  private syncReferences() {
    const seen = new Set<string>();
    for (const r of this.doc.references) {
      const g = this.doc.geometryOf(r.id);
      if (!g) continue;
      seen.add(r.id);
      const key = r.hiddenLayers.join('\u0000');
      let entry = this.referenceObjects.get(r.id);
      if (entry && entry.key !== key) {
        this.referenceRoot.remove(entry.lines);
        disposeObject(entry.lines);
        entry = undefined;
      }
      if (!entry) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(referenceSegments(r, g), 3));
        const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: COLORS.reference, transparent: true, opacity: 0.85 }));
        lines.matrixAutoUpdate = false;
        entry = { key, lines };
        this.referenceObjects.set(r.id, entry);
        this.referenceRoot.add(lines);
      }
      entry.lines.matrix.copy(referenceMatrix(r));
      entry.lines.matrixWorldNeedsUpdate = true;
      entry.lines.visible = r.visible;
    }
    for (const [id, entry] of this.referenceObjects) {
      if (seen.has(id)) continue;
      this.referenceRoot.remove(entry.lines);
      disposeObject(entry.lines);
      this.referenceObjects.delete(id);
    }
  }

  private buildEntityObject(e: Entity, cutters: Entity[], key: string): EntityObject {
    const { geometry, failed } = buildCutGeometry(e, cutters);
    const material = new THREE.MeshStandardMaterial({
      color: e.color,
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.entityId = e.id;

    const edgeGeometry = featureEdges(geometry, 25);
    const edgeMaterial = e.hole
      ? new THREE.LineDashedMaterial({ color: COLORS.hole, dashSize: 3, gapSize: 2 })
      : new THREE.LineBasicMaterial({ color: COLORS.edge });
    const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
    if (e.hole) edges.computeLineDistances();

    const group = new THREE.Group();
    group.add(mesh, edges);
    group.matrixAutoUpdate = false;
    group.matrix.copy(entityMatrix(e));
    group.visible = e.visible;
    group.updateMatrixWorld(true);
    this.entityRoot.add(group);
    return { key, group, mesh, edges, material, edgeMaterial, cutFailed: failed };
  }

  private disposeEntityObject(obj: EntityObject) {
    this.entityRoot.remove(obj.group);
    disposeObject(obj.group);
  }

  /** Apply selection / hover / hole / x-ray styling to all entity materials. */
  updateStyles() {
    for (const e of this.doc.entities) {
      const obj = this.objects.get(e.id);
      if (!obj) continue;
      const selected = this.doc.selection.has(e.id);
      const hovered = this.hoverId === e.id || this.highlightIds.has(e.id);
      const m = obj.material;
      m.color.set(e.hole ? COLORS.hole : e.color);
      const transparent = e.hole || this.xray;
      m.transparent = transparent;
      m.opacity = e.hole ? 0.22 : this.xray ? 0.45 : 1;
      m.depthWrite = !transparent;
      m.emissive.set(selected ? 0x1d4ed8 : hovered ? this.highlightColor : 0x000000);
      m.emissiveIntensity = selected ? 0.18 : hovered ? 0.14 : 0;
      m.needsUpdate = true;
      // While a group is open for editing, everything outside it fades back.
      const outside = !!this.doc.openGroupId && !isInsideGroup(e, this.doc.openGroupId, this.doc.groups);
      if (outside) {
        m.transparent = true;
        m.opacity = Math.min(m.opacity, 0.25);
        m.depthWrite = false;
      }
      const warn = this.warningIds.has(e.id);
      const edgeColor = selected ? COLORS.selection : hovered ? this.highlightColor : warn ? COLORS.erase : e.hole ? COLORS.hole : COLORS.edge;
      if (warn && !selected && !hovered) {
        m.color.lerp(new THREE.Color(0xe5484d), 0.55);
        m.emissive.set(0xd92020);
        m.emissiveIntensity = 0.2;
      }
      obj.edgeMaterial.color.set(edgeColor);
      obj.group.visible = e.visible;
    }
    this.requestRender();
  }

  /** Hover highlight; `color` lets tools like Erase use red. */
  setHover(id: string | null, color = COLORS.hover) {
    if (this.hoverId === id && this.highlightColor === color) return;
    this.hoverId = id;
    this.highlightColor = color;
    this.updateStyles();
  }

  /** Highlight a set of entities (e.g. rectangle-selection preview). */
  setHighlighted(ids: Iterable<string>, color = COLORS.hover) {
    this.highlightIds = new Set(ids);
    this.highlightColor = color;
    this.updateStyles();
  }

  hasCutFailures(): boolean {
    for (const obj of this.objects.values()) if (obj.cutFailed) return true;
    return false;
  }

  // ---- picking ------------------------------------------------------------

  /** Canvas-relative pixel → normalised device coordinates. */
  toNdc(px: THREE.Vector2): THREE.Vector2 {
    return new THREE.Vector2((px.x / this.canvas.clientWidth) * 2 - 1, -(px.y / this.canvas.clientHeight) * 2 + 1);
  }

  /** Camera matrices are normally refreshed at render time; picking may run before that. */
  private syncCamera() {
    this.camera.updateMatrixWorld();
  }

  rayAt(px: THREE.Vector2): THREE.Ray {
    this.syncCamera();
    this.raycaster.setFromCamera(this.toNdc(px), this.camera);
    return this.raycaster.ray.clone();
  }

  /** World → canvas pixel. `inFront` is false when the point is behind the camera. */
  toScreen(p: THREE.Vector3): { x: number; y: number; inFront: boolean } {
    this.syncCamera();
    const v = p.clone().project(this.camera);
    return {
      x: ((v.x + 1) / 2) * this.canvas.clientWidth,
      y: ((1 - v.y) / 2) * this.canvas.clientHeight,
      inFront: v.z > -1 && v.z < 1,
    };
  }

  /** Approximate size of one screen pixel in world units at point `p`. */
  worldPerPixel(p: THREE.Vector3): number {
    const h = this.canvas.clientHeight || 1;
    if (this._ortho) {
      const o = this.orthoCamera;
      return (o.top - o.bottom) / o.zoom / h;
    }
    const dist = this.perspCamera.position.distanceTo(p);
    return (2 * dist * Math.tan((FOV * Math.PI) / 360)) / h;
  }

  pick(px: THREE.Vector2, exclude?: Set<string>): PickHit | null {
    this.syncCamera();
    this.raycaster.setFromCamera(this.toNdc(px), this.camera);
    const meshes: THREE.Mesh[] = [];
    for (const [id, obj] of this.objects) {
      if (!obj.group.visible || exclude?.has(id)) continue;
      meshes.push(obj.mesh);
    }
    const hits = this.raycaster.intersectObjects(meshes, false);
    for (const hit of hits) {
      const entity = this.doc.get(hit.object.userData.entityId as string);
      if (!entity || !hit.face) continue;
      const mesh = hit.object as THREE.Mesh;
      const inv = mesh.matrixWorld.clone().invert();
      const localNormal = hit.face.normal.clone();
      // Double-sided materials: make the normal face the viewer.
      const worldNormal = localNormal.clone().transformDirection(mesh.matrixWorld);
      if (worldNormal.dot(this.raycaster.ray.direction) > 0) {
        localNormal.negate();
        worldNormal.negate();
      }
      return {
        entity,
        object: mesh,
        point: hit.point.clone(),
        normal: worldNormal,
        localPoint: hit.point.clone().applyMatrix4(inv),
        localNormal,
        faceIndex: hit.faceIndex ?? 0,
      };
    }
    return null;
  }

  /** Entities whose screen-space bounds pass the rectangle test (for drag selection). */
  entitiesInRect(
    rect: { x0: number; y0: number; x1: number; y1: number },
    mode: 'window' | 'crossing',
    corners: (e: Entity) => THREE.Vector3[],
  ): string[] {
    const result: string[] = [];
    for (const e of this.doc.entities) {
      if (!e.visible) continue;
      const pts = corners(e).map((p) => this.toScreen(p));
      const inside = (p: { x: number; y: number }) => p.x >= rect.x0 && p.x <= rect.x1 && p.y >= rect.y0 && p.y <= rect.y1;
      if (mode === 'window') {
        if (pts.every(inside)) result.push(e.id);
      } else {
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        const overlaps = Math.min(...xs) <= rect.x1 && Math.max(...xs) >= rect.x0 && Math.min(...ys) <= rect.y1 && Math.max(...ys) >= rect.y0;
        if (overlaps) result.push(e.id);
      }
    }
    return result;
  }

  // ---- tool feedback ------------------------------------------------------

  /**
   * Highlight every triangle of the hit mesh that satisfies `predicate`
   * (called with the triangle's local normal and centroid).
   */
  highlightFace(
    hit: PickHit | null,
    predicate?: (normal: THREE.Vector3, centroid: THREE.Vector3) => boolean,
    color = COLORS.selection,
  ) {
    if (!hit) {
      if (this.faceHighlight.visible) {
        this.faceHighlight.visible = false;
        this.requestRender();
      }
      return;
    }
    const geom = hit.object.geometry;
    const pos = geom.getAttribute('position');
    const index = geom.getIndex();
    const triCount = index ? index.count / 3 : pos.count / 3;
    const vi = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    const centroid = new THREE.Vector3();
    const target = hit.localNormal;
    const planeD = hit.localNormal.dot(hit.localPoint);
    const out: number[] = [];
    for (let t = 0; t < triCount; t++) {
      a.fromBufferAttribute(pos, vi(t, 0));
      b.fromBufferAttribute(pos, vi(t, 1));
      c.fromBufferAttribute(pos, vi(t, 2));
      n.subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b));
      if (n.lengthSq() < 1e-12) continue;
      n.normalize();
      centroid.copy(a).add(b).add(c).divideScalar(3);
      let ok: boolean;
      if (predicate) {
        ok = predicate(n.dot(target) < 0 ? n.clone().negate() : n, centroid);
      } else {
        ok = Math.abs(n.dot(target)) > 0.9999 && Math.abs(target.dot(a) - planeD) < 1e-3;
      }
      if (ok) out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    this.faceHighlight.geometry.dispose();
    this.faceHighlight.geometry = g;
    this.faceHighlight.matrix.copy(hit.object.matrixWorld);
    (this.faceHighlight.material as THREE.ShaderMaterial).uniforms.color.value.set(color);
    this.faceHighlight.visible = out.length > 0;
    this.requestRender();
  }

  setSnapMarker(point: THREE.Vector3 | null, kind = '', tooltip = '') {
    if (!point) {
      if (this.snapMarker.visible) {
        this.snapMarker.visible = false;
        this.requestRender();
      }
      return;
    }
    this.snapMarker.visible = true;
    this.snapMarker.position.copy(point);
    const el = this.snapMarker.element;
    el.className = `snap-marker snap-${kind}`;
    el.dataset.tip = tooltip;
    this.requestRender();
  }
}
