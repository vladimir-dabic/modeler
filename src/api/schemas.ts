import { z } from 'zod';

/**
 * Shared input schemas. They are the single source for runtime validation AND the JSON
 * Schema handed to AI clients (Claude tools, MCP), so descriptions here are read by AI.
 * All lengths are millimetres, angles degrees, world Z-up.
 */

export const Num = z.number().refine(Number.isFinite, 'must be a finite number');
export const Positive = z.number().positive().refine(Number.isFinite, 'must be a finite number');
export const Vec3 = z.tuple([Num, Num, Num]).describe('[x, y, z] in mm');
export const Size3 = z.tuple([Positive, Positive, Positive]).describe('[x, y, z] sizes in mm, all > 0');
export const Vec2 = z.tuple([Num, Num]);
export const Rotation = z.tuple([Num, Num, Num]).describe('Euler XYZ rotation in degrees');
export const Axis = z.enum(['x', 'y', 'z']);
export const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a hex colour like #e9c98f');
export const Id = z.string().min(1);
export const Kind = z.enum(['box', 'cylinder', 'extrusion']);

export const Target = z
  .union([
    z.strictObject({ ids: z.array(Id).min(1).describe('Entity or group ids (or "$alias" inside apply_operations)') }),
    z.strictObject({ selection: z.literal(true) }),
    z.strictObject({ group: Id.describe('Group id or exact name; selects all its members') }),
    z.strictObject({ name: z.string().min(1).describe('Exact part or group name, case-insensitive. Use * as a wildcard, e.g. "Shelf *"') }),
    z
      .strictObject({
        all: z.literal(true).optional(),
        kind: Kind.optional(),
        hole: z.boolean().optional(),
        in_group: Id.optional().describe('Only parts inside this group (id or name), at any depth'),
      })
      .refine((v) => Object.keys(v).length > 0, 'give at least one filter, or { "all": true }'),
  ])
  .describe('Which parts to act on: { ids }, { selection: true }, { group }, { name } (wildcards ok), or filters { all, kind, hole, in_group }');

export type TargetInput = z.infer<typeof Target>;

const Count = z.int().min(2).max(500);

export const Pattern = z
  .union([
    z.strictObject({
      linear: z
        .strictObject({
          count: Count.describe('Total number of items including the original'),
          step: Vec3.optional().describe('Offset between neighbours'),
          span: Vec3.optional().describe('Offset from the original to the last copy (alternative to step)'),
        })
        .refine((v) => (v.step ? 1 : 0) + (v.span ? 1 : 0) === 1, 'give exactly one of step or span'),
    }),
    z.strictObject({
      grid: z.strictObject({
        counts: z.array(z.int().min(1).max(100)).min(2).max(3).describe('[nx, ny] or [nx, ny, nz] items per axis, including the original'),
        step: Vec3,
      }),
    }),
    z.strictObject({
      radial: z.strictObject({
        count: Count.describe('Total number of items around the circle, including the original'),
        axis: Axis.optional().describe('Rotation axis, default z'),
        center: Vec3.optional().describe('Circle centre; default: centre of the target'),
        angle: Num.optional().describe('Total sweep in degrees, default 360 (evenly spaced, no overlap)'),
      }),
    }),
    z.strictObject({ offsets: z.array(Vec3).min(1).max(500).describe('One copy per offset from the original') }),
  ])
  .describe('How to place copies. Counts include the original.');

export type PatternInput = z.infer<typeof Pattern>;
