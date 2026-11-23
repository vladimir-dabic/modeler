import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BridgeServer } from '../mcp/src/bridge';

let dir: string;
let server: BridgeServer;
const get = (path: string, host = `127.0.0.1:${server.port}`, method = 'GET') =>
  new Promise<{ status: number; type?: string; body: string }>((resolve) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, method, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, type: res.headers['content-type'], body }));
    });
    req.end();
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'modeler-app-'));
  await mkdir(join(dir, 'app/assets'), { recursive: true });
  await writeFile(join(dir, 'app/index.html'), '<!doctype html><title>Modeler</title>');
  await writeFile(join(dir, 'app/assets/manifold-abcdef12.wasm'), 'wasm');
  await writeFile(join(dir, 'secret.txt'), 'outside');
  server = new BridgeServer({ port: 0, origins: [], appDir: join(dir, 'app') });
  await server.start();
});
afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

describe('MCP server serving the app (ADR 0026)', () => {
  it('serves the app, its assets and the bridge info on one port', async () => {
    const index = await get('/');
    expect(index).toMatchObject({ status: 200, type: 'text/html; charset=utf-8' });
    expect((await get('/some/app/route')).body).toContain('<title>Modeler');
    expect((await get('/assets/manifold-abcdef12.wasm')).type).toBe('application/wasm');
    expect((await get('/assets/missing.js')).status).toBe(404);
    expect(JSON.parse((await get('/modeler-bridge.json')).body)).toEqual({ app: 'modeler', protocol: 1, port: server.port });
  });

  it('refuses other hosts, other methods and paths outside the app', async () => {
    expect((await get('/', 'evil.example')).status).toBe(403);
    expect((await get('/', undefined, 'POST')).status).toBe(405);
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt']) {
      const r = await get(p);
      expect(r.body, p).not.toContain('outside');
    }
  });
});

describe('MCP bridge when its port is taken', () => {
  it('start() rejects with EADDRINUSE instead of crashing the process', async () => {
    const second = new BridgeServer({ port: server.port!, origins: [], appDir: join(dir, 'app') });
    await expect(second.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await second.close();
    // The first server still works.
    expect((await get('/')).status).toBe(200);
  });
});
