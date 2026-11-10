import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { disposeObject } from './overlay';

/**
 * 3D printer bed + build volume. The bed spans (0,0)–(W,D) like slicers do, with its
 * top a hair below z = 0 so parts sitting on it never z-fight.
 */
export class PrintPlate {
  readonly group = new THREE.Group();
  private readonly label: CSS2DObject;
  private content = new THREE.Group();
  private volumeMaterial: THREE.LineBasicMaterial | null = null;
  private alert = false;

  constructor() {
    const el = document.createElement('div');
    el.className = 'vp-plate-label';
    this.label = new CSS2DObject(el);
    this.group.add(this.content, this.label);
  }

  setVolume([w, d, h]: [number, number, number], name: string) {
    this.group.remove(this.content);
    disposeObject(this.content);
    this.content = new THREE.Group();

    const thickness = 3;
    const bed = new THREE.Mesh(
      new THREE.BoxGeometry(w, d, thickness),
      new THREE.MeshStandardMaterial({ color: 0x33373e, roughness: 0.9, metalness: 0.05 }),
    );
    bed.position.set(w / 2, d / 2, -0.2 - thickness / 2);
    const rim = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(w, d, thickness)),
      new THREE.LineBasicMaterial({ color: 0x1f2328 }),
    );
    rim.position.copy(bed.position);

    this.volumeMaterial = new THREE.LineBasicMaterial({ transparent: true, depthWrite: false });
    const volume = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(w, d, h).translate(w / 2, d / 2, h / 2)),
      this.volumeMaterial,
    );
    this.setAlert(this.alert);
    this.content.add(bed, rim, volume);
    this.group.add(this.content);

    this.label.position.set(w / 2, -Math.max(6, w * 0.03), 0);
    this.label.element.textContent = `${name} · ${w} × ${d} × ${h} mm`;
  }

  /** Red build volume when a part doesn't fit (like slicers do). */
  setAlert(on: boolean) {
    this.alert = on;
    if (!this.volumeMaterial) return;
    this.volumeMaterial.color.set(on ? 0xe5484d : 0x7d8794);
    this.volumeMaterial.opacity = on ? 0.9 : 0.45;
    this.label.element.classList.toggle('alert', on);
  }
}

/** A plain 1.75 m figure for judging scale (Build workspace). Not part of the model. */
export function makeScaleFigure(): THREE.Group {
  const mat = new THREE.MeshStandardMaterial({ color: 0x7c8fa6, roughness: 0.8 });
  const g = new THREE.Group();
  const capsule = (radius: number, length: number, x: number, z: number) => {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 6, 16).rotateX(Math.PI / 2), mat);
    m.position.set(x, 0, z);
    return m;
  };
  g.add(
    capsule(75, 760, -95, 455), // legs
    capsule(75, 760, 95, 455),
    capsule(185, 380, 0, 1190), // torso
    capsule(55, 600, -255, 1120), // arms
    capsule(55, 600, 255, 1120),
  );
  const head = new THREE.Mesh(new THREE.SphereGeometry(115, 24, 16), mat);
  head.position.set(0, 0, 1635);
  g.add(head);
  g.position.set(-900, -400, 0);
  g.userData.label = 'Scale figure (1.75 m)';
  return g;
}
