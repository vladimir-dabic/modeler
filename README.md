# Modeler

A prompt-first 3D modeler for makers (hobbyists, home DIY, semi-pros): describe what you want to Claude, get an exact model, a cut list and a build booklet. **3D-printed parts**, **furniture and metal frames**, **buildings**.

- **Draw like SketchUp:** Box, Cylinder, Line/Shape, Push/Pull, Move/Copy, Rotate, Tape. Smart snapping, and you type exact sizes while you draw (`600,400` ↵ `18` ↵).
- **Three workspaces:**
  - **Print:** your printer's bed, a fit check, *Place on plate*, volume and filament weight, STL;
  - **Workshop:** wood materials, cut list CSV;
  - **Build:** metres, a person for scale, areas and volumes.
- **Holes:** push a circle into a face to drill it. Holes stay editable and are cut in the STL.
- **Comfortable navigation:** zoom at the cursor that never passes through surfaces, hold Shift to pan or Alt to orbit with any tool, and fully customisable shortcuts (`?`).
- **Designed for AI:** every change goes through one typed Modeler API, used by the UI, an MCP server (Claude Code / Claude Desktop can build in the open app: click **Connect AI**; see [mcp/README.md](mcp/README.md)) and, next, an in-app assistant.

## Quick start

**Use it with Claude (or another MCP client):** one package has the app and the MCP server.

```bash
claude mcp add -s user modeler -- npx -y modeler-mcp --root "$HOME/Models"
```

Open http://127.0.0.1:47830, click **Connect AI**, and ask Claude to build something. More clients: [mcp/README.md](mcp/README.md).

**Develop:**

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm test           # unit tests
npm run smoke      # end-to-end test in headless Chrome (dev server must be running)
npm run build      # type-check + production build
npm run build:mcp  # bundle the MCP server (mcp/dist/modeler-mcp.mjs)
npm run serve      # build everything and run the server that serves the app (like the npm package)
npm run check:pack # pack the npm package and test it from an empty folder
```

## Documentation

| | |
|---|---|
| [User guide](docs/user-guide.md) | workspaces, tools, typing measurements, navigation, shortcuts, files |
| [Architecture](docs/architecture.md) | how it's built: layers, data flow, invariants, module map |
| [Modeler API](docs/modeler-api.md) | the operation layer the UI, AI assistant and MCP share |
| [AI integration](docs/ai-integration.md) | in-app assistant + MCP server design |
| [Development](docs/development.md) | setup, testing, conventions, recipes |
| [Roadmap](docs/roadmap.md) | what's next |
| [Decisions (ADRs)](docs/adr/README.md) | why things are the way they are |

Built with Vite, TypeScript and Three.js (no UI framework); geometry (holes, booleans) by [Manifold](https://github.com/elalish/manifold), with [three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg) as a fallback.
