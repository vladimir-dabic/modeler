/// <reference types="node" />
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initManifold } from '../../src/model/manifold';
import { parseArgs } from 'node:util';
import { DEFAULT_BRIDGE_PORT } from '../../src/bridge/protocol';
import { BridgeServer, DEFAULT_ORIGINS } from './bridge';
import { NodeFileHost } from './files';
import { createModelerServer } from './server';

/**
 * `node mcp/dist/modeler-mcp.mjs [--root DIR] [--port N] [--origin URL]... [--no-bridge]`
 * stdout carries MCP messages only; logs go to stderr.
 */
const log = (msg: string) => process.stderr.write(`[modeler-mcp] ${msg}\n`);

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    port: { type: 'string' },
    origin: { type: 'string', multiple: true },
    'no-bridge': { type: 'boolean' },
  },
});

const root = resolve(values.root ?? process.env.MODELER_ROOT ?? process.cwd());
if (parse(root).root === root) {
  log(`refusing to use the filesystem root as the working folder; pass --root <folder>`);
  process.exit(1);
}
const port = Number(values.port ?? process.env.MODELER_BRIDGE_PORT ?? DEFAULT_BRIDGE_PORT);
// The web app, when this package was built with it (ADR 0026): served on the bridge port.
const here = dirname(fileURLToPath(import.meta.url));
const appDir = statSync(join(here, 'app', 'index.html'), { throwIfNoEntry: false }) ? join(here, 'app') : undefined;
const servedOrigins = appDir ? [`http://127.0.0.1:${port}`, `http://localhost:${port}`] : [];
const origins = [
  ...(values.origin ?? (process.env.MODELER_ORIGINS ? process.env.MODELER_ORIGINS.split(',').map((s) => s.trim()) : DEFAULT_ORIGINS)),
  ...servedOrigins,
];

// The geometry engine (ADR 0017); its WebAssembly is copied next to this bundle.
const engineOk = await initManifold(join(here, 'manifold.wasm'));
if (!engineOk) log('Manifold engine failed to load; using the fallback engine');
const files = await NodeFileHost.create(root);
let bridge: BridgeServer | undefined;
let bridgeStatus = 'off (--no-bridge)';
if (!values['no-bridge']) {
  bridge = new BridgeServer({ port, origins, appDir, log });
  try {
    await bridge.start();
    bridgeStatus = `listening on ws://127.0.0.1:${port}; allowed app origins: ${origins.join(', ')}${appDir ? `; the app is at http://127.0.0.1:${port}` : ''}`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    bridgeStatus = `unavailable: ${code === 'EADDRINUSE' ? `port ${port} is in use (is another modeler MCP server running?)` : (err as Error).message}`;
    bridge = undefined;
  }
}
log(`working folder ${root}; bridge ${bridgeStatus}`);

// Is the code on disk newer than this running server? (Then a restart picks it up.)
const self = fileURLToPath(import.meta.url);
const repo = join(dirname(self), '..', '..');
const builtAt = statSync(self).mtimeMs;
const newest = (path: string): number => {
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info) return 0;
  return info.isDirectory() ? Math.max(0, ...readdirSync(path).map((n) => newest(join(path, n)))) : info.mtimeMs;
};
// Installed from npm there are no sources next to it (and npm resets file times): nothing to compare.
const fromRepo = !!statSync(join(repo, 'src', 'api'), { throwIfNoEntry: false });
const buildInfo = () => {
  if (!fromRepo) return {};
  const changed = Math.max(...['src/api', 'src/model', 'src/bridge', 'mcp/src'].map((p) => newest(join(repo, p))));
  return {
    built: new Date(builtAt).toISOString(),
    ...(changed > builtAt ? { update_available: 'The modeler was updated after this server started. Restart the MCP server to load the new tools.' } : {}),
  };
};

const { server } = createModelerServer({ files, bridge, bridgeStatus, buildInfo });
const shutdown = async () => {
  await bridge?.close();
  process.exit(0);
};
server.onclose = () => void shutdown();
process.stdin.on('close', () => void shutdown());
await server.connect(new StdioServerTransport());
