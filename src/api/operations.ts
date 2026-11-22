import * as THREE from 'three';
import { z } from 'zod';
import { buildCutList } from '../model/cutlist';
import { copyEntities } from '../model/editing';
import { newId } from '../model/Document';
import { anchorFor, AXIS_VECTORS, dimensionGeometry, MAX_ANNOTATION_TEXT } from '../model/annotations';
import { DxfError, parseDxf } from '../model/dxf';
import { exportStl, parseDocumentFile } from '../model/io';
import { exportGlb } from '../model/gltf';
import { DRAWING_UNITS, DRAWING_UNIT_MM, localBounds, referenceMatrix } from '../model/references';
import { cleanNumber, cleanVec, DEG, mirrorEntity, rotateEntityAbout, worldBounds } from '../model/geometry';
import { commonParentGroup, groupChain, groupMembers } from '../model/groups';
import { footprintMm2, fusedVolume, solidVolumes } from '../model/quantities';
import { maxEdgeRadius } from '../model/shapes';
import { buildWorldGeometries, cuttersFor } from '../model/csg';
import { manifoldReady, sectionAt } from '../model/manifold';
import type { Anchor, Annotation, BoxEntity, CylinderEntity, DrawingGeometry, DrawingUnit, Entity, ExtrusionEntity, Group, ReferenceDrawing, RevolveEntity, SphereEntity, TubeEntity, Vec3 as V3 } from '../model/types';
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
import { annotationLine, ApiError, boundsJson, boundsOf, entityLine, entitySummary, groupLine, OperationContext, r2, referenceLine, type FileHost, type ViewName } from './core';
import { Axis, Color, Id, NonNegative, Num, Pattern, Positive, Rotation, Size3, Target, Vec2, Vec3, type PatternInput } from './schemas';

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
    'Overview of the model: workspace, printer, overall bounds, the parts, annotations (notes, dimensions) and any reference drawings (imported plans to build on; not parts). detail "outline" lists each top-level group as one line (best first call on big models), "compact" (default) one line per part, "full" complete JSON. Lines read: id "name" shape size at x,y,z [hole] in "group".',
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
    if (doc.annotations.length) scene.annotations = doc.annotations.map((a) => annotationLine(a, doc));
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
    // Overlapping parts count once: this is the plastic the printer lays down.
    const total = fusedVolume(solids, doc.entities, doc.groups) / 1000;
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
    const vols = solidVolumes(solids, ctx.doc.entities, ctx.doc.groups);
    const rows = solids.map((e) => ({ id: e.id, name: e.name, footprint_m2: r2(footprintMm2(e) / 1e6), volume_m3: Math.round((vols.get(e.id) ?? 0) / 1e6) / 1000 }));
    // The total fuses overlapping parts (a wall through a slab counts once); rows are per part.
    return { rows, total_volume_m3: Math.round(fusedVolume(solids, ctx.doc.entities, ctx.doc.groups) / 1e6) / 1000 };
  },
});

// ---- create -------------------------------------------------------------------------------

const addBox = def({
  name: 'add_box',
  kind: 'write',
  description:
    'Add a box (board, block, panel). position is its min corner (default origin); size is [x, y, z] in mm. edge_radius rounds every edge and corner (printed enclosures, soft blocks). Example: { "name": "Side", "position": [0, 0, 18], "size": [18, 300, 700] }.',
  input: z.strictObject({ ...AddCommon, size: Size3, edge_radius: NonNegative.optional().describe('Round all edges, mm (< half the smallest side)') }),
  run(ctx, input) {
    const e: BoxEntity = {
      ...baseEntity(ctx, 'box', input),
      kind: 'box',
      size: input.size.map(cleanNumber) as V3,
      ...(input.edge_radius ? { edgeRadius: edgeRadiusFor(input.size, input.edge_radius) } : {}),
    };
    ctx.doc.add(e);
    return { ids: [e.id] };
  },
});

const addCylinder = def({
  name: 'add_cylinder',
  kind: 'write',
  description:
    'Add a cylinder (rod, dowel, round hole), or a cone/frustum with a different top: radius_top or diameter_top (0 = pointed; larger than the base for a countersink hole). position is the centre of its base; it extends along axis (default z) by height. Give radius or diameter. For a screw hole: hole: true. Example M3 hole through a 10 mm plate: { "position": [20, 20, -1], "diameter": 3.4, "height": 12, "hole": true }.',
  input: z
    .strictObject({
      ...AddCommon,
      radius: Positive.optional(),
      diameter: Positive.optional(),
      height: Positive,
      radius_top: NonNegative.optional(),
      diameter_top: NonNegative.optional(),
      axis: Axis.optional(),
      segments: z.int().min(3).max(256).optional().describe('Smoothness; default from workspace'),
    })
    .refine((v) => (v.radius ? 1 : 0) + (v.diameter ? 1 : 0) === 1, 'give exactly one of radius or diameter')
    .refine((v) => v.radius_top === undefined || v.diameter_top === undefined, 'give radius_top or diameter_top, not both'),
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
    setTopRadius(e, input.radius_top ?? (input.diameter_top !== undefined ? input.diameter_top / 2 : undefined));
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

// ---- round and smooth kinds -------------------------------------------------------------------

const AXIS_ROTATION: Record<string, V3> = { x: [0, 90, 0], y: [-90, 0, 0], z: [0, 0, 0] };

function edgeRadiusFor(size: number[], r: number): number {
  const max = maxEdgeRadius(size);
  if (r > max) throw new ApiError('invalid_input', `edge_radius ${r} is too large for a ${size.join('×')} box`, `At most ${r2(max)} (just under half the smallest side).`, 'edge_radius');
  return cleanNumber(r);
}

/** A top radius makes a cone/frustum; equal to the base, it is a plain cylinder again. */
function setTopRadius(e: CylinderEntity, top: number | undefined) {
  if (top === undefined) return;
  if (Math.abs(top - e.radius) < 1e-9) delete e.radiusTop;
  else e.radiusTop = cleanNumber(top);
}

const addSphere = def({
  name: 'add_sphere',
  kind: 'write',
  description:
    'Add a sphere or ellipsoid. position is its CENTRE. Give radius or diameter (sphere), or radii [x, y, z] (ellipsoid: egg, head, body). Use with holes for domes and half-spheres.',
  input: z
    .strictObject({
      ...AddCommon,
      radius: Positive.optional(),
      diameter: Positive.optional(),
      radii: Size3.optional().describe('Ellipsoid radii [x, y, z], mm'),
      segments: z.int().min(8).max(256).optional().describe('Smoothness (default 48)'),
    })
    .refine((v) => (v.radius ? 1 : 0) + (v.diameter ? 1 : 0) + (v.radii ? 1 : 0) === 1, 'give exactly one of radius, diameter or radii'),
  run(ctx, input) {
    const r = input.radius ?? (input.diameter ? input.diameter / 2 : undefined);
    const e: SphereEntity = {
      ...baseEntity(ctx, 'sphere', input),
      kind: 'sphere',
      radii: (r !== undefined ? [r, r, r] : input.radii!).map(cleanNumber) as V3,
      segments: input.segments ?? 48,
    };
    ctx.doc.add(e);
    return { ids: [e.id] };
  },
});

const addRevolve = def({
  name: 'add_revolve',
  kind: 'write',
  description:
    'Add a solid of revolution (vase, bottle, knob, turned leg, bowl): profile points [radius, z] (radius ≥ 0) outline one side of it; it spins 360° around an axis through position (default z). Points with radius 0 lie on the axis and close it there. Example cup: [[0,0],[40,0],[45,90],[42,90],[37,4],[0,4]].',
  input: z.strictObject({
    ...AddCommon,
    profile: z.array(Vec2).min(3).max(500).describe('[radius, z] points of a closed outline, mm'),
    axis: Axis.optional(),
    segments: z.int().min(3).max(256).optional().describe('Smoothness around the axis (default 64)'),
  }),
  run(ctx, input) {
    const base = baseEntity(ctx, 'revolve', input);
    if (!input.rotation) base.rotation = AXIS_ROTATION[input.axis ?? 'z'];
    const e: RevolveEntity = {
      ...base,
      kind: 'revolve',
      profile: input.profile.map(([r, z]) => [cleanNumber(r), cleanNumber(z)]),
      segments: input.segments ?? 64,
    };
    ctx.doc.add(e);
    return { ids: [e.id] };
  },
});

/** World path points → position (the first point) and local points. */
function tubePath(points: number[][]): { position: V3; path: V3[] } {
  const [x0, y0, z0] = points[0];
  return { position: [cleanNumber(x0), cleanNumber(y0), cleanNumber(z0)], path: points.map(([x, y, z]) => [cleanNumber(x - x0), cleanNumber(y - y0), cleanNumber(z - z0)]) };
}

const addTube = def({
  name: 'add_tube',
  kind: 'write',
  description:
    'Add a round tube along a path of world points (tail, neck, handle, cable, pipe, rail): one part instead of many cylinders. smooth (default true) curves through the points; false makes straight segments. Give radius/diameter for a constant tube, or radii (one per point) to taper. Ends are flat.',
  input: z
    .strictObject({
      name: AddCommon.name,
      color: AddCommon.color,
      hole: AddCommon.hole,
      group: AddCommon.group,
      path: z.array(Vec3).min(2).max(500).describe('World points the centre line passes through, mm'),
      radius: Positive.optional(),
      diameter: Positive.optional(),
      radii: z.array(Positive).min(2).max(500).optional().describe('A radius per path point'),
      smooth: z.boolean().optional(),
      segments: z.int().min(3).max(128).optional().describe('Smoothness around the tube (default 24)'),
    })
    .refine((v) => (v.radius ? 1 : 0) + (v.diameter ? 1 : 0) + (v.radii ? 1 : 0) === 1, 'give exactly one of radius, diameter or radii'),
  run(ctx, input) {
    if (input.radii && input.radii.length !== input.path.length) {
      throw new ApiError('invalid_input', `radii has ${input.radii.length} values for ${input.path.length} path points`, 'Give one radius per point.', 'radii');
    }
    const { position, path } = tubePath(input.path);
    const radius = input.radius ?? (input.diameter ? input.diameter / 2 : Math.max(...input.radii!));
    const e: TubeEntity = {
      ...baseEntity(ctx, 'tube', { ...input, position }),
      kind: 'tube',
      path,
      radius: cleanNumber(radius),
      ...(input.radii ? { radii: input.radii.map(cleanNumber) } : {}),
      smooth: input.smooth ?? true,
      segments: input.segments ?? 24,
    };
    ctx.doc.add(e);
    return { ids: [e.id] };
  },
});

// ---- split for printing ---------------------------------------------------------------------

const splitForPrint = def({
  name: 'split_for_print',
  kind: 'write',
  description:
    'Cut a part or assembly into two printable pieces along a plane across axis (default z) at a coordinate (default: the middle). The lower piece gets pegs and the upper one matching holes with clearance, so they align and glue. Each piece is a new group; holes that cut the original are copied into each piece; the upper piece moves gap mm away. The original is replaced (one undo brings it back). Default pegs: as many as fit, up to 2.',
  input: z.strictObject({
    target: Target,
    axis: Axis.optional(),
    at: Num.optional().describe('Where to cut, mm along axis'),
    gap: NonNegative.optional().describe('How far to move the upper piece apart (default 10)'),
    pegs: z.int().min(0).max(8).optional().describe('Number of pegs (0 = none)'),
    peg_diameter: Positive.optional().describe('Default: 5 mm, smaller for small cut faces'),
    peg_depth: Positive.optional().describe('How far a peg goes into each piece (default 1.2 × diameter)'),
    clearance: NonNegative.optional().describe('Extra radius of the peg holes (default 0.2 mm, a sliding fit)'),
    name: z.string().min(1).max(80).optional().describe('Base name of the pieces'),
  }),
  run(ctx, input) {
    const { doc } = ctx;
    const targets = ctx.resolve(input.target);
    const solids = targets.filter((e) => !e.hole && e.visible);
    if (!solids.length) throw new ApiError('not_found', 'The target has no visible solid parts to split');
    const axis = input.axis ?? 'z';
    const i = AXIS_INDEX[axis];
    const box = boundsOf(solids);
    const lo = box.min.getComponent(i);
    const hi = box.max.getComponent(i);
    const at = cleanNumber(input.at ?? (lo + hi) / 2);
    if (!(at > lo + 0.5 && at < hi - 0.5)) {
      throw new ApiError('invalid_input', `at ${at} is not inside the target (${axis} ${r2(lo)} … ${r2(hi)})`, 'Cut somewhere between them, at least 0.5 mm from either end.', 'at');
    }
    // Holes that cut the original are copied into both pieces.
    const allHoles = doc.entities.filter((e) => e.hole && e.visible);
    const affecting = [...new Set(solids.flatMap((s) => cuttersFor(s, allHoles, doc.groups)))];

    // Pegs: placed inside the cut face, clear of its edges.
    const clearance = input.clearance ?? 0.2;
    const warnings: string[] = [];
    let pegPoints: THREE.Vector3[] = [];
    let diameter = input.peg_diameter ?? 5;
    const wanted = input.pegs ?? 2;
    if (wanted > 0) {
      if (manifoldReady()) {
        const geoms = buildWorldGeometries(solids, doc.entities, doc.groups).map((p) => p.geometry);
        const probe = sectionAt(geoms, axis, at, 0, 0);
        if (input.peg_diameter === undefined) diameter = Math.min(5, Math.max(2, Math.min(...probe.size) * 0.25));
        const wall = 1.2;
        // Thin walls: try smaller pegs (down to 2 mm) before giving up, unless a size was asked for.
        const sizes = input.peg_diameter === undefined ? [...new Set([diameter, 4, 3, 2].filter((d) => d <= diameter))] : [diameter];
        for (const d of sizes) {
          const points = sectionAt(geoms, axis, at, d / 2 + clearance + wall, wanted).points;
          if (points.length > pegPoints.length) {
            pegPoints = points;
            diameter = d;
          }
          if (points.length >= wanted) break;
        }
        geoms.forEach((g) => g.dispose());
        if (pegPoints.length < wanted) warnings.push(pegPoints.length ? `Only ${pegPoints.length} of ${wanted} pegs fit in the cut face.` : 'The cut face is too small for pegs; glue the pieces flat.');
      } else {
        pegPoints = [box.getCenter(new THREE.Vector3()).setComponent(i, at)];
        warnings.push('The geometry engine is not loaded: one peg was placed at the centre; check it is inside the part.');
      }
    }
    // A peg may go no deeper than either piece is thick.
    let depth = input.peg_depth ?? diameter * 1.2;
    const room = Math.min(at - lo, hi - at) - clearance - 0.8;
    if (pegPoints.length && depth > room) {
      depth = Math.max(1, room);
      warnings.push(`Pegs shortened to ${r2(depth)} mm deep to fit the pieces.`);
    }

    const baseName = input.name ?? ('group' in input.target ? ctx.group(input.target.group).name : solids.length === 1 ? solids[0].name : 'Part');
    const pieces = [
      { name: `${baseName} 1`, keepLow: true },
      { name: `${baseName} 2`, keepLow: false },
    ];
    // Snug: the cutter only has to cover this piece's own geometry.
    const margin = 1;
    const created: Entity[] = [];
    const newGroups: Group[] = [];
    for (const piece of pieces) {
      const groupId = newId();
      const cutId = newId();
      newGroups.push({ id: groupId, name: piece.name }, { id: cutId, name: `${piece.name} body`, parentId: groupId });
      const members: Entity[] = [];
      for (const e of [...solids, ...affecting]) {
        const c = structuredClone(e);
        c.id = newId();
        c.groupId = cutId;
        if (c.hole) c.holeScope = 'group';
        members.push(c);
      }
      // Removes the other half: a box hole that only cuts this piece's body.
      const size = box.getSize(new THREE.Vector3()).addScalar(2 * margin);
      const min = box.min.clone().subScalar(margin);
      if (piece.keepLow) {
        min.setComponent(i, at);
        size.setComponent(i, hi + margin - at);
      } else {
        size.setComponent(i, at - (lo - margin));
      }
      members.push({ ...baseEntity(ctx, 'box', { name: `Cut ${piece.keepLow ? 'above' : 'below'} ${axis} ${at}`, position: min.toArray() as V3, hole: true }), kind: 'box', size: cleanVec(size), holeScope: 'group', quiet: true, groupId: cutId } as BoxEntity);
      pegPoints.forEach((p, k) => {
        const base = p.clone().setComponent(i, piece.keepLow ? at - depth : at - 0.5);
        const radius = piece.keepLow ? diameter / 2 : diameter / 2 + clearance;
        const height = piece.keepLow ? 2 * depth : depth + clearance + 0.5;
        members.push({
          ...baseEntity(ctx, 'cylinder', { name: piece.keepLow ? `Peg ${k + 1}` : `Peg hole ${k + 1}`, position: base.toArray() as V3, rotation: AXIS_ROTATION[axis], color: solids[0].color, hole: !piece.keepLow }),
          kind: 'cylinder',
          radius: cleanNumber(radius),
          height: cleanNumber(height),
          segments: 48,
          // The peg sits beside the body (not inside it), so the body's cut box can't remove it.
          groupId: piece.keepLow ? groupId : cutId,
          ...(piece.keepLow ? {} : { holeScope: 'group' as const }),
        } as CylinderEntity);
      });
      if (!piece.keepLow) for (const m of members) m.position = cleanVec(vec(m.position).setComponent(i, m.position[i] + (input.gap ?? 10)));
      created.push(...members);
    }
    doc.remove(targets.map((e) => e.id));
    for (const e of created) doc.add(e);
    doc.setGroups([...doc.groups, ...newGroups]);
    return {
      ids: created.map((e) => e.id),
      pieces: pieces.map((p) => p.name),
      pegs: pegPoints.length,
      ...(pegPoints.length ? { peg: { diameter: r2(diameter), depth: r2(depth), hole_diameter: r2(diameter + 2 * clearance) } } : {}),
      ...(warnings.length ? { notes: warnings } : {}),
    };
  },
});

// ---- edit -----------------------------------------------------------------------------------

const updateEntity = def({
  name: 'update_entity',
  kind: 'write',
  description:
    'Change one part\'s parameters. Only keys that fit the part apply: size, edge_radius (box); radius or diameter (cylinder, sphere, tube); radius_top or diameter_top (cylinder → cone); height (cylinder, shape); radii ([x,y,z] for a sphere, one per point for a tube); points (shape); profile (revolve); path (tube, world points), smooth (tube); segments (round kinds). Example: { "id": "k3f9a2", "set": { "size": [18, 300, 650] } }.',
  input: z.strictObject({
    id: Id,
    set: z
      .strictObject({
        name: z.string().min(1).optional(),
        position: Vec3.optional(),
        rotation: Rotation.optional(),
        size: Size3.optional(),
        edge_radius: NonNegative.optional(),
        radius: Positive.optional(),
        diameter: Positive.optional(),
        radius_top: NonNegative.optional(),
        diameter_top: NonNegative.optional(),
        height: Positive.optional(),
        radii: z.array(Positive).min(2).max(500).optional(),
        segments: z.int().min(3).max(256).optional(),
        points: z.array(Vec2).min(3).max(500).optional(),
        profile: z.array(Vec2).min(3).max(500).optional(),
        path: z.array(Vec3).min(2).max(500).optional(),
        smooth: z.boolean().optional(),
        color: Color.optional(),
        hole: z.boolean().optional(),
        visible: z.boolean().optional(),
      })
      .refine((v) => Object.keys(v).length > 0, 'set at least one field'),
  }),
  run(ctx, input) {
    const e = ctx.entity(input.id);
    const s = input.set;
    const KINDS: Record<string, Entity['kind'][]> = {
      size: ['box'],
      edge_radius: ['box'],
      radius: ['cylinder', 'sphere', 'tube'],
      diameter: ['cylinder', 'sphere', 'tube'],
      radius_top: ['cylinder'],
      diameter_top: ['cylinder'],
      height: ['cylinder', 'extrusion'],
      radii: ['sphere', 'tube'],
      segments: ['cylinder', 'sphere', 'revolve', 'tube'],
      points: ['extrusion'],
      profile: ['revolve'],
      path: ['tube'],
      smooth: ['tube'],
    };
    for (const [key, kinds] of Object.entries(KINDS)) {
      if ((s as Record<string, unknown>)[key] !== undefined && !kinds.includes(e.kind)) {
        const plural: Record<Entity['kind'], string> = { box: 'boxes', cylinder: 'cylinders', extrusion: 'shapes', sphere: 'spheres', revolve: 'revolves', tube: 'tubes' };
        const names = kinds.map((k) => plural[k]);
        const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
        throw new ApiError('invalid_input', `"${e.name}" is a ${e.kind}; ${key} only applies to ${list}`, undefined, `set.${key}`);
      }
    }
    if (e.kind === 'sphere' && s.radii && s.radii.length !== 3) throw new ApiError('invalid_input', 'A sphere\'s radii are [x, y, z]', undefined, 'set.radii');
    const pathLength = s.path?.length ?? (e.kind === 'tube' ? e.path.length : 0);
    if (e.kind === 'tube' && s.radii && s.radii.length !== pathLength) {
      throw new ApiError('invalid_input', `radii has ${s.radii.length} values for ${pathLength} path points`, undefined, 'set.radii');
    }
    if (e.kind === 'tube' && s.path && !s.radii && e.radii && e.radii.length !== s.path.length) {
      throw new ApiError('invalid_input', 'The new path has a different number of points than radii', 'Give radii too, or radius for a constant tube.', 'set.path');
    }
    ctx.doc.update(e.id, (x) => {
      if (s.name) x.name = s.name.trim();
      if (s.position) x.position = s.position.map(cleanNumber) as V3;
      if (s.rotation) x.rotation = s.rotation.map(cleanNumber) as V3;
      if (s.color) x.color = s.color;
      if (s.hole !== undefined) x.hole = s.hole;
      if (s.visible !== undefined) x.visible = s.visible;
      const r = s.radius ?? (s.diameter !== undefined ? s.diameter / 2 : undefined);
      switch (x.kind) {
        case 'box':
          if (s.size) x.size = s.size.map(cleanNumber) as V3;
          if (s.edge_radius !== undefined) {
            if (s.edge_radius === 0) delete x.edgeRadius;
            else x.edgeRadius = edgeRadiusFor(x.size, s.edge_radius);
          } else if (x.edgeRadius && x.edgeRadius > maxEdgeRadius(x.size)) {
            x.edgeRadius = cleanNumber(maxEdgeRadius(x.size)); // keep it valid when the box shrinks
          }
          break;
        case 'cylinder': {
          const top = x.radiusTop;
          if (r !== undefined) x.radius = cleanNumber(r);
          if (s.height) x.height = cleanNumber(s.height);
          if (s.segments) x.segments = s.segments;
          const newTop = s.radius_top ?? (s.diameter_top !== undefined ? s.diameter_top / 2 : undefined);
          if (newTop !== undefined) setTopRadius(x, newTop);
          else if (top !== undefined) setTopRadius(x, top);
          break;
        }
        case 'sphere':
          if (r !== undefined) x.radii = [cleanNumber(r), cleanNumber(r), cleanNumber(r)];
          if (s.radii) x.radii = s.radii.map(cleanNumber) as V3;
          if (s.segments) x.segments = Math.max(8, s.segments);
          break;
        case 'revolve':
          if (s.profile) x.profile = s.profile.map(([a, b]) => [cleanNumber(a), cleanNumber(b)]);
          if (s.segments) x.segments = s.segments;
          break;
        case 'tube':
          if (s.path) {
            const { position, path } = tubePath(s.path);
            x.position = position;
            x.rotation = [0, 0, 0];
            x.path = path;
          }
          if (r !== undefined) {
            x.radius = cleanNumber(r);
            delete x.radii;
          }
          if (s.radii) {
            x.radii = s.radii.map(cleanNumber);
            x.radius = cleanNumber(Math.max(...s.radii));
          }
          if (s.smooth !== undefined) x.smooth = s.smooth;
          if (s.segments) x.segments = Math.min(128, s.segments);
          break;
        case 'extrusion':
          if (s.height) x.height = cleanNumber(s.height);
          if (s.points) x.points = s.points.map(([a, b]) => [cleanNumber(a), cleanNumber(b)]);
          break;
      }
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
  description:
    'Make the targeted parts holes (subtracted from overlapping solids) or solids again. only_own_group: true makes a hole cut only parts in its own group (e.g. a pocket in one part of an assembly that must not cut its neighbours); false: it cuts everything it overlaps (the default).',
  input: z.strictObject({ target: Target, hole: z.boolean(), only_own_group: z.boolean().optional() }),
  run(ctx, input) {
    const parts = ctx.resolve(input.target);
    if (input.only_own_group && input.hole) {
      const loose = parts.find((e) => !e.groupId);
      if (loose) throw new ApiError('invalid_input', `"${loose.name}" is not in a group, so "its own group" means nothing`, 'Group it with the parts it should cut first.', 'only_own_group');
    }
    for (const e of parts) {
      ctx.doc.update(e.id, (x) => {
        x.hole = input.hole;
        if (!input.hole || input.only_own_group === false) delete x.holeScope;
        else if (input.only_own_group) x.holeScope = 'group';
      });
    }
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
  description:
    'Render PNG images of the model from standard views to check shape and alignment visually. explode (0–1) renders it pulled apart (how parts fit together) without changing the user\'s view. Use sparingly: images cost tokens.',
  input: z.strictObject({
    views: z.array(z.enum(['iso', 'top', 'front', 'right', 'left', 'back', 'bottom'])).min(1).max(4).optional(),
    size: z.int().min(256).max(1024).optional(),
    explode: z.number().min(0).max(1).optional(),
    explode_axis: Axis.optional(),
  }),
  async runAsync(ctx, input) {
    if (!ctx.host?.renderViews) throw new ApiError('unsupported', 'This host cannot render images', 'Open the model in the app (live bridge) to get images.');
    const opts = input.explode !== undefined ? { explode: input.explode, axis: input.explode_axis } : undefined;
    return { images: await ctx.host.renderViews((input.views ?? ['iso']) as ViewName[], input.size ?? 768, opts) };
  },
});

const explodeView = def({
  name: 'explode_view',
  kind: 'host',
  description:
    'Show the model pulled apart in the app (an exploded view: how the parts fit together). factor 0 = assembled, 1 = fully apart; axis limits it to one direction (e.g. z lifts parts apart vertically). Top-level groups move as units. View only: the model and undo history are untouched.',
  input: z.strictObject({ factor: z.number().min(0).max(1), axis: Axis.optional() }),
  async runAsync(ctx, input) {
    if (!ctx.host?.setExplode) throw new ApiError('unsupported', 'Only the app has an exploded view', 'Use render_views { explode } in the app, or ask the user to open it and click Connect AI.');
    ctx.host.setExplode(input.factor, input.axis ?? null);
    return { factor: input.factor, axis: input.axis ?? 'all' };
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
    const data = exportStl(targets, ctx.doc.entities, ctx.doc.groups);
    if (!data) throw new ApiError('not_found', 'Nothing to export', 'Only visible solid parts (not holes) are exported.');
    const shown = await host.write(input.path, new Uint8Array(data));
    const solids = targets.filter((e) => e.visible && !e.hole).length;
    return { path: shown, solids, triangles: (data.byteLength - 84) / 50, bytes: data.byteLength };
  },
});

const exportModel = def({
  name: 'export_model',
  kind: 'host',
  description:
    'Write the model for other 3D programs: GLB (binary glTF) for SketchUp (File > Import), Blender, Twinmotion, Unreal, web/AR. Visible solids with holes cut, one named node per part, groups as nested nodes, one material per colour; converted to metres, Y-up. Target limits it to some parts; default: everything visible.',
  input: z.strictObject({
    path: FilePath.describe('Must end in .glb'),
    format: z.enum(['glb']).optional().describe('Default: from the file extension'),
    target: Target.optional(),
  }),
  async runAsync(ctx, input) {
    const host = files(ctx);
    if (!/\.glb$/i.test(input.path)) throw new ApiError('invalid_input', 'The file name must end in .glb', 'GLB is the only export_model format so far; use export_stl for 3D printing.', 'path');
    const targets = input.target ? ctx.resolve(input.target) : ctx.doc.entities;
    const name = input.path.replace(/^.*[\\/]/, '').replace(/\.glb$/i, '');
    const result = exportGlb(targets, ctx.doc.entities, ctx.doc.groups, { name });
    if (!result) throw new ApiError('not_found', 'Nothing to export', 'Only visible solid parts (not holes) are exported.');
    const shown = await host.write(input.path, result.data);
    return { path: shown, format: 'glb', parts: result.parts, groups: result.groups, materials: result.materials, triangles: result.triangles, bytes: result.data.byteLength };
  },
});

// ---- annotations (ADR 0015) ----------------------------------------------------------------

const PointRef = z
  .union([
    Vec3,
    z.strictObject({
      part: Id.describe('Part id or exact name'),
      at: z.tuple([Num, Num, Num]).optional().describe("Fractions of the part's own box: [0,0,0] min corner, [1,1,1] max corner, [0.5,0.5,1] top centre (default)"),
    }),
  ])
  .describe('A world point [x, y, z] (mm), or a point on a part { part, at }. Points on parts follow the part when it moves or is resized.');
type PointRefInput = z.infer<typeof PointRef>;

const AxisName = z.enum(['x', 'y', 'z']);
const Side = z.enum(['+x', '-x', '+y', '-y', '+z', '-z']).describe('Which way the dimension line sits from the measured points');
const AnnotationText = z.string().trim().min(1).max(MAX_ANNOTATION_TEXT);

function anchorOf(ctx: OperationContext, p: PointRefInput): Anchor {
  if (Array.isArray(p)) return { point: p.map(cleanNumber) as V3 };
  const e = ctx.part(p.part);
  return { entity: e.id, at: (p.at ?? [0.5, 0.5, 1]).map(cleanNumber) as V3 };
}

const sideVector = (side: string) => {
  const v = AXIS_VECTORS[side[1] as 'x' | 'y' | 'z'].clone();
  return side[0] === '-' ? v.negate() : v;
};

/**
 * Offset of a dimension line: `distance` (default: 15% of the length, 10–500 mm) towards
 * `side`, or away from the centre of the parts it measures.
 */
function dimensionOffset(dir: THREE.Vector3, length: number, mid: THREE.Vector3, center: THREE.Vector3 | null, distance?: number, side?: string): V3 {
  const dist = distance ?? Math.min(500, Math.max(10, Math.round(length * 0.15)));
  let v: THREE.Vector3 | null = null;
  if (side) {
    v = sideVector(side);
    v.addScaledVector(dir, -v.dot(dir));
    if (v.lengthSq() < 1e-6) throw new ApiError('invalid_input', `side ${side} is along the dimension itself`, 'Pick a side perpendicular to what you measure.', 'side');
  } else {
    let best = -1;
    const away = center ? mid.clone().sub(center) : new THREE.Vector3();
    for (const axis of ['z', 'y', 'x'] as const) {
      const a = AXIS_VECTORS[axis];
      if (Math.abs(a.dot(dir)) > 0.1) continue;
      const score = Math.abs(away.dot(a));
      if (score > best + 1e-6) {
        best = score;
        v = a.clone().multiplyScalar(away.dot(a) < 0 ? -1 : 1);
      }
    }
    if (!v || best < 1e-6) v = Math.abs(dir.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, -1, 0);
    v.addScaledVector(dir, -v.dot(dir));
    if (v.lengthSq() < 1e-6) v = new THREE.Vector3(0, 0, 1).cross(dir);
  }
  return cleanVec(v.normalize().multiplyScalar(dist));
}

/** The part of an offset vector perpendicular to the dimension (the dimension line can't slide along itself). */
function perpendicular(v: number[], dir: THREE.Vector3): V3 {
  const o = vec(v);
  return cleanVec(o.addScaledVector(dir, -o.dot(dir)));
}

function addDimensionTo(ctx: OperationContext, from: Anchor, to: Anchor, opts: { axis?: 'x' | 'y' | 'z'; distance?: number; vector?: number[]; side?: string; text?: string }): Annotation {
  const get = (id: string) => ctx.doc.get(id);
  const probe = dimensionGeometry({ id: '', kind: 'dimension', from, to, offset: [0, 0, 0], axis: opts.axis }, get)!;
  if (probe.value < 1e-6) throw new ApiError('invalid_geometry', 'The two points are the same along what you measure', opts.axis ? `Check the ${opts.axis} coordinates.` : undefined);
  const parts = [from, to].flatMap((x) => ('entity' in x ? [ctx.doc.get(x.entity)!] : []));
  const center = parts.length ? boundsOf(parts).getCenter(new THREE.Vector3()) : null;
  const mid = probe.a.clone().add(probe.b).multiplyScalar(0.5);
  const d: Annotation = {
    id: newId(),
    kind: 'dimension',
    from,
    to,
    offset: opts.vector ? perpendicular(opts.vector, probe.dir) : dimensionOffset(probe.dir, probe.value, mid, center, opts.distance, opts.side),
    ...(opts.axis ? { axis: opts.axis } : {}),
    ...(opts.text ? { text: opts.text } : {}),
  };
  ctx.doc.addAnnotation(d);
  return d;
}

const addNote = def({
  name: 'add_note',
  kind: 'write',
  description:
    'Add a text note (annotation, not geometry), e.g. "Oak top, 18 mm" or "drill on site". It sits at `at` (a point, or { part, at } to stay attached to a part), with a leader line when label_offset moves the text away.',
  input: z.strictObject({
    text: AnnotationText,
    at: PointRef,
    label_offset: Vec3.optional().describe('Where the text goes relative to the point, mm (default: on the point, no leader)'),
  }),
  run(ctx, input) {
    const a: Annotation = { id: newId(), kind: 'note', text: input.text, anchor: anchorOf(ctx, input.at), offset: input.label_offset ? cleanVec(vec(input.label_offset)) : [0, 0, 0] };
    ctx.doc.addAnnotation(a);
    return { ids: [], annotation: annotationLine(a, ctx.doc) };
  },
});

const addDimension = def({
  name: 'add_dimension',
  kind: 'write',
  description:
    'Add a dimension between two points (or { part, at } points, which keep it updated when parts move or resize). axis measures along x, y or z only; otherwise the true distance. The line sits offset mm (default ~15% of the length) towards side (default: away from the parts). text overrides the value; "<>" inserts it.',
  input: z.strictObject({
    from: PointRef,
    to: PointRef,
    axis: AxisName.optional(),
    offset: z.union([Num, Vec3]).optional().describe('Distance from the measured points to the dimension line, mm (or an exact offset vector)'),
    side: Side.optional(),
    text: AnnotationText.optional(),
  }),
  run(ctx, input) {
    const vector = Array.isArray(input.offset) ? input.offset : undefined;
    const distance = typeof input.offset === 'number' ? input.offset : undefined;
    const d = addDimensionTo(ctx, anchorOf(ctx, input.from), anchorOf(ctx, input.to), { axis: input.axis, distance, vector, side: input.side, text: input.text });
    return { ids: [], annotation: annotationLine(d, ctx.doc) };
  },
});

const dimensionParts = def({
  name: 'dimension_parts',
  kind: 'write',
  description:
    'Add overall dimensions of the targeted parts (e.g. a whole cabinet or group): one per axis (default x, y and z), attached to the outermost parts so they update when the model changes. Width (x) sits above, depth (y) and height (z) to the left.',
  input: z.strictObject({
    target: Target,
    axes: z.array(AxisName).min(1).max(3).optional(),
    offset: Num.optional().describe('Distance from the parts to the dimension lines, mm'),
  }),
  run(ctx, input) {
    const parts = ctx.resolve(input.target).filter((e) => !e.hole);
    if (!parts.length) throw new ApiError('not_found', 'The target has only holes', 'Dimension solid parts.');
    const box = boundsOf(parts);
    const lines: string[] = [];
    const plan = { x: { other: [box.min.y, box.max.z], side: '+z' }, y: { other: [box.min.x, box.max.z], side: '-x' }, z: { other: [box.min.x, box.min.y], side: '-x' } } as const;
    for (const axis of input.axes ?? (['x', 'y', 'z'] as const)) {
      const i = AXIS_INDEX[axis];
      if (box.max.getComponent(i) - box.min.getComponent(i) < 1e-6) continue;
      const point = (value: number) => {
        const p = new THREE.Vector3();
        const others = [0, 1, 2].filter((k) => k !== i);
        p.setComponent(i, value);
        p.setComponent(others[0], plan[axis].other[0]);
        p.setComponent(others[1], plan[axis].other[1]);
        return p;
      };
      const extreme = (pick: 'min' | 'max') =>
        parts.reduce((best, e) => {
          const v = worldBounds(e)[pick].getComponent(i);
          const bv = worldBounds(best)[pick].getComponent(i);
          return (pick === 'min' ? v < bv : v > bv) ? e : best;
        });
      const from = anchorFor(point(box.min.getComponent(i)), extreme('min'));
      const to = anchorFor(point(box.max.getComponent(i)), extreme('max'));
      lines.push(annotationLine(addDimensionTo(ctx, from, to, { axis, distance: input.offset, side: plan[axis].side }), ctx.doc));
    }
    return { ids: [], annotations: lines };
  },
});

const updateAnnotation = def({
  name: 'update_annotation',
  kind: 'write',
  description:
    'Change an annotation: text (a dimension\'s override; "" restores the measured value), a note\'s label_offset, or a dimension\'s offset distance and side.',
  input: z.strictObject({
    id: Id,
    text: z.string().max(MAX_ANNOTATION_TEXT).optional(),
    label_offset: Vec3.optional(),
    offset: Num.optional(),
    side: Side.optional(),
  }),
  run(ctx, input) {
    const a = ctx.annotation(input.id);
    if (a.kind === 'note' && (input.offset !== undefined || input.side)) throw new ApiError('invalid_input', 'Notes use label_offset', undefined, 'offset');
    if (a.kind === 'dimension' && input.label_offset) throw new ApiError('invalid_input', 'Dimensions use offset and side', undefined, 'label_offset');
    if (a.kind === 'note' && input.text !== undefined && !input.text.trim()) throw new ApiError('invalid_input', 'A note needs text', 'Use delete_annotations to remove it.', 'text');
    let offset: V3 | undefined;
    if (a.kind === 'dimension' && (input.offset !== undefined || input.side)) {
      const g = dimensionGeometry(a, (id) => ctx.doc.get(id))!;
      const current = vec(a.offset);
      const dist = input.offset ?? current.length();
      const side = input.side ? sideVector(input.side) : current.lengthSq() > 1e-9 ? current : new THREE.Vector3(0, 0, 1);
      side.addScaledVector(g.dir, -side.dot(g.dir));
      if (side.lengthSq() < 1e-9) throw new ApiError('invalid_input', `side ${input.side} is along the dimension itself`, undefined, 'side');
      offset = cleanVec(side.normalize().multiplyScalar(dist));
    }
    ctx.doc.updateAnnotation(a.id, (x) => {
      if (input.text !== undefined) {
        if (x.kind === 'note') x.text = input.text.trim();
        else if (input.text.trim()) x.text = input.text.trim();
        else delete x.text;
      }
      if (x.kind === 'note' && input.label_offset) x.offset = cleanVec(vec(input.label_offset));
      if (x.kind === 'dimension' && offset) x.offset = offset;
    });
    return { ids: [], annotation: annotationLine(ctx.doc.getAnnotation(a.id)!, ctx.doc) };
  },
});

const deleteAnnotations = def({
  name: 'delete_annotations',
  kind: 'write',
  description: 'Remove annotations by id, or all of them. Parts are not affected.',
  input: z
    .strictObject({ ids: z.array(Id).min(1).optional(), all: z.literal(true).optional() })
    .refine((v) => (v.ids ? 1 : 0) + (v.all ? 1 : 0) === 1, 'give exactly one of ids or all'),
  run(ctx, input) {
    const ids = input.all ? ctx.doc.annotations.map((a) => a.id) : input.ids!.map((id) => ctx.annotation(id).id);
    ctx.doc.removeAnnotations(ids);
    return { ids: [], removed: ids.length };
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
  addSphere,
  addRevolve,
  addTube,
  splitForPrint,
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
  explodeView,
  openFile,
  saveFile,
  exportStlOp,
  exportModel,
  addNote,
  addDimension,
  dimensionParts,
  updateAnnotation,
  deleteAnnotations,
  importDxf,
  getReference,
  updateReference,
  deleteReference,
];
