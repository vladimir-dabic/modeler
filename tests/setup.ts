import { initManifold } from '../src/model/manifold';

// Every test runs with the Manifold engine loaded, as the app and the MCP server do
// (ADR 0017). Tests that need the fallback engine switch with setCsgEngine('bvh').
await initManifold();
