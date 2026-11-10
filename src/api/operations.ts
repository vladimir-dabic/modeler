import * as THREE from 'three';
import { z } from 'zod';
import { buildCutList } from '../model/cutlist';
import { copyEntities } from '../model/editing';
import { newId } from '../model/Document';
import { DxfError, parseDxf } from '../model/dxf';
import { exportStl, parseDocumentFile } from '../model/io';
import { DRAWING_UNITS, DRAWING_UNIT_MM, localBounds, referenceMatrix } from '../model/references';
import { cleanNumber, cleanVec, DEG, mirrorEntity, rotateEntityAbout } from '../model/geometry';
import { commonParentGroup, groupChain, groupMembers } from '../model/groups';
import { footprintMm2, solidVolumes } from '../model/quantities';
import type { BoxEntity, CylinderEntity, DrawingGeometry, DrawingUnit, Entity, ExtrusionEntity, Group, ReferenceDrawing, Vec3 as V3 } from '../model/types';
import {
  checkPrintFit,
  FILAMENTS,
  placeOnPlateDelta,
  PRINTERS,
  printerName,
  printerVolume,
  WORKSPACE_IDS,
  WORKSPACES,
} from '../model/workspaces';
import { ApiError, boundsJson, boundsOf, entityLine, entitySummary, groupLine, OperationContext, r2, referenceLine, type FileHost, type ViewName } from './core';
import { Axis, Color, Id, Num, Pattern, Positive, Rotation, Size3, Target, Vec2, Vec3, type PatternInput } from './schemas';

/**
 * Every Modeler API operation. See docs/modeler-api.md.
 *
 * - `read` operations never change the model.
 * - `write` operations run inside one transaction (one undo step); the API validates the
 *   result and rolls back on any error. They return `{ ids }` so batches can alias them.
 * - `settings` operations change document settings (not undoable).
 * - `history` is undo/redo. `host` operations need a host capability (e.g. rendering).
 */
export type OperationKind = 'read' | 'write' | 'settings' | 'history' | 'host';

export interface OperationDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  kind: OperationKind;
  input: S;
  run?(ctx: OperationContext, input: z.output<S>): unknown;
  runAsync?(ctx: OperationContext, input: z.output<S>): Promise<unknown>;
}

const def = <S extends z.ZodType>(d: OperationDef<S>): OperationDef<S> => d;

// ---- helpers ------------------------------------------------------------------------

const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;
const vec = (v: ArrayLike<number>) => new THREE.Vector3(v[0], v[1], v[2]);

function workspace(ctx: OperationContext) {
  return WORKSPACES[ctx.doc.workspace];
}

function translate(ctx: OperationContext, entities: Entity[], delta: THREE.Vector3) {
  if (delta.lengthSq() === 0) return;
  for (const e of entities) {
    ctx.doc.update(e.id, (x) => {
      x.position = cleanVec(vec(x.position).add(delta));
    });
  }
}

function anchorPoint(box: THREE.Box3, anchor: 'min' | 'center' | 'max'): THREE.Vector3 {
  if (anchor === 'min') return box.min.clone();
  if (anchor === 'max') return box.max.clone();
  return box.getCenter(new THREE.Vector3());
}

function groupRefOrUndefined(ctx: OperationContext, ref: string | undefined): string | undefined {
  return ref ? ctx.group(ref).id : undefined;
}

function baseEntity(ctx: OperationContext, kind: Entity['kind'], input: { name?: string; position?: number[]; rotation?: number[]; color?: string; hole?: boolean; group?: string }) {
  const groupId = groupRefOrUndefined(ctx, input.group);
  return {
    id: newId(),
    name: input.name?.trim() || ctx.doc.nextName(kind),
    position: cleanVec(vec(input.position ?? [0, 0, 0])),
    rotation: (input.rotation ?? [0, 0, 0]).map(cleanNumber) as V3,
    color: input.color ?? workspace(ctx).defaultColor,
    hole: input.hole ?? false,
    visible: true,
    ...(groupId ? { groupId } : {}),
  };
}

const AddCommon = {
  name: z.string().optional().describe('Meaningful name (shows in the cut list); default "Box N" etc.'),
  position: Vec3.optional(),
  rotation: Rotation.optional(),
  color: Color.optional().describe('Default: the workspace colour'),
  hole: z.boolean().optional().describe('true = subtract from every solid it overlaps'),
  group: Id.optional().describe('Add into this group (id or name)'),
};

// ---- read -------------------------------------------------------------------------------

const getScene = def({
  name: 'get_scene',
  kind: 'read',
  description:
    'Overview of the model: workspace, printer, overall bounds, the parts and any reference drawings (imported plans to build on; not parts). detail "outline" lists each top-level group as one line (best first call on big models), "compact" (default) one line per part, "full" complete JSON. Lines read: id "name" shape size at x,y,z [hole] in "group".',
  input: z.strictObject({
    detail: z.enum(['outline', 'compact', 'full']).optional(),
    include_hidden: z.boolean().optional(),
  }),
  run(ctx, input) {
    const { doc } = ctx;
    const detail = input.detail ?? 'compact';
    const parts = doc.entities.filter((e) => input.include_hidden || e.visible);
    const solids = parts.filter((e) => !e.hole);
    const ws = workspace(ctx);
    const scene: Record<string, unknown> = {
      workspace: ws.id,
      display_units: doc.units,
      counts: { parts: parts.filter((e) => !e.hole).length, holes: parts.filter((e) => e.hole).length, groups: doc.groups.length },
      bounds: solids.length ? boundsJson(boundsOf(solids)) : null,
    };
    if (ws.printPlate) scene.printer = { name: printerName(doc.printer), volume: printerVolume(doc.printer) };
    if (doc.references.length) scene.references = doc.references.map((r) => referenceLine(r, doc));
    if (detail === 'full') {
      scene.parts = parts.map((e) => entitySummary(e, doc.groups));
      scene.groups = doc.groups.map((g) => ({ id: g.id, name: g.name, parent: g.parentId, parts: groupMembers(g.id, doc.entities, doc.groups).length }));
    } else if (detail === 'outline') {
      const top = doc.groups.filter((g) => !g.parentId);
      scene.lines = [...top.map((g) => groupLine(g, doc.entities, doc.groups)), ...parts.filter((e) => !e.groupId).map((e) => entityLine(e, doc.groups))];
    } else {
      scene.lines = parts.map((e) => entityLine(e, doc.groups));
      if (doc.groups.length) scene.groups = doc.groups.map((g) => groupLine(g, doc.entities, doc.groups) + (g.parentId ? ` in "${doc.getGroup(g.parentId)?.name}"` : ''));
    }
    return scene;
  },
});

const getEntities = def({
  name: 'get_entities',
  kind: 'read',
  description: 'Full details (sizes, position, rotation, bounds, group) of the targeted parts.',
  input: z.strictObject({ target: Target }),
  run(ctx, input) {
    return { parts: ctx.resolve(input.target).map((e) => entitySummary(e, ctx.doc.groups)) };
  },
});

const getSelection = def({
  name: 'get_selection',
  kind: 'read',
  description: 'What the user has selected in the app (ids, lines, and the group if a whole group is selected). Use it to resolve "this", "these", "the selected part".',
  input: z.strictObject({}),
  run(ctx) {
    const sel = ctx.doc.selected();
    return { count: sel.length, lines: sel.map((e) => entityLine(e, ctx.doc.groups)), bounds: sel.length ? boundsJson(boundsOf(sel)) : null };
  },
});

const measure = def({
  name: 'measure',
  kind: 'read',
  description: 'Distance between two points, or the gap between two targets per axis (0 = touching or overlapping on that axis) and between their centres.',
  input: z.strictObject({
    from: Vec3.optional(),
    to: Vec3.optional(),
    between: z.tuple([Target, Target]).optional(),
  }),
  run(ctx, input) {
    if (input.between) {
      const a = boundsOf(ctx.resolve(input.between[0]));
      const b = boundsOf(ctx.resolve(input.between[1]));
      const gap = [0, 1, 2].map((i) => {
        const ga = b.min.getComponent(i) - a.max.getComponent(i);
        const gb = a.min.getComponent(i) - b.max.getComponent(i);
        return r2(Math.max(0, ga, gb));
      });
      const ca = a.getCenter(new THREE.Vector3());
      const cb = b.getCenter(new THREE.Vector3());
      return { gap, center_distance: r2(ca.distanceTo(cb)), overlapping: a.intersectsBox(b) && gap.every((g) => g === 0) };
    }
    if (!input.from || !input.to) throw new ApiError('invalid_input', 'Give from and to points, or between two targets');
    const d = vec(input.to).sub(vec(input.from));
    return { distance: r2(d.length()), delta: [r2(d.x), r2(d.y), r2(d.z)] };
  },
});

const checkPrint = def({
  name: 'check_print',
  kind: 'read',
  description: 'Print readiness: printer, problems (off the bed, too tall, below the bed, floating), size, solid volume and weight per filament at 100% infill.',
  input: z.strictObject({}),
  run(ctx) {
    const { doc } = ctx;
    const volume = printerVolume(doc.printer);
    const solids = doc.entities.filter((e) => e.visible && !e.hole);
    const vols = solidVolumes(solids, doc.entities);
    const total = [...vols.values()].reduce((a, b) => a + b, 0) / 1000;
    return {
      printer: printerName(doc.printer),
      build_volume: volume,
      problems: checkPrintFit(doc.entities, volume).map((i) => `${i.id} "${i.name}" ${i.message}`),
      size: solids.length ? boundsJson(boundsOf(solids)).size : null,
      volume_cm3: r2(total),
      weight_g: Object.fromEntries(FILAMENTS.map((f) => [f.name, r2(total * f.density)])),
    };
  },
});

const getCutList = def({
  name: 'get_cut_list',
  kind: 'read',
  description: 'Woodworking cut list: identical parts grouped as thickness × width × length (mm) with quantities.',
  input: z.strictObject({}),
  run(ctx) {
    return { rows: buildCutList(ctx.doc.entities).map((r) => ({ parts: r.names, qty: r.quantity, t_w_l: [r.thickness, r.width, r.length], note: r.note || undefined })) };
  },
});

const getQuantities = def({
  name: 'get_quantities',
  kind: 'read',
  description: 'Building quantities: per part footprint (m², seen from above) and volume (m³, holes/openings removed), plus totals.',
  input: z.strictObject({}),
  run(ctx) {
    const solids = ctx.doc.entities.filter((e) => e.visible && !e.hole);
    const vols = solidVolumes(solids, ctx.doc.entities);
    const rows = solids.map((e) => ({ id: e.id, name: e.name, footprint_m2: r2(footprintMm2(e) / 1e6), volume_m3: Math.round((vols.get(e.id) ?? 0) / 1e6) / 1000 }));
    return { rows, total_volume_m3: Math.round([...vols.values()].reduce((a, b) => a + b, 0) / 1e6) / 1000 };
  },
});

// ---- create -------------------------------------------------------------------------------

const addBox = def({
  name: 'add_box',
  kind: 'write',
  description: 'Add a box (board, block, panel). position is its min corner (default origin); size is [x, y, z] in mm. Example: { "name": "Side", "position": [0, 0, 18], "size": [18, 300, 700] }.',
  input: z.strictObject({ ...AddCommon, size: Size3 }),
  run(ctx, input) {
    const e: BoxEntity = { ...baseEntity(ctx, 'box', input), kind: 'box', size: input.size.map(cleanNumber) as V3 };
    ctx.doc.add(e);
    return { ids: [e.id] };
  },
});

const addCylinder = def({
  name: 'add_cylinder',
  kind: 'write',
  description:
    'Add a cylinder (rod, dowel, round hole). position is the centre of its base; it extends along axis (default z) by height. Give radius or diameter. For a screw hole: hole: true. Example M3 hole through a 10 mm plate: { "position": [20, 20, -1], "diameter": 3.4, "height": 12, "hole": true }.',
  input: z
    .strictObject({
      ...AddCommon,
      radius: Positive.optional(),
      diameter: Positive.optional(),
      height: Positive,
      axis: Axis.optional(),
      segments: z.int().min(3).max(256).optional().describe('Smoothness; default from workspace'),
    })
    .refine((v) => (v.radius ? 1 : 0) + (v.diameter ? 1 : 0) === 1, 'give exactly one of radius or diameter'),
  run(ctx, input) {
    const axisRotation: Record<string, V3> = { x: [0, 90, 0], y: [-90, 0, 0], z: [0, 0, 0] };
    const base = baseEntity(ctx, 'cylinder', input);
    if (!input.rotation) base.rotation = axisRotation[input.axis ?? 'z'];
    const e: CylinderEntity = {
      ...base,
      kind: 'cylinder',
      radius: cleanNumber(input.radius ?? input.diameter! / 2),
      height: cleanNumber(input.height),
      segments: input.segments ?? workspace(ctx).cylinderSegments,
    };
    ctx.doc.add(e);
    return { ids: [e.id] };
  },
});

const addShape = def({
  name: 'add_shape',
  kind: 'write',
  description: 'Add an extruded outline (L-bracket, triangle, custom profile). points are [x, y] in mm relative to position, on the XY plane; extruded up by height. Use rotation to stand it up.',
  input: z.strictObject({ ...AddCommon, points: z.array(Vec2).min(3).max(500), height: Positive }),
  run(ctx, input) {
    const e: ExtrusionEntity = {
      ...baseEntity(ctx, 'extrusion', input),
      kind: 'extrusion',
      points: input.points.map(([x, y]) => [cleanNumber(x), cleanNumber(y)]),
      height: cleanNumber(input.height),
    };
    ctx.doc.add(e);
    return { ids: [e.id] };
  },
});

// ---- edit -----------------------------------------------------------------------------------

const updateEntity = def({
  name: 'update_entity',
  kind: 'write',
  description: 'Change one part\'s parameters. Only keys that fit the part apply: size (box); radius or diameter, segments (cylinder); points (shape); height (cylinder, shape). Example: { "id": "k3f9a2", "set": { "size": [18, 300, 650] } }.',
  input: z.strictObject({
    id: Id,
    set: z
      .strictObject({
        name: z.string().min(1).optional(),
        position: Vec3.optional(),
        rotation: Rotation.optional(),
        size: Size3.optional(),
        radius: Positive.optional(),
        diameter: Positive.optional(),
        height: Positive.optional(),
        segments: z.int().min(3).max(256).optional(),
        points: z.array(Vec2).min(3).max(500).optional(),
        color: Color.optional(),
        hole: z.boolean().optional(),
        visible: z.boolean().optional(),
      })
      .refine((v) => Object.keys(v).length > 0, 'set at least one field'),
  }),
  run(ctx, input) {
    const e = ctx.entity(input.id);
    const s = input.set;
    const wrong = (key: string, kinds: string) => {
      throw new ApiError('invalid_input', `"${e.name}" is a ${e.kind}; ${key} only applies to ${kinds}`, undefined, `set.${key}`);
    };
    if (s.size && e.kind !== 'box') wrong('size', 'boxes');
    if ((s.radius || s.diameter || s.segments) && e.kind !== 'cylinder') wrong('radius/diameter/segments', 'cylinders');
    if (s.points && e.kind !== 'extrusion') wrong('points', 'shapes');
    if (s.height && e.kind === 'box') wrong('height', 'cylinders and shapes (boxes use size)');
    ctx.doc.update(e.id, (x) => {
      if (s.name) x.name = s.name.trim();
      if (s.position) x.position = s.position.map(cleanNumber) as V3;
      if (s.rotation) x.rotation = s.rotation.map(cleanNumber) as V3;
      if (s.color) x.color = s.color;
      if (s.hole !== undefined) x.hole = s.hole;
      if (s.visible !== undefined) x.visible = s.visible;
      if (x.kind === 'box' && s.size) x.size = s.size.map(cleanNumber) as V3;
      if (x.kind === 'cylinder') {
        if (s.radius) x.radius = cleanNumber(s.radius);
        if (s.diameter) x.radius = cleanNumber(s.diameter / 2);
        if (s.segments) x.segments = s.segments;
      }
      if (x.kind !== 'box' && s.height) x.height = cleanNumber(s.height);
      if (x.kind === 'extrusion' && s.points) x.points = s.points.map(([a, b]) => [cleanNumber(a), cleanNumber(b)]);
    });
    return { ids: [e.id] };
  },
});

const deleteEntities = def({
  name: 'delete_entities',
  kind: 'write',
  description: 'Delete the targeted parts (groups left empty disappear).',
  input: z.strictObject({ target: Target }),
  run(ctx, input) {
    const ids = ctx.resolve(input.target).map((e) => e.id);
    ctx.doc.remove(ids);
    return { ids: [] as string[], deleted: ids.length };
  },
});

const setHole = def({
  name: 'set_hole',
  kind: 'write',
  description: 'Make the targeted parts holes (subtracted from overlapping solids) or solids again.',
  input: z.strictObject({ target: Target, hole: z.boolean() }),
  run(ctx, input) {
    const parts = ctx.resolve(input.target);
    for (const e of parts) ctx.doc.update(e.id, (x) => (x.hole = input.hole));
    return { ids: parts.map((e) => e.id) };
  },
});

const setVisible = def({
  name: 'set_visible',
  kind: 'write',
  description: 'Hide or show the targeted parts. Hidden parts are not exported and do not cut.',
  input: z.strictObject({ target: Target, visible: z.boolean() }),
  run(ctx, input) {
    const parts = ctx.resolve(input.target);
    for (const e of parts) ctx.doc.update(e.id, (x) => (x.visible = input.visible));
    return { ids: parts.map((e) => e.id) };
  },
});

const setColor = def({
  name: 'set_color',
  kind: 'write',
  description: 'Set the colour of the targeted parts (#rrggbb).',
  input: z.strictObject({ target: Target, color: Color }),
  run(ctx, input) {
    const parts = ctx.resolve(input.target);
    for (const e of parts) ctx.doc.update(e.id, (x) => (x.color = input.color));
    return { ids: parts.map((e) => e.id) };
  },
});

// ---- transform ------------------------------------------------------------------------------

const move = def({
  name: 'move',
  kind: 'write',
  description: 'Move the targeted parts together: by an offset, or so their anchor point (bounds min, center or max; default min) lands at "to".',
  input: z
    .strictObject({ target: Target, by: Vec3.optional(), to: Vec3.optional(), anchor: z.enum(['min', 'center', 'max']).optional() })
    .refine((v) => (v.by ? 1 : 0) + (v.to ? 1 : 0) === 1, 'give exactly one of by or to'),
  run(ctx, input) {
    const parts = ctx.resolve(input.target);
    const delta = input.by ? vec(input.by) : vec(input.to!).sub(anchorPoint(boundsOf(parts), input.anchor ?? 'min'));
    translate(ctx, parts, delta);
    return { ids: parts.map((e) => e.id) };
  },
});

const rotate = def({
  name: 'rotate',
  kind: 'write',
  description: 'Rotate the targeted parts together by angle degrees (counter-clockwise looking down the axis) about axis (default z) through pivot (default: the centre of their bounds; or "min", or a point).',
  input: z.strictObject({ target: Target, angle: Num, axis: Axis.optional(), pivot: z.union([Vec3, z.enum(['center', 'min'])]).optional() }),
  run(ctx, input) {
    const parts = ctx.resolve(input.target);
    const box = boundsOf(parts);
    const pivot = Array.isArray(input.pivot) ? vec(input.pivot) : anchorPoint(box, input.pivot === 'min' ? 'min' : 'center');
    const axis = new THREE.Vector3().setComponent(AXIS_INDEX[input.axis ?? 'z'], 1);
    const q = new THREE.Quaternion().setFromAxisAngle(axis, input.angle * DEG);
    for (const e of parts) ctx.doc.update(e.id, (x) => rotateEntityAbout(x, q, pivot));
    return { ids: parts.map((e) => e.id) };
  },
});

const placeOnGround = def({
  name: 'place_on_ground',
  kind: 'write',
  description: 'Drop the targeted parts (default: everything) so their lowest solid point sits at z = 0.',
  input: z.strictObject({ target: Target.optional() }),
  run(ctx, input) {
    const parts = input.target ? ctx.resolve(input.target) : ctx.doc.entities;
    const solids = parts.filter((e) => !e.hole);
    const box = boundsOf(solids.length ? solids : parts);
    translate(ctx, parts, new THREE.Vector3(0, 0, -box.min.z));
    return { ids: parts.map((e) => e.id) };
  },
});

const placeOnPlate = def({
  name: 'place_on_plate',
  kind: 'write',
  description: 'Centre the targeted parts (default: everything) on the 3D printer bed and set them down on it.',
  input: z.strictObject({ target: Target.optional() }),
  run(ctx, input) {
    const parts = input.target ? ctx.resolve(input.target) : ctx.doc.entities;
    translate(ctx, parts, placeOnPlateDelta(parts, printerVolume(ctx.doc.printer)));
    return { ids: parts.map((e) => e.id) };
  },
});

// ---- layout (one call = one intent) -------------------------------------------------------------

type CopyTransform = { offset: THREE.Vector3 } | { rotate: THREE.Quaternion; pivot: THREE.Vector3 };

function patternTransforms(pattern: PatternInput | undefined, box: THREE.Box3): CopyTransform[] {
  if (!pattern) {
    const width = box.max.x - box.min.x;
    return [{ offset: new THREE.Vector3(width + Math.max(10, width * 0.1), 0, 0) }];
  }
  if ('offsets' in pattern) return pattern.offsets.map((o) => ({ offset: vec(o) }));
  if ('linear' in pattern) {
    const { count, step, span } = pattern.linear;
    const s = step ? vec(step) : vec(span!).divideScalar(count - 1);
    return Array.from({ length: count - 1 }, (_, i) => ({ offset: s.clone().multiplyScalar(i + 1) }));
  }
  if ('grid' in pattern) {
    const [nx, ny, nz = 1] = pattern.grid.counts;
    const s = vec(pattern.grid.step);
    const out: CopyTransform[] = [];
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++)
        for (let k = 0; k < nz; k++) if (i || j || k) out.push({ offset: new THREE.Vector3(i * s.x, j * s.y, k * s.z) });
    return out;
  }
  const { count, axis = 'z', center, angle = 360 } = pattern.radial;
  const pivot = center ? vec(center) : box.getCenter(new THREE.Vector3());
  const step = Math.abs(angle) >= 360 ? 360 / count : angle / (count - 1);
  const ax = new THREE.Vector3().setComponent(AXIS_INDEX[axis], 1);
  return Array.from({ length: count - 1 }, (_, i) => ({ rotate: new THREE.Quaternion().setFromAxisAngle(ax, step * (i + 1) * DEG), pivot }));
}

const duplicate = def({
  name: 'duplicate',
  kind: 'write',
  description:
    'Copy the targeted parts in ONE call using a pattern (counts include the original): linear { count, step | span }, grid { counts, step }, radial { count, axis, center, angle } (bolt circles), or offsets [...]. Without a pattern: one copy beside the original. Whole groups are copied as new groups. Returns all copies.',
  input: z.strictObject({ target: Target, pattern: Pattern.optional() }),
  run(ctx, input) {
    const parts = ctx.resolve(input.target);
    const transforms = patternTransforms(input.pattern, boundsOf(parts));
    const ids: string[] = [];
    for (const t of transforms) {
      const copies = copyEntities(ctx.doc, parts, (c) => {
        if ('offset' in t) c.position = cleanVec(vec(c.position).add(t.offset));
        else rotateEntityAbout(c, t.rotate, t.pivot);
      });
      ids.push(...copies.map((c) => c.id));
    }
    return { ids };
  },
});

const mirror = def({
  name: 'mirror',
  kind: 'write',
  description:
    'Mirror the targeted parts across a plane perpendicular to x, y or z. about = the plane position (mm), or a part/group id whose centre defines it. keep_original (default true) makes mirrored copies; false flips in place. Default plane: the far side of the target (copies end up touching), or its centre when flipping in place.',
  input: z.strictObject({ target: Target, plane: Axis, about: z.union([Num, Id]).optional(), keep_original: z.boolean().optional() }),
  run(ctx, input) {
    const parts = ctx.resolve(input.target);
    const axis = AXIS_INDEX[input.plane];
    const keep = input.keep_original ?? true;
    const box = boundsOf(parts);
    let c: number;
    if (typeof input.about === 'number') c = input.about;
    else if (typeof input.about === 'string') c = boundsOf(ctx.resolve({ ids: [input.about] })).getCenter(new THREE.Vector3()).getComponent(axis);
    else c = keep ? box.max.getComponent(axis) : box.getCenter(new THREE.Vector3()).getComponent(axis);
    if (keep) {
      const copies = copyEntities(ctx.doc, parts, (x) => mirrorEntity(x, axis, c));
      return { ids: copies.map((x) => x.id) };
    }
    for (const e of parts) ctx.doc.update(e.id, (x) => mirrorEntity(x, axis, c));
    return { ids: parts.map((e) => e.id) };
  },
});

const SIDES = {
  top: { axis: 2, dir: 1 },
  bottom: { axis: 2, dir: -1 },
  right: { axis: 0, dir: 1 },
  left: { axis: 0, dir: -1 },
  back: { axis: 1, dir: 1 },
  front: { axis: 1, dir: -1 },
} as const;

const place = def({
  name: 'place',
  kind: 'write',
  description:
    'Put the targeted parts against another target without computing coordinates: side top/bottom/left(-x)/right(+x)/front(-y)/back(+y), gap in mm (default 0), and on the other two axes align min/center/max (default center) or keep. Example: lid on top of a box, centred: { "target": { "name": "Lid" }, "relative_to": { "name": "Box" }, "side": "top" }.',
  input: z.strictObject({
    target: Target,
    relative_to: Target,
    side: z.enum(['top', 'bottom', 'left', 'right', 'front', 'back']),
    align: z.enum(['min', 'center', 'max', 'keep']).optional(),
    gap: Num.optional(),
  }),
  run(ctx, input) {
    const parts = ctx.resolve(input.target);
    const ref = ctx.resolve(input.relative_to);
    const own = new Set(parts.map((e) => e.id));
    if (ref.some((e) => own.has(e.id))) throw new ApiError('invalid_input', 'target and relative_to overlap', 'Pick a reference that is not part of the target.');
    const B = boundsOf(parts);
    const R = boundsOf(ref);
    const { axis, dir } = SIDES[input.side];
    const gap = input.gap ?? 0;
    const delta = new THREE.Vector3();
    delta.setComponent(axis, dir > 0 ? R.max.getComponent(axis) + gap - B.min.getComponent(axis) : R.min.getComponent(axis) - gap - B.max.getComponent(axis));
    const mode = input.align ?? 'center';
    for (const i of [0, 1, 2]) {
      if (i === axis || mode === 'keep') continue;
      const b = mode === 'min' ? B.min.getComponent(i) : mode === 'max' ? B.max.getComponent(i) : (B.min.getComponent(i) + B.max.getComponent(i)) / 2;
      const r = mode === 'min' ? R.min.getComponent(i) : mode === 'max' ? R.max.getComponent(i) : (R.min.getComponent(i) + R.max.getComponent(i)) / 2;
      delta.setComponent(i, r - b);
    }
    translate(ctx, parts, delta);
    return { ids: parts.map((e) => e.id) };
  },
});

const align = def({
  name: 'align',
  kind: 'write',
  description: 'Move the targeted parts (as one block) along one axis so their min, center or max lines up with another target\'s.',
  input: z.strictObject({ target: Target, to: Target, axis: Axis, mode: z.enum(['min', 'center', 'max']) }),
  run(ctx, input) {
    const parts = ctx.resolve(input.target);
    const i = AXIS_INDEX[input.axis];
    const pick = (b: THREE.Box3) => (input.mode === 'min' ? b.min.getComponent(i) : input.mode === 'max' ? b.max.getComponent(i) : (b.min.getComponent(i) + b.max.getComponent(i)) / 2);
    const delta = new THREE.Vector3().setComponent(i, pick(boundsOf(ctx.resolve(input.to))) - pick(boundsOf(parts)));
    translate(ctx, parts, delta);
    return { ids: parts.map((e) => e.id) };
  },
});

const distribute = def({
  name: 'distribute',
  kind: 'write',
  description:
    'Space parts evenly along an axis (shelves, slats, posts). With count, the target is copied first until there are that many. With between [lower, upper], parts are spaced inside that gap with equal spaces (mode "even") or a fixed spacing gap; without it, the first and last part stay put. Example: 4 shelves between bottom and top: { "target": { "name": "Shelf" }, "count": 4, "between": [{ "name": "Bottom" }, { "name": "Top" }], "axis": "z" }.',
  input: z.strictObject({
    target: Target,
    axis: Axis,
    count: z.int().min(1).max(500).optional(),
    between: z.tuple([Target, Target]).optional(),
    mode: z.enum(['even', 'spacing']).optional(),
    spacing: Num.optional().describe('Gap between parts for mode "spacing" (mm)'),
  }),
  run(ctx, input) {
    const i = AXIS_INDEX[input.axis];
    let units = ctx.units(ctx.resolve(input.target));
    if (input.count && input.count > units.length) {
      const last = units[units.length - 1];
      for (let n = units.length; n < input.count; n++) units.push(copyEntities(ctx.doc, last, () => {}));
    }
    const lo = (u: Entity[]) => boundsOf(u).min.getComponent(i);
    const size = (u: Entity[]) => {
      const b = boundsOf(u);
      return b.max.getComponent(i) - b.min.getComponent(i);
    };
    units = units.sort((a, b) => lo(a) - lo(b));
    const total = units.reduce((s, u) => s + size(u), 0);
    let start: number;
    let gap: number;
    if (input.between) {
      let a = boundsOf(ctx.resolve(input.between[0]));
      let b = boundsOf(ctx.resolve(input.between[1]));
      if (a.min.getComponent(i) > b.min.getComponent(i)) [a, b] = [b, a];
      const from = a.max.getComponent(i);
      const to = b.min.getComponent(i);
      if (input.mode === 'spacing') {
        gap = input.spacing ?? 0;
        start = from + gap;
      } else {
        gap = (to - from - total) / (units.length + 1);
        start = from + gap;
      }
      if (start + total + gap * (units.length - 1) > to + 1e-6) {
        throw new ApiError('invalid_geometry', `${units.length} parts (${r2(total)} mm) don't fit in the ${r2(to - from)} mm between the references`, 'Use fewer parts, smaller parts, or a smaller spacing.');
      }
    } else {
      start = lo(units[0]);
      if (input.mode === 'spacing') gap = input.spacing ?? 0;
      else {
        if (units.length < 3) throw new ApiError('invalid_input', 'Spacing evenly without "between" needs at least 3 parts', 'Add count, or give between [lower, upper].');
        const end = lo(units[units.length - 1]) + size(units[units.length - 1]);
        gap = (end - start - total) / (units.length - 1);
      }
    }
    let at = start;
    for (const u of units) {
      translate(ctx, u, new THREE.Vector3().setComponent(i, at - lo(u)));
      at += size(u) + gap;
    }
    return { ids: units.flat().map((e) => e.id) };
  },
});

// ---- groups ------------------------------------------------------------------------------------

const group = def({
  name: 'group',
  kind: 'write',
  description: 'Group the targeted parts (and any groups they belong to inside the common parent) into a new group, so they select, move and copy as one. Returns the group id.',
  input: z.strictObject({ target: Target, name: z.string().min(1).optional() }),
  run(ctx, input) {
    const { doc } = ctx;
    const parts = ctx.resolve(input.target);
    const parent = commonParentGroup(parts, doc.groups);
    const g: Group = { id: newId(), name: input.name?.trim() || doc.nextNameFor('Group'), ...(parent ? { parentId: parent } : {}) };
    const groups = doc.groups.map((x) => ({ ...x }));
    for (const e of parts) {
      const chain = groupChain(e.groupId, doc.groups).map((x) => x.id); // innermost → outermost
      const at = parent ? chain.indexOf(parent) : chain.length;
      if (at <= 0) doc.update(e.id, (x) => (x.groupId = g.id));
      else {
        const child = groups.find((x) => x.id === chain[at - 1])!;
        child.parentId = g.id;
      }
    }
    doc.setGroups([...groups, g]);
    return { ids: [g.id], group: g.id };
  },
});

const ungroup = def({
  name: 'ungroup',
  kind: 'write',
  description: 'Dissolve a group (id or name). Its parts and subgroups move up one level and stay where they are.',
  input: z.strictObject({ group: Id }),
  run(ctx, input) {
    const { doc } = ctx;
    const g = ctx.group(input.group);
    const members = groupMembers(g.id, doc.entities, doc.groups).map((e) => e.id);
    for (const e of doc.entities.filter((x) => x.groupId === g.id)) {
      doc.update(e.id, (x) => {
        if (g.parentId) x.groupId = g.parentId;
        else delete x.groupId;
      });
    }
    doc.setGroups(doc.groups.filter((x) => x.id !== g.id).map((x) => (x.parentId === g.id ? { ...x, parentId: g.parentId } : x)).map((x) => {
      if (!x.parentId) {
        const { parentId: _drop, ...rest } = x;
        return rest;
      }
      return x;
    }));
    return { ids: members };
  },
});

const renameGroup = def({
  name: 'rename_group',
  kind: 'write',
  description: 'Rename a group, found by its id or its current name.',
  input: z.strictObject({ group: Id, name: z.string().min(1) }),
  run(ctx, input) {
    const g = ctx.group(input.group);
    ctx.doc.setGroups(ctx.doc.groups.map((x) => (x.id === g.id ? { ...x, name: input.name.trim() } : x)));
    return { ids: [g.id] };
  },
});

// ---- selection & settings -------------------------------------------------------------------------

const setSelection = def({
  name: 'set_selection',
  kind: 'read', // selection is UI state, not an undoable model change
  description: 'Select the targeted parts in the app (shows the user what you mean). No target clears the selection.',
  input: z.strictObject({ target: Target.optional() }),
  run(ctx, input) {
    const ids = input.target ? ctx.resolve(input.target).map((e) => e.id) : [];
    ctx.doc.setSelection(ids);
    return { selected: ids.length };
  },
});

const setWorkspace = def({
  name: 'set_workspace',
  kind: 'settings',
  description: 'Switch workspace: print (3D printing, mm), workshop (woodworking, mm) or build (houses, cm display). Changes display units, snapping and panels, never the model.',
  input: z.strictObject({ workspace: z.enum(WORKSPACE_IDS as [string, ...string[]]) }),
  run(ctx, input) {
    const ws = WORKSPACES[input.workspace as keyof typeof WORKSPACES];
    ctx.doc.setUnits(ws.units);
    ctx.doc.setWorkspace(ws.id);
    return { workspace: ws.id, display_units: ws.units };
  },
});

const setPrinter = def({
  name: 'set_printer',
  kind: 'settings',
  description: `Choose the 3D printer (profile id) or a custom build volume [x, y, z] mm. Profiles: ${PRINTERS.map((p) => `${p.id} (${p.volume.join('×')})`).join(', ')}.`,
  input: z
    .strictObject({
      profile: z.enum(PRINTERS.map((p) => p.id) as [string, ...string[]]).optional(),
      custom: Size3.optional(),
    })
    .refine((v) => (v.profile ? 1 : 0) + (v.custom ? 1 : 0) === 1, 'give exactly one of profile or custom'),
  run(ctx, input) {
    const current = ctx.doc.printer;
    ctx.doc.setPrinter(input.custom ? { profile: 'custom', custom: input.custom.map((v) => Math.round(v * 10) / 10) as V3 } : { ...current, profile: input.profile! });
    return { printer: printerName(ctx.doc.printer), build_volume: printerVolume(ctx.doc.printer) };
  },
});

const undo = def({
  name: 'undo',
  kind: 'history',
  description: 'Undo the last change (one call or batch = one step).',
  input: z.strictObject({}),
  run(ctx) {
    const label = ctx.doc.undoLabel;
    if (!ctx.doc.canUndo) throw new ApiError('not_found', 'Nothing to undo');
    ctx.doc.undo();
    return { undone: label ?? 'last change' };
  },
});

const redo = def({
  name: 'redo',
  kind: 'history',
  description: 'Redo the last undone change.',
  input: z.strictObject({}),
  run(ctx) {
    if (!ctx.doc.canRedo) throw new ApiError('not_found', 'Nothing to redo');
    ctx.doc.redo();
    return { redone: true };
  },
});

// ---- host ---------------------------------------------------------------------------------------------

const renderViews = def({
  name: 'render_views',
  kind: 'host',
  description: 'Render PNG images of the model from standard views to check shape and alignment visually. Use sparingly: images cost tokens.',
  input: z.strictObject({
    views: z.array(z.enum(['iso', 'top', 'front', 'right', 'left', 'back', 'bottom'])).min(1).max(4).optional(),
    size: z.int().min(256).max(1024).optional(),
  }),
  async runAsync(ctx, input) {
    if (!ctx.host?.renderViews) throw new ApiError('unsupported', 'This host cannot render images', 'Open the model in the app (live bridge) to get images.');
    return { images: await ctx.host.renderViews((input.views ?? ['iso']) as ViewName[], input.size ?? 768) };
  },
});

function files(ctx: OperationContext): FileHost {
  if (!ctx.host?.files) {
    throw new ApiError('unsupported', 'This host has no file access', 'Files are only available through the MCP server; in the app use File > Open / Save / Export.');
  }
  return ctx.host.files;
}

const FilePath = z.string().min(1).max(500);

const openFile = def({
  name: 'open_file',
  kind: 'host',
  description: 'Open a .modeler.json project file (path relative to the working folder), replacing the current model. In the live app this is one undo step.',
  input: z.strictObject({ path: FilePath.describe('e.g. "projects/bookcase.modeler.json"') }),
  async runAsync(ctx, input) {
    const host = files(ctx);
    const text = await host.readText(input.path);
    let file;
    try {
      file = parseDocumentFile(text);
    } catch (err) {
      throw new ApiError('invalid_input', `${input.path} is not a modeler project: ${(err as Error).message}`);
    }
    ctx.doc.load(file, true);
    host.currentPath = input.path;
    return { path: input.path, parts: file.entities.length, groups: file.groups?.length ?? 0, workspace: ctx.doc.workspace };
  },
});

const saveFile = def({
  name: 'save_file',
  kind: 'host',
  description: 'Save the model as a .modeler.json project file. Without a path, saves to the file last opened or saved.',
  input: z.strictObject({ path: FilePath.optional().describe('Must end in .json, e.g. "clip.modeler.json"') }),
  async runAsync(ctx, input) {
    const host = files(ctx);
    const path = input.path ?? host.currentPath;
    if (!path) throw new ApiError('invalid_input', 'No file name yet', 'Give a path, e.g. "model.modeler.json".', 'path');
    if (!/\.json$/i.test(path)) throw new ApiError('invalid_input', 'Project files must end in .json', 'Use e.g. "model.modeler.json".', 'path');
    const shown = await host.write(path, JSON.stringify(ctx.doc.toFile(), null, 1));
    host.currentPath = path;
    return { path: shown, parts: ctx.doc.entities.length };
  },
});

const exportStlOp = def({
  name: 'export_stl',
  kind: 'host',
  description: 'Write a binary STL (mm) of the visible solids, with holes cut, for 3D printing. Target limits it to some parts; default: everything visible.',
  input: z.strictObject({
    path: FilePath.describe('Must end in .stl'),
    target: Target.optional(),
  }),
  async runAsync(ctx, input) {
    const host = files(ctx);
    if (!/\.stl$/i.test(input.path)) throw new ApiError('invalid_input', 'The file name must end in .stl', undefined, 'path');
    const targets = input.target ? ctx.resolve(input.target) : ctx.doc.entities;
    const data = exportStl(targets, ctx.doc.entities);
    if (!data) throw new ApiError('not_found', 'Nothing to export', 'Only visible solid parts (not holes) are exported.');
    const shown = await host.write(input.path, new Uint8Array(data));
    const solids = targets.filter((e) => e.visible && !e.hole).length;
    return { path: shown, solids, triangles: (data.byteLength - 84) / 50, bytes: data.byteLength };
  },
});

// ---- reference drawings (ADR 0014) ----------------------------------------------------------

const DrawingUnitSchema = z.enum(DRAWING_UNITS as [DrawingUnit, ...DrawingUnit[]]);

/** A hint when assumed units give an implausible size (a plan in metres read as mm…). */
function unitsHint(sizeMm: number[]): string | undefined {
  const big = Math.max(...sizeMm);
  if (big < 50) return `The drawing is only ${r2(big)} mm across; it is probably in metres or inches. Fix it with update_reference { units }.`;
  if (big > 2_000_000) return `The drawing is ${r2(big / 1_000_000)} km across; check its units with update_reference { units }.`;
  return undefined;
}

function drawingSize(g: DrawingGeometry, units: DrawingUnit): number[] {
  const b = localBounds(g);
  const k = DRAWING_UNIT_MM[units];
  return b ? [r2((b.max[0] - b.min[0]) * k), r2((b.max[1] - b.min[1]) * k)] : [0, 0];
}

const importDxf = def({
  name: 'import_dxf',
  kind: 'host',
  description:
    'Import a DXF drawing (e.g. a floor plan) as a reference drawing: lines on the ground (or at position) to build on and snap to. It is not part of the model (no cut list, export or holes). Give path (MCP: relative to the working folder) or text (the file contents). Units come from the file, else units, else mm. DWG is not supported: save as DXF first.',
  input: z
    .strictObject({
      path: FilePath.optional().describe('A .dxf file'),
      text: z.string().max(60_000_000).optional().describe('DXF contents (the app passes the picked file)'),
      name: z.string().max(100).optional().describe('Default: the file name'),
      units: DrawingUnitSchema.optional().describe('Units of the drawing when the file does not say (default mm), or to override it'),
      position: Vec3.optional().describe('Where the drawing\'s lower-left corner goes (default 0,0,0)'),
      rotation: Num.optional().describe('Rotation about Z in degrees'),
    })
    .refine((v) => (v.path ? 1 : 0) + (v.text !== undefined ? 1 : 0) === 1, 'give exactly one of path or text'),
  async runAsync(ctx, input) {
    const text = input.path ? await files(ctx).readText(input.path) : input.text!;
    let parsed;
    try {
      parsed = parseDxf(text);
    } catch (err) {
      if (err instanceof DxfError) throw new ApiError('invalid_input', err.message);
      throw err;
    }
    const fileName = input.path?.split(/[\\/]/).pop()?.replace(/\.dxf$/i, '');
    const name = input.name?.trim() || fileName || ctx.doc.nextNameFor('Drawing');
    const units = input.units ?? parsed.units ?? 'mm';
    const ref: ReferenceDrawing = {
      id: newId(),
      name,
      kind: 'drawing',
      units,
      position: cleanVec(vec(input.position ?? [0, 0, 0])),
      rotation: cleanNumber(input.rotation ?? 0),
      visible: true,
      hiddenLayers: parsed.hiddenLayers,
    };
    ctx.doc.transact(() => ctx.doc.addReference(ref, parsed.geometry), `Import ${name}`);
    const size = drawingSize(parsed.geometry, units);
    const counts = new Map<number, number>();
    for (const p of parsed.geometry.paths) counts.set(p.layer, (counts.get(p.layer) ?? 0) + 1);
    const layers = parsed.geometry.layers.map((l, i) => `${l}: ${counts.get(i) ?? 0}${parsed.hiddenLayers.includes(l) ? ' (hidden)' : ''}`);
    const hint = input.units || parsed.units ? undefined : unitsHint(size);
    return {
      id: ref.id,
      name,
      units,
      units_from: input.units ? 'input' : parsed.units ? 'file' : 'assumed (the file does not say)',
      size_mm: size,
      layers: layers.length > 40 ? [...layers.slice(0, 40), `…and ${layers.length - 40} more`] : layers,
      ...(Object.keys(parsed.skipped).length ? { skipped: parsed.skipped } : {}),
      ...(hint ? { hint } : {}),
    };
  },
});

const getReference = def({
  name: 'get_reference',
  kind: 'read',
  description:
    'Read the lines of a reference drawing in world mm (units, position and rotation applied), to build on a plan, e.g. walls along its outlines. One line per path: "Walls: closed x,y x,y …", "Doors: arc centre x,y r R from x,y to x,y", "circle centre x,y ø D". Filter with layers; limit caps the paths (default 200).',
  input: z.strictObject({
    reference: Id.describe('Reference drawing id or exact name'),
    layers: z.array(z.string()).optional().describe('Only these layers (default: the visible ones)'),
    limit: z.int().min(1).max(2000).optional(),
  }),
  run(ctx, input) {
    const r = ctx.reference(input.reference);
    const g = ctx.doc.geometryOf(r.id);
    if (!g) throw new ApiError('not_found', `"${r.name}" has no geometry`);
    const m = referenceMatrix(r);
    const k = DRAWING_UNIT_MM[r.units];
    const w = ([x, y]: number[]) => {
      const p = new THREE.Vector3(x, y, 0).applyMatrix4(m);
      return `${r2(p.x)},${r2(p.y)}`;
    };
    const want = input.layers ? new Set(input.layers.map((l) => l.toLowerCase())) : null;
    const hidden = new Set(r.hiddenLayers);
    const counts = new Map<number, number>();
    for (const p of g.paths) counts.set(p.layer, (counts.get(p.layer) ?? 0) + 1);
    const limit = input.limit ?? 200;
    const lines: string[] = [];
    let total = 0;
    for (const p of g.paths) {
      const layer = g.layers[p.layer];
      if (want ? !want.has(layer.toLowerCase()) : hidden.has(layer)) continue;
      total++;
      if (lines.length >= limit) continue;
      if (p.center) {
        const radius = Math.hypot(p.points[0][0] - p.center[0], p.points[0][1] - p.center[1]) * k;
        lines.push(
          p.closed
            ? `${layer}: circle centre ${w(p.center)} ø${r2(radius * 2)}`
            : `${layer}: arc centre ${w(p.center)} r ${r2(radius)} from ${w(p.points[0])} to ${w(p.points[p.points.length - 1])}`,
        );
      } else {
        lines.push(`${layer}: ${p.closed ? 'closed ' : ''}${p.points.map(w).join(' ')}`);
      }
    }
    return {
      reference: referenceLine(r, ctx.doc),
      layers: g.layers.map((l, i) => `${l}: ${counts.get(i) ?? 0}${hidden.has(l) ? ' (hidden)' : ''}`),
      paths: lines,
      ...(total > lines.length ? { truncated: `${total - lines.length} more paths; filter by layers or raise limit` } : {}),
    };
  },
});

const updateReference = def({
  name: 'update_reference',
  kind: 'write',
  description:
    'Change a reference drawing: name, units (rescales it), position, rotation (about Z, degrees), visible, or switch layers off/on by name ("*" = all). Reference drawings are listed in get_scene.',
  input: z.strictObject({
    reference: Id.describe('Reference drawing id or exact name'),
    name: z.string().min(1).max(100).optional(),
    units: DrawingUnitSchema.optional(),
    position: Vec3.optional(),
    rotation: Num.optional(),
    visible: z.boolean().optional(),
    hide_layers: z.array(z.string()).optional(),
    show_layers: z.array(z.string()).optional().describe('Applied after hide_layers'),
  }),
  run(ctx, input) {
    const r = ctx.reference(input.reference);
    const layers = ctx.doc.geometryOf(r.id)?.layers ?? [];
    const expand = (names: string[]) => {
      if (names.includes('*')) return layers;
      const lower = new Map(layers.map((l) => [l.toLowerCase(), l]));
      return names.map((n) => {
        const l = lower.get(n.toLowerCase());
        if (!l) throw new ApiError('not_found', `"${r.name}" has no layer "${n}"`, `Layers: ${layers.slice(0, 40).join(', ')}`);
        return l;
      });
    };
    const hide = input.hide_layers ? expand(input.hide_layers) : [];
    const show = new Set(input.show_layers ? expand(input.show_layers) : []);
    ctx.doc.updateReference(r.id, (x) => {
      if (input.name) x.name = input.name.trim();
      if (input.units) x.units = input.units;
      if (input.position) x.position = cleanVec(vec(input.position));
      if (input.rotation !== undefined) x.rotation = cleanNumber(input.rotation);
      if (input.visible !== undefined) x.visible = input.visible;
      if (hide.length || show.size) x.hiddenLayers = [...new Set([...x.hiddenLayers, ...hide])].filter((l) => !show.has(l));
    });
    return { ids: [], reference: referenceLine(ctx.doc.getReference(r.id)!, ctx.doc) };
  },
});

const deleteReference = def({
  name: 'delete_reference',
  kind: 'write',
  description: 'Remove a reference drawing (the model is not affected).',
  input: z.strictObject({ reference: Id.describe('Reference drawing id or exact name') }),
  run(ctx, input) {
    const r = ctx.reference(input.reference);
    ctx.doc.removeReference(r.id);
    return { ids: [], removed: `${r.id} "${r.name}"` };
  },
});

/** All operations except apply_operations (which ModelerApi provides, as it needs the executor). */
export const OPERATIONS: OperationDef<any>[] = [
  getScene,
  getEntities,
  getSelection,
  measure,
  checkPrint,
  getCutList,
  getQuantities,
  addBox,
  addCylinder,
  addShape,
  updateEntity,
  deleteEntities,
  setHole,
  setVisible,
  setColor,
  move,
  rotate,
  placeOnGround,
  placeOnPlate,
  duplicate,
  mirror,
  place,
  align,
  distribute,
  group,
  ungroup,
  renameGroup,
  setSelection,
  setWorkspace,
  setPrinter,
  undo,
  redo,
  renderViews,
  openFile,
  saveFile,
  exportStlOp,
  importDxf,
  getReference,
  updateReference,
  deleteReference,
];
