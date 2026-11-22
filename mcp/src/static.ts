/// <reference types="node" />
import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

/**
 * Serves the built web app from the MCP package (ADR 0026), so one install gives both:
 * `npx modeler-mcp`, open http://127.0.0.1:47830, click Connect AI. Only GET/HEAD, only
 * files inside the app folder, only for a localhost Host (like the bridge, against DNS
 * rebinding). Unknown paths get index.html.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

export function serveStatic(appDir: string, req: IncomingMessage, res: ServerResponse): void {
  if (!LOCAL_HOST.test(req.headers.host ?? '')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  const root = normalize(appDir + sep);
  let file = normalize(join(root, path));
  if (!file.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  let info = statSync(file, { throwIfNoEntry: false });
  if (info?.isDirectory()) {
    file = join(file, 'index.html');
    info = statSync(file, { throwIfNoEntry: false });
  }
  if (!info?.isFile()) {
    // An app route, or a missing asset: the app itself (assets 404 properly).
    if (extname(path)) {
      res.writeHead(404).end('Not found');
      return;
    }
    file = join(root, 'index.html');
    info = statSync(file, { throwIfNoEntry: false });
    if (!info?.isFile()) {
      res.writeHead(404).end('The app is not built into this package');
      return;
    }
  }
  const hashed = /[-.][A-Za-z0-9_-]{8,}\.(js|css|wasm)$/.test(file);
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
}
