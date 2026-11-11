import * as THREE from 'three';
import { cleanNumber, entityMatrix, localBounds } from './geometry';
import type { Anchor, Annotation, DimensionAnnotation, Entity, Vec3 } from './types';

/**
 * Annotations (ADR 0015): notes and dimensions attached to parts. Anchors are fractions of
 * a part's local box, so they follow moves, rotations and resizes. DOM-free.
 */

export const AXIS_VECTORS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) } as const;

type Lookup = (id: string) => Entity | undefined;

/** World position of an anchor, or null if its part is gone. */
export function resolveAnchor(anchor: Anchor, get: Lookup): THREE.Vector3 | null {
  if ('point' in anchor) return new THREE.Vector3(...anchor.point);
  const e = get(anchor.entity);
  if (!e) return null;
  const b = localBounds(e);
  const size = b.getSize(new THREE.Vector3());
  const local = new THREE.Vector3(b.min.x + size.x * anchor.at[0], b.min.y + size.y * anchor.at[1], b.min.z + size.z * anchor.at[2]);
  return local.applyMatrix4(entityMatrix(e));
}

/** An anchor for a world point: on the part if one is given, else a fixed point. */
export function anchorFor(point: THREE.Vector3, entity?: Entity): Anchor {
  if (!entity) return { point: [cleanNumber(point.x), cleanNumber(point.y), cleanNumber(point.z)] };
  const local = point.clone().applyMatrix4(entityMatrix(entity).invert());
  const b = localBounds(entity);
  const size = b.getSize(new THREE.Vector3());
  const frac = (v: number, min: number, s: number) => (s > 1e-9 ? Math.round(((v - min) / s) * 1e6) / 1e6 : 0);
  return { entity: entity.id, at: [frac(local.x, b.min.x, size.x), frac(local.y, b.min.y, size.y), frac(local.z, b.min.z, size.z)] };
}

/** Part ids an annotation is attached to. */
export function anchoredIds(a: Annotation): string[] {
  const anchors = a.kind === 'note' ? [a.anchor] : [a.from, a.to];
  return anchors.flatMap((x) => ('entity' in x ? [x.entity] : []));
}

/** Drop annotations whose parts no longer exist. */
export function pruneAnnotations(annotations: Annotation[], get: Lookup): Annotation[] {
  return annotations.filter((a) => anchoredIds(a).every((id) => get(id)));
}

/** Shown unless a part it is attached to is hidden. */
export function annotationVisible(a: Annotation, get: Lookup): boolean {
  return anchoredIds(a).every((id) => get(id)?.visible !== false);
}

export interface DimensionGeometry {
  /** Measured points. */
  a: THREE.Vector3;
  b: THREE.Vector3;
  /** Ends of the dimension line. */
  a2: THREE.Vector3;
  b2: THREE.Vector3;
  /** Unit direction of the dimension line. */
  dir: THREE.Vector3;
  value: number;
}

export function dimensionGeometry(d: DimensionAnnotation, get: Lookup): DimensionGeometry | null {
  const a = resolveAnchor(d.from, get);
  const b = resolveAnchor(d.to, get);
  if (!a || !b) return null;
  const offset = new THREE.Vector3(...d.offset);
  const a2 = a.clone().add(offset);
  let dir: THREE.Vector3;
  let value: number;
  let b2: THREE.Vector3;
  if (d.axis) {
    const along = b.clone().sub(a).dot(AXIS_VECTORS[d.axis]);
    dir = AXIS_VECTORS[d.axis].clone().multiplyScalar(along < 0 ? -1 : 1);
    value = Math.abs(along);
    b2 = a2.clone().addScaledVector(dir, value);
  } else {
    const ab = b.clone().sub(a);
    value = ab.length();
    dir = value > 1e-9 ? ab.normalize() : new THREE.Vector3(1, 0, 0);
    b2 = b.clone().add(offset);
  }
  return { a, b, a2, b2, dir, value };
}

/** The label of a dimension: its text with "<>" replaced, or the formatted value. */
export function dimensionText(d: DimensionAnnotation, formatted: string): string {
  return d.text ? d.text.replace(/<>/g, formatted) : formatted;
}

/** Label position of a note. */
export function noteLabelPoint(anchor: THREE.Vector3, offset: Vec3): THREE.Vector3 {
  return anchor.clone().add(new THREE.Vector3(...offset));
}

// ---- validation (untrusted files) ---------------------------------------------------------

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNum);

function parseAnchor(raw: any): Anchor | null {
  if (!raw || typeof raw !== 'object') return null;
  if (isVec3(raw.point)) return { point: raw.point };
  if (typeof raw.entity === 'string' && isVec3(raw.at)) return { entity: raw.entity, at: raw.at };
  return null;
}

export const MAX_ANNOTATION_TEXT = 500;

/** Validate an annotation from a project file. Returns null if unusable. */
export function parseAnnotation(raw: any, newId: () => string): Annotation | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && raw.id ? raw.id : newId();
  const offset: Vec3 = isVec3(raw.offset) ? raw.offset : [0, 0, 0];
  if (raw.kind === 'note') {
    const anchor = parseAnchor(raw.anchor);
    if (!anchor || typeof raw.text !== 'string' || !raw.text.trim()) return null;
    return { id, kind: 'note', text: raw.text.slice(0, MAX_ANNOTATION_TEXT), anchor, offset };
  }
  if (raw.kind === 'dimension') {
    const from = parseAnchor(raw.from);
    const to = parseAnchor(raw.to);
    if (!from || !to) return null;
    return {
      id,
      kind: 'dimension',
      from,
      to,
      offset,
      ...(['x', 'y', 'z'].includes(raw.axis) ? { axis: raw.axis } : {}),
      ...(typeof raw.text === 'string' && raw.text.trim() ? { text: raw.text.slice(0, MAX_ANNOTATION_TEXT) } : {}),
    };
  }
  return null;
}
