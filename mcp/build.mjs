// Bundles the MCP server (and the parts of src/ it uses) into one file that runs with
// plain `node`, so MCP clients need no install step. See ADR 0013.
import { build } from 'esbuild';

await build({
  entryPoints: ['mcp/src/main.ts'],
  outfile: 'mcp/dist/modeler-mcp.mjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // Prefer ES module builds, so three-mesh-bvh / three-bvh-csg share one copy of three.
  mainFields: ['module', 'main'],
  // ws and other CommonJS dependencies call require() for Node built-ins.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  // Optional native speed-ups of ws; it works without them.
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
});
console.log('built mcp/dist/modeler-mcp.mjs');
