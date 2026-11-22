// Checks the publishable MCP package (ADR 0026) the way a user gets it: `npm run pack:mcp`,
// then unpack the tarball into an empty folder (no node_modules) and run it from there.
// - the server starts over stdio and answers MCP (tools, version);
// - it serves the app on its port, safely (no path escape, localhost only, wasm type);
// - the served app connects to it (Connect AI) and Claude's calls reach the open tab.
// Uses a non-default port, so a running modeler MCP server doesn't get in the way.
import { execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright-core';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 47931;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const tgz = readdirSync('test-results').filter((f) => /^modeler-mcp-.*\.tgz$/.test(f)).sort().at(-1);
if (!tgz) throw new Error('Run npm run pack:mcp first');
const dir = mkdtempSync(join(tmpdir(), 'modeler-pack-'));
execSync(`tar -xzf ${join('test-results', tgz)} -C ${dir}`);
const models = join(dir, 'models');
execSync(`mkdir -p ${models}`);
const version = JSON.parse(execSync(`cat ${join(dir, 'package/package.json')}`).toString()).version;

const client = new Client({ name: 'pack-check', version: '1' });
await client.connect(new StdioClientTransport({
  command: 'node',
  args: [join(dir, 'package/dist/modeler-mcp.mjs'), '--root', models, '--port', String(PORT)],
  cwd: dir,
  stderr: 'pipe',
}));
const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const tools = (await client.listTools()).tools;
check('the unpacked package runs on its own and lists the tools', tools.length > 40, `${tools.length} tools`);
const status = await call('connection_status');
check('it reports its version and where the app is', status.data.server_version === version && status.data.bridge.includes(`app is at http://127.0.0.1:${PORT}`), JSON.stringify(status.data));

const get = (path, host = `127.0.0.1:${PORT}`) =>
  new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.end();
  });
const index = await get('/');
check('it serves the app', index.status === 200 && index.type.startsWith('text/html') && index.body.includes('<div'), `${index.status} ${index.type}`);
const info = await get('/modeler-bridge.json');
check('it tells the app which port its bridge is on', JSON.parse(info.body).port === PORT, info.body);
const wasm = readdirSync(join(dir, 'package/dist/app/assets')).find((f) => f.endsWith('.wasm'));
const w = await get(`/assets/${wasm}`);
check('the geometry engine is served as application/wasm', w.status === 200 && w.type === 'application/wasm', `${w.status} ${w.type}`);
const escape = await get('/../../package.json');
const escape2 = await get('/%2e%2e/%2e%2e/package.json');
check('paths cannot escape the app folder', escape.status !== 200 || !escape.body.includes('"bin"'), `${escape.status}`);
check('…also when encoded', escape2.status !== 200 || !escape2.body.includes('"bin"'), `${escape2.status}`);
const rebinding = await get('/', 'evil.example:47931');
check('another Host (DNS rebinding) is refused', rebinding.status === 403, `${rebinding.status}`);

// The served app connects to this server and Claude's calls land in the tab.
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1300, height: 850 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForFunction(() => window.modeler);
await page.waitForFunction((port) => window.modeler.bridge.url.endsWith(`:${port}`), PORT);
await page.evaluate(() => window.modeler.runCommand('ai.connect'));
let live = false;
for (let i = 0; i < 40 && !live; i++) {
  live = (await call('connection_status')).data.mode === 'live';
  if (!live) await new Promise((r) => setTimeout(r, 100));
}
check('the served app connects to its own server (Connect AI)', live);
const added = await call('add_box', { name: 'Packed', size: [100, 50, 20] });
const inTab = await page.evaluate(() => window.modeler.doc.entities.map((e) => e.name));
check('a call over MCP changes the model in the tab', added.ok && inTab.includes('Packed'), JSON.stringify(inTab));
check('no errors in the page', errors.length === 0, errors.join('; '));

await browser.close();
await client.close();
rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\nPackage OK');
process.exit(failed ? 1 : 0);
