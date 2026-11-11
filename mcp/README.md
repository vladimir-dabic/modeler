# modeler-mcp

An MCP server that lets Claude (Claude Code, Claude Desktop, or any MCP client) model in Modeler. It exposes every [Modeler API](../docs/api-reference.md) operation as an MCP tool, with the same names, JSON Schemas and descriptions, plus `connection_status`. Design: [docs/ai-integration.md](../docs/ai-integration.md), decisions: [ADR 0013](../docs/adr/0013-mcp-server-bridge-and-files.md).

## Two modes

| | Live | Headless |
|---|---|---|
| When | the app is open and you clicked **Connect AI** | no app connected |
| Calls edit | the model in your browser tab, as labelled undo steps (`AI: …`) | the server's own in-memory model |
| `render_views` | yes (PNG images) | `unsupported` |
| `open_file` / `save_file` / `export_stl` / `import_dxf` | yes: they run in the server on the tab's model | yes |

File paths are relative to the server's **working folder** (`--root`, default: the folder it was started in). Paths outside it are refused. Only `.json` project files and `.stl` files are written; `.dxf` files are read by `import_dxf`.

## Build

You don't need to build by hand: `mcp/run.mjs` (what Claude runs) rebuilds the bundle by itself when the code changed, then starts it. To build explicitly:

```bash
npm install
npm run build:mcp      # → mcp/dist/modeler-mcp.mjs + manifold.wasm (the geometry engine; keep them together)
```

## Set up Claude Code

From the repo folder:

```bash
claude mcp add -s user modeler -- node "$PWD/mcp/run.mjs" --root "$HOME/Models"
```

`-s user` makes it available in every project. Use any folder you like for `--root` (it must exist). Then `npm run dev`, open http://localhost:5173, click **Connect AI** in the top bar, and ask Claude e.g. *"build a bookcase with 4 shelves in the open modeler"*.

Headless, without the app: *"make a 60×40×20 mm box with four M3 holes in the corners and export box.stl"*.

With a plan in the working folder: *"import kitchen.dxf and put 600 mm base cabinets along the back wall"*. Claude reads the plan's lines with `get_reference`.

## Set up Claude Desktop

Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config), with absolute paths:

```json
{
  "mcpServers": {
    "modeler": {
      "command": "node",
      "args": ["/path/to/modeler/mcp/run.mjs", "--root", "/path/to/your/models"]
    }
  }
}
```

Always pass `--root` here, because Claude Desktop starts servers from an arbitrary folder.

## Managing the server

Claude starts the server itself, **once per session**, and stops it when the session ends. You never run it in a terminal yourself.

| I want to… | Claude Code | Claude Desktop |
|---|---|---|
| **Use the latest tools after an update** | `/mcp` → *modeler* → **Reconnect** (or start a new session) | Quit and reopen the app |
| See whether it runs, and its tools | `/mcp`, or `claude mcp list` | Settings → Developer |
| Stop it for now | `/mcp` → *modeler* → **Disable** (Enable brings it back) | Remove it from the config and restart |
| Remove it for good | `claude mcp remove modeler -s user` | Remove it from `claude_desktop_config.json` |

- **Why a restart is needed:** a running server keeps the code it started with. Rebuilding the file doesn't change a process that's already running. Restarting through `run.mjs` rebuilds if the code changed and starts fresh, so **Reconnect is the only step**.
- **Claude can tell when it's out of date:** `connection_status` reports when the running server was built, plus `update_available` when newer modeler code is on disk.
- **Two sessions at once:** both get a server, but only the first owns the live bridge to the app (port 47830). The other works headless and says so in `connection_status`. Close the extra session, or Reconnect in the one you want live.
- **Stray process** (rare, e.g. after a crash): `pgrep -fl modeler-mcp` lists them; `kill <pid>` stops one. Claude restarts the server on its next use.

**Upgrading from the first setup:** older instructions registered `mcp/dist/modeler-mcp.mjs` directly. That still works, but needs `npm run build:mcp` after every update. Switch to the launcher once:

```bash
claude mcp remove modeler -s user
claude mcp add -s user modeler -- node /Users/you/dev/AI/modeler/mcp/run.mjs --root /Users/you/Models
```

## Options

| Option | Env variable | Default | |
|---|---|---|---|
| `--root DIR` | `MODELER_ROOT` | current folder | working folder for files |
| `--port N` | `MODELER_BRIDGE_PORT` | 47830 | live-bridge port. If you change it, open the app with `?aiPort=N` |
| `--origin URL` (repeatable) | `MODELER_ORIGINS` (comma-separated) | `http://localhost:5173`, `http://127.0.0.1:5173`, and the same on 4173 | app origins allowed to connect |
| `--no-bridge` | | | headless only |

Logs go to stderr (stdout carries MCP messages).

## Notes

- **Only one server can own the bridge port.** If both Claude Desktop and Claude Code run the server, the second one runs headless-only; `connection_status` shows this.
- **The app connects to whichever server owns the port.** If you restart Claude, the app reconnects on its own while the button says *Waiting for AI…*.
- **A second tab that connects takes over** from the first one.

## Code

| File | |
|---|---|
| `src/main.ts` | CLI: options, starts the bridge, MCP over stdio |
| `src/server.ts` | MCP tools ↔ Modeler API; routing between the tab and the headless document |
| `src/bridge.ts` | WebSocket server: origin/host checks, one tab, request/response |
| `src/files.ts` | `NodeFileHost`: file access limited to the working folder |
| `build.mjs` | esbuild bundle |

The app side is `src/bridge/BridgeClient.ts`, and the message types live in `src/bridge/protocol.ts`. Tests: `tests/mcp.test.ts` (in-process, both modes) and step 17 of `scripts/smoke.mjs` (the built bundle over stdio, driving a real tab).
