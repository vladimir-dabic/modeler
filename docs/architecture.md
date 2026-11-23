# Architecture

Vite + TypeScript + Three.js, no UI framework ([ADR 0003](adr/0003-vanilla-typescript-threejs.md)). Boolean operations (holes) are done by the **Manifold** WebAssembly engine, with `three-bvh-csg` as the fallback ([ADR 0017](adr/0017-manifold-geometry-engine.md)). About 6k lines of TypeScript.

## Layers

```mermaid
flowchart TB
  subgraph Clients["Clients (who changes the model)"]
    UI["UI: tools, sidebar, top bar, keyboard"]
    Chat["In-app AI assistant (planned)"]
    MCP["MCP server (planned)"]
  end
  API["Modeler API: src/api, typed and validated operations (ADR 0008)"]
  subgraph Model["Model layer: src/model, DOM-free, runs in Node"]
    Doc["ModelDocument: entities, groups, selection, transactions, undo"]
    Geo["geometry / csg / units / cutlist / workspaces / io"]
  end
  subgraph View["View layer: src/viewport"]
    VP["Viewport: Three.js scene, cameras, picking"]
    Snap["Snapper: inference / snapping"]
  end
  UI --> API
  Chat --> API
  MCP --> API
  API --> Doc
  Doc -- "change events" --> VP
  Doc -- "change events" --> UI
  UI -. "interactive tools: live preview" .-> Doc
  VP --- Snap
  Doc --- Geo
```

**Rule of thumb:** the model layer knows nothing about the screen. The view layer renders the model and answers "what's under the cursor?". Clients change the model only through the API ([ADR 0008](adr/0008-modeler-api-single-entry-point.md)).

### Who changes the model, and how

| Who | How |
|---|---|
| Sidebar, commands, right-click menu (`src/ui`, `App.runCommand`) | Modeler API operations via `App.uiCall` (errors become toasts with the API's hint) |
| Workspace / printer switches | API `set_workspace` / `set_printer`; the app reacts to `doc.onSettingsChange`, so an AI switch updates the UI the same way |
| Interactive tools (`src/tools`) | mutate entities inside `doc.begin()` … `doc.commit()` for live previews (ADR 0004); copying uses the shared `copyEntities` (`src/model/editing.ts`) |
| Future AI assistant / MCP | Modeler API, as tools |

**Remaining gap:** tool commits aren't yet run through the API's `validateEntity`.

## Key concepts

### Entities ([ADR 0001](adr/0001-parametric-entities-mm-z-up.md))

`src/model/types.ts`. Every part is one of:

| kind | parameters | local frame |
|---|---|---|
| `box` | `size: [x, y, z]` | spans `[0, size]` from the origin |
| `cylinder` | `radius`, `height`, `segments` | base centre at the origin, extends +Z |
| `extrusion` | `points: [x, y][]`, `height` | closed outline on local XY, extruded +Z |
| `sphere` | `radii: [x, y, z]`, `segments` | sphere / ellipsoid centred on the origin |
| `revolve` | `profile: [r, z][]` (r ≥ 0), `segments` | closed profile spun 360° around local Z |
| `tube` | `path: [x, y, z][]` (first = origin), `radius`, `radii?` (per point), `smooth`, `segments` | round tube along the path, flat ends |

Holes have two optional flags:
- `holeScope: 'group'` makes a hole cut only parts in its own group subtree. `cuttersFor(solid, holes, groups)` applies it.
- `quiet` marks a helper cutter, drawn only while selected.

Export and volume totals fuse the cut solids into one watertight solid (`fuseGeometries` in `csg.ts`); `split_for_print` builds pieces from copies plus scoped quiet cutters plus pegs ([ADR 0018](adr/0018-print-workflow-fuse-scope-split.md)).

Two optional fields refine existing kinds: a box's `edgeRadius` (rounded edges and corners) and a cylinder's `radiusTop` (cone or frustum; 0 = pointed, either end may be 0). The meshes of the round and smooth kinds come from `src/model/shapes.ts`. They're closed solids with outward faces, which hole cutting and STL rely on.

All kinds share `id`, `name`, `position` (world mm), `rotation` (Euler XYZ, degrees), `color`, `hole`, `visible`, and an optional `groupId`. World units: **mm, Z-up** (X red, Y green, Z blue).

### Components and part properties ([ADR 0025](adr/0025-components-and-part-properties.md))

Entities with the same `component` id are linked copies: they share their definition (every field except name, position, rotation, visibility, group). `syncComponents` (`src/model/parts.ts`) makes the copies follow the one that changed; it runs after every API write and in `ModelDocument.commit`. Optional part properties (`material`, `finish`, `banding`, `partNo`, `note`) are part of the definition and feed the cut list, the booklet's part letters and GLB material names.

### Groups ([ADR 0011](adr/0011-groups-as-flat-membership.md))

`doc.groups` is a list of `{ id, name, parentId? }`, and an entity names its group with `groupId`. Groups have **no transform**; members keep world positions, so geometry, snapping, CSG and export are unaffected. Pure helpers live in `src/model/groups.ts`:
- `groupMembers`, `groupChain` (nesting);
- `selectionUnit`: what a click selects;
- `groupForSelection`;
- `pruneGroups`: groups left empty disappear on every write.

Selection works SketchUp-style. A click selects the outermost group. `doc.openGroupId` is the group open for editing: clicks pick parts inside it, and the viewport fades everything else. It's UI state, not saved and not undoable.

### Reference drawings ([ADR 0014](adr/0014-exchange-formats-and-reference-drawings.md))

Imported plans (DXF) to trace and snap to. They are **not part of the model**: no selection, CSG, cut list, volumes, print checks or export.
- `doc.references` holds the metadata: `{ id, name, kind: 'drawing', units, position, rotation (about Z), visible, hiddenLayers }`. It's snapshotted, so changes are undoable.
- The line geometry `{ layers, paths }` is immutable and kept beside it (`doc.geometryOf(id)`), **outside undo snapshots**, so a big plan isn't copied into every undo step.
- `src/model/dxf.ts` parses ASCII DXF into that geometry. `src/model/references.ts` has the placement matrix (`referenceMatrix`: drawing units → mm, rotate, translate), bounds, snap points and file validation.
- The viewport draws each drawing as one `LineSegments` (rebuilt only when layers change; placement is a matrix). The snapper adds its corners, segment midpoints and arc/circle centres.

### Build instructions ([ADR 0021](adr/0021-build-instructions-booklet.md))

Build instructions live in `doc.instructions`: only the title, intro, language and step order with texts. Letters, quantities and pictures are derived when the booklet opens (`src/model/instructions.ts`, `src/viewport/InstructionImages.ts`, `src/ui/InstructionsView.ts`).

A project with several pieces of furniture has a booklet per top-level group ([ADR 0027](adr/0027-one-booklet-per-piece-of-furniture.md)), stored in `doc.instructions.groups[groupId]`. `instructionScope` picks the group's parts (plus all holes), `storedInstructions` the group's stored booklet (inheriting the project language) and `withInstructions` writes one back.

### Annotations ([ADR 0015](adr/0015-annotations-notes-and-dimensions.md))

Notes and dimensions in `doc.annotations`. They're snapshotted (one undo step per change), saved in the file, never geometry.
- An `Anchor` is `{ point }` or `{ entity, at }`, where `at` = fractions of the part's local box. `resolveAnchor` turns it into a world point through the part's current matrix, so anchors follow moves, rotations and resizes.
- `Document.remove` prunes annotations whose parts are gone, in the same transaction. Hidden parts hide their annotations.
- `src/model/annotations.ts` has anchors, dimension geometry, pruning and validation (DOM-free).
- `src/viewport/AnnotationLayer.ts` draws them: HTML labels, lines on top of the model, ticks of constant screen size. `hitTest(px)` is how the Select tool picks them.
- Selection is `doc.annotationSelection`, exclusive with the part selection.
- The Text and Dimension tools create annotations through the API (`ToolContext.call`).

### Exploded view

A display state in the viewport, never a model change: no transaction, no undo step, not saved.
- `src/model/explode.ts` (`explodeOffsets`, DOM-free) groups visible parts into units, the same units a click selects (ADR 0011): top-level groups and loose parts, or the children of the open group. Each unit moves away from the assembly's centre in proportion to its distance (×2.5 at full spread), optionally along one axis only.
- `Viewport.setExplode` applies the offsets as object matrices. Zoom-to-fit, renders and rectangle selection use the drawn positions; snapping and the model don't.
- **Stands on the floor:** after spreading, everything is lifted so the lowest part sits at the model's original bottom.
- **Presentation look:** the grid, axes, bed and scale figure live under one `stage` node, hidden while exploded together with reference drawings, on a studio-gradient background. Annotations are suppressed.
- **Look-only** ([ADR 0019](adr/0019-exploded-view-look-only.md)):
  - `App.uiCall` refuses write/history operations, and undo/redo are refused too; the Sidebar is `setLocked`;
  - editing tools, New, Open and Import reassemble first;
  - bridge (MCP) edits reassemble first through `BridgeClient.beforeRequest(operation)`.
- API: `explode_view` (host) and `render_views { explode }`.

### Document and transactions ([ADR 0002](adr/0002-document-transactions-snapshot-undo.md))

`ModelDocument` (`src/model/Document.ts`) owns `entities`, `groups`, `annotations`, `references` (+ their geometry), `selection`, `annotationSelection`, `openGroupId`, `units` and document settings (`workspace`, `printer`).

- `begin()` → mutations → `commit()` records **one undo step** (a JSON snapshot); `cancel()` rolls back. `transact(fn)` wraps a function, joining an open transaction if there is one.
- Every mutation emits `onChange({committed})`. `committed: false` during a drag, so the viewport updates live; `true` on commit, which triggers autosave.
- `version` increments on every change. It's the cache key for derived data (snap points, volumes).
- `commit(label)` names the undo step (`undoLabel`). `checkpoint()` / `rollback()` let the API undo a failed batch even inside an outer transaction.
- Settings changes (`setUnits`, `setWorkspace`, `setPrinter`) emit `onSettingsChange`.
- Undo history holds up to 200 steps. `workspace`, `printer` and `units` are document settings, **not** part of undo.

### Rendering

`Viewport.sync()` rebuilds a mesh only when its entity changed. The cache key is the entity JSON plus the JSON of every hole overlapping it, so moving a hole re-cuts only the solids it touches. Per entity:

- **Mesh:** `buildCutGeometry` in `csg.ts` makes the geometry, with holes subtracted ([ADR 0005](adr/0005-holes-as-csg-cutters.md)).
  - It uses Manifold (`manifold.ts`: all holes in one exact, watertight batch) once `initManifold()` has loaded the WebAssembly, and three-bvh-csg before that, or if Manifold rejects an input ([ADR 0017](adr/0017-manifold-geometry-engine.md)).
  - When the engine becomes ready, `Viewport.rebuildAll()` re-cuts everything.
  - Manifold objects live in WebAssembly memory: free every one (`.delete()`); `manifold.ts` does it in `finally`.
- **Edges:** `featureEdges` in `edges.ts` draws creases above 25° plus open boundaries, and drops seams that CSG leaves inside flat faces.
- **Styling:** `updateStyles()` applies selection, hover, print-warning, hole and x-ray looks.

Rendering is on demand (`requestRender()`), not a constant loop.

Scene helpers:
- `Grid.ts`: an infinite shader grid whose spacing adapts to the zoom (1 mm → 1 m) and fades between levels.
- `SceneHelpers.ts`: the print bed and build volume, and the scale figure.
- `overlay.ts`: temporary lines and labels for tools.

### Interaction

- **Tools** ([ADR 0004](adr/0004-tools-edit-live-entities.md)): `src/tools/*`. Each tool is a small state machine (`idle → rect → height`, …). It receives pointer events, key presses and typed values from the measurement box. Drawing tools add a real entity at the first click and update it live, so the preview *is* the result.
- **Snapper:** `src/viewport/Snapper.ts` turns a cursor position into a 3D point. Priority: snap points within 14 px (corners > centres > midpoints), then faces, then the ground; free positions are rounded to the snap step.
- **Commands and keymap** ([ADR 0006](adr/0006-command-registry-and-keymap.md)): `commands.ts` lists every bindable action and `keymap.ts` maps keys to command ids. User overrides live in `localStorage`. `App.runCommand(id)` executes them, and the toolbar buttons go through the same function.
- **Right-click menu** ([ADR 0012](adr/0012-context-menu-from-commands.md)): `src/ui/ContextMenu.ts`. A right-click without a drag opens it (a right-drag pans). Its items are commands, built in `App.menuItems`, so each shows its current shortcut.
- **Hold-to-navigate:** holding the pan/orbit key gives the left mouse button to `OrbitControls` without switching tools, so an operation in progress survives. A quick tap of the same key is forwarded to the tool as a key press.

### Workspaces ([ADR 0007](adr/0007-workspaces-are-configuration.md))

`src/model/workspaces.ts` holds three configuration objects: units, snap step, grid base, home view, swatches, cylinder segments, sidebar panels, print plate on/off, scale figure on/off. It also holds the printer profiles and the pure functions `checkPrintFit`, `placeOnPlateDelta` and `meshVolume`. `App.applyWorkspace` pushes the configuration into the viewport, sidebar and settings.

## Persistence

| What | Where | Key / format |
|---|---|---|
| Model (autosave) | `localStorage` | `modeler.autosave.v1:<tab id>`, a `DocumentFile`, one per browser tab; index `modeler.tabs.v1` (`src/ui/TabSession.ts`, ADR 0023) |
| Clipboard fallback | `localStorage` | `modeler.clipboard.v1`, the last copy (the system clipboard has it too) |
| Project file | Save / Save As / Open / drag-drop: written back in place where the File System Access API exists, else downloaded ([ADR 0016](adr/0016-project-files-save-in-place.md)) | `*.modeler.json`: `{format: 'modeler', version: 1, units, workspace, printer, entities, groups, annotations?, references?}`; each reference carries its `geometry` |
| Reference drawing source | import / drag-drop | `*.dxf` (ASCII), converted on import; the DXF itself isn't kept |
| App settings (snap per workspace, cut preview, filament) | `localStorage` | `modeler.settings.v1` |
| Shortcut overrides, hold keys | `localStorage` | `modeler.keymap.v1` |
| Last sidebar tab | `localStorage` | `modeler.sidebarTab` |
| Current file + recent files (file handles) | IndexedDB | database `modeler`, store `files`, keys `current`, `recent` |

Loading is defensive (`parseDocumentFile`):
- invalid entities are dropped and duplicate ids re-issued;
- references to missing groups are removed, and empty groups pruned;
- unknown workspaces or printers fall back to defaults;
- malformed reference drawings or paths are dropped;
- malformed annotations, and annotations attached to missing parts, are dropped.

If the autosave doesn't fit in `localStorage` (a large reference drawing), it is saved without reference drawings and the user is told once to save the project.

## Invariants

These must hold after every committed change. The Modeler API enforces them in `validateEntity` (`src/api/core.ts`).

1. All lengths are finite and in mm; sizes, radius and height are > 0; extrusion outlines have ≥ 3 points and non-zero area.
2. Entity ids are unique strings; names are non-empty.
3. Stored numbers are clean (`cleanNumber` / `cleanVec`): no `599.9999999` in the properties panel or cut list.
4. One user action, or one AI turn, is **one undo step**.
5. The model layer (`src/model`) never imports from `viewport`, `ui`, `tools`, `api` or the DOM, and `src/api` imports only `src/model`.
6. Every group has at least one member (directly or through subgroups); `groupId` / `parentId` never point at missing groups.
7. Reference drawings and annotations never affect the model: tools, CSG, cut lists, quantities and exports read `doc.entities` only.
8. Every annotation's part anchors point at existing parts.

## Module map

```
mcp/                  MCP server (Node), bundled to mcp/dist by npm run build:mcp — see mcp/README.md
  src/main.ts, server.ts, bridge.ts, files.ts
src/
  main.ts             entry; creates App, exposes window.modeler (debug + smoke test)
  App.ts              layout, toolbar, workspace switching, keyboard/pointer routing, runCommand
  commands.ts         bindable command list + default keys
  keymap.ts           combo parsing/display, conflicts, persistence (pure, unit-tested)
  api/                Modeler API (DOM-free, unit-tested) — see docs/modeler-api.md
    schemas.ts, core.ts, operations.ts, ModelerApi.ts, reference.ts
    guide.ts            how an AI should use the API (MCP instructions / system prompt)
  bridge/             live link to the MCP server (ADR 0013)
    protocol.ts         message types, port, protocol version (DOM-free, shared with mcp/)
    BridgeClient.ts     the tab side: dials out on "Connect AI", runs requests on the API
  model/              DOM-free domain layer (unit-tested)
    types.ts            Entity, Group, DocumentFile, Unit
    Document.ts         ModelDocument: entities, groups, selection, transactions, undo, events
    groups.ts           group membership helpers (selection units, pruning, nesting)
    editing.ts          copyEntities (shared by the API and the Move tool)
    naming.ts           "Shelf" → "Shelf 2"
    quantities.ts       footprints and CSG volumes
    geometry.ts         meshes from entities, bounds, snap points, faces, push/pull, drawing planes
    csg.ts              hole subtraction (engine choice + three-bvh-csg fallback), world geometry for export
    manifold.ts         the Manifold engine: load, mesh ↔ Manifold, subtract/union, volume
    units.ts            parse/format lengths and angles
    cutlist.ts          cut list grouping + CSV
    io.ts               file parse/validate, STL export, autosave, settings
    clipboard.ts        copy/paste format: copyParts, paste placement, fresh ids (ADR 0023)
    parts.ts            components (linked copies, syncComponents) and part properties (ADR 0025)
    gltf.ts             GLB export (own DOM-free writer, ADR 0020)
    dxf.ts              ASCII DXF → reference-drawing geometry (blocks, bulges, OCS)
    references.ts       reference drawings: placement matrix, bounds, snap points, validation
    annotations.ts      notes/dimensions: anchors, dimension geometry, pruning, validation
    instructions.ts     build-instructions booklet: part letters, suggested/stored steps (ADR 0021)
    shapes.ts           meshes for rounded boxes, spheres, revolves, tubes; outward-winding check
    explode.ts          exploded-view offsets per unit (display only)
    workspaces.ts       workspace configs, printers, fit check, volume
  ui/ProjectFiles.ts  project files: open/save in place, Save As, recent files, download fallback
  viewport/           Three.js rendering + picking
    Viewport.ts         scene, cameras, zoom, entity→mesh sync, styles, picking, highlights
    Snapper.ts          inference engine
    Grid.ts, SceneHelpers.ts, edges.ts, overlay.ts
  tools/              interactive tools (Tool base + one class per tool)
  ui/                 Sidebar (Properties/Print/Quantities/Cut list/Objects tree), ShortcutsDialog, ContextMenu, icons, dom helper
tests/                vitest unit tests: model, api (+ generated reference check), keymap, edges
scripts/smoke.mjs     end-to-end test driving the real UI in headless Chrome
```
