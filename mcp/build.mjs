// Bundles the MCP server (and the parts of src/ it uses) into mcp/dist/modeler-mcp.mjs plus
// manifold.wasm, which run with plain `node` (ADR 0013, 0017). `npm run build:mcp` runs it;
// mcp/run.mjs calls buildMcp() when the sources changed. Logs go to stderr, because the
// server's stdout carries MCP messages.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

const version = JSON.parse(readFileSync(join(repo, 'mcp/package.json'), 'utf8')).version;

/**
 * Bundle the server. With `withApp`, also copy the built web app (`npm run build` → dist/)
 * into mcp/dist/app, which the server then serves on the bridge port (ADR 0026).
 */
export async function buildMcp({ withApp = false } = {}) {
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
    define: { __MODELER_VERSION__: JSON.stringify(version) },
    logLevel: 'warning',
  });
  // The geometry engine's WebAssembly sits next to the bundle (ADR 0017).
  copyFileSync(join(repo, 'node_modules/manifold-3d/manifold.wasm'), join(repo, 'mcp/dist/manifold.wasm'));
  if (withApp) {
    if (!existsSync(join(repo, 'dist/index.html'))) throw new Error('Build the app first (npm run build)');
    rmSync(join(repo, 'mcp/dist/app'), { recursive: true, force: true });
    cpSync(join(repo, 'dist'), join(repo, 'mcp/dist/app'), { recursive: true });
  }
  // The package page shows the root README; the license files travel with the package (ADR 0026).
  if (withApp) for (const f of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) copyFileSync(join(repo, f), join(repo, 'mcp', f));
}

// Run directly (npm run build:mcp).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const withApp = process.argv.includes('--with-app');
  await buildMcp({ withApp });
  console.error(`built mcp/dist/modeler-mcp.mjs ${version} (+ manifold.wasm${withApp ? ', app' : ''})`);
}
