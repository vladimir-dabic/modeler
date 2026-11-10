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
| `npm run typecheck` | `tsc --noEmit` over `src`, `tests`, `vite.config.ts` |
| `npm run build` | type-check + production build into `dist/` |

`window.modeler` is the live `App` instance in the browser console. It's useful for debugging (`modeler.doc.entities`, `modeler.viewport.zoomExtents()`) and is what the smoke test uses.

## Testing strategy

| Layer | How it's tested |
|---|---|
| `src/model/*`, `src/keymap.ts`, `src/viewport/edges.ts` | **Unit tests** (`tests/*.test.ts`). Pure functions, fast; add a test with every change |
| Tools, viewport, UI wiring | **Smoke test** (`scripts/smoke.mjs`). Real mouse and keyboard in headless Chrome; asserts on `window.modeler.doc` |
| Visual changes | Run `node scripts/smoke.mjs <dir>` or a small Playwright script and **look at the screenshots** |
| Modeler API (planned) | Unit tests per operation + scenario tests replaying AI-style call sequences |

Before calling a change done: `npm run typecheck && npm test && npm run smoke` (with the dev server running).

## Conventions

- **mm, Z-up, degrees** everywhere in the model. Convert only for display (`formatLength` / `parseLength`).
- **Clean numbers:** store results through `cleanNumber` / `cleanVec`, so the UI shows `600`, not `599.9999999`.
- **Model layer stays DOM-free:** nothing in `src/model` imports from `viewport`, `ui`, `tools` or browser globals (the exception is `localStorage` helpers in `io.ts`, guarded by try/catch). The planned `src/api` follows the same rule.
- **All model changes go through `ModelDocument`** (and, once it exists, the Modeler API): `begin`/`commit`/`cancel`, `transact`, `add`/`remove`/`update`. One user action = one undo step.
- **No hard-coded shortcuts.** Every action is a command in `src/commands.ts`, run via `App.runCommand`.
- **Workspace behaviour comes from configuration** (`WORKSPACES[...]`, `app.workspace`, `ctx.workspace()`), not from scattered `if (workspace === 'print')` checks.
- **Comments explain *why*,** not what. User-facing text is plain and specific ("is 300 mm tall — the printer reaches 256 mm").
- **Docs move with the code:** see [docs/README.md](README.md#keeping-these-docs-current).

## Recipes

### Add a Modeler API operation (planned layer)

1. Define the input schema and an AI-oriented description ([how to write it](modeler-api.md#writing-operation-descriptions-for-ai-readers)).
2. Implement `run` against `ModelDocument` inside a transaction, validating the final state.
3. Return a `ChangeSummary` and warnings; use the shared error codes with a recovery hint.
4. Unit-test valid input, each error, and undo.
5. Add it to the catalogue in [modeler-api.md](modeler-api.md). It's now automatically available to the UI, the assistant and MCP.

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

1. Extend `types.ts`.
2. Update `geometry.ts`: `buildLocalGeometry`, `localBounds`, `snapPoints`, `classifyFace`, `applyPushPull`.
3. Update `io.ts` (`parseEntity`), `cutlist.ts`, the Sidebar properties, and (when it exists) the API schemas.
4. Add unit tests, plus a record in the ADR log if it changes the modeling approach.

### Add a workspace setting

Add the field to `WorkspaceConfig` in `src/model/workspaces.ts`, fill it for all three workspaces, apply it in `App.applyWorkspace`, and extend `tests/workspaces.test.ts`.

### Record a decision

Copy [adr/0000-template.md](adr/0000-template.md) to the next number, fill it in, and add it to the index in [adr/README.md](adr/README.md).
