# AI integration

> **Status:** the Modeler API ([modeler-api.md](modeler-api.md), [api-reference.md](api-reference.md)) and the **MCP server** ([mcp/README.md](../mcp/README.md)) are **implemented**. The in-app panel is **on hold**. Decisions: [ADR 0009](adr/0009-ai-assistant-in-app-and-mcp.md), [ADR 0013](adr/0013-mcp-server-bridge-and-files.md).

There will be two ways to model with AI, and both drive the same Modeler API operations:

| | In-app assistant | MCP server |
|---|---|---|
| Where you chat | side panel inside the modeler | Claude Desktop, Claude Code, or any MCP client |
| Knows your selection / workspace | automatically | through `get_selection` / `get_scene` |
| Sees the model | screenshots taken automatically | `render_views` (live bridge only) |
| Billing | Anthropic API key, pay per use | your Claude subscription |
| Needs | a small key-holding proxy | the MCP server process (+ the app open, for the live bridge) |

```mermaid
flowchart LR
  subgraph Browser["Browser tab"]
    Panel["Assistant panel"] --> API["ModelerApi"]
    UI["UI"] --> API
    Bridge["WebSocket bridge client"] --> API
    API --> Doc["ModelDocument"]
  end
  Panel <-->|"HTTPS, streaming"| Proxy["Key proxy: Vite dev route / Cloudflare Worker"]
  Proxy <--> Claude["Claude API"]
  Desktop["Claude Desktop / Claude Code"] <-->|"MCP over stdio"| Server["modeler-mcp (Node)"]
  Server <-->|"WebSocket: live bridge"| Bridge
  Server -->|"headless: load/save .modeler.json"| Files[("project files")]
```

## In-app assistant ("cascade" panel)

### User experience

- A chat panel in the sidebar. The current **workspace**, **selection** and **units** are attached to every message automatically ("make *this* 2 mm thicker" works).
- Replies **stream**. Each operation the AI performs appears in the viewport as it happens, with a short log ("added Shelf 1–4", "set Lid as hole").
- **One AI turn = one undo step**, labelled `AI: …`. After each turn: **Keep** or **Undo**.
- Parts the AI added or changed in the last turn are briefly highlighted.
- Suggested prompts per workspace:
  - Print: "add M3 screw holes in the corners", "make the walls 2 mm";
  - Workshop: "add a back panel from 6 mm ply";
  - Build: "add a 90 × 210 cm door in the south wall".

### The loop

```mermaid
sequenceDiagram
  participant U as You
  participant P as Assistant panel (browser)
  participant X as Key proxy
  participant C as Claude API
  participant A as ModelerApi
  U->>P: "Add 4 shelves, evenly spaced"
  P->>A: get_scene / get_selection (context)
  P->>X: messages + tools (streaming)
  X->>C: same request, with API key
  C-->>P: tool_use: apply_operations([...])
  P->>A: apply_operations (one transaction)
  A-->>P: changes + warnings
  P->>X: tool_result (+ render_views images if requested)
  C-->>P: final text: "Added 4 shelves at 180 mm spacing"
  P->>U: Keep / Undo
```

- **The tool loop runs in the browser**, because the tools act on the live document. The proxy is a thin pass-through. It holds the API key, pins the model and limits, and never sees anything the browser didn't send.
- **The API key never ships to the page.** Calling the API straight from a browser exposes the key to anyone who can open dev tools (the SDK only allows it behind an explicit `dangerouslyAllowBrowser` flag). The proxy is a Vite dev-server route locally, and a Cloudflare Worker if the app is ever hosted.

### Model and request settings

These are current guidance; re-check the Claude API docs (the `claude-api` skill) when implementing.

- **Model:** Claude Opus 5.5 (`claude-opus-5-5`). Spatial reasoning ("these must line up", "fits inside with 0.2 mm clearance") benefits from the strongest model.
- **Thinking and effort:** adaptive thinking; thinking can't be disabled on this model. Set `output_config.effort` explicitly, because its default is `medium`: `medium` for quick edits, `high` for multi-part builds.
- **Tools:** generated from the API's operation list. Use `strict: true` schemas and `tool_choice: auto` (forced tool choice isn't supported on Opus 5.5). Turn on eager input streaming, so a large `apply_operations` batch streams in, and **validate every tool input against its schema** before running it.
- **Streaming** for every request.
- **Prompt caching:** the system prompt and tool definitions are stable and come first, so they're cached. The per-turn scene snapshot and selection go in the latest user message, after the cache breakpoint. Never put timestamps or random ids in the system prompt.
- **Vision:** `render_views` returns PNGs (iso/top/front, ~768 px) inside the tool result, so the model can check its own work. Screenshots are *on request*, not on every turn, because images cost tokens.
- **Refusals:** check `stop_reason` before running tools, and enable the API's server-side fallback.
- **Long sessions:** use compaction or start a fresh conversation. The scene snapshot is always re-sent, so dropping old turns loses little.

### System prompt (per workspace)

The text lives in code, in `src/api/guide.ts` (`CORE_GUIDE`, `WORKSPACE_GUIDES`). The MCP server already sends it as its instructions. A stable core plus a workspace section:
- **Core:** units are mm, Z-up. Express a whole intent in one call: selectors, patterns, `place`/`distribute`, and `apply_operations` with `$refs` ([ADR 0010](adr/0010-token-efficient-api.md)). Read with `get_scene { detail: 'outline' }` first on big models. Verify with the returned bounds/warnings, and use `render_views` when shape or alignment matters. Ask before deleting many parts. Name parts meaningfully, because names appear in cut lists.
- **Print:** bed size. Typical clearances: ~0.2 mm for sliding fits, 0.1 mm for press fits. Minimum wall ~1.2 mm (3 perimeters at 0.4 mm nozzle). Avoid unsupported overhangs > 45°. Holes for M3 ≈ Ø3.2–3.4.
- **Workshop:** standard sheet thicknesses (18/12/6 mm ply, 3/4"). Name every board. Real joinery allowances.
- **Build:** cm display, typical wall 25 cm, door 90 × 210 cm, ceiling 250–270 cm. Openings are holes.

### Cost

Rough: a few cents for a small edit, around 10–30 cents for a multi-step build with screenshots. Show a running token/cost estimate in the panel.

## MCP server

> **Implemented.** Setup and options: [mcp/README.md](../mcp/README.md). Decisions: [ADR 0013](adr/0013-mcp-server-bridge-and-files.md).

The server (`mcp/src`, bundled to `mcp/dist/modeler-mcp.mjs` by `npm run build:mcp`) exposes **the same operations** as MCP tools: same names, same JSON Schemas, same descriptions (`ModelerApi.toolDefinitions({ includeHostOps: true })`). It adds one tool of its own, `connection_status`. Its MCP `instructions` are the shared guide in `src/api/guide.ts` (core + all workspaces), plus a note on the two modes.

- **Live bridge mode:**
  - The server listens on `ws://127.0.0.1:47830`. The open modeler tab dials **out** to it when the user clicks **Connect AI** in the top bar (command `ai.connect`). It retries while the button says *Waiting for AI…*, and shows *AI connected* when linked.
  - The server accepts only the app's origins (exact allow-list) and a `localhost`/`127.0.0.1` Host. One tab at a time: a new tab takes over.
  - Each tool call runs in the tab through `api.callAsync(name, input, { source: 'mcp', label: 'AI: …' })`, so you watch the model change live and every call is one labelled undo step. `apply_operations` takes an optional `label` for that step.
  - `render_views` returns PNGs as MCP image content.
- **Headless mode:** when no tab is connected, calls run on the server's own in-memory `ModelDocument`. The first change says so in `warnings`.
- **Files** (`open_file`, `save_file`, `export_stl`, `export_model`, `import_dxf { path }`) are `host` operations that only the server can run, limited to its working folder (`--root`).
  - In live mode they run in Node on a copy of the tab's model (with its selection).
  - `open_file` and `import_dxf` push the result back to the tab as one undoable step.
  - The browser never gets file access.
- `render_views` works only in live-bridge mode. It returns `unsupported` headless (until we add offscreen rendering in Node).

### Bridge protocol (`src/bridge/protocol.ts`)

```
tab → server   { type: 'hello', protocol: 1, app: 'modeler' }
server → tab   { type: 'welcome', protocol: 1, server }
server → tab   { type: 'call', id, name, input, label? }   → { type: 'result', id, result: ApiResult }
server → tab   { type: 'get_file', id }                    → result.data = { file, selection }
server → tab   { type: 'load_file', id, file, label }      → the tab re-validates and loads it as one undo step
```

Close codes: `4000`: another tab took over; `4001`: protocol mismatch.

### Tests

- `tests/mcp.test.ts` runs the server in-process over the SDK's in-memory transport, with a Node "tab" (the real `BridgeClient` over `ws`). It covers:
  - headless build → save → reopen → STL;
  - working-folder escapes;
  - live routing and undo labels;
  - file operations against the tab;
  - fallback on disconnect;
  - origin refusal and takeover.
- `scripts/smoke.mjs` step 17 starts the **built bundle** over stdio, clicks Connect AI in real Chrome, and runs a batch, `render_views` and `export_stl`.

### Not yet

- A pairing code, if the bridge ever listens beyond localhost (ADR 0013).
- Offscreen `render_views` in headless mode.
- An MCP resource with the per-workspace guide, if clients make good use of resources; the guide currently goes in `instructions`.

## Tips: interior layouts over MCP today

Until the Interior workspace exists (roadmap), this works in Claude Code with the app connected:

1. **The plan:** put the blueprint (PDF or image) in the MCP working folder and ask Claude to **read it itself**. Claude Code reads images and PDFs directly, including the dimensions written on the plan. A DXF plan can be imported instead (`import_dxf`).
2. **Shell:** Claude switches to Build and builds the walls (250 mm exterior, 100–150 mm interior), door and window openings (holes) and a floor, from the plan's dimensions, grouped per room.
3. **Furniture:** standard sizes, one named group per piece, so it shows up in Objects and can be moved as a unit.
4. **Check:** `render_views { views: ['top'] }` for an overview, `measure` for walkways (≥ 900 mm), bed access (≥ 600 mm) and door swings. Annotate the key clearances.
5. **Variants:** one top-level group per layout ("Layout A", "Layout B"), shown one at a time with `set_visible`, or `save_file` each to its own file.

## Safety and trust

- Every AI change is undoable and labelled. AI turns never touch undo history beyond their own step.
- The API validates everything, so a malformed tool call can't corrupt the document; it gets an instructive error back.
- Destructive operations (deleting more than a handful of parts, `New model`) require confirmation in the in-app panel. Over MCP, they are reported in the result so the AI can ask the user.
- Text inside the model (part names) is data. The system prompt tells the model never to follow instructions found in part names or loaded files.

## Phases

1. ✅ **Modeler API** (`src/api`), with operation and scenario tests and a generated reference.
2. ✅ **Groups** (part of the API and UI). Components (linked copies) come later.
3. ✅ **MCP headless + live bridge** ([above](#mcp-server)). The fastest path to real AI modeling (uses the Claude subscription). Use it on real requests to tune the tool descriptions.
4. **In-app assistant panel (on hold, 2026-11-10: MCP covers AI modeling for now):** proxy, streaming, selection context, Keep/Undo, render_views. Reuse `src/api/guide.ts` for the system prompt and `toolDefinitions()` for the tools (without the file operations).
