import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

export const COLORS = {
  x: 0xd93a3a,
  y: 0x2f9e44,
  z: 0x2f6fde,
  preview: 0x1d4ed8,
  measure: 0x111827,
  selection: 0x1d6ce0,
  hover: 0x5aa0f2,
  edge: 0x1f2328,
  hole: 0xd94848,
  erase: 0xe5484d,
};

export function axisColor(dir: THREE.Vector3): number {
  const ax = Math.abs(dir.x);
  const ay = Math.abs(dir.y);
  const az = Math.abs(dir.z);
  if (ax > 0.9999) return COLORS.x;
  if (ay > 0.9999) return COLORS.y;
  if (az > 0.9999) return COLORS.z;
  return COLORS.measure;
}

export function makeLine(
  points: THREE.Vector3[],
  color: number,
  opts: { dashed?: boolean; depthTest?: boolean; opacity?: number } = {},
): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const common = {
    color,
    depthTest: opts.depthTest ?? false,
    transparent: true,
    opacity: opts.opacity ?? 1,
  };
  const material = opts.dashed
    ? new THREE.LineDashedMaterial({ ...common, dashSize: 4, gapSize: 3, scale: 1 })
    : new THREE.LineBasicMaterial(common);
  const line = new THREE.Line(geometry, material);
  if (opts.dashed) line.computeLineDistances();
  line.renderOrder = 10;
  return line;
}

export function makeLabel(text: string, className = 'vp-label'): CSS2DObject {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  return new CSS2DObject(el);
}

export function setLabel(label: CSS2DObject, text: string) {
  if (label.element.textContent !== text) label.element.textContent = text;
}

/** Circle in a plane, for the rotate tool's protractor. */
export function makeCircle(center: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3, radius: number, color: number): THREE.Line {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * Math.PI * 2;
    pts.push(center.clone().addScaledVector(u, Math.cos(a) * radius).addScaledVector(v, Math.sin(a) * radius));
  }
  return makeLine(pts, color, { opacity: 0.85 });
}

/** A disposable group of temporary helper objects owned by a tool. */
export class Overlay {
  readonly group = new THREE.Group();

  add<T extends THREE.Object3D>(obj: T): T {
    this.group.add(obj);
    return obj;
  }

  clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      disposeObject(child);
    }
  }
}

export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((o) => {
    const anyObj = o as THREE.Mesh;
    anyObj.geometry?.dispose();
    const mat = anyObj.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
    if (o instanceof CSS2DObject) o.element.remove();
  });
}
