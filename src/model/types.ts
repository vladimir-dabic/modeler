import type { Instructions } from './instructions';
import type { PrinterSetting, WorkspaceId } from './workspaces';

/**
 * Core data model. All lengths are stored in millimetres, angles in degrees.
 * The world is Z-up (like SketchUp and every slicer): X = red, Y = green, Z = blue.
 */

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export type EntityKind = 'box' | 'cylinder' | 'extrusion' | 'sphere' | 'revolve' | 'tube';

interface EntityBase {
  id: string;
  name: string;
  kind: EntityKind;
  /** Origin of the entity's local frame, in world space (mm). */
  position: Vec3;
  /** Euler rotation in degrees, XYZ order, applied about the local origin. */
  rotation: Vec3;
  color: string;
  /** Hole entities are subtracted from every solid they overlap. */
  hole: boolean;
  /**
   * 'group': this hole only cuts parts inside its own group (and that group's subgroups).
   * Absent: it cuts every solid it overlaps.
   */
  holeScope?: 'group';
  /** A helper cutter (e.g. the half removed by split_for_print): cuts, but is only drawn while selected. */
  quiet?: boolean;
  visible: boolean;
  /** Group this entity belongs to (see Group); absent = top level. */
  groupId?: string;
}

/** Axis-aligned (in local space) box spanning [0, size] on each axis. */
export interface BoxEntity extends EntityBase {
  kind: 'box';
  size: Vec3;
  /** Rounds every edge and corner with this radius (mm); absent or 0 = sharp. */
  edgeRadius?: number;
}

/** Cylinder whose base centre is the local origin, extending along +Z. */
export interface CylinderEntity extends EntityBase {
  kind: 'cylinder';
  /** Bottom radius. */
  radius: number;
  height: number;
  segments: number;
  /** Top radius when it differs (a cone or frustum; 0 = pointed). Absent = a cylinder. */
  radiusTop?: number;
}

/** Closed 2D profile on the local XY plane, extruded along +Z. */
export interface ExtrusionEntity extends EntityBase {
  kind: 'extrusion';
  points: Vec2[];
  height: number;
}

/** Sphere or ellipsoid centred on the local origin. */
export interface SphereEntity extends EntityBase {
  kind: 'sphere';
  radii: Vec3;
  segments: number;
}

/**
 * A closed profile in the (radius, z) half-plane, revolved 360° around the local Z axis
 * (vases, knobs, turned legs). Radii are ≥ 0; points on the axis close the solid there.
 */
export interface RevolveEntity extends EntityBase {
  kind: 'revolve';
  profile: Vec2[];
  segments: number;
}

/**
 * A round tube along a path (local points; the first is the local origin), smooth
 * through the points unless `smooth` is false. Ends are capped flat.
 */
export interface TubeEntity extends EntityBase {
  kind: 'tube';
  path: Vec3[];
  radius: number;
  /** A radius per path point (tapering), instead of `radius` everywhere. */
  radii?: number[];
  smooth: boolean;
  segments: number;
}

export type Entity = BoxEntity | CylinderEntity | ExtrusionEntity | SphereEntity | RevolveEntity | TubeEntity;

/**
 * Groups are flat membership (ADR 0011): no transform of their own. Members keep
 * world-space positions; nesting is expressed with parentId.
 */
export interface Group {
  id: string;
  name: string;
  parentId?: string;
}

export type Unit = 'mm' | 'cm' | 'm' | 'in';

// ---- reference drawings (ADR 0014) ----------------------------------------------------

/** Units a drawing can be in; `DRAWING_UNIT_MM` converts them to mm. */
export type DrawingUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';

/** One polyline of a drawing, in drawing units. Arcs and circles are tessellated. */
export interface DrawingPath {
  /** Index into DrawingGeometry.layers. */
  layer: number;
  points: Vec2[];
  closed?: boolean;
  /** Set for arcs/circles: their centre (a snap point); only the ends are corner snaps. */
  center?: Vec2;
}

/** Immutable line geometry of an imported drawing, kept out of undo snapshots. */
export interface DrawingGeometry {
  layers: string[];
  paths: DrawingPath[];
}

/**
 * A reference drawing: lines to trace and snap to, not part of the model (no cut list,
 * export or CSG). Lies on the XY plane through `position`, rotated about Z.
 */
export interface ReferenceDrawing {
  id: string;
  name: string;
  kind: 'drawing';
  units: DrawingUnit;
  /** Where the drawing's origin sits, in mm. */
  position: Vec3;
  /** Rotation about Z, degrees. */
  rotation: number;
  visible: boolean;
  /** Layers switched off. */
  hiddenLayers: string[];
}

/** A reference drawing as stored in a file: metadata plus its geometry. */
export interface ReferenceFile extends ReferenceDrawing {
  geometry: DrawingGeometry;
}

// ---- annotations (ADR 0015) -------------------------------------------------------------

/**
 * Where an annotation is attached: a fixed world point, or a point on a part given as
 * fractions of the part's local box ([0,0,0] min corner … [1,1,1] max corner), so it
 * follows the part when it moves, rotates or is resized.
 */
export type Anchor = { point: Vec3 } | { entity: string; at: Vec3 };

/** A text label at anchor + offset, with a leader line to the anchor when offset ≠ 0. */
export interface NoteAnnotation {
  id: string;
  kind: 'note';
  text: string;
  anchor: Anchor;
  /** Label position relative to the anchor, world mm. */
  offset: Vec3;
}

/** A linear dimension between two anchors; the value is always measured. */
export interface DimensionAnnotation {
  id: string;
  kind: 'dimension';
  from: Anchor;
  to: Anchor;
  /** From the measured points to the dimension line, world mm. */
  offset: Vec3;
  /** Measure along one world axis instead of the true distance. */
  axis?: 'x' | 'y' | 'z';
  /** Text instead of the value; "<>" stands for the measured value. */
  text?: string;
}

export type Annotation = NoteAnnotation | DimensionAnnotation;

export interface DocumentFile {
  format: 'modeler';
  version: 1;
  units: Unit;
  /** Optional for files written before workspaces existed. */
  workspace?: WorkspaceId;
  printer?: PrinterSetting;
  entities: Entity[];
  groups?: Group[];
  references?: ReferenceFile[];
  annotations?: Annotation[];
  /** Build instructions (ADR 0021). */
  instructions?: Instructions;
}
