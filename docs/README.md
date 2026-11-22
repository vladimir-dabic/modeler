# Modeler documentation

| Document | What it covers | Read it when |
|---|---|---|
| [User guide](user-guide.md) | Workspaces, tools, typing measurements, navigation, shortcuts, files | You want to *use* the app |
| [Architecture](architecture.md) | Layers, data flow, key concepts, invariants, module map | You're changing code, or want to know how it works |
| [Modeler API](modeler-api.md) | The typed operation layer that the UI, the AI chat and MCP all use | You're adding a feature or an AI capability |
| [API reference](api-reference.md) | Every operation and its fields (generated from code) | You're calling the API |
| [AI integration](ai-integration.md) | The in-app assistant panel and the MCP server: design and phases | You're working on AI features |
| [Development](development.md) | Setup, scripts, testing, conventions, step-by-step recipes | You're about to write code |
| [Roadmap](roadmap.md) | What's planned, roughly in order | You're deciding what to do next |
| [Architecture decisions (ADRs)](adr/README.md) | Why things are the way they are, one decision per file | You're about to change something fundamental |

## The one-paragraph version

Modeler is a SketchUp-style 3D modeler that runs in the browser. Instead of a mesh, it stores **parametric entities** (boxes, cylinders, extruded outlines) in **millimetres, Z-up**. Parts can be **holes** that cut into solids. There are three **workspaces**: Print (3D printing), Workshop (woodworking) and Build (houses). They tune units, snapping, materials and panels for each scale of work. Every change to the model is a **transaction** on one `ModelDocument`. The guiding principle (ADR 0008): **the modeler is an API**. The UI, the in-app AI assistant and the MCP server all change the model through the same typed operations. It is made for hobbyists, home makers and semi-professionals who prompt their way from an idea to something they can build (ADR 0024): buildable output and automatic checks come before richer modelling.

## Keeping these docs current

Docs are part of the change. If a change alters behaviour or structure:

- update the affected guide in the same change;
- if it changes a **decision** (not just code), add a new ADR, or mark the old one *Superseded by ADR-NNNN*. Never silently rewrite an accepted ADR.
