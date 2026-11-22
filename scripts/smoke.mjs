// End-to-end smoke test: drives the real UI in headless Chrome with mouse + keyboard.
// Usage: npm run dev (in another terminal), then `npm run smoke` (screenshots → test-results/)
// or `node scripts/smoke.mjs <screenshot-dir>`.
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright-core';

const URL = process.env.MODELER_URL ?? 'http://localhost:5173/';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Screenshots go to an ignored folder unless a directory is given.
const outDir = process.argv[2] ?? 'test-results';
mkdirSync(outDir, { recursive: true });

/** The workspace badge next to the file name opens a menu of workspaces (ADR 0023). */
async function pickWorkspace(page, name) {
  await page.click('.ws-chip');
  await page.click(`.cm-item:has-text("${name} —")`);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));

await page.goto(URL);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForFunction(() => window.modeler);

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
};

/** Page coordinates of a world point. */
const screen = async (x, y, z) =>
  page.evaluate(([x, y, z]) => {
    const app = window.modeler;
    const r = app.viewport.canvas.getBoundingClientRect();
    const THREE_V = app.viewport.camera.position.constructor;
    const s = app.viewport.toScreen(new THREE_V(x, y, z));
    return { x: r.left + s.x, y: r.top + s.y };
  }, [x, y, z]);

const entities = () => page.evaluate(() => JSON.parse(JSON.stringify(window.modeler.doc.entities)));
const clickWorld = async (x, y, z) => {
  const p = await screen(x, y, z);
  await page.mouse.move(p.x, p.y, { steps: 4 });
  await page.mouse.click(p.x, p.y);
};
const typeValue = async (text) => {
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
};

// The geometry engine (ADR 0017) loads in the background.
const engine = await page.waitForFunction(() => window.modeler.geometryEngine() === 'manifold', null, { timeout: 5000 }).then(() => 'manifold', () => page.evaluate(() => window.modeler.geometryEngine()));
check('Manifold geometry engine loads in the browser', engine === 'manifold', engine);

// 0. Fresh start defaults to the Print workspace; the first part of this test is woodworking.
check('defaults to the Print workspace', await page.evaluate(() => window.modeler.doc.workspace === 'print'));
await pickWorkspace(page, 'Workshop');
check('Workshop sets mm and 1 mm snap', await page.evaluate(() => window.modeler.doc.units === 'mm' && window.modeler.settings.snapStep === 1));

// Zoom so a ~1 m model fits.
await page.evaluate(() => {
  const vp = window.modeler.viewport;
  vp.controls.target.set(300, 200, 0);
  vp.camera.position.set(1100, -900, 900);
  vp.controls.update();
});

// 1. Box from typed dimensions
await page.keyboard.press('b');
await clickWorld(0, 0, 0);
await typeValue('600,400');
await typeValue('18');
let ents = await entities();
check('box created from typed size', ents.length === 1 && JSON.stringify(ents[0].size) === '[600,400,18]', JSON.stringify(ents[0]?.size));
check('box sits on the ground at origin', JSON.stringify(ents[0]?.position) === '[0,0,0]', JSON.stringify(ents[0]?.position));

// 2. Cylinder pushed into the top face becomes a hole
await page.keyboard.press('c');
await clickWorld(150, 150, 18);
await typeValue('d10');
const below = await screen(150, 150, -40);
await page.mouse.move(below.x, below.y, { steps: 6 });
await page.mouse.click(below.x, below.y);
ents = await entities();
const cyl = ents.find((e) => e.kind === 'cylinder');
check('cylinder radius from diameter', cyl?.radius === 5, String(cyl?.radius));
check('cylinder pushed into face is a hole', cyl?.hole === true, JSON.stringify({ hole: cyl?.hole, h: cyl?.height, pos: cyl?.position }));

// 3. Push/pull the +X face of the box by a typed distance
await page.keyboard.press('p');
await clickWorld(600, 200, 9);
await typeValue('100');
ents = await entities();
const box = ents.find((e) => e.kind === 'box');
check('push/pull +X face', box?.size[0] === 700, JSON.stringify(box?.size));

// 4. Undo / redo
await page.keyboard.press('Meta+z');
ents = await entities();
check('undo restores size', ents.find((e) => e.kind === 'box')?.size[0] === 600);
await page.keyboard.press('Meta+Shift+z');
ents = await entities();
check('redo re-applies', ents.find((e) => e.kind === 'box')?.size[0] === 700);

// 5. Move-copy with typed offset, then array
await page.keyboard.press('Escape');
await page.keyboard.press(' ');
await clickWorld(350, 200, 18); // select the box by clicking its top
await page.keyboard.press('m');
await clickWorld(0, 0, 0);
await page.keyboard.down('Alt');
await page.keyboard.up('Alt');
await typeValue('0,0,100');
ents = await entities();
check('copy created by move+Alt', ents.filter((e) => e.kind === 'box').length === 2, `${ents.length} entities`);
await typeValue('3x');
ents = await entities();
const boxes = ents.filter((e) => e.kind === 'box');
check('array 3x makes 4 boxes', boxes.length === 4, boxes.map((b) => b.position[2]).join(','));
check('array spacing', JSON.stringify(boxes.map((b) => b.position[2]).sort((a, b) => a - b)) === '[0,100,200,300]');

// 6. Rotate the selection 90° about Z with a typed angle
await page.keyboard.press('Escape');
await page.keyboard.press(' ');
await clickWorld(350, 200, 318);
await page.keyboard.press('q');
await clickWorld(0, 0, 300);
await clickWorld(300, 0, 300);
const mid = await screen(300, 300, 300);
await page.mouse.move(mid.x, mid.y, { steps: 4 });
await typeValue('90');
ents = await entities();
const top = ents.filter((e) => e.kind === 'box').find((e) => e.position[2] === 300);
check('rotate 90°', top && Math.abs(top.rotation[2] - 90) < 1e-6, JSON.stringify(top?.rotation));

// 7. Line tool: L-shaped bracket, typed segments, then thickness
await page.keyboard.press('Escape');
await page.keyboard.press('l');
await clickWorld(-300, 0, 0);
for (const seg of ['0,-200', '-100,0', '0,100', '-100,0']) {
  // dx,dy offsets, drawn with negative-x direction to stay clear of the box
  await typeValue(seg);
}
await typeValue('0,100');
await page.keyboard.press('Enter'); // close
await typeValue('5');
ents = await entities();
const shape = ents.find((e) => e.kind === 'extrusion');
check('extruded shape created', !!shape && shape.points.length === 6 && shape.height === 5, JSON.stringify(shape?.points));

// 8. Tape measure
await page.keyboard.press('t');
await clickWorld(0, 0, 0);
await clickWorld(700, 0, 0);
const tape = await page.$eval('.vcb', (el) => el.value);
check('tape measure shows 700', tape === '700', tape);

// 9. STL export and cut list
const stl = await page.evaluate(async () => {
  const io = await import('/src/model/io.ts');
  const doc = window.modeler.doc;
  const buf = io.exportStl(doc.entities, doc.entities);
  return buf ? new DataView(buf).getUint32(80, true) : 0;
});
check('STL export produces triangles', stl > 100, `${stl} triangles`);
await page.click('.tab:has-text("Cut list")');
const rows = await page.$$eval('.cutlist tbody tr', (trs) => trs.map((t) => t.textContent));
check('cut list groups the 4 boards', rows.some((r) => r.includes('4') && r.includes('18 × 400 × 700')), rows.join(' | '));

// 10. Autosave survives reload
await page.waitForTimeout(500);
await page.reload();
await page.waitForFunction(() => window.modeler);
ents = await entities();
check('autosave restored after reload', ents.length >= 6, `${ents.length} entities`);

// 11. Hold Shift to pan mid-operation, then continue drawing with the same tool
{
  await page.evaluate(() => { window.modeler.viewport.setView('iso'); window.modeler.viewport.zoomExtents(); });
  const before = await page.evaluate(() => window.modeler.doc.entities.length);
  await page.keyboard.press('b');
  await clickWorld(-600, -600, 0); // first corner, box tool now waiting for the second
  const view = () => page.evaluate(() => {
    const vp = window.modeler.viewport;
    const d = vp.controls.target.clone().sub(vp.camera.position).normalize();
    return { t: vp.controls.target.toArray(), d: d.toArray() };
  });
  const v0 = await view();
  await page.keyboard.down('Shift');
  const tempShown = await page.$eval('.tool-btn[aria-label^="Pan"]', (b) => b.classList.contains('temp'));
  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(800, 520, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const v1 = await view();
  const moved = Math.hypot(...v1.t.map((x, i) => x - v0.t[i]));
  const turned = Math.hypot(...v1.d.map((x, i) => x - v0.d[i]));
  check('Shift shows the pan tool as temporarily active', tempShown);
  check('Shift-drag pans (target moves, view direction unchanged)', moved > 10 && turned < 1e-6, `moved ${moved.toFixed(1)}, turned ${turned.toExponential(1)}`);
  const stillDrawing = await page.evaluate(() => window.modeler.doc.inTransaction);
  check('box in progress survives the pan', stillDrawing);
  const active = await page.$eval('.tool-btn.active', (b) => b.getAttribute('aria-label'));
  check('tool is still Box after releasing Shift', active.startsWith('Box'), active);
  await typeValue('100,100');
  await typeValue('10');
  const after = await entities();
  const made = after[after.length - 1];
  check('box finished after panning', after.length === before + 1 && JSON.stringify(made.size) === '[100,100,10]', JSON.stringify(made?.size));

  // ⌘-click adds to the selection (Shift is pan now).
  await page.keyboard.press(' ');
  await page.evaluate(() => window.modeler.doc.clearSelection());
  const a = after.find((e) => e.kind === 'box' && e.position[2] === 0 && e.size[0] === 700);
  await clickWorld(350, 200, 18);
  await page.keyboard.down('Meta');
  await clickWorld(-550, -550, 10);
  await page.keyboard.up('Meta');
  const selCount = await page.evaluate(() => window.modeler.doc.selection.size);
  check('⌘-click adds to selection', selCount === 2 && !!a, `${selCount} selected`);
}

// 12. Hold Alt + drag orbits mid-operation; a quick Alt tap still toggles (hole while drawing)
{
  const view = () => page.evaluate(() => {
    const vp = window.modeler.viewport;
    return vp.controls.target.clone().sub(vp.camera.position).normalize().toArray();
  });
  await page.keyboard.press('Escape');
  await page.keyboard.press('c');
  await clickWorld(-800, 200, 0);
  await typeValue('d20');
  const d0 = await view();
  await page.keyboard.down('Alt');
  const orbitTemp = await page.$eval('.tool-btn[aria-label="Orbit"]', (b) => b.classList.contains('temp'));
  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(780, 430, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const d1 = await view();
  check('hold Alt shows Orbit as temporarily active', orbitTemp);
  check('Alt-drag orbits the view', Math.hypot(...d1.map((x, i) => x - d0[i])) > 0.05);
  check('cylinder in progress survives the orbit', await page.evaluate(() => window.modeler.doc.inTransaction));
  await page.keyboard.down('Alt');
  await page.keyboard.up('Alt'); // quick tap → toggle hole
  await typeValue('30');
  const ents2 = await entities();
  const cyl2 = ents2[ents2.length - 1];
  check('quick Alt tap still toggles hole', cyl2.kind === 'cylinder' && cyl2.radius === 10 && cyl2.hole === true, JSON.stringify({ r: cyl2.radius, hole: cyl2.hole }));
}

// 13. Shortcuts dialog: open with ?, rebind Box to K, use it, reset
{
  await page.keyboard.press('Escape');
  await page.keyboard.press('?');
  check('? opens the shortcuts dialog', await page.isVisible('.modal'));
  const boxRow = page.locator('.sc-row', { has: page.locator('.sc-label', { hasText: /^Box$/ }) });
  await boxRow.locator('.sc-key').first().click();
  await page.keyboard.press('k');
  const status = await page.textContent('.sc-status');
  check('recorded K for Box', /K → Box/.test(status ?? ''), status ?? '');
  await boxRow.locator('.sc-key').first().click(); // record again…
  await page.keyboard.press('5'); // …a digit, which must be refused
  const warn = await page.textContent('.sc-status');
  const stillK = await page.evaluate(() => window.modeler.keymap.commandFor('K') === 'tool.box');
  check('digits are refused (reserved for measurements)', /reserved/.test(warn ?? '') && stillK, warn ?? '');
  await page.screenshot({ path: `${outDir}/modeler-shortcuts.png` });
  await page.keyboard.press('Escape'); // cancel recording
  await page.keyboard.press('Escape'); // close
  check('Esc closes the dialog', !(await page.isVisible('.modal')));
  await page.keyboard.press('k');
  let active = await page.$eval('.tool-btn.active', (b) => b.getAttribute('aria-label'));
  check('K now selects Box', active === 'Box', active);
  await page.keyboard.press(' ');
  await page.keyboard.press('b');
  active = await page.$eval('.tool-btn.active', (b) => b.getAttribute('aria-label'));
  check('B no longer selects Box', active === 'Select', active);
  const boxTitle = await page.$eval('.tool-btn[aria-label="Box"]', (b) => b.title);
  check('toolbar tooltip shows the new key', boxTitle === 'Box (K)', boxTitle);
  await page.reload();
  await page.waitForFunction(() => window.modeler);
  check('custom shortcut survives reload', await page.evaluate(() => window.modeler.keymap.commandFor('K') === 'tool.box'));
  await page.evaluate(() => window.modeler.keymap.resetAll());
  check('reset restores B', await page.evaluate(() => window.modeler.keymap.commandFor('B') === 'tool.box'));
}

// 14. Workspaces: Print plate fit check + place on plate; Build units; persistence
{
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.modeler.doc.load({ format: 'modeler', version: 1, units: 'mm', entities: [] }, false));
  await pickWorkspace(page, 'Print');
  const tabs = await page.$$eval('.tab', (t) => t.map((x) => x.textContent));
  check('Print workspace shows a Print tab, no cut list', tabs.includes('Print') && !tabs.includes('Cut list'), tabs.join(','));
  await page.evaluate(() => window.modeler.doc.add({ id: 'p1', name: 'Arm', kind: 'box', position: [200, 100, 0], rotation: [0, 0, 0], size: [120, 20, 10], color: '#f08c3a', hole: false, visible: true }));
  await page.click('.tab:has-text("Print")');
  const problem = await page.textContent('.status-card');
  check('part hanging off the bed is reported', /off the bed/.test(problem ?? ''), problem ?? '');
  await page.click('button:has-text("Place on plate")');
  const pos = await page.evaluate(() => window.modeler.doc.get('p1').position);
  check('Place on plate centres it on the bed', JSON.stringify(pos) === '[68,118,0]', JSON.stringify(pos));
  await page.waitForTimeout(400);
  const ok = await page.textContent('.status-card');
  check('fit check turns green', /fits on the bed/.test(ok ?? ''), ok ?? '');
  const vol = await page.$eval('.prop-section:last-of-type', (el) => el.textContent);
  check('volume and weight are shown', /24 cm³/.test(vol ?? '') && /29\.8 g/.test(vol ?? ''), vol ?? '');
  // Centred for the 256 mm bed it spans x 68–188, which is off a 180 mm A1 mini bed.
  await page.selectOption('select[aria-label="Printer"]', 'bambu-a1-mini');
  check('a smaller printer flags the part', await page.isVisible('.status-card.warn'));
  check('the build volume turns red', await page.$eval('.vp-plate-label', (el) => el.classList.contains('alert')));
  await page.click('button:has-text("Place on plate")');
  check('Place on plate fits it onto the A1 mini', await page.isVisible('.status-card.ok'));

  await pickWorkspace(page, 'Build');
  check('Build switches to cm', await page.evaluate(() => window.modeler.doc.units === 'cm'));
  check('Build has a Quantities tab', (await page.$$eval('.tab', (t) => t.map((x) => x.textContent))).includes('Quantities'));
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForFunction(() => window.modeler);
  check('workspace and printer survive reload', await page.evaluate(() => window.modeler.doc.workspace === 'build' && window.modeler.doc.printer.profile === 'bambu-a1-mini'));
  await pickWorkspace(page, 'Print');
}

// 15. Groups, right-click menu, Modeler API in the browser
{
  await page.keyboard.press('Escape');
  await pickWorkspace(page, 'Workshop');
  await page.evaluate(() => {
    const { api, doc } = window.modeler;
    doc.load({ format: 'modeler', version: 1, units: 'mm', entities: [] }, false);
    api.call('add_box', { name: 'Front', position: [0, 0, 0], size: [400, 18, 150] });
    api.call('add_box', { name: 'Back', position: [0, 300, 0], size: [400, 18, 150] });
    window.modeler.viewport.setView('iso');
    window.modeler.viewport.zoomExtents();
  });
  await page.keyboard.press(' ');
  await clickWorld(200, 0, 75);
  await page.keyboard.down('Meta');
  await clickWorld(200, 300, 140);
  await page.keyboard.up('Meta');
  await page.keyboard.press('Meta+g');
  check('⌘G groups the selection', await page.evaluate(() => window.modeler.doc.groups.length === 1));
  await page.keyboard.press('Escape');
  await clickWorld(200, 0, 75);
  check('clicking a grouped part selects the whole group', await page.evaluate(() => window.modeler.doc.selection.size === 2));
  check('properties show the group', /Group · 2 parts/.test((await page.textContent('.sidebar-body')) ?? ''));

  const front = await screen(200, 0, 75);
  await page.mouse.dblclick(front.x, front.y);
  check('double-click opens the group', await page.isVisible('.group-badge'));
  check('…and selects just that part', await page.evaluate(() => window.modeler.doc.selection.size === 1));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  check('Esc, Esc closes the group', !(await page.isVisible('.group-badge')));

  // Right-click a part → context menu
  await page.mouse.click(front.x, front.y, { button: 'right' });
  check('right-click opens the menu', await page.isVisible('.context-menu'));
  const items = await page.$$eval('.cm-item span', (els) => els.map((e) => e.textContent));
  check('menu has group actions', items.includes('Ungroup') && items.includes('Duplicate') && items.includes('Delete'), items.join(', '));
  await page.click('.cm-item:has-text("Duplicate")');
  const after = await page.evaluate(() => ({ groups: window.modeler.doc.groups.map((g) => g.name), parts: window.modeler.doc.entities.length }));
  check('Duplicate from the menu copies the group as a new group', after.parts === 4 && after.groups.join() === 'Group 1,Group 2', JSON.stringify(after));

  // Right-click empty space
  await page.mouse.click(80, 820, { button: 'right' });
  const emptyItems = await page.$$eval('.cm-item span', (els) => els.map((e) => e.textContent));
  check('empty-space menu offers Select all', emptyItems.includes('Select all'), emptyItems.join(', '));
  await page.keyboard.press('Escape');
  check('Esc closes the menu', !(await page.isVisible('.context-menu')));

  // Right-drag still pans, without a menu
  const t0 = await page.evaluate(() => window.modeler.viewport.controls.target.toArray());
  await page.mouse.move(700, 500);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(780, 540, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  const t1 = await page.evaluate(() => window.modeler.viewport.controls.target.toArray());
  check('right-drag pans (no menu)', Math.hypot(...t1.map((v, i) => v - t0[i])) > 5 && !(await page.isVisible('.context-menu')));

  // Objects tree
  await page.click('.tab:has-text("Objects")');
  check('Objects tab shows groups as tree rows', (await page.$$('.outliner-item.group')).length === 2);
  await page.click('.tab:has-text("Properties")');

  // The API in the browser: an AI-style batch, undo as one step, and rendered views.
  const batch = await page.evaluate(() => {
    const r = window.modeler.api.call('apply_operations', { operations: [
      { name: 'add_box', as: 'b', input: { name: 'Plinth', position: [0, 600, 0], size: [400, 300, 60] } },
      { name: 'duplicate', input: { target: { ids: ['$b'] }, pattern: { linear: { count: 3, step: [450, 0, 0] } } } },
    ] }, { source: 'test', label: 'AI: plinths' });
    return { ok: r.ok, parts: window.modeler.doc.entities.length, label: window.modeler.doc.undoLabel };
  });
  check('API batch runs in the app as one labelled step', batch.ok && batch.parts === 7 && batch.label === 'AI: plinths', JSON.stringify(batch));
  await page.keyboard.press('Meta+z');
  check('one undo removes the whole batch', await page.evaluate(() => window.modeler.doc.entities.length === 4));
  const views = await page.evaluate(async () => {
    const r = await window.modeler.api.callAsync('render_views', { views: ['iso', 'top'], size: 256 });
    return r.ok ? r.data.images.map((i) => i.png.length) : r.error;
  });
  check('render_views returns PNG images', Array.isArray(views) && views.length === 2 && views.every((n) => n > 1000), JSON.stringify(views));
  await page.evaluate(() => window.modeler.doc.clearSelection());
}

// 16. Scroll-zooming toward the floor never takes the camera underneath it
await page.evaluate(() => { window.modeler.viewport.setView('iso'); window.modeler.viewport.zoomExtents(); });
const floor = await screen(900, -300, 0);
await page.mouse.move(floor.x, floor.y);
for (let i = 0; i < 80; i++) await page.mouse.wheel(0, -100);
await page.waitForTimeout(100);
const camZ = await page.evaluate(() => window.modeler.viewport.camera.position.z);
check('zoom never goes through the floor', camZ > 0, `camera z = ${camZ.toFixed(3)}`);

await page.click('.tab:has-text("Properties")');
await page.keyboard.press(' ');
await page.evaluate(() => {
  const app = window.modeler;
  app.doc.setSelection([app.doc.entities[0].id]);
  app.viewport.setView('iso');
  app.viewport.zoomExtents();
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${outDir}/modeler-smoke.png` });

// 17. MCP live bridge: the built server (over stdio, as Claude runs it) drives a second tab.
{
  execSync('node mcp/build.mjs', { stdio: 'ignore' });
  const port = 48000 + Math.floor(Math.random() * 1000);
  const root = mkdtempSync(join(tmpdir(), 'modeler-smoke-'));
  const mcp = new Client({ name: 'smoke', version: '1' });
  await mcp.connect(new StdioClientTransport({ command: 'node', args: ['mcp/dist/modeler-mcp.mjs', '--root', root, '--port', String(port)], stderr: 'ignore' }));
  const call = async (name, args = {}) => {
    const r = await mcp.callTool({ name, arguments: args });
    return { ...JSON.parse(r.content[0].text), content: r.content };
  };
  const tab = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  tab.on('pageerror', (e) => errors.push(`bridge tab pageerror: ${e.message}`));
  await tab.goto(`${URL}?aiPort=${port}`);
  await tab.waitForFunction(() => window.modeler);
  await tab.evaluate(() => window.modeler.doc.load({ format: 'modeler', version: 1, units: 'mm', entities: [] }, true));
  await tab.click('.ai-btn');
  await tab.waitForFunction(() => window.modeler.bridge.status === 'connected', null, { timeout: 5000 }).catch(() => {});
  check('Connect AI links the tab to the MCP server', (await tab.textContent('.ai-btn')).includes('AI connected') && (await call('connection_status')).data?.mode === 'live');
  const built = await call('apply_operations', {
    label: 'box with holes',
    operations: [
      { name: 'add_box', input: { name: 'Body', size: [60, 40, 20] } },
      { name: 'add_cylinder', input: { name: 'M3', radius: 1.6, height: 30, position: [6, 6, -5], hole: true } },
    ],
  });
  const state = await tab.evaluate(() => ({ n: window.modeler.doc.entities.length, label: window.modeler.doc.undoLabel }));
  check('MCP batch appears in the tab as one AI undo step', built.ok && state.n === 2 && state.label === 'AI: Box with holes', JSON.stringify(state));
  // The exploded view is look-only (ADR 0019): Claude's edit reassembles it first.
  await call('explode_view', { factor: 0.8 });
  const exploded = await tab.evaluate(() => window.modeler.viewport.explode.factor);
  await call('add_box', { name: 'Lid', size: [60, 40, 3], position: [0, 0, 30] });
  const afterEdit = await tab.evaluate(() => ({ factor: window.modeler.viewport.explode.factor, n: window.modeler.doc.entities.length }));
  check('explode_view works over MCP; Claude\'s edit reassembles the view', exploded === 0.8 && afterEdit.factor === 0 && afterEdit.n === 3, JSON.stringify({ exploded, afterEdit }));
  const images = (await call('render_views', { views: ['iso'], size: 256 })).content.filter((c) => c.type === 'image');
  check('render_views over MCP returns an image', images.length === 1 && images[0].data.length > 1000);
  const stl = await call('export_stl', { path: 'body.stl' });
  check('export_stl writes the tab\'s model from Node', stl.ok && stl.data.triangles > 12, JSON.stringify(stl));
  await tab.screenshot({ path: `${outDir}/modeler-mcp-bridge.png` });
  await tab.click('.ai-btn');
  check('clicking again disconnects', (await tab.evaluate(() => window.modeler.bridge.status)) === 'off');
  await mcp.close();
  await tab.close();
  rmSync(root, { recursive: true, force: true });
}

// 18. DXF import: a kitchen plan becomes a reference drawing you can snap to (ADR 0014).
{
  const dxf = [];
  const add = (...pairs) => dxf.push(...pairs);
  add(0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC');
  add(0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 0, 'LAYER', 2, 'Walls', 70, 0, 62, 7, 0, 'LAYER', 2, 'Dims', 70, 0, 62, -1, 0, 'ENDTAB', 0, 'ENDSEC');
  add(0, 'SECTION', 2, 'BLOCKS', 0, 'BLOCK', 2, 'BASE600', 10, 0, 20, 0);
  add(0, 'LWPOLYLINE', 8, '0', 90, 4, 70, 1, 10, 0, 20, 0, 10, 600, 20, 0, 10, 600, 20, 600, 10, 0, 20, 600);
  add(0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 600, 21, 600, 0, 'ENDBLK', 0, 'ENDSEC');
  add(0, 'SECTION', 2, 'ENTITIES');
  add(0, 'LWPOLYLINE', 8, 'Walls', 90, 4, 70, 1, 10, -250, 20, -250, 10, 4250, 20, -250, 10, 4250, 20, 3250, 10, -250, 20, 3250);
  add(0, 'LWPOLYLINE', 8, 'Walls', 90, 4, 70, 1, 10, 0, 20, 0, 10, 4000, 20, 0, 10, 4000, 20, 3000, 10, 0, 20, 3000);
  add(0, 'ARC', 8, 'Doors', 10, 3000, 20, 0, 40, 800, 50, 90, 51, 180);
  add(0, 'INSERT', 8, 'Cabinets', 2, 'BASE600', 10, 0, 20, 2400, 70, 4, 44, 600);
  add(0, 'LINE', 8, 'Dims', 10, 0, 20, -600, 11, 4000, 21, -600);
  add(0, 'TEXT', 8, 'Walls', 1, 'Kitchen');
  add(0, 'ENDSEC', 0, 'EOF');

  const tab = await browser.newPage({ viewport: { width: 1300, height: 850 } });
  tab.on('pageerror', (e) => errors.push(`dxf tab pageerror: ${e.message}`));
  await tab.goto(URL);
  await tab.waitForFunction(() => window.modeler);
  await tab.evaluate(() => window.modeler.doc.load({ format: 'modeler', version: 1, units: 'mm', entities: [] }, true));
  await pickWorkspace(tab, 'Workshop');
  const [chooser] = await Promise.all([tab.waitForEvent('filechooser'), tab.click('button[aria-label^="Import a DXF"]')]);
  await chooser.setFiles({ name: 'kitchen.dxf', mimeType: 'application/dxf', buffer: Buffer.from(dxf.join('\n')) });
  await tab.waitForFunction(() => window.modeler.doc.references.length === 1, null, { timeout: 5000 }).catch(() => {});
  const ref = await tab.evaluate(() => {
    const d = window.modeler.doc;
    const r = d.references[0];
    return r && { name: r.name, units: r.units, hidden: r.hiddenLayers, layers: d.geometryOf(r.id).layers, parts: d.entities.length, label: d.undoLabel };
  });
  check('DXF imports as a reference drawing, not parts', ref?.name === 'kitchen' && ref.parts === 0 && ref.label === 'Import kitchen', JSON.stringify(ref));
  check('DXF layers, units and off layers are kept', ref?.units === 'mm' && ref.layers.join() === 'Walls,Doors,Cabinets,Dims' && ref.hidden.join() === 'Dims', JSON.stringify(ref));
  check('Objects tab lists the drawing', (await tab.textContent('.sidebar')).includes('Reference drawings'));

  // Trace the cabinet run: box from one cabinet corner to the opposite one, 900 high.
  await tab.evaluate(() => {
    const app = window.modeler;
    app.viewport.setView('top', false);
    app.viewport.fitBox(app.viewport.referencesBox());
  });
  const at = async (x, y) =>
    tab.evaluate(([x, y]) => {
      const app = window.modeler;
      const r = app.viewport.canvas.getBoundingClientRect();
      const s = app.viewport.toScreen(new (app.viewport.camera.position.constructor)(x, y, 0));
      return { x: r.left + s.x + 4, y: r.top + s.y - 3 }; // a few px off: the snap must pull it in
    }, [x, y]);
  // The plan is shifted so its lower-left extent (-250, -600: the off "Dims" layer counts) is the origin.
  const c1 = await at(250, 3000);
  const c2 = await at(2650, 3600);
  await tab.keyboard.press('b');
  await tab.mouse.move(c1.x, c1.y, { steps: 3 });
  await tab.mouse.click(c1.x, c1.y);
  await tab.mouse.move(c2.x, c2.y, { steps: 5 });
  await tab.mouse.click(c2.x, c2.y);
  await tab.keyboard.type('900');
  await tab.keyboard.press('Enter');
  const traced = await tab.evaluate(() => window.modeler.doc.entities.map((e) => ({ p: e.position, s: e.size })));
  check('box snaps to the drawing\'s corners', traced.length === 1 && traced[0].p.join() === '250,3000,0' && traced[0].s.join() === '2400,600,900', JSON.stringify(traced));

  // Layers and units from the panel.
  await tab.click('.outliner-item.reference .outliner-name');
  await tab.click('.outliner-item.layer:has-text("Cabinets") .eye');
  await tab.selectOption('.references select', 'cm');
  const after = await tab.evaluate(() => ({ ...window.modeler.doc.references[0] }));
  check('panel hides layers and changes units', after.hiddenLayers.includes('Cabinets') && after.units === 'cm', JSON.stringify(after));
  await tab.keyboard.press('Escape');
  await tab.keyboard.press('Meta+z');
  await tab.keyboard.press('Meta+z');
  const undone = await tab.evaluate(() => ({ ...window.modeler.doc.references[0] }));
  check('undo restores layers and units', undone.units === 'mm' && !undone.hiddenLayers.includes('Cabinets'), JSON.stringify(undone));
  await tab.evaluate(() => {
    const app = window.modeler;
    app.viewport.setView('iso', false);
    app.viewport.zoomExtents();
  });
  await tab.waitForTimeout(200);
  await tab.screenshot({ path: `${outDir}/modeler-dxf.png` });
  await tab.close();
}

// 19. Annotations (ADR 0015): dimension and text tools, attached to parts; select, drag, edit, delete.
{
  const tab = await browser.newPage({ viewport: { width: 1300, height: 850 } });
  tab.on('pageerror', (e) => errors.push(`annotation tab pageerror: ${e.message}`));
  await tab.bringToFront(); // background pages get no animation frames, so labels wouldn't render
  await tab.goto(URL);
  await tab.waitForFunction(() => window.modeler);
  await tab.evaluate(() => window.modeler.doc.load({ format: 'modeler', version: 1, units: 'mm', entities: [] }, true));
  await pickWorkspace(tab, 'Workshop');
  await tab.evaluate(() => {
    const app = window.modeler;
    app.api.call('add_box', { name: 'Cabinet', size: [600, 300, 700] });
    app.viewport.setView('front', false);
    app.viewport.zoomExtents();
  });
  const at = (x, y, z, dx = 0, dy = 0) =>
    tab.evaluate(([x, y, z, dx, dy]) => {
      const app = window.modeler;
      const r = app.viewport.canvas.getBoundingClientRect();
      const s = app.viewport.toScreen(new (app.viewport.camera.position.constructor)(x, y, z));
      return { x: r.left + s.x + dx, y: r.top + s.y + dy };
    }, [x, y, z, dx, dy]);
  const click = async (p) => {
    await tab.mouse.move(p.x, p.y, { steps: 4 });
    await tab.mouse.click(p.x, p.y);
  };
  // Dimension: top-left corner → top-right corner, then up 60 px.
  await tab.keyboard.press('d');
  await click(await at(0, 0, 700, 3, 2));
  await click(await at(600, 0, 700, -3, 2));
  await click(await at(300, 0, 700, 0, -60));
  // Text: on the front face, label up and to the right.
  await tab.keyboard.press('n');
  await click(await at(300, 0, 350));
  await click(await at(300, 0, 350, 160, -40));
  await tab.waitForSelector('.vp-annotation-editor');
  await tab.keyboard.type('Oak, 18 mm');
  await tab.keyboard.press('Enter');
  const anns = await tab.evaluate(() => JSON.parse(JSON.stringify(window.modeler.doc.annotations)));
  const dim = anns.find((a) => a.kind === 'dimension');
  const note = anns.find((a) => a.kind === 'note');
  check('Dimension tool attaches to part corners', dim && dim.from.entity && dim.to.entity && dim.offset[2] > 0, JSON.stringify(dim));
  check('Text tool adds a note on the part', note?.text === 'Oak, 18 mm' && note.anchor.entity && note.offset.some((v) => v !== 0), JSON.stringify(note));
  // Labels reach the DOM on the next rendered frame.
  const labels = async () => {
    await tab.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    return tab.$$eval('.vp-annotation', (els) => els.map((e) => e.textContent));
  };
  check('labels show value and text', JSON.stringify(await labels()) === JSON.stringify(['600 mm', 'Oak, 18 mm']), JSON.stringify(await labels()));
  // Resizing the part updates the dimension.
  await tab.evaluate(() => {
    const app = window.modeler;
    app.api.call('update_entity', { id: app.doc.entities[0].id, set: { size: [800, 300, 700] } });
  });
  await tab.waitForTimeout(50);
  check('dimension follows a resize', (await labels())[0] === '800 mm', JSON.stringify(await labels()));

  // Select tool: click the note label, drag it, Delete, undo.
  await tab.keyboard.press('Space');
  const box = await (await tab.$('.vp-note')).boundingBox();
  await tab.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await tab.mouse.down();
  await tab.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 30, { steps: 6 });
  await tab.mouse.up();
  const moved = await tab.evaluate(() => ({ sel: [...window.modeler.doc.annotationSelection], ann: window.modeler.doc.annotations.find((a) => a.kind === 'note'), label: window.modeler.doc.undoLabel }));
  check('clicking a label selects it, dragging moves it', moved.sel.length === 1 && moved.label === 'Move annotation' && JSON.stringify(moved.ann.offset) !== JSON.stringify(note.offset), JSON.stringify(moved));
  check('properties show the selected note', (await tab.textContent('.sidebar')).includes('Attached to'));
  // Double-click edits in place.
  await labels();
  const box2 = await (await tab.$('.vp-note')).boundingBox();
  await tab.mouse.dblclick(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await tab.waitForSelector('.vp-annotation-editor');
  await tab.keyboard.press('Meta+a');
  await tab.keyboard.type('Oak top');
  await tab.keyboard.press('Enter');
  check('double-click edits the text', (await labels()).includes('Oak top'), JSON.stringify(await labels()));
  await tab.screenshot({ path: `${outDir}/modeler-annotations.png` });
  await tab.keyboard.press('Delete');
  const afterDelete = await tab.evaluate(() => window.modeler.doc.annotations.length);
  await tab.keyboard.press('Meta+z');
  const afterUndo = await tab.evaluate(() => window.modeler.doc.annotations.length);
  check('Delete removes the annotation, undo restores it', afterDelete === 1 && afterUndo === 2, `${afterDelete} → ${afterUndo}`);
  // Deleting the part takes its annotations along.
  await tab.evaluate(() => window.modeler.api.call('delete_entities', { target: { all: true } }));
  check('deleting the part removes its annotations', (await tab.evaluate(() => window.modeler.doc.annotations.length)) === 0);
  await tab.close();
}

// 20. Project files (ADR 0016): save in place, Save As, Open, title + dirty dot; download fallback.
{
  const tab = await browser.newPage({ viewport: { width: 1300, height: 850 } });
  tab.on('pageerror', (e) => errors.push(`files tab pageerror: ${e.message}`));
  await tab.bringToFront();
  await tab.goto(URL);
  await tab.waitForFunction(() => window.modeler);
  await tab.evaluate(() => {
    window.modeler.doc.load({ format: 'modeler', version: 1, units: 'mm', entities: [] }, true);
    // In-memory stand-ins for the native pickers (headless Chrome can't click them).
    const disk = (window.__disk = {});
    window.__pickers = { save: 0, open: 0 };
    const handle = (name) => ({
      kind: 'file',
      name,
      getFile: async () => new File([disk[name] ?? ''], name),
      createWritable: async () => ({ write: async (t) => (disk[name] = t), close: async () => {} }),
      queryPermission: async () => 'granted',
    });
    let saveNames = ['kitchen.modeler.json', 'kitchen-v2.modeler.json'];
    window.showSaveFilePicker = async () => (window.__pickers.save++, handle(saveNames.shift()));
    window.showOpenFilePicker = async () => (window.__pickers.open++, [handle('kitchen.modeler.json')]);
  });
  const state = () =>
    tab.evaluate(() => ({ title: document.title, name: document.querySelector('.doc-name').textContent, dirty: document.querySelector('.doc-name').classList.contains('dirty'), pickers: { ...window.__pickers }, disk: Object.fromEntries(Object.entries(window.__disk).map(([k, v]) => [k, JSON.parse(v).entities.length])) }));
  await tab.evaluate(() => window.modeler.api.call('add_box', { name: 'Base', size: [600, 560, 720] }));
  let st = await state();
  check('unsaved changes show a dot', st.dirty && st.title.startsWith('• Untitled'), JSON.stringify(st));
  await tab.keyboard.press('Meta+s');
  await tab.waitForTimeout(100);
  st = await state();
  check('first ⌘S asks for a file and saves', st.pickers.save === 1 && st.disk['kitchen.modeler.json'] === 1 && st.name === 'kitchen' && !st.dirty && st.title === 'kitchen — Modeler', JSON.stringify(st));
  await tab.evaluate(() => window.modeler.api.call('add_box', { name: 'Wall', size: [600, 18, 720], position: [0, 600, 0] }));
  await tab.keyboard.press('Meta+s');
  await tab.waitForTimeout(100);
  st = await state();
  check('next ⌘S saves in place, no picker', st.pickers.save === 1 && st.disk['kitchen.modeler.json'] === 2 && !st.dirty, JSON.stringify(st));
  await tab.keyboard.press('Meta+Shift+s');
  await tab.waitForTimeout(100);
  st = await state();
  check('⇧⌘S saves as a new file', st.pickers.save === 2 && st.disk['kitchen-v2.modeler.json'] === 2 && st.name === 'kitchen-v2', JSON.stringify(st));
  await tab.evaluate(() => window.modeler.runCommand('file.new'));
  await tab.click('.np-card.current'); // New asks what you're making; keep the current kind
  st = await state();
  check('New model starts Untitled', st.name === 'Untitled' && !st.dirty, JSON.stringify(st));
  await tab.keyboard.press('Meta+o');
  await tab.waitForTimeout(150);
  st = await state();
  const opened = await tab.evaluate(() => ({ n: window.modeler.doc.entities.length, label: window.modeler.doc.undoLabel }));
  check('⌘O opens a file as an undoable step', st.pickers.open === 1 && opened.n === 2 && opened.label === 'Open kitchen.modeler.json' && st.name === 'kitchen' && !st.dirty, JSON.stringify({ st, opened }));
  await tab.screenshot({ path: `${outDir}/modeler-files.png`, clip: { x: 0, y: 0, width: 1300, height: 60 } });
  // Without the File System Access API, Save downloads a copy.
  await tab.evaluate(() => {
    delete window.showSaveFilePicker;
    delete window.showOpenFilePicker;
  });
  const [download] = await Promise.all([tab.waitForEvent('download', { timeout: 3000 }).catch(() => null), tab.keyboard.press('Meta+s')]);
  check('other browsers: Save downloads a copy', download?.suggestedFilename() === 'kitchen.modeler.json', download?.suggestedFilename());
  // The toolbar's GLB button downloads a binary glTF of the model (ADR 0020).
  const [glb] = await Promise.all([
    tab.waitForEvent('download', { timeout: 3000 }).catch(() => null),
    tab.getByRole('button', { name: /^Export GLB/ }).click(),
  ]);
  const glbPath = glb ? await glb.path() : null;
  const glbHead = glbPath ? readFileSync(glbPath).subarray(0, 4).toString() : null;
  check('toolbar GLB button downloads a glTF binary', glb?.suggestedFilename() === 'kitchen.glb' && glbHead === 'glTF', JSON.stringify({ name: glb?.suggestedFilename(), glbHead }));
  await tab.close();
}

// 21. Round and smooth parts: Sphere tool, cone from Properties, and each new kind rendered.
{
  const tab = await browser.newPage({ viewport: { width: 1300, height: 850 } });
  tab.on('pageerror', (e) => errors.push(`shapes tab pageerror: ${e.message}`));
  await tab.bringToFront();
  await tab.goto(URL);
  await tab.waitForFunction(() => window.modeler);
  await tab.evaluate(() => {
    const app = window.modeler;
    app.doc.load({ format: 'modeler', version: 1, units: 'mm', entities: [] }, true);
    app.viewport.setView('iso', false);
    const V = app.viewport.camera.position.constructor;
    const box = app.viewport.referencesBox(); // empty box to extend
    box.expandByPoint(new V(-60, -60, 0)).expandByPoint(new V(160, 120, 90));
    app.viewport.fitBox(box);
  });
  const at = (x, y, z) =>
    tab.evaluate(([x, y, z]) => {
      const app = window.modeler;
      const r = app.viewport.canvas.getBoundingClientRect();
      const s = app.viewport.toScreen(new (app.viewport.camera.position.constructor)(x, y, z));
      return { x: r.left + s.x, y: r.top + s.y };
    }, [x, y, z]);
  // Sphere tool: click on the ground, move, type a diameter.
  await tab.click('button[aria-label="Sphere"]');
  const p0 = await at(0, 0, 0);
  await tab.mouse.move(p0.x + 3, p0.y, { steps: 3 });
  await tab.mouse.click(p0.x + 3, p0.y);
  await tab.mouse.move(p0.x + 40, p0.y + 10, { steps: 4 });
  await tab.keyboard.type('d40');
  await tab.keyboard.press('Enter');
  const sphere = await tab.evaluate(() => {
    const e = window.modeler.doc.entities[0];
    return e && { kind: e.kind, radii: e.radii, z: e.position[2], label: window.modeler.doc.undoLabel, selected: window.modeler.doc.selection.has(e.id) };
  });
  check('Sphere tool: a typed diameter, resting on the ground', sphere?.kind === 'sphere' && sphere.radii.join() === '20,20,20' && sphere.z === 20 && sphere.label === 'Sphere' && sphere.selected, JSON.stringify(sphere));

  // A cylinder becomes a cone from the Properties panel.
  await tab.evaluate(() => {
    const app = window.modeler;
    app.api.call('add_cylinder', { name: 'Spike', position: [60, 0, 0], diameter: 30, height: 60 });
    app.doc.setSelection([app.doc.entities[1].id]);
    app.sidebar.setTab('properties');
  });
  const top = tab.locator('.prop-row:has-text("Top ⌀") input');
  await top.fill('0');
  await top.press('Enter');
  const cone = await tab.evaluate(() => window.modeler.doc.entities[1].radiusTop);
  check('Properties: Top ⌀ 0 turns a cylinder into a cone', cone === 0, String(cone));

  // One of each new kind, rendered.
  const added = await tab.evaluate(() => {
    const app = window.modeler;
    return [
      app.api.call('add_revolve', { name: 'Cup', position: [120, 0, 0], profile: [[0, 0], [20, 0], [24, 45], [21, 45], [17, 3], [0, 3]] }),
      app.api.call('add_tube', { name: 'Handle', path: [[-40, 60, 0], [-20, 80, 40], [20, 90, 50], [60, 70, 20]], radii: [8, 6, 4, 2] }),
      app.api.call('add_box', { name: 'Soft block', position: [100, 60, 0], size: [50, 40, 30], edge_radius: 6 }),
      app.api.call('add_sphere', { name: 'Egg', position: [20, 60, 25], radii: [15, 15, 25] }),
    ].every((r) => r.ok);
  });
  check('API adds a revolve, a tapered tube, a rounded box and an ellipsoid', added);
  await tab.evaluate(() => window.modeler.doc.clearSelection());
  await tab.waitForTimeout(250);
  await tab.screenshot({ path: `${outDir}/modeler-shapes.png` });
  await tab.close();
}

// 22. Split for printing from the right-click menu (pegs + clearance holes), on the Manifold engine.
{
  const tab = await browser.newPage({ viewport: { width: 1300, height: 850 } });
  tab.on('pageerror', (e) => errors.push(`split tab pageerror: ${e.message}`));
  await tab.bringToFront();
  await tab.goto(URL);
  await tab.waitForFunction(() => window.modeler && window.modeler.geometryEngine() === 'manifold');
  await tab.evaluate(() => {
    const app = window.modeler;
    app.doc.load({ format: 'modeler', version: 1, units: 'mm', workspace: 'print', entities: [] }, true);
    app.api.call('add_cylinder', { name: 'Vase', position: [60, 60, 0], diameter: 70, diameter_top: 50, height: 120, segments: 96 });
    app.api.call('add_cylinder', { name: 'Inside', position: [60, 60, 3], diameter: 40, diameter_top: 22, height: 125, segments: 96, hole: true });
    app.doc.setSelection([app.doc.entities[0].id]);
    app.viewport.setView('iso', false);
    app.viewport.zoomExtents();
  });
  await tab.waitForTimeout(150);
  const c = await tab.evaluate(() => {
    const app = window.modeler;
    const r = app.viewport.canvas.getBoundingClientRect();
    const s = app.viewport.toScreen(new (app.viewport.camera.position.constructor)(60, 25, 60));
    return { x: r.left + s.x, y: r.top + s.y };
  });
  await tab.mouse.click(c.x, c.y, { button: 'right' });
  await tab.click('.cm-item:has-text("Split for printing")');
  const split = await tab.evaluate(() => {
    const d = window.modeler.doc;
    return { groups: d.groups.filter((g) => !g.parentId).map((g) => g.name), pegs: d.entities.filter((e) => /^Peg \d/.test(e.name)).length, holes: d.entities.filter((e) => e.name.startsWith('Peg hole')).length, label: d.undoLabel, toast: document.querySelector('.toast').textContent };
  });
  check('right-click → Split for printing makes two pieces with pegs', split.groups.join() === 'Vase 1,Vase 2' && split.pegs === 2 && split.holes === 2 && split.label === 'Split for print', JSON.stringify(split));
  await tab.evaluate(() => {
    window.modeler.doc.clearSelection();
    window.modeler.viewport.zoomExtents();
  });
  await tab.waitForTimeout(250);
  await tab.screenshot({ path: `${outDir}/modeler-split.png` });
  await tab.close();
}

// 23. Exploded view: a display state (button, slider, axis); the model and undo stay untouched.
{
  const tab = await browser.newPage({ viewport: { width: 1400, height: 850 } });
  tab.on('pageerror', (e) => errors.push(`explode tab pageerror: ${e.message}`));
  await tab.bringToFront();
  await tab.goto(URL);
  await tab.waitForFunction(() => window.modeler);
  await tab.evaluate(() => {
    const app = window.modeler;
    app.doc.load({ format: 'modeler', version: 1, units: 'mm', entities: [] }, true);
    app.api.call('apply_operations', {
      operations: [
        { name: 'add_box', input: { name: 'Left side', size: [18, 300, 700] }, as: 'l' },
        { name: 'add_box', input: { name: 'Right side', size: [18, 300, 700], position: [582, 0, 0] }, as: 'r' },
        { name: 'add_box', input: { name: 'Top', size: [564, 300, 18], position: [18, 0, 682] }, as: 't' },
        { name: 'add_box', input: { name: 'Bottom', size: [564, 300, 18], position: [18, 0, 0] }, as: 'b' },
        { name: 'add_box', input: { name: 'Shelf', size: [564, 280, 18], position: [18, 0, 340] }, as: 's' },
        { name: 'group', input: { target: { ids: ['$l', '$r', '$t', '$b', '$s'] }, name: 'Cabinet' } },
        { name: 'add_box', input: { name: 'Lamp', size: [120, 120, 200], position: [240, 90, 760] } },
      ],
    });
    app.viewport.setView('iso', false);
    app.viewport.zoomExtents();
  });
  await pickWorkspace(tab, 'Workshop');
  await tab.evaluate(() => window.modeler.viewport.zoomExtents());
  const snapshot = () =>
    tab.evaluate(() => {
      const app = window.modeler;
      const drawn = (n) => {
        const e = app.doc.entities.find((x) => x.name === n);
        const m = app.viewport.objects.get(e.id).group.matrixWorld.elements;
        return [m[12], m[13], m[14]].map((v) => Math.round(v));
      };
      return {
        lamp: drawn('Lamp'),
        left: drawn('Left side'),
        top: drawn('Top'),
        model: app.doc.entities.find((x) => x.name === 'Lamp').position,
        version: app.doc.version,
        canUndo: app.doc.undoLabel,
        factor: app.viewport.explode.factor,
        gridShown: app.viewport.grid.mesh.parent.visible,
        studio: app.viewport.scene.background !== null,
        parts: app.doc.entities.length,
      };
    });
  const before = await snapshot();
  await tab.click('button:has-text("Explode")');
  const on = await snapshot();
  check('Explode takes every board apart and lifts the lamp off, on the floor (view only)', on.left[0] < before.left[0] - 100 && on.lamp[2] > before.lamp[2] && on.left[2] === before.left[2] && JSON.stringify(on.model) === JSON.stringify(before.model) && on.version === before.version, JSON.stringify({ before, on }));
  check('exploded look: no grid/axes/bed, studio background', !on.gridShown && on.studio && before.gridShown && !before.studio, JSON.stringify({ before: [before.gridShown, before.studio], on: [on.gridShown, on.studio] }));
  // Look only: Delete, ⌘Z and the Properties panel refuse to edit.
  await tab.evaluate(() => window.modeler.doc.setSelection([window.modeler.doc.entities.find((e) => e.name === 'Lamp').id]));
  await tab.keyboard.press('Delete');
  await tab.keyboard.press('Meta+z');
  const locked = await snapshot();
  const sidebarText = await tab.textContent('.sidebar');
  check('exploded view is look-only (Delete, undo, Properties)', locked.parts === before.parts && locked.version === before.version && sidebarText.includes('look only') && (await tab.isDisabled('button[aria-label="Undo"]')), JSON.stringify({ parts: locked.parts, version: locked.version }));
  await tab.evaluate(() => window.modeler.doc.clearSelection());
  await tab.locator('.explode-slider').fill('100');
  const more = await snapshot();
  check('the slider spreads it further', more.left[0] < on.left[0] && more.lamp[2] > on.lamp[2] && more.factor === 1, JSON.stringify(more));
  // Open the cabinet: only its boards come apart; the lamp stays.
  await tab.evaluate(() => {
    const app = window.modeler;
    app.doc.setOpenGroup(app.doc.groups[0].id);
    app.viewport.zoomExtents();
  });
  const opened = await snapshot();
  check('inside an open group, only its parts come apart', opened.left[0] < before.left[0] - 100 && JSON.stringify(opened.lamp) === JSON.stringify(before.lamp), JSON.stringify(opened));
  await tab.screenshot({ path: `${outDir}/modeler-explode.png` });
  await tab.evaluate(() => window.modeler.doc.setOpenGroup(null));
  await tab.keyboard.press('b');
  const back = await snapshot();
  check('a drawing tool puts it back together, grid and all', back.factor === 0 && JSON.stringify(back.lamp) === JSON.stringify(before.lamp) && back.version === before.version && back.gridShown && !back.studio, JSON.stringify(back));
  await tab.close();
}

// 24. Build instructions (ADR 0021): the booklet from the toolbar, edited in place, follows the model.
{
  const tab = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  tab.on('pageerror', (e) => errors.push(`instructions tab pageerror: ${e.message}`));
  await tab.bringToFront();
  await tab.goto(URL);
  await tab.waitForFunction(() => window.modeler);
  await tab.evaluate(() => {
    const app = window.modeler;
    app.doc.load({ format: 'modeler', version: 1, units: 'mm', entities: [] }, true);
    app.api.call('apply_operations', { label: 'Coffee table', operations: [
      { name: 'add_box', input: { name: 'Top', size: [1000, 600, 25], position: [0, 0, 400], color: '#c8a165' } },
      { name: 'add_box', input: { name: 'Leg', size: [50, 50, 400], position: [30, 30, 0], color: '#8b5a2b' }, as: 'leg' },
      { name: 'duplicate', input: { target: { ids: ['$leg'] }, pattern: { grid: { counts: [2, 2, 1], step: [890, 490, 0] } } } },
      { name: 'add_box', input: { name: 'Shelf', size: [890, 490, 18], position: [55, 55, 120], color: '#c8a165' } },
    ] });
  });
  await tab.getByRole('button', { name: /^Build instructions/ }).click();
  await tab.waitForSelector('.ins-page');
  const booklet = () => tab.evaluate(() => ({
    pages: document.querySelectorAll('.ins-page').length,
    steps: document.querySelectorAll('.ins-step').length,
    letters: [...document.querySelectorAll('.ins-part .ins-letter')].map((e) => e.textContent).join(''),
    images: [...document.querySelectorAll('.ins-page img')].every((img) => img.complete && img.naturalWidth > 0),
    firstStep: document.querySelector('.ins-step-text')?.textContent || document.querySelector('.ins-step-text')?.getAttribute('data-placeholder'),
  }));
  let b = await booklet();
  // Cover, parts, 3 steps on 2 pages, done.
  check('Instructions opens a booklet: cover, lettered parts, steps with pictures', b.pages === 5 && b.steps === 3 && b.letters === 'ABC' && b.images && b.firstStep === 'Add 4 × A (Leg).', JSON.stringify(b));
  await tab.screenshot({ path: `${outDir}/modeler-instructions.png` });
  // Typing over a suggested step stores the steps (one undo step); Delete doesn't reach the model.
  await tab.keyboard.press('Delete');
  const text = tab.locator('.ins-step-text').first();
  await text.click();
  await text.fill('Screw the four legs A to the shelf.');
  await tab.keyboard.press('Enter');
  await tab.waitForTimeout(300);
  const stored = await tab.evaluate(() => ({ parts: window.modeler.doc.entities.length, label: window.modeler.doc.undoLabel, text: window.modeler.doc.instructions?.steps?.[0]?.text }));
  b = await booklet();
  check('a step text edited in the booklet is stored as one undo step', stored.parts === 6 && stored.label === 'Step 1 text' && stored.text === 'Screw the four legs A to the shelf.' && b.firstStep === stored.text, JSON.stringify({ stored, b }));
  await tab.evaluate(() => window.modeler.api.call('set_instructions', { language: 'sr' }));
  await tab.waitForTimeout(400);
  const kicker = await tab.locator('.ins-kicker').textContent();
  check('the open booklet follows API changes (language)', kicker === 'Uputstvo za izradu', kicker);
  await tab.keyboard.press('Escape');
  check('Escape closes the booklet', (await tab.locator('.ins-overlay').count()) === 0);
  await tab.close();
}

// 25. Copy/paste between tabs, one autosave per tab, New project dialog, workspace badge (ADR 0023).
{
  const context = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new globalThis.URL(URL).origin });
  const a = await context.newPage();
  const b = await context.newPage();
  for (const [t, n] of [[a, 'A'], [b, 'B']]) {
    t.on('pageerror', (e) => errors.push(`tab ${n} pageerror: ${e.message}`));
    await t.goto(URL);
    await t.waitForFunction(() => window.modeler);
  }
  await a.bringToFront();
  await a.evaluate(() => {
    const app = window.modeler;
    app.doc.load({ format: 'modeler', version: 1, units: 'mm', entities: [] }, true);
    app.api.call('apply_operations', { operations: [
      { name: 'add_box', input: { name: 'Leg', size: [40, 40, 400] }, as: 'l' },
      { name: 'add_box', input: { name: 'Top', size: [500, 300, 20], position: [0, 0, 400] }, as: 't' },
      { name: 'group', input: { target: { ids: ['$l', '$t'] }, name: 'Stool' } },
    ] });
    app.doc.setSelection(app.doc.entities.map((e) => e.id));
  });
  await a.evaluate(() => window.modeler.runCommand('edit.copy'));
  await a.waitForTimeout(150);
  const copied = await a.evaluate(() => navigator.clipboard.readText());
  check('Copy puts the parts on the system clipboard', copied.includes('"modeler-clipboard"'), copied.slice(0, 60));
  // Tab B: a real paste event (what ⌘V fires), with the copied text.
  await b.bringToFront();
  await b.evaluate(() => window.modeler.doc.load({ format: 'modeler', version: 1, units: 'mm', entities: [] }, true));
  await b.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  }, copied);
  const pasted = await b.evaluate(() => ({ names: window.modeler.doc.entities.map((e) => e.name), groups: window.modeler.doc.groups.map((g) => g.name), selected: window.modeler.doc.selection.size, label: window.modeler.doc.undoLabel }));
  check('…and a paste in another tab brings them in, grouped and selected, as one undo step', JSON.stringify(pasted.names) === '["Leg","Top"]' && pasted.groups[0] === 'Stool' && pasted.selected === 2 && pasted.label === 'Paste', JSON.stringify(pasted));
  // Pasting again in the same tab lands beside, not on top.
  await b.evaluate(() => window.modeler.runCommand('edit.paste'));
  await b.waitForTimeout(200);
  const again = await b.evaluate(() => window.modeler.doc.entities.filter((e) => e.name === 'Leg').map((e) => e.position[0]));
  check('pasting again goes beside the model', again.length === 2 && again[1] > 500, JSON.stringify(again));
  // Each tab autosaves into its own slot.
  await a.waitForTimeout(500);
  const slots = await a.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('modeler.autosave.v1:')).map((k) => JSON.parse(localStorage.getItem(k)).entities.length).sort());
  check('two tabs keep two autosaves (no overwriting)', JSON.stringify(slots) === '[2,4]', JSON.stringify(slots));
  // New asks what you're making; the badge shows and changes the workspace.
  await a.bringToFront();
  await a.evaluate(() => window.modeler.runCommand('file.new'));
  const dialog = await a.locator('.new-project').isVisible();
  await a.click('.np-card[data-workspace="build"]');
  const fresh = await a.evaluate(() => ({ parts: window.modeler.doc.entities.length, ws: window.modeler.doc.workspace, badge: document.querySelector('.ws-chip').textContent }));
  check('New asks what you are making and starts that kind of project', dialog && fresh.parts === 0 && fresh.ws === 'build' && fresh.badge.startsWith('Build'), JSON.stringify(fresh));
  await a.screenshot({ path: `${outDir}/modeler-new-project.png`, clip: { x: 0, y: 0, width: 1300, height: 60 } });
  await pickWorkspace(a, 'Workshop');
  check('the workspace badge switches workspace', (await a.evaluate(() => window.modeler.doc.workspace)) === 'workshop');
  await context.close();
}

// 26. Components and part properties (ADR 0025): link copies from the menu, edit one, set a material.
{
  const tab = await browser.newPage({ viewport: { width: 1300, height: 900 } });
  tab.on('pageerror', (e) => errors.push(`parts tab pageerror: ${e.message}`));
  await tab.goto(URL);
  await tab.waitForFunction(() => window.modeler);
  await tab.evaluate(() => {
    const app = window.modeler;
    app.doc.load({ format: 'modeler', version: 1, units: 'mm', workspace: 'workshop', entities: [] }, true);
    app.api.call('apply_operations', { operations: [
      { name: 'add_box', input: { name: 'Leg', size: [50, 50, 400], position: [0, 0, 0] }, as: 'l' },
      { name: 'duplicate', input: { target: { ids: ['$l'] }, pattern: { linear: { count: 4, step: [200, 0, 0] } } } },
    ] });
    app.doc.setSelection(app.doc.entities.map((e) => e.id));
    app.viewport.zoomExtents();
  });
  const box = await tab.locator('canvas').first().boundingBox();
  const at = await tab.evaluate(() => {
    const app = window.modeler;
    const e = app.doc.entities[0];
    const p = new app.viewport.camera.position.constructor(e.position[0] + 25, e.position[1] + 25, 200).project(app.viewport.camera);
    return { x: ((p.x + 1) / 2), y: ((1 - p.y) / 2) };
  });
  await tab.mouse.click(box.x + at.x * box.width, box.y + at.y * box.height, { button: 'right' });
  const menu = await tab.locator('.context-menu .cm-item').allTextContents();
  await tab.click('.cm-item:has-text("Make component")');
  const linked = await tab.evaluate(() => new Set(window.modeler.doc.entities.map((e) => e.component)).size === 1 && !!window.modeler.doc.entities[0].component);
  check('right-click → Make component links the selected legs', menu.some((t) => t.startsWith('Make component')) && linked, menu.join(', '));
  // Edit one copy in Properties: all follow.
  await tab.evaluate(() => window.modeler.doc.setSelection([window.modeler.doc.entities[2].id]));
  const sizeField = tab.locator('.prop-section:has(h4:text("Dimensions")) .prop-row').first().locator('input').nth(2);
  await sizeField.fill('450');
  await sizeField.press('Enter');
  const heights = await tab.evaluate(() => window.modeler.doc.entities.map((e) => e.size[2]));
  check('changing one linked copy in Properties changes all', JSON.stringify(heights) === '[450,450,450,450]', JSON.stringify(heights));
  const material = tab.locator('.prop-section:has(h4:text("Part")) .prop-row:has-text("Material") input');
  await material.fill('Oak');
  await material.press('Enter');
  const mats = await tab.evaluate(() => window.modeler.doc.entities.map((e) => e.material));
  const linkedText = await tab.locator('.prop-section:has(h4:text("Part"))').textContent();
  check('a material set on one copy is on all; the panel says they are linked', mats.every((m) => m === 'Oak') && linkedText.includes('4 copies'), JSON.stringify({ mats, linkedText }));
  await tab.locator('.sidebar').screenshot({ path: `${outDir}/modeler-part-properties.png` });
  await tab.close();
}

check('no console errors', errors.length === 0, errors.join('\n'));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
