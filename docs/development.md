# Development

## Setup

Needs Node 22+ and, for the smoke test, Google Chrome.

```bash
npm install
npm run dev          # http://localhost:5173 (hot reload)
```

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm test` | vitest unit tests in `tests/` (Node, no browser) |
| `npm run smoke` | end-to-end test: drives the real UI in headless Chrome. **Needs `npm run dev` running.** Screenshots go to `test-results/` (ignored); `node scripts/smoke.mjs <dir>` writes elsewhere |
| `npm run typecheck` | `tsc --noEmit` over `src`, `tests`, `mcp/src`, `vite.config.ts` |
| `npm run build` | type-check + production build into `dist/` |
| `npm run bench:csg` | old vs new geometry engine on representative scenes → `test-results/csg-bench.md` ([ADR 0017](adr/0017-manifold-geometry-engine.md)) |
| `npm run docs:api` | regenerate `docs/api-reference.md` from the operation definitions |
| `npm run build:mcp` | bundle the MCP server into `mcp/dist/modeler-mcp.mjs`. Usually not needed: `mcp/run.mjs` (what Claude runs) rebuilds when sources changed. A *running* server keeps its old code until it's restarted (`/mcp` → Reconnect). See [mcp/README.md](../mcp/README.md#managing-the-server) |

`window.modeler` is the live `App` instance in the browser console. It's useful for debugging (`modeler.doc.entities`, `modeler.viewport.zoomExtents()`) and is what the smoke test uses.

## Testing strategy

| Layer | How it's tested |
|---|---|
| `src/model/*`, `src/keymap.ts`, `src/viewport/edges.ts` | **Unit tests** (`tests/*.test.ts`). Pure functions, fast; add a test with every change |
| MCP server, bridge, file host | **`tests/mcp.test.ts`**: in-process server + a Node "tab" running the real `BridgeClient` |
| Tools, viewport, UI wiring | **Smoke test** (`scripts/smoke.mjs`). Real mouse and keyboard in headless Chrome; asserts on `window.modeler.doc` |
| Visual changes | Run `node scripts/smoke.mjs <dir>` or a small Playwright script and **look at the screenshots** |
| Modeler API (`src/api`) | `tests/api.test.ts`: per operation + scenario tests (e.g. the bookcase batch); `tests/api-reference.test.ts` keeps the generated reference current |

Before calling a change done: `npm run typecheck && npm test && npm run smoke` (with the dev server running).

## Conventions

- **mm, Z-up, degrees** everywhere in the model. Convert only for display (`formatLength` / `parseLength`).
- **Clean numbers:** store results through `cleanNumber` / `cleanVec`, so the UI shows `600`, not `599.9999999`.
- **Model layer stays DOM-free:** nothing in `src/model` imports from `viewport`, `ui`, `tools` or browser globals (the exception is `localStorage` helpers in `io.ts`, guarded by try/catch). `src/api` and `src/bridge/protocol.ts` follow the same rule; the MCP server (`mcp/`) imports them in Node.
- **Model changes from UI code go through the Modeler API** (`app.uiCall`). Only interactive tools mutate `ModelDocument` directly, inside a transaction, for live previews. One user action = one undo step.
- **No hard-coded shortcuts.** Every action is a command in `src/commands.ts`, run via `App.runCommand`.
- **Workspace behaviour comes from configuration** (`WORKSPACES[...]`, `app.workspace`, `ctx.workspace()`), not from scattered `if (workspace === 'print')` checks.
- **Comments explain *why*,** not what. User-facing text is plain and specific ("is 300 mm tall — the printer reaches 256 mm").
- **Docs move with the code:** see [docs/README.md](README.md#keeping-these-docs-current).

## Recipes

### Add a Modeler API operation

1. In `src/api/operations.ts`, add a `def({ name, kind, description, input, run })`:
   - the input schema uses the shared pieces in `schemas.ts` (`Target`, `Vec3`, `Size3`, `Pattern`…);
   - the description follows [the guidelines](modeler-api.md#writing-operation-descriptions-for-ai-readers).
2. In `run`:
   - resolve parts with `ctx.resolve(target)`;
   - mutate through `ctx.doc` (`add`, `update`, `remove`, `setGroups`);
   - throw `ApiError(code, message, hint)` for anything the caller can fix;
   - return `{ ids }` for write operations.

   The API handles the transaction, validation, rollback, change summary and warnings.
3. Add it to `OPERATIONS`, then unit-test it in `tests/api.test.ts` (success, each error, undo).
4. Run `npm run docs:api` to regenerate [api-reference.md](api-reference.md); a test fails if you forget.
5. If the UI needs it, call it with `app.uiCall(name, input, label)`. It's automatically available to the AI assistant and MCP (run `npm run build:mcp` so the bundled server picks it up).
6. If the AI should use it in a particular way, add a line to `src/api/guide.ts`.

### Add a command (keyboard-bindable action)

1. Add `{ id, label, category, keys }` to `src/commands.ts` (`keys: []` if it shouldn't have a default).
2. Handle the id in `App.runCommand`.
3. If a button triggers it, create the button with `withTitle(..., command)` so its tooltip shows the current key.

The shortcuts dialog picks it up automatically.

### Add a tool

1. Subclass `Tool` in `src/tools/`: implement `hint()`, the pointer handlers, and `value()` for typed input; override `busy` if it has non-transaction state.
2. Register it in `App.ts` (`tools`, `TOOLBAR`, `TOOL_NAMES`), add `tool.<id>` to `commands.ts`, and add an icon in `ui/icons.ts`.
3. Edit through a transaction: `doc.begin()` on the first click, mutate + `doc.touch()` while dragging, `doc.commit()` to finish, `cancel()` on Escape.
4. Add a smoke-test step.

### Add an entity kind

1. Extend `types.ts` (`EntityKind` and the `Entity` union). Then `npm run typecheck` lists most places that branch on kind.
2. **Geometry:**
   - complex meshes go in `shapes.ts` (closed, outward; `ensureOutward` fixes the winding);
   - `geometry.ts`: `buildLocalGeometry`, `localBounds`, `snapPoints`, `classifyFace` (return null if it can't push/pull), `applyPushPull`, `mirrorEntity`;
   - `csg.ts` `grownCutter`, so it can be a clean hole with the fallback engine (Manifold needs no growth). The mesh must be a closed solid, or Manifold rejects it.
3. **Silent defaults the compiler won't catch:**
   - `io.ts` `parseEntity`: unknown kinds are dropped from files;
   - `cutlist.ts`, `quantities.ts` (`footprintMm2`).
4. **API:**
   - an `add_…` operation;
   - the field → kinds table in `update_entity`;
   - `shapeText`, `entitySummary` and `validateEntity` in `core.ts`;
   - the `Kind` enum in `schemas.ts`;
   - then `npm run docs:api`.
5. **UI:** the `KIND_ICON` / `KIND_NAME` maps and the properties in `Sidebar.ts`, `KIND_LABEL` in `Document.ts`, an icon, and a tool if it needs one.
6. Unit tests (volume against the formula, outward faces, file round trip, mirror), a smoke step, and an ADR if it changes the modeling approach.

### Add a workspace setting

Add the field to `WorkspaceConfig` in `src/model/workspaces.ts`, fill it for all three workspaces, apply it in `App.applyWorkspace`, and extend `tests/workspaces.test.ts`.

### Record a decision

Copy [adr/0000-template.md](adr/0000-template.md) to the next number, fill it in, and add it to the index in [adr/README.md](adr/README.md).
