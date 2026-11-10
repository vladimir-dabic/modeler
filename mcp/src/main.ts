/// <reference types="node" />
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parse, resolve } from 'node:path';
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
const origins = values.origin ?? (process.env.MODELER_ORIGINS ? process.env.MODELER_ORIGINS.split(',').map((s) => s.trim()) : DEFAULT_ORIGINS);

const files = await NodeFileHost.create(root);
let bridge: BridgeServer | undefined;
let bridgeStatus = 'off (--no-bridge)';
if (!values['no-bridge']) {
  bridge = new BridgeServer({ port, origins, log });
  try {
    await bridge.start();
    bridgeStatus = `listening on ws://127.0.0.1:${port}; allowed app origins: ${origins.join(', ')}`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    bridgeStatus = `unavailable: ${code === 'EADDRINUSE' ? `port ${port} is in use (is another modeler MCP server running?)` : (err as Error).message}`;
    bridge = undefined;
  }
}
log(`working folder ${root}; bridge ${bridgeStatus}`);

const { server } = createModelerServer({ files, bridge, bridgeStatus });
const shutdown = async () => {
  await bridge?.close();
  process.exit(0);
};
server.onclose = () => void shutdown();
process.stdin.on('close', () => void shutdown());
await server.connect(new StdioServerTransport());
