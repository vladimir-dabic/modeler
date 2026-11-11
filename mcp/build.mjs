// Bundles the MCP server (and the parts of src/ it uses) into mcp/dist/modeler-mcp.mjs plus
// manifold.wasm, which run with plain `node` (ADR 0013, 0017). `npm run build:mcp` runs it;
// mcp/run.mjs calls buildMcp() when the sources changed. Logs go to stderr, because the
// server's stdout carries MCP messages.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildMcp() {
  mkdirSync(join(repo, 'mcp/dist'), { recursive: true });
  await build({
    entryPoints: [join(repo, 'mcp/src/main.ts')],
    outfile: join(repo, 'mcp/dist/modeler-mcp.mjs'),
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
  // The geometry engine's WebAssembly sits next to the bundle (ADR 0017).
  copyFileSync(join(repo, 'node_modules/manifold-3d/manifold.wasm'), join(repo, 'mcp/dist/manifold.wasm'));
}

// Run directly (npm run build:mcp).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildMcp();
  console.error('built mcp/dist/modeler-mcp.mjs (+ manifold.wasm)');
}
