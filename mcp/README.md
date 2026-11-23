# Modeler

A prompt-first 3D modeler for makers: hobbyists, home DIY and semi-pros. Describe what you want to Claude (or another AI client), watch it appear in the app, and end up with an exact model, a cut list and a build booklet you can print or send to a craftsman. For **furniture and metal frames**, **3D-printed parts** and **small buildings**.

## What it does

- **Model by prompt or by hand.** Every change goes through one typed Modeler API, used by the UI and by an MCP server: Claude Code, Claude Desktop, Cursor, VS Code and other MCP clients can build in the open app (click **Connect AI**). By hand: Box, Cylinder, Sphere, Line/Shape, Push/Pull, Move/Copy, Rotate and Tape, with smart snapping, and you type exact sizes while you draw (`600,400` ↵ `18` ↵).
- **Exact geometry.** Holes cut like drilling (push a circle into a face), plus round and smooth shapes: cones, spheres, revolved profiles, tubes along a path, rounded boxes. Geometry by [Manifold](https://github.com/elalish/manifold).
- **Parts that know what they are.** Linked copies (components: edit one leg, all four follow), and material, finish, edge banding and part numbers on every part.
- **From model to making.**
  - cut list (CSV), by material and edge banding;
  - a build booklet in the style of flat-pack instructions: lettered parts with pictures, steps with arrows, print or save as PDF, in English or Serbian;
  - exploded view of every part, notes and dimensions that follow the parts;
  - STL for 3D printing (fused, watertight, splittable with pegs) and GLB for SketchUp, Blender and renderers.
- **Three workspaces:** *Print* (your printer's bed, fit check, filament weight), *Workshop* (boards in real sizes) and *Build* (metres, a person for scale, areas and volumes).
- **Comfortable.** Zoom at the cursor, hold Shift to pan or Alt to orbit with any tool, customisable shortcuts (`?`), save in place, import a DXF plan to build on, copy and paste between browser tabs.

## Quick start

**Use it with Claude (or another MCP client):** one package has the app and the MCP server (Node 20 or newer).

```bash
claude mcp add -s user modeler -- npx -y modeler-mcp --root "$HOME/Models"
```

Open http://127.0.0.1:47830, click **Connect AI**, and ask Claude to build something, e.g. *"a coffee table 90×60 with a black steel frame, then write the build instructions"*. Other clients and options: [docs/mcp.md](docs/mcp.md).

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
| [MCP server](docs/mcp.md) | install, clients, options, how the live bridge works |
| [Modeler API](docs/modeler-api.md) | the operation layer the UI and the AI share |
| [API reference](docs/api-reference.md) | every operation and its fields (generated from code) |
| [Architecture](docs/architecture.md) | layers, data flow, invariants, module map |
| [AI integration](docs/ai-integration.md) | the MCP server and the planned in-app assistant |
| [Development](docs/development.md) | setup, testing, conventions, recipes |

Docs are part of every change: update the affected guide in the same change. Comments and docs mention "ADR NNNN"; those are the project's decision records, kept by the maintainer outside this repository.

## License

[AGPL-3.0](LICENSE). Third-party components and their licenses: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
