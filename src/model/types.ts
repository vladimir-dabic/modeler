import type { PrinterSetting, WorkspaceId } from './workspaces';

/**
 * Core data model. All lengths are stored in millimetres, angles in degrees.
 * The world is Z-up (like SketchUp and every slicer): X = red, Y = green, Z = blue.
 */

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export type EntityKind = 'box' | 'cylinder' | 'extrusion';

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
  visible: boolean;
}

/** Axis-aligned (in local space) box spanning [0, size] on each axis. */
export interface BoxEntity extends EntityBase {
  kind: 'box';
  size: Vec3;
}

/** Cylinder whose base centre is the local origin, extending along +Z. */
export interface CylinderEntity extends EntityBase {
  kind: 'cylinder';
  radius: number;
  height: number;
  segments: number;
}

/** Closed 2D profile on the local XY plane, extruded along +Z. */
export interface ExtrusionEntity extends EntityBase {
  kind: 'extrusion';
  points: Vec2[];
  height: number;
}

export type Entity = BoxEntity | CylinderEntity | ExtrusionEntity;

export type Unit = 'mm' | 'cm' | 'm' | 'in';

export interface DocumentFile {
  format: 'modeler';
  version: 1;
  units: Unit;
  /** Optional for files written before workspaces existed. */
  workspace?: WorkspaceId;
  printer?: PrinterSetting;
  entities: Entity[];
}
