# Modeler API

> **Status:** implemented in `src/api` ([ADR 0008](adr/0008-modeler-api-single-entry-point.md), [ADR 0010](adr/0010-token-efficient-api.md)). Every operation with all its fields is listed in the generated **[API reference](api-reference.md)**. This page explains the design and conventions.

The Modeler API is the **single way to change the model**: a set of named, typed, validated **operations** on a `ModelDocument`. Three kinds of client use exactly the same operations:

| Client | How it calls the API |
|---|---|
| UI (sidebar, commands, right-click menu) | `app.uiCall('set_hole', {...}, 'Make hole')`, a thin wrapper over `api.call` that turns errors into toasts |
| In-app AI assistant (planned) | as Claude **tools**: `api.toolDefinitions()` |
| MCP server (planned) | as MCP **tools**: same names, schemas and descriptions |

If a capability exists for one client, it exists for all of them. A model-changing feature isn't done until it's an operation.

## Design principles

1. **Parametric and explicit.** Operations speak in parts and dimensions (`add_box {size: [18, 300, 720]}`), never in vertices or mouse positions. Nothing depends on the camera; the selection is explicit state (`get_selection` / `set_selection`).
2. **Millimetres and degrees, Z-up**, always. Clients convert units for display; the API never does.
3. **Validated at the boundary.** Inputs are checked against Zod schemas before anything is touched, and every part a write changed is validated again afterwards (`validateEntity`). Invalid input changes nothing and returns an error that says how to fix it.
4. **Atomic and undoable.** One write call, or one `apply_operations` batch, is one transaction and one undo step, optionally labelled (`{ label: 'AI: add 4 shelves' }`). If anything fails, the document is rolled back.
5. **Self-describing.** Each operation carries a description written for an AI reader. Its JSON Schema is generated from the same Zod schema that validates it, so the docs, the AI tools and the runtime can't disagree.
6. **Feedback in every result.** Writes return what changed and any warnings (print-fit problems in the Print workspace), so a client can verify without a second call.
7. **DOM-free.** `src/api` imports only `src/model`, so it runs in Node (headless MCP, tests). Capabilities that need a screen (`render_views`) come from an injected host.
8. **Additive evolution.** New operations and optional fields are fine. Renaming or removing one needs an ADR, because saved prompts and MCP configs depend on the names.
9. **Few calls, few tokens** (ADR 0010). One call should express a whole intent. See [Token efficiency](#token-efficiency).

## Code map

```
src/api/
  schemas.ts      shared Zod schemas: Vec3, Size3, Target (selectors), Pattern, Color…
  core.ts         ApiError + error codes, results, ApiHost, OperationContext (target
                  resolution, "units" of grouped parts), compact formatting, validateEntity
  operations.ts   every operation: name, kind, AI-readable description, schema, run
  ModelerApi.ts   call / callAsync / toolDefinitions; transactions, rollback, change
                  summaries, warnings; apply_operations with $aliases
  reference.ts    generates docs/api-reference.md
  guide.ts        how an AI should use the API (MCP instructions; in-app system prompt)
  index.ts        public exports
```

```ts
const api = new ModelerApi(doc, { renderViews, files });  // host is optional
api.call('add_box', { name: 'Side', size: [18, 300, 700] }, { source: 'ui', label: 'Add side' });
await api.callAsync('render_views', { views: ['iso'] });  // host operations are async
api.toolDefinitions();                                     // [{ name, description, input_schema }]
```

### Operation kinds

| Kind | Meaning |
|---|---|
| `read` | never changes the model (`get_*`, `measure`, `check_print`, also `set_selection`, which is UI state) |
| `write` | one transaction / undo step; validated; rolled back on error; returns `{ ids }` |
| `settings` | document settings that are saved but not undoable (`set_workspace`, `set_printer`); the app reacts via `doc.onSettingsChange` |
| `history` | `undo`, `redo` |
| `host` | needs a host capability, called with `callAsync`: `render_views` (`host.renderViews`, the app), `open_file` / `save_file` / `export_stl` / `export_model` / `import_dxf { path }` (`host.files`, only the MCP server, limited to its working folder: [ADR 0013](adr/0013-mcp-server-bridge-and-files.md)). Without the capability they return `unsupported` |

### Results

```ts
type ApiResult =
  | { ok: true; data: unknown; changes?: ChangeSummary; warnings?: string[] }
  | { ok: false; error: { code: ErrorCode; message: string; hint?: string; path?: string } };

type ErrorCode = 'invalid_input' | 'not_found' | 'ambiguous' | 'invalid_geometry' | 'unsupported' | 'internal';

interface ChangeSummary {      // compact lines, not full JSON (token efficiency)
  added: string[];             // 'k3f9a2 "Shelf 2" box 564×280×18 at 18,0,180 in "Bookcase"'
  updated: string[];
  removed: string[];           // 'k3f9a2 "Shelf 2"'
  groups_added?: string[];
  groups_removed?: string[];
}
```

Errors are written for recovery without a human, for example:

- `ambiguous`: `2 parts are named "Shelf"`, with the hint *Use ids (a1, b2) or a wildcard like "Shelf*" to mean all of them.*
- a failed batch says which step: `step 3 (add_box): size.1: Too small: expected number to be >0`, with `path: operations.2.input.size.1`.

### Targeting entities (selectors)

```ts
type Target =
  | { ids: string[] }          // part ids, or group ids (= all their members)
  | { selection: true }
  | { group: string }          // group id or exact name
  | { name: string }           // exact, case-insensitive; '*' wildcard: "Shelf *"
  | { all?: true; kind?: 'box'|'cylinder'|'extrusion'; hole?: boolean; in_group?: string };
```

- **No match** is a `not_found` error, listing names that do exist.
- **A plain name that matches several parts** is `ambiguous`, and the error lists their ids. Wildcards and filters are explicit about wanting many, so nothing is ever changed by guesswork.
- **Grouped parts move as one:** operations that move things (`distribute`, …) keep a group together when *all* its members are targeted.

## Views

- `explode_view { factor 0–1, axis? }` (host, app only) shows the model pulled apart: every part, assemblies (groups) kept side by side as clusters ([ADR 0022](adr/0022-exploded-view-all-parts.md)). View state only: no undo step, nothing saved.
- `render_views { views?, size?, explode?, explode_axis? }` can render exploded images without changing the user's view.

## Printing

- `set_hole { target, hole, only_own_group? }`: `only_own_group: true` scopes a hole to its group ([ADR 0018](adr/0018-print-workflow-fuse-scope-split.md)).
- `split_for_print { target, axis?, at?, gap?, pegs?, peg_diameter?, peg_depth?, clearance?, name? }` replaces the target with two parametric pieces with pegs and clearance holes. The result lists the pieces, the peg count and size, and `notes` if pegs had to shrink or didn't fit.
- `export_model` writes GLB for other 3D programs: separate named parts (not fused), groups as nested nodes, metres Y-up ([ADR 0020](adr/0020-glb-export-own-writer.md)).
- `export_stl` writes one fused, watertight solid. The `check_print` / `get_quantities` totals count overlapping parts once.

## Components and part properties

- `make_component { target, match? }` links identical parts as copies of one component: editing the shape, colour or properties of one edits all; each keeps its place, name and group. `make_unique { target }` unlinks ([ADR 0025](adr/0025-components-and-part-properties.md)).
- `set_properties { target, material?, finish?, banding?, part_no?, note? }` (null clears) says what parts are made of; the cut list, booklet and GLB use it.

## Clipboard

- `paste { data, offset? }` inserts parts copied with ⌘C (JSON text, format `modeler-clipboard`): new ids, whole groups and attached notes kept, in place or beside the model ([ADR 0023](adr/0023-clipboard-tabs-new-project.md)). Copying itself is UI-only (`copyParts` in `src/model/clipboard.ts`).

## Build instructions

- `get_instructions` / `set_instructions { title?, intro?, language?, steps? }` ([ADR 0021](adr/0021-build-instructions-booklet.md)). Letters, quantities and pictures are derived from the model; only the title, intro, language and step order with texts are stored. A step is `{ parts?: target, text? }`; `steps: null` goes back to the suggested bottom-up steps.

## Annotations

Notes and dimensions ([ADR 0015](adr/0015-annotations-notes-and-dimensions.md)). A point is `[x, y, z]`, or `{ part, at }` with `at` = fractions of the part's own box (`[0.5, 0.5, 1]`, top centre, is the default). Points on parts keep the annotation attached.

| Operation | |
|---|---|
| `add_note { text, at, label_offset? }` | A label, with a leader when `label_offset` moves it away |
| `add_dimension { from, to, axis?, offset?, side?, text? }` | `axis` measures along x/y/z; `offset` is a distance in mm (default ~15% of the length) or an exact vector; `side` (`+z`, `-y`…) sets the direction, default: away from the parts; `text` overrides the value, with `<>` = value |
| `dimension_parts { target, axes?, offset? }` | Overall dimensions of a part or group in one call, attached to its outermost parts |
| `update_annotation { id, text?, label_offset?, offset?, side? }` | |
| `delete_annotations { ids \| all }` | |

`get_scene` lists them under `annotations`, e.g. `a1 dimension 600 along x: "Left side" at 0,0,1 → "Right side" at 1,0,1, offset 0,0,90`. `render_views` draws the labels into its images.

## Reference drawings

Imported plans the model is built on ([ADR 0014](adr/0014-exchange-formats-and-reference-drawings.md)). They are not parts, so selectors never match them.

| Operation | |
|---|---|
| `import_dxf { path \| text, name?, units?, position?, rotation? }` | `host`. `path` needs `host.files` (MCP); the app passes `text`. One undo step. The result has the size in mm, layers with path counts, skipped entity types, and a `hint` when assumed units look wrong |
| `get_reference { reference, layers?, limit? }` | `read`. One compact line per path in world mm: `Walls: closed x,y …`, `arc centre … r …`, `circle centre … ø…` |
| `update_reference { reference, name?, units?, position?, rotation?, visible?, hide_layers?, show_layers? }` | `write`. Layers by name, `"*"` = all |
| `delete_reference { reference }` | `write` |

`get_scene` lists them under `references`. A drawing is addressed by id or exact name (`ctx.reference`).

## Token efficiency

Each call costs a model round trip, so the API is built so an intent maps to **one** call.

### Patterns

`duplicate` takes a pattern; **counts include the original**:

```ts
type Pattern =
  | { linear: { count: number; step?: Vec3; span?: Vec3 } }        // step OR span
  | { grid: { counts: [nx, ny] | [nx, ny, nz]; step: Vec3 } }
  | { radial: { count: number; axis?: 'x'|'y'|'z'; center?: Vec3; angle?: number } }
  | { offsets: Vec3[] };
```

`{ "target": { "name": "Bolt hole" }, "pattern": { "radial": { "count": 6, "center": [50, 50, 0] } } }` gives six holes on a bolt circle. Groups whose members are all copied are copied as new groups (`Drawer` → `Drawer 2`).

### Intent-level operations

- **`place`:** put parts against another part (top/bottom/left/right/front/back, a gap, and an alignment on the other axes).
- **`distribute`:** space parts evenly along an axis, optionally `between` two references; `count` creates the copies first.
- **`mirror`:** reflect about a plane given by a coordinate or by a part's centre.
- **`align`:** line up min, centre or max on one axis.

None of them needs coordinate arithmetic from the client.

### References inside a batch

`apply_operations` names a step's result with `as`; later steps use `"$name"`. Inside an `ids` list an alias expands to all its ids; elsewhere (`about`, `group`) it must refer to exactly one. This builds a whole bookcase in **one** call and one undo step; it's covered by `tests/api.test.ts`:

```json
{ "operations": [
  { "name": "add_box", "as": "bottom", "input": { "name": "Bottom", "position": [0, 0, 0], "size": [600, 300, 18] } },
  { "name": "add_box", "as": "left",   "input": { "name": "Side", "position": [0, 0, 18], "size": [18, 300, 700] } },
  { "name": "mirror",  "as": "right",  "input": { "target": { "ids": ["$left"] }, "plane": "x", "about": "$bottom" } },
  { "name": "add_box", "as": "top",    "input": { "name": "Top", "size": [600, 300, 18] } },
  { "name": "place",   "input": { "target": { "ids": ["$top"] }, "relative_to": { "ids": ["$left"] }, "side": "top", "align": "min" } },
  { "name": "add_box", "as": "shelf",  "input": { "name": "Shelf", "position": [18, 0, 0], "size": [564, 280, 18] } },
  { "name": "distribute", "as": "shelves", "input": { "target": { "ids": ["$shelf"] }, "count": 4, "between": [{ "ids": ["$bottom"] }, { "ids": ["$top"] }], "axis": "z" } },
  { "name": "group", "input": { "target": { "ids": ["$bottom", "$left", "$right", "$top", "$shelves"] }, "name": "Bookcase" } }
] }
```

History (`undo`/`redo`), host operations and nested batches can't run inside a batch. An optional `"label": "bookcase"` names the batch's undo step (the MCP server shows it as `AI: Bookcase`).

### Compact output

- **Writes return only what changed,** as one line per part; numbers are rounded to 0.01.
- **`get_scene` detail levels:**
  - `outline`: one line per top-level group (`"Bookcase" [group, 8 parts] 600×300×736 at 0,0,0`);
  - `compact` (default): one line per part;
  - `full`: complete JSON.
- **Defaults instead of parameters:**
  - names auto-number;
  - colour, cylinder smoothness and units come from the workspace;
  - `position` defaults to the origin, `rotation` to 0.

## Writing operation descriptions (for AI readers)

Each description should answer, briefly:
1. **What it does**, in one sentence.
2. **When to use it** vs. a neighbour (e.g. `move` vs. `place`).
3. **Units and conventions**: mm, which corner `position` refers to.
4. **One concrete example input.**

Keep them stable: tool definitions are prompt-cached by AI clients, so a reworded description costs a cache rebuild. After changing one, run `npm run docs:api` (a test fails if the reference is stale).

## Testing

- **`tests/api.test.ts`:**
  - each operation's success path, and its errors (`invalid_input`, `ambiguous`, `not_found`, `invalid_geometry`);
  - batch rollback and step-numbered errors;
  - group copy and nesting;
  - print warnings, settings events;
  - the bookcase scenario;
  - every operation has a description and a JSON Schema.
- **`tests/api-reference.test.ts`:** fails if [api-reference.md](api-reference.md) doesn't match the code.
- **The smoke test** runs a batch in the real app, checks it's one labelled undo step, and renders views. Step 17 does the same through the built MCP server over the live bridge.
- **`tests/mcp.test.ts`:** the MCP server in-process (both modes, files, bridge security).

## Not yet implemented

- Interactive tools (ADR 0004) still mutate the document directly during drags, and their committed results aren't yet run through `validateEntity`.
