# Modeler

A SketchUp-style 3D modeler in the browser for **3D-printed parts**, **woodworking** and **buildings**: quick, exact and parametric.

- **Draw like SketchUp:** Box, Cylinder, Line/Shape, Push/Pull, Move/Copy, Rotate, Tape. Smart snapping, and you type exact sizes while you draw (`600,400` ↵ `18` ↵).
- **Three workspaces:**
  - **Print:** your printer's bed, a fit check, *Place on plate*, volume and filament weight, STL;
  - **Workshop:** wood materials, cut list CSV;
  - **Build:** metres, a person for scale, areas and volumes.
- **Holes:** push a circle into a face to drill it. Holes stay editable and are cut in the STL.
- **Comfortable navigation:** zoom at the cursor that never passes through surfaces, hold Shift to pan or Alt to orbit with any tool, and fully customisable shortcuts (`?`).
- **Designed for AI:** every change will go through one typed Modeler API, used by the UI, an in-app assistant and an MCP server (planned).

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm test           # unit tests
npm run smoke      # end-to-end test in headless Chrome (dev server must be running)
npm run build      # type-check + production build
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

Built with Vite, TypeScript and Three.js (no UI framework); CSG by [three-bvh-csg](https://github.com/gkjohnson/three-bvh-csg).
