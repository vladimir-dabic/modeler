/// <reference types="node" />
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { BridgeServer } from '../mcp/src/bridge';
import { NodeFileHost } from '../mcp/src/files';
import { createModelerServer } from '../mcp/src/server';
import { ModelerApi } from '../src/api';
import { BridgeClient, type BridgeStatus, type SocketLike } from '../src/bridge/BridgeClient';
import { ModelDocument } from '../src/model/Document';
import { parseDocumentFile } from '../src/model/io';

const APP_ORIGIN = 'http://localhost:5173';

let dir: string;
const cleanups: (() => unknown)[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'modeler-mcp-'));
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  await rm(dir, { recursive: true, force: true });
});

async function connect(bridge?: BridgeServer) {
  const files = await NodeFileHost.create(dir);
  const { server, local } = createModelerServer({ files, bridge, bridgeStatus: bridge ? 'test bridge' : 'off' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(() => client.close());
  /** Call a tool; returns the parsed ApiResult JSON plus the raw MCP result. */
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const raw = await client.callTool({ name, arguments: args });
    const content = raw.content as { type: string; text?: string }[];
    return { ...JSON.parse(content[0].text!), isError: raw.isError === true, raw };
  };
  return { client, call, local, files };
}

async function until(cond: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function startBridge() {
  const bridge = new BridgeServer({ port: 0, origins: [APP_ORIGIN] });
  await bridge.start();
  cleanups.push(() => bridge.close());
  return bridge;
}

/** A modeler "tab" in Node: a document + API + the real BridgeClient over the ws package. */
function openTab(port: number, origin = APP_ORIGIN) {
  const doc = new ModelDocument();
  const api = new ModelerApi(doc);
  const statuses: { status: BridgeStatus; why?: string }[] = [];
  const client = new BridgeClient(api, {
    port,
    retryMs: 50,
    createSocket: (url) => new WebSocket(url, { origin }) as unknown as SocketLike,
    onStatus: (status, why) => statuses.push({ status, why }),
  });
  client.start();
  cleanups.push(() => client.stop());
  return { doc, api, client, statuses };
}

const PLAN_DXF = [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', 0, 'LWPOLYLINE', 8, 'Walls', 90, 4, 70, 1, 10, 0, 20, 0, 10, 4000, 20, 0, 10, 4000, 20, 3000, 10, 0, 20, 3000, 0, 'ENDSEC', 0, 'EOF'].join('\n');

const BOOKCASE = {
  label: 'bookcase',
  operations: [
    { name: 'add_box', input: { name: 'Left side', size: [18, 280, 900] }, as: 'left' },
    { name: 'add_box', input: { name: 'Right side', size: [18, 280, 900], position: [582, 0, 0] } },
    { name: 'add_box', input: { name: 'Shelf', size: [564, 280, 18], position: [18, 0, 0] }, as: 'shelf' },
    { name: 'duplicate', input: { target: { ids: ['$shelf'] }, pattern: { linear: { count: 4, step: [0, 0, 220] } } } },
    { name: 'group', input: { target: { all: true }, name: 'Bookcase' } },
  ],
};

describe('MCP server: tools', () => {
  it('exposes every API operation 1:1, plus connection_status', async () => {
    const { client, local } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names[0]).toBe('connection_status');
    expect(names.slice(1).sort()).toEqual(local.operations().map((op) => op.name).sort());
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
    const batch = tools.find((t) => t.name === 'apply_operations')!;
    expect(batch.description).toBe(local.operations().find((op) => op.name === 'apply_operations')!.description);
  });

  it('sends the modeling guide as server instructions', async () => {
    const { client } = await connect();
    const text = client.getInstructions() ?? '';
    expect(text).toMatch(/millimetres/);
    expect(text).toMatch(/apply_operations/);
    expect(text).toMatch(/headless/);
  });
});

describe('MCP server: headless mode', () => {
  it('builds, saves, reopens and exports an STL', async () => {
    const { call, local } = await connect();
    const status = await call('connection_status');
    expect(status.data.mode).toBe('headless');

    const built = await call('apply_operations', {
      label: 'case with holes',
      operations: [
        { name: 'add_box', input: { name: 'Case', size: [60, 40, 20] } },
        { name: 'add_cylinder', input: { name: 'M3', radius: 1.6, height: 30, position: [6, 6, -5], hole: true }, as: 'h' },
        { name: 'mirror', input: { target: { ids: ['$h'] }, plane: 'x', about: 30 } },
      ],
    });
    expect(built.ok).toBe(true);
    expect(built.warnings.join(' ')).toMatch(/server's own model/);
    expect(local.doc.undoLabel).toBe('AI: Case with holes');
    // The headless reminder appears once, not on every call.
    const second = await call('add_box', { name: 'Tab', size: [10, 10, 2], position: [60, 0, 0] });
    expect(second.warnings).toBeUndefined();

    const saved = await call('save_file', { path: 'parts/case.modeler.json' });
    expect(saved).toMatchObject({ ok: true, data: { path: join('parts', 'case.modeler.json'), parts: 4 } });
    const file = parseDocumentFile(await readFile(join(dir, 'parts/case.modeler.json'), 'utf8'));
    expect(file.entities.map((e) => e.name)).toEqual(['Case', 'M3', 'M3 2', 'Tab']);

    await call('delete_entities', { target: { all: true } });
    const opened = await call('open_file', { path: 'parts/case.modeler.json' });
    expect(opened).toMatchObject({ ok: true, data: { parts: 4 } });
    expect(local.doc.entities).toHaveLength(4);
    // save_file without a path writes back to the opened file.
    expect((await call('save_file')).data.path).toBe(join('parts', 'case.modeler.json'));

    const stl = await call('export_stl', { path: 'case.stl', target: { name: 'Case' } });
    expect(stl.ok).toBe(true);
    const bytes = await readFile(join(dir, 'case.stl'));
    expect(bytes.length).toBe(stl.data.bytes);
    expect(bytes.readUInt32LE(80)).toBe(stl.data.triangles);
    expect(stl.data.solids).toBe(1);

    const glb = await call('export_model', { path: 'case.glb' });
    expect(glb).toMatchObject({ ok: true, data: { format: 'glb', parts: 2 } });
    const glbBytes = await readFile(join(dir, 'case.glb'));
    expect(glbBytes.length).toBe(glb.data.bytes);
    expect(glbBytes.subarray(0, 4).toString()).toBe('glTF');
    expect((await call('export_model', { path: 'case.stl' })).error.message).toMatch(/\.glb/);
  });

  it('imports a DXF headless and saves it with the project', async () => {
    const { call, local } = await connect();
    await writeFile(join(dir, 'plan.dxf'), PLAN_DXF);
    expect((await call('import_dxf', { path: 'plan.dxf', name: 'Kitchen plan' })).ok).toBe(true);
    expect((await call('get_scene')).data.references[0]).toMatch(/"Kitchen plan" drawing 4000×3000 mm/);
    await call('save_file', { path: 'kitchen.modeler.json' });
    const file = parseDocumentFile(await readFile(join(dir, 'kitchen.modeler.json'), 'utf8'));
    expect(file.references?.[0].geometry.paths).toHaveLength(1);
    expect(local.doc.references).toHaveLength(1);
    expect((await call('import_dxf', { path: '../plan.dxf' })).error.message).toMatch(/outside/);
  });

  it('keeps files inside the working folder', async () => {
    const { call } = await connect();
    await call('add_box', { size: [10, 10, 10] });
    for (const path of ['../escape.json', '/etc/escape.json', 'a/../../escape.json']) {
      const r = await call('save_file', { path });
      expect(r.isError, path).toBe(true);
      expect(r.error.message).toMatch(/outside the working folder/);
    }
    // A symlink pointing outside is refused too.
    const outside = await mkdtemp(join(tmpdir(), 'modeler-outside-'));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await symlink(outside, join(dir, 'link'));
    expect((await call('save_file', { path: 'link/x.json' })).error.message).toMatch(/outside/);
    expect((await call('save_file', { path: 'link/sub/x.json' })).error.message).toMatch(/outside/);
    // Only project / STL extensions are written.
    expect((await call('save_file', { path: 'notes.txt' })).error.message).toMatch(/\.json/);
    expect((await call('export_stl', { path: 'model.json' })).error.message).toMatch(/\.stl/);
  });

  it('reports clear errors for bad files and missing capabilities', async () => {
    const { call } = await connect();
    await writeFile(join(dir, 'bad.json'), '{"hello": 1}');
    expect((await call('open_file', { path: 'bad.json' })).error.message).toMatch(/not a modeler project/);
    expect((await call('open_file', { path: 'missing.json' })).error.code).toBe('not_found');
    const render = await call('render_views', { views: ['iso'] });
    expect(render.isError).toBe(true);
    expect(render.error.code).toBe('unsupported');
    expect((await call('export_stl', { path: 'empty.stl' })).error.code).toBe('not_found');
  });
});

describe('MCP server: live bridge', () => {
  it('routes calls to the connected tab as labelled undo steps', async () => {
    const bridge = await startBridge();
    const { call, local } = await connect(bridge);
    const tab = openTab(bridge.port!);
    await until(() => tab.client.status === 'connected' && bridge.connected, 'tab to connect');

    expect((await call('connection_status')).data.mode).toBe('live');
    expect((await call('set_workspace', { workspace: 'workshop' })).ok).toBe(true);
    expect(tab.doc.workspace).toBe('workshop');
    const r = await call('apply_operations', BOOKCASE);
    expect(r.ok).toBe(true);
    expect(r.warnings).toBeUndefined();
    expect(tab.doc.entities).toHaveLength(6);
    expect(tab.doc.groups.map((g) => g.name)).toEqual(['Bookcase']);
    expect(tab.doc.undoLabel).toBe('AI: Bookcase');
    expect(local.doc.entities).toHaveLength(0); // the headless model is untouched

    await call('add_box', { name: 'Top', size: [600, 280, 18], position: [0, 0, 900] });
    expect(tab.doc.undoLabel).toBe('AI: Add box');
    expect((await call('undo')).ok).toBe(true);
    expect(tab.doc.entities).toHaveLength(6);

    // Errors come back as tool errors; nothing changes.
    const bad = await call('add_box', { size: [0, 10, 10] });
    expect(bad.isError).toBe(true);
    expect(tab.doc.entities).toHaveLength(6);
  });

  it('runs file operations in Node against the tab\'s model', async () => {
    const bridge = await startBridge();
    const { call } = await connect(bridge);
    const tab = openTab(bridge.port!);
    await until(() => bridge.connected, 'tab to connect');
    await call('apply_operations', BOOKCASE);

    expect((await call('save_file', { path: 'bookcase.modeler.json' })).data.parts).toBe(6);
    const saved = parseDocumentFile(await readFile(join(dir, 'bookcase.modeler.json'), 'utf8'));
    expect(saved.entities).toHaveLength(6);

    // export_stl sees the tab's selection.
    await call('set_selection', { target: { name: 'Left side' } });
    expect((await call('export_stl', { path: 'side.stl', target: { selection: true } })).data.solids).toBe(1);

    // open_file replaces the tab's model as one undoable step.
    await call('delete_entities', { target: { all: true } });
    await call('add_box', { name: 'Scratch', size: [5, 5, 5] });
    const opened = await call('open_file', { path: 'bookcase.modeler.json' });
    expect(opened.ok).toBe(true);
    expect(tab.doc.entities).toHaveLength(6);
    expect(tab.doc.undoLabel).toBe('AI: Open bookcase.modeler.json');
    tab.doc.undo();
    expect(tab.doc.entities.map((e) => e.name)).toEqual(['Scratch']);
  });

  it('imports a DXF from the working folder into the tab as one undo step', async () => {
    const bridge = await startBridge();
    const { call, local } = await connect(bridge);
    const tab = openTab(bridge.port!);
    await until(() => bridge.connected, 'tab to connect');
    await call('add_box', { name: 'Existing', size: [10, 10, 10] });
    await writeFile(join(dir, 'plan.dxf'), PLAN_DXF);
    const r = await call('import_dxf', { path: 'plan.dxf' });
    expect(r).toMatchObject({ ok: true, data: { name: 'plan', units: 'mm', size_mm: [4000, 3000] } });
    expect(tab.doc.references.map((x) => x.name)).toEqual(['plan']);
    expect(tab.doc.geometryOf(tab.doc.references[0].id)?.paths).toHaveLength(1);
    expect(tab.doc.entities.map((e) => e.name)).toEqual(['Existing']);
    expect(tab.doc.undoLabel).toBe('AI: Import plan.dxf');
    expect(local.doc.references).toHaveLength(0);
    // The AI can then change it in the tab.
    expect((await call('update_reference', { reference: 'plan', units: 'cm' })).ok).toBe(true);
    expect(tab.doc.references[0].units).toBe('cm');
    tab.doc.undo();
    tab.doc.undo();
    expect(tab.doc.references).toHaveLength(0);
    expect(tab.doc.entities).toHaveLength(1);
  });

  it('falls back to headless when the tab disconnects', async () => {
    const bridge = await startBridge();
    const { call, local } = await connect(bridge);
    const tab = openTab(bridge.port!);
    await until(() => bridge.connected, 'tab to connect');
    tab.client.stop();
    await until(() => !bridge.connected, 'tab to disconnect');
    const r = await call('add_box', { size: [10, 10, 10] });
    expect(r.warnings.join(' ')).toMatch(/Connect AI/);
    expect(local.doc.entities).toHaveLength(1);
    expect(tab.doc.entities).toHaveLength(0);
  });

  it('refuses other origins', async () => {
    const bridge = await startBridge();
    const evil = openTab(bridge.port!, 'http://evil.example');
    await new Promise((r) => setTimeout(r, 200));
    expect(bridge.connected).toBe(false);
    expect(evil.client.status).toBe('waiting');
  });

  it('lets a new tab take over and tells the old one', async () => {
    const bridge = await startBridge();
    const { call } = await connect(bridge);
    const first = openTab(bridge.port!);
    await until(() => first.client.status === 'connected', 'first tab');
    const second = openTab(bridge.port!);
    await until(() => second.client.status === 'connected' && first.client.status === 'off', 'takeover');
    expect(first.statuses.at(-1)?.why).toMatch(/Another tab/);
    await call('add_box', { size: [10, 10, 10] });
    expect(second.doc.entities).toHaveLength(1);
    expect(first.doc.entities).toHaveLength(0);
  });
});
