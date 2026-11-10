# Modeler: notes for working on this repo

SketchUp-style browser modeler (Vite + TS + Three.js, no UI framework). **Read [docs/README.md](docs/README.md) first.** Architecture: [docs/architecture.md](docs/architecture.md). Decisions: [docs/adr/](docs/adr/README.md).

## Guiding principle: the modeler is an API

The UI, the in-app AI assistant and the MCP server are all clients of one typed, validated **Modeler API** in `src/api` ([ADR 0008](docs/adr/0008-modeler-api-single-entry-point.md), design: [docs/modeler-api.md](docs/modeler-api.md), generated reference: [docs/api-reference.md](docs/api-reference.md)).
- New model-changing features start as an API operation (schema + AI-readable description + run + tests), then get UI on top via `app.uiCall`. After changing operations run `npm run docs:api` (a test fails if the reference is stale).
- Keep it token-efficient (ADR 0010): selectors, patterns, intent-level operations, compact results.
- Keep `src/model`, `src/api` and `src/bridge/protocol.ts` DOM-free: the MCP server runs them in Node.
- Operation names and schemas are a contract: change them additively; renames need an ADR.

## Commands
- `npm run dev`: dev server on :5173.
- `npm test`: vitest unit tests in `tests/`.
- `npm run smoke`: Playwright drives the real UI in headless system Chrome. Needs the dev server running. Run it after changing tools, viewport or UI wiring.
- `npm run typecheck` / `npm run build`.
- `npm run build:mcp`: bundles the MCP server (`mcp/`, [mcp/README.md](mcp/README.md)) to `mcp/dist/modeler-mcp.mjs`. Rebuild after changing `src/api`/`src/model`/`mcp/src`. MCP tests: `tests/mcp.test.ts`; the smoke test also drives the built bundle.

## Conventions (details in docs/development.md)
- **Units:** world is **Z-up, millimetres**; rotations are Euler XYZ in degrees. Store clean numbers (`cleanNumber` / `cleanVec`).
- **Model changes:** UI code goes through the API; only interactive tools mutate `ModelDocument` directly inside a transaction. One user action or AI turn = one undo step.
- **Groups:** flat membership (`groupId` / `parentId`, no transforms), helpers in `src/model/groups.ts`. Tools pick whole units via `Tool.unitOf`.
- **Shortcuts:** never hard-code them. Add commands to `src/commands.ts` and handle them in `App.runCommand`. Reserved keys are enforced by `reservedReason` in `keymap.ts`.
- **Workspaces:** they are configuration (`src/model/workspaces.ts`). Read `app.workspace` / `ctx.workspace()` instead of branching on ids. `doc.workspace` / `doc.printer` are document settings, not undoable.
- **Hold-to-pan/orbit:** handled in `App` (`tempNav` / `heldKey`). A short tap of a hold key is forwarded to the active tool.
- **Debugging:** `window.modeler` exposes the App instance, for debugging and for the smoke test.

## Docs are part of every change
Update the affected doc in the same change. A changed *decision* gets a new ADR (copy `docs/adr/0000-template.md`) and the old one is marked superseded, never silently edited. Step-by-step recipes (add a tool / command / entity kind / API operation): [docs/development.md](docs/development.md#recipes).
