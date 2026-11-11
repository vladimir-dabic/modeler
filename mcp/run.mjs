#!/usr/bin/env node
// Starts the modeler MCP server: rebuilds the bundle first if any of its sources changed,
// then runs it. Point Claude Code / Claude Desktop at this file, and a restart of the MCP
// server is all it takes to pick up new tools. Logs go to stderr (stdout carries MCP).
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(repo, 'mcp/dist/modeler-mcp.mjs');
const SOURCES = ['src/api', 'src/model', 'src/bridge', 'mcp/src', 'mcp/build.mjs', 'package-lock.json'];

/** Newest modification time under the server's sources. */
function newest(path) {
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info) return 0;
  if (!info.isDirectory()) return info.mtimeMs;
  return Math.max(0, ...readdirSync(path).map((name) => newest(join(path, name))));
}

const built = statSync(bundle, { throwIfNoEntry: false })?.mtimeMs ?? 0;
const changed = Math.max(...SOURCES.map((p) => newest(join(repo, p))));
if (changed > built) {
  process.stderr.write('[modeler-mcp] sources changed; rebuilding…\n');
  const { buildMcp } = await import('./build.mjs');
  await buildMcp();
}
await import(pathToFileURL(bundle).href);
