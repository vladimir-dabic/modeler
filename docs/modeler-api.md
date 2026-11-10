# Modeler API

> **Status:** designed, not yet implemented. The decision is [ADR 0008](adr/0008-modeler-api-single-entry-point.md). This document is the specification to build against. Update it as the implementation lands.

The Modeler API is the **single way to change the model**. It's a set of named, typed, validated **operations** on a `ModelDocument`. Three kinds of client use exactly the same operations:

| Client | How it calls the API |
|---|---|
| UI (sidebar, top bar, commands) | directly, `api.call('set_hole', {...})` |
| In-app AI assistant | as Claude **tools**: each operation becomes a tool definition |
| MCP server | as MCP **tools**: same names, same schemas |

If a capability exists for one client, it exists for all of them. A feature isn't done until it's an operation.

## Design principles

1. **Parametric and explicit.** Operations speak in parts and dimensions (`add_box {size: [18, 300, 720]}`), never in vertices or mouse positions. Nothing depends on the camera or hidden UI state; the selection is explicit state you read and set.
2. **Millimetres and degrees, Z-up**, always. Clients convert units for display; the API never does.
3. **Validated at the boundary.** Every input is checked against a schema before anything is touched. Invalid input changes nothing and returns an error that says *how to fix it*.
4. **Atomic and undoable.** One call, or one `apply_operations` batch, is one transaction and one undo step. If any operation in a batch fails, none of it is applied.
5. **Self-describing.** Each operation carries a description written for an AI reader (what it does, when to use it, units, an example) and a JSON Schema generated from the same source as the validator.
6. **Feedback in every result.** Writes return what changed (ids, new bounds) and any warnings, such as print-fit problems in the Print workspace. A client, human or AI, can verify the result without a second call.
7. **DOM-free.** The API lives next to the model layer and runs in Node. Capabilities that need a screen (rendering views) are injected by the host; in a headless host they return `unsupported`.
8. **Additive evolution.** New operations and optional fields can be added freely. Renaming or removing one needs a new ADR, because saved AI prompts and MCP configs depend on the names.
9. **Few calls, few tokens** ([ADR 0010](adr/0010-token-efficient-api.md)). Every round trip re-sends the conversation, so one call should express a whole intent: "4 shelves evenly spaced between the bottom and the top" is **one** call, not eight. See [Token efficiency](#token-efficiency).

## Shape of the code (planned)

```ts
// src/api/ (planned): imports only from src/model
export interface OperationDef<I, O> {
  name: string;               // snake_case; also the Claude tool name and MCP tool name
  description: string;        // written for an AI reader
  kind: 'read' | 'write';
  input: ZodType<I>;          // validation + JSON Schema (single source of truth)
  run(ctx: OperationContext, input: I): O;
}

export class ModelerApi {
  constructor(doc: ModelDocument, host?: ApiHost) {}
  operations(): OperationDef<unknown, unknown>[];          // for tool lists
  call(name: string, input: unknown, meta?: CallMeta): ApiResult;
  apply(calls: { name: string; input: unknown }[], meta?: CallMeta): ApiResult; // atomic batch
}

export interface CallMeta {
  source: 'ui' | 'assistant' | 'mcp';
  label?: string;             // undo-history label, e.g. "AI: add 5 shelves"
}

export interface ApiHost {   // optional host capabilities
  renderViews?(views: ViewName[], size: number): Promise<{ view: ViewName; png: string }[]>;
}
```

### Results

```ts
type ApiResult<T = unknown> =
  | { ok: true; data: T; changes?: ChangeSummary; warnings?: Warning[] }
  | { ok: false; error: { code: ErrorCode; message: string; hint?: string; path?: string } };

type ErrorCode =
  | 'invalid_input'     // schema validation failed (path says where)
  | 'not_found'         // unknown entity id / name
  | 'ambiguous'         // a name matched several entities; hint lists their ids
  | 'invalid_geometry'  // e.g. outline with zero area, size ≤ 0
  | 'unsupported';      // e.g. render_views in a headless host

interface ChangeSummary {
  added: EntitySummary[];
  updated: EntitySummary[];
  removed: string[];          // ids
}
```

Error messages are written so an AI can recover without a human. Example: `"size[2] must be > 0 (got -18). To make a hole into a face, create a positive size and set hole: true."`

### Entity summary (the compact form every read returns)

```json
{ "id": "k3f9a2", "name": "Side", "kind": "box", "hole": false,
  "position": [0, 0, 0], "rotation": [0, 0, 0], "size": [18, 300, 720],
  "bounds": { "min": [0, 0, 0], "max": [18, 300, 720] }, "color": "#e6d3ad" }
```

Cylinders carry `radius`, `height`, `segments`; extrusions carry `points` and `height`. Bounds are world-space, so a client can reason about touching or overlapping without re-deriving geometry.

### Targeting entities (selectors)

Operations that act on existing parts take a **target**. A selector can pick many parts at once, so the AI never has to list ids it can describe:

```ts
type Target =
  | { ids: string[] }
  | { selection: true }
  | { group: string }                 // all members of a group (by id or name)
  | { name: string }                  // exact, case-insensitive; '*' wildcard: "Shelf *"
  | { kind?: EntityKind; hole?: boolean; in_group?: string; all?: true }; // filters, combined with AND
```

Examples: `{ "name": "Shelf *" }`, `{ "hole": true, "in_group": "Lid" }`, `{ "all": true }`.

A selector that matches **nothing** is a `not_found` error. A plain `name` (no wildcard) that matches **several** parts is `ambiguous`, and the error lists the candidates, so nothing is ever changed by guesswork. Wildcards and filters are explicit about wanting many.

## Operation catalogue (v1)

### Read

| Operation | Input | Returns |
|---|---|---|
| `get_scene` | `{ detail?: 'outline'\|'compact'\|'full', include_hidden?: boolean }` | workspace, units, printer, overall bounds, entities; groups collapsed to one line in `outline` (see [compact output](#compact-output)) |
| `get_entities` | `Target` | full summaries |
| `get_selection` | — | selected ids + summaries |
| `measure` | `{ from: Point, to: Point }` or `{ between: [id, id] }` | distance, dx/dy/dz, gap between parts |
| `check_print` | — | fit issues, size, volume (cm³), weight per filament |
| `get_cut_list` | — | grouped rows (T × W × L, qty, names) |
| `get_quantities` | — | per-object footprint m², volume m³, totals |

### Write

| Operation | Input (all mm / degrees) | Notes |
|---|---|---|
| `add_box` | `{ name?, position?, size, rotation?, color?, hole? }` | position = min corner, default origin |
| `add_cylinder` | `{ name?, position?, radius \| diameter, height, axis?: 'x'\|'y'\|'z', segments?, color?, hole? }` | position = base centre |
| `add_shape` | `{ name?, position?, points: [x,y][], height, rotation?, color?, hole? }` | closed outline, ≥ 3 points |
| `update_entity` | `{ id, set: Partial<{name, position, rotation, size, radius, height, segments, points, color, hole, visible}> }` | validated as a whole after the patch |
| `delete_entities` | `Target` | |
| `duplicate` | `{ target, pattern?: Pattern, group_copies?: boolean }` | one call makes any number of copies; see [patterns](#patterns) |
| `mirror` | `{ target, plane: 'x'\|'y'\|'z', about?: number \| id, keep_original?: boolean }` | left/right symmetric parts in one call |
| `move` | `{ target, by?: Vec3, to?: Vec3, anchor?: 'min'\|'center'\|'max' }` | `to` places the target's anchor at a point |
| `place` | `{ target, relative_to: Target, side: 'top'\|'bottom'\|'left'\|'right'\|'front'\|'back'\|'inside_bottom', align?: 'min'\|'center'\|'max', gap?: number }` | "put the lid on top of the box, centred" without computing coordinates |
| `distribute` | `{ target, count?, between?: [Target, Target], axis, mode: 'even'\|'spacing', spacing?: number }` | evenly space parts (shelves, slats, fence posts); with `count`, copies the target until there are that many first |
| `rotate` | `{ target, angle, axis?: 'x'\|'y'\|'z', pivot?: Vec3 \| 'center' \| 'min' }` | pivot defaults to the target's centre |
| `align` | `{ target, to: Target, axis, mode: 'min'\|'center'\|'max' }` | line up edges or centres |
| `group` | `{ target, name? }` | returns the new group id ([ADR 0011](adr/0011-groups-as-flat-membership.md)) |
| `ungroup` | `{ group }` | members stay where they are |
| `set_hole` | `{ target, hole: boolean }` | |
| `place_on_plate` | `{ target? }` | Print workspace; centres on the bed, z = 0 |
| `set_selection` | `Target \| { clear: true }` | |
| `set_workspace` | `{ workspace: 'print'\|'workshop'\|'build' }` | document setting, not undoable |
| `set_printer` | `{ profile } \| { custom: Vec3 }` | |
| `apply_operations` | `{ operations: { name, input, as?: string }[] }` | atomic batch, one undo step; later steps can use `"$alias"` (see [references](#references-inside-a-batch)) |
| `undo` / `redo` | — | |

### View and files (host-dependent)

| Operation | Input | Notes |
|---|---|---|
| `render_views` | `{ views?: ('iso'\|'top'\|'front'\|'right')[], size?: number }` | PNG images for visual self-checks. Browser host only |
| `export_stl` | `{ target? }` | browser: download; headless: write file / return base64 |
| `open_file` / `save_file` | `{ path }` | headless MCP host only |

## Token efficiency

Each call costs a model round trip: the whole conversation is re-read and a new response generated. The API is designed so an intent maps to **one** call.

### Patterns

`duplicate` takes a pattern, so arrays are one call:

```ts
type Pattern =
  | { linear: { count: number; step: Vec3 } }                    // 5 slats, 120 mm apart
  | { linear: { count: number; span: Vec3 } }                    // 5 copies spread over 480 mm
  | { grid: { counts: [nx, ny, nz?]; step: Vec3 } }              // 3 × 4 pegboard holes
  | { radial: { count: number; axis: 'x'|'y'|'z'; center?: Vec3; angle?: number } } // 6 bolt holes on a circle
  | { offsets: Vec3[] };                                         // arbitrary copies
```

`{ "name": "duplicate", "input": { "target": { "name": "Bolt hole" }, "pattern": { "radial": { "count": 6, "axis": "z", "center": [50, 50, 0] } } } }` makes six holes on a bolt circle in one call.

### References inside a batch

`apply_operations` lets a step name its result with `as` and later steps refer to it as `"$name"`. A whole assembly is then built in **one** call without waiting for ids:

```json
{ "operations": [
  { "name": "add_box", "as": "bottom", "input": { "name": "Bottom", "position": [0, 0, 0], "size": [600, 300, 18] } },
  { "name": "add_box", "as": "left",   "input": { "name": "Side", "position": [0, 0, 18], "size": [18, 300, 700] } },
  { "name": "mirror",  "as": "right",  "input": { "target": { "ids": ["$left"] }, "plane": "x", "about": "$bottom", "keep_original": true } },
  { "name": "add_box", "as": "top",    "input": { "name": "Top", "size": [600, 300, 18] } },
  { "name": "place",   "input": { "target": { "ids": ["$top"] }, "relative_to": { "ids": ["$left"] }, "side": "top", "align": "min" } },
  { "name": "add_box", "as": "shelf",  "input": { "name": "Shelf", "position": [18, 0, 0], "size": [564, 280, 18] } },
  { "name": "distribute", "as": "shelves", "input": { "target": { "ids": ["$shelf"] }, "count": 4, "between": [{ "ids": ["$bottom"] }, { "ids": ["$top"] }], "axis": "z", "mode": "even" } },
  { "name": "group", "input": { "target": { "ids": ["$bottom", "$left", "$right", "$top", "$shelves"] }, "name": "Bookcase" } }
] }
```

Eight steps, one call, one undo step: a complete bookcase. Done one operation at a time, this would be about eight model round trips.

An alias that refers to several parts (like `$shelves`) expands to all of them.

### Compact output

- **Writes return only what changed**: added/updated summaries and removed ids. The model is never echoed back.
- **Numbers are rounded** to 0.01 mm / 0.01° in output.
- **`get_scene` detail levels:**
  - `outline`: one line per top-level part or group (`Bookcase [group, 8 parts] 600×300×736 at 0,0,0`);
  - `compact` (default): one short line per part;
  - `full`: complete summaries as JSON.

  Large models should be read in `outline` first, then expanded with `get_entities { group: ... }`.
- **Defaults instead of parameters:**
  - names are auto-numbered ("Shelf 2");
  - colour, cylinder smoothness and units come from the workspace;
  - `rotation` defaults to 0.

  The AI writes only what matters.
- **Errors are short:** a code, one sentence, and a hint.

## Writing operation descriptions (for AI readers)

Each description should answer, briefly:
1. **What it does**, in one sentence.
2. **When to use it** vs. a neighbour (e.g. `move` vs. `align`).
3. **Units and conventions**: mm, which corner `position` refers to.
4. **One concrete example input.**

Keep them stable: the tool definitions are prompt-cached (see [AI integration](ai-integration.md)), so a reworded description costs a cache rebuild.

## Testing

- Every operation gets unit tests in Node: valid input, each error code, undo restores the previous state.
- **Scenario tests** replay realistic AI call sequences ("bookcase with 4 shelves", "box with M3 screw holes") and assert the resulting model. These double as regression tests for the AI integration without calling a model.
