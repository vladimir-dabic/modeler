// End-to-end smoke test: drives the real UI in headless Chrome with mouse + keyboard.
// Usage: npm run dev (in another terminal), then `npm run smoke` (screenshots → test-results/)
// or `node scripts/smoke.mjs <screenshot-dir>`.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const URL = process.env.MODELER_URL ?? 'http://localhost:5173/';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Screenshots go to an ignored folder unless a directory is given.
const outDir = process.argv[2] ?? 'test-results';
mkdirSync(outDir, { recursive: true });

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

// 0. Fresh start defaults to the Print workspace; the first part of this test is woodworking.
check('defaults to the Print workspace', await page.evaluate(() => window.modeler.doc.workspace === 'print'));
await page.click('.ws-btn:has-text("Workshop")');
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
  await page.click('.ws-btn:has-text("Print")');
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

  await page.click('.ws-btn:has-text("Build")');
  check('Build switches to cm', await page.evaluate(() => window.modeler.doc.units === 'cm'));
  check('Build has a Quantities tab', (await page.$$eval('.tab', (t) => t.map((x) => x.textContent))).includes('Quantities'));
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForFunction(() => window.modeler);
  check('workspace and printer survive reload', await page.evaluate(() => window.modeler.doc.workspace === 'build' && window.modeler.doc.printer.profile === 'bambu-a1-mini'));
  await page.click('.ws-btn:has-text("Print")');
}

// 15. Scroll-zooming toward the floor never takes the camera underneath it
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

check('no console errors', errors.length === 0, errors.join('\n'));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
