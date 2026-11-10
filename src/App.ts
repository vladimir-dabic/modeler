import * as THREE from 'three';
import { cutListToCsv, buildCutList } from './model/cutlist';
import { ModelDocument, newId } from './model/Document';
import { cleanNumber, worldBoundsOf } from './model/geometry';
import {
  downloadBlob,
  exportStl,
  loadAutosave,
  loadSettings,
  parseDocumentFile,
  pickFile,
  saveAutosave,
  saveSettings,
  type Settings,
} from './model/io';
import type { Entity, Unit } from './model/types';
import {
  checkPrintFit,
  isWorkspaceId,
  placeOnPlateDelta,
  printerName,
  printerVolume,
  WORKSPACE_IDS,
  WORKSPACES,
  type FitIssue,
  type PrinterSetting,
  type WorkspaceConfig,
  type WorkspaceId,
} from './model/workspaces';
import { formatLength, parseLength } from './model/units';
import { BoxTool, CylinderTool, LineTool } from './tools/CreateTools';
import { EraseTool, OrbitTool, PanTool, TapeTool } from './tools/MiscTools';
import { MoveTool } from './tools/MoveTool';
import { PushPullTool } from './tools/PushPullTool';
import { RotateTool } from './tools/RotateTool';
import { SelectTool } from './tools/SelectTool';
import type { Tool, ToolContext, ToolEvent, ToolId } from './tools/Tool';
import { COMMANDS } from './commands';
import { comboFromEvent, holdKeyLabel, Keymap, MEASUREMENT_CHARS, type HoldAction } from './keymap';
import { h, isTextInput } from './ui/dom';
import { icon } from './ui/icons';
import { ShortcutsDialog } from './ui/ShortcutsDialog';
import { Sidebar } from './ui/Sidebar';
import { Snapper } from './viewport/Snapper';
import { Viewport, type ViewName } from './viewport/Viewport';

const TOOLBAR: (ToolId | '|')[] = ['select', '|', 'box', 'cylinder', 'line', '|', 'pushpull', 'move', 'rotate', '|', 'tape', 'erase', '|', 'orbit', 'pan'];

const TOOL_NAMES: Record<ToolId, string> = {
  select: 'Select',
  box: 'Box',
  cylinder: 'Cylinder',
  line: 'Line / Shape',
  pushpull: 'Push/Pull',
  move: 'Move / Copy',
  rotate: 'Rotate',
  tape: 'Tape Measure',
  erase: 'Eraser',
  orbit: 'Orbit',
  pan: 'Pan',
};

/** A quick press-and-release of a hold key (no drag) still counts as a tap for tools. */
const TAP_MS = 400;

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}


export class App {
  readonly doc = new ModelDocument();
  readonly settings: Settings = loadSettings();
  readonly viewport: Viewport;
  readonly snapper: Snapper;
  private readonly tools: Record<ToolId, Tool>;
  private active: Tool;
  private readonly sidebar: Sidebar;
  private readonly toolButtons = new Map<ToolId, HTMLButtonElement>();
  readonly keymap = new Keymap(COMMANDS, safeStorage());
  private readonly shortcuts: ShortcutsDialog;
  /** Buttons whose tooltip shows a (customisable) shortcut. */
  private readonly titled: { el: HTMLElement; label: string; command: string }[] = [];
  private readonly workspaceButtons = new Map<WorkspaceId, HTMLButtonElement>();
  private printIssues: FitIssue[] = [];
  private readonly els: {
    hint: HTMLElement;
    vcbLabel: HTMLElement;
    vcb: HTMLInputElement;
    toast: HTMLElement;
    empty: HTMLElement;
    undo: HTMLButtonElement;
    redo: HTMLButtonElement;
    units: HTMLSelectElement;
    snap: HTMLInputElement;
    snapStep: HTMLInputElement;
    snapList: HTMLDataListElement;
    ortho: HTMLButtonElement;
    xray: HTMLButtonElement;
    cuts: HTMLButtonElement;
  };
  private fileName = 'model';
  private defaultColor = '#d4dae3';
  private autosaveTimer = 0;
  /**
   * Holding the pan/orbit key (Shift / Alt by default) turns the left button into
   * pan/orbit without switching tools, so an operation in progress survives.
   * `ending` = the key was released mid-drag; we leave the mode when that drag ends.
   */
  private tempNav: { action: HoldAction; key: string; ending: boolean } | null = null;
  /** The hold key currently down, to tell a tap (tool toggle) from a hold-and-drag. */
  private heldKey: { key: string; dragged: boolean; at: number } | null = null;
  private pointerButtons = 0;
  private toastTimer = 0;

  constructor(root: HTMLElement) {
    // ---- layout ----
    const vpEl = h('main', { class: 'viewport' });
    const empty = h('div', { class: 'vp-empty' });
    vpEl.append(empty);

    const hint = h('div', { class: 'hint' });
    const vcbLabel = h('span', { class: 'vcb-label' });
    const vcb = h('input', { class: 'vcb', type: 'text', spellcheck: 'false', 'aria-label': 'Measurements', placeholder: 'type a value…' });
    const toast = h('div', { class: 'toast', role: 'status' });

    const units = h('select', { class: 'select', title: 'Display units' },
      ...(['mm', 'cm', 'm', 'in'] as Unit[]).map((u) => h('option', { value: u }, u)),
    );
    const snap = h('input', { type: 'checkbox', checked: this.settings.snapEnabled });
    const snapStep = h('input', { type: 'text', class: 'field small-field', title: 'Snap step (used for free points, sizes and moves)', list: 'snap-steps' });
    const snapList = h('datalist', { id: 'snap-steps' });
    // Buttons run the same commands as their shortcuts; tooltips show the current key.
    const btn = (name: string, title: string, command: string, label?: string) =>
      this.withTitle(h('button', { class: `tb-btn ${label ? 'with-label' : ''}`, 'aria-label': title, onclick: () => this.runCommand(command), html: icon(name, 18) + (label ? `<span>${label}</span>` : '') }), title, command);
    const textBtn = (label: string, title: string, command: string) =>
      this.withTitle(h('button', { class: 'tb-btn text', onclick: () => this.runCommand(command) }, label), title, command);

    const undo = btn('undo', 'Undo', 'edit.undo');
    const redo = btn('redo', 'Redo', 'edit.redo');
    const ortho = textBtn('Persp', 'Toggle perspective / orthographic (parallel) projection', 'view.projection');
    const xray = textBtn('X-ray', 'See through solids', 'view.xray');
    const cuts = textBtn('Cuts', 'Show holes cut into solids (turn off if the scene gets slow)', 'view.cuts');

    const views: [ViewName, string][] = [
      ['iso', 'Iso'],
      ['top', 'Top'],
      ['front', 'Front'],
      ['right', 'Right'],
      ['left', 'Left'],
      ['back', 'Back'],
    ];

    const topbar = h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', html: icon('box', 18) }), 'Modeler'),
      this.workspaceSwitcher(),
      h('div', { class: 'tb-group' },
        btn('new', 'New model', 'file.new'),
        btn('open', 'Open project…', 'file.open'),
        btn('save', 'Save project', 'file.save'),
        btn('export', 'Export STL for 3D printing (selection, or everything)', 'file.exportStl', 'STL'),
      ),
      h('div', { class: 'tb-group' }, undo, redo),
      h('div', { class: 'tb-group views' },
        ...views.map(([v, label]) => textBtn(label, `${label} view`, `view.${v}`)),
        btn('extents', 'Zoom extents', 'view.extents'),
      ),
      h('div', { class: 'tb-group' }, ortho, xray, cuts),
      h('div', { class: 'tb-spacer' }),
      h('div', { class: 'tb-group settings' },
        this.withTitle(h('label', { class: 'tb-field' }, snap, h('span', {}, 'Snap')), 'Snap to grid / steps', 'view.snap'),
        snapStep,
        snapList,
        units,
      ),
      h('div', { class: 'tb-group' }, btn('keyboard', 'Keyboard shortcuts', 'help.shortcuts')),
    );

    const toolbar = h('nav', { class: 'toolbar', 'aria-label': 'Tools' });
    const sidebarEl = h('aside', { class: 'sidebar' });
    const statusbar = h('footer', { class: 'statusbar' }, hint, h('div', { class: 'vcb-wrap' }, vcbLabel, vcb));
    this.shortcuts = new ShortcutsDialog(this.keymap);
    root.append(topbar, toolbar, vpEl, sidebarEl, statusbar, toast, this.shortcuts.el);

    this.els = { hint, vcbLabel, vcb, toast, empty, undo, redo, units, snap, snapStep, snapList, ortho, xray, cuts };

    // ---- core ----
    this.viewport = new Viewport(vpEl, this.doc);
    this.viewport.showCuts = this.settings.showCuts;
    this.snapper = new Snapper(this.viewport, this.doc, this.settings);

    const ctx: ToolContext = {
      doc: this.doc,
      viewport: this.viewport,
      snapper: this.snapper,
      settings: this.settings,
      setHint: (t) => (this.els.hint.textContent = t),
      setMeasurement: (label, value) => this.setMeasurement(label, value),
      toast: (t) => this.toast(t),
      setTool: (id) => this.setTool(id),
      defaultColor: () => this.defaultColor,
      workspace: () => this.workspace,
    };
    this.tools = {
      select: new SelectTool(ctx),
      box: new BoxTool(ctx),
      cylinder: new CylinderTool(ctx),
      line: new LineTool(ctx),
      pushpull: new PushPullTool(ctx),
      move: new MoveTool(ctx),
      rotate: new RotateTool(ctx),
      tape: new TapeTool(ctx),
      erase: new EraseTool(ctx),
      orbit: new OrbitTool(ctx),
      pan: new PanTool(ctx),
    };

    for (const item of TOOLBAR) {
      if (item === '|') {
        toolbar.append(h('div', { class: 'tool-sep' }));
        continue;
      }
      const b = h('button', { class: 'tool-btn', 'aria-label': TOOL_NAMES[item], onclick: () => this.setTool(item), html: icon(item, 22) });
      this.toolButtons.set(item, b);
      toolbar.append(b);
    }

    this.sidebar = new Sidebar(this.doc, {
      placeOnGround: (ids) => this.placeOnGround(ids),
      duplicateSelection: () => this.duplicateSelection(),
      deleteSelection: () => this.deleteSelection(),
      zoomTo: (ids) => this.viewport.zoomExtents(ids.map((id) => this.doc.get(id)).filter(Boolean) as Entity[]),
      exportCutList: () => this.exportCutList(),
      setDefaultColor: (c) => (this.defaultColor = c),
      keyLabel: (command) => this.keymap.label(command),
      holdLabel: (action) => holdKeyLabel(this.keymap.holdKey(action)),
      workspace: () => this.workspace,
      printIssues: () => this.printIssues,
      setPrinter: (p) => this.setPrinter(p),
      filament: () => this.settings.filament,
      setFilament: (id) => {
        this.settings.filament = id;
        saveSettings(this.settings);
        this.sidebar.render(true);
      },
      placeOnPlate: (ids) => this.placeOnPlate(ids),
      exportStl: () => this.exportStl(),
    });
    sidebarEl.append(this.sidebar.el);

    this.doc.onChange((ev) => {
      this.viewport.sync();
      this.updatePrintChecks();
      this.updateChrome();
      if (ev.committed) this.scheduleAutosave();
    });
    this.doc.onSelectionChange(() => {
      this.viewport.updateStyles();
      if (!this.active.busy) this.els.hint.textContent = this.active.hint();
    });

    this.bindSettings();
    this.bindPointer();
    this.bindKeyboard();
    this.bindVcb();
    this.bindDragDrop();

    this.keymap.onChange(() => this.refreshShortcutHints());
    this.refreshShortcutHints();

    this.active = this.tools.select;
    this.restore();
    this.setTool('select');
    this.updateChrome();
  }

  // ---- startup / persistence ----------------------------------------------

  private restore() {
    const saved = loadAutosave();
    if (saved) this.doc.load(saved, true);
    this.applyWorkspace(this.doc.workspace, { keepUnits: true });
    this.viewport.sync();
    this.viewport.setView('iso', false);
    this.viewport.zoomExtents();
  }

  // ---- workspaces -------------------------------------------------------------

  get workspace(): WorkspaceConfig {
    return WORKSPACES[this.doc.workspace];
  }

  private workspaceSwitcher(): HTMLElement {
    const wrap = h('div', { class: 'tb-group workspace-switch', role: 'radiogroup', 'aria-label': 'Workspace' });
    for (const id of WORKSPACE_IDS) {
      const ws = WORKSPACES[id];
      const b = this.withTitle(
        h('button', { class: 'ws-btn', role: 'radio', onclick: () => this.runCommand(`workspace.${id}`), html: `${icon(ws.icon, 16)}<span>${ws.name}</span>` }),
        `${ws.name} workspace — ${ws.tagline}`,
        `workspace.${id}`,
      );
      this.workspaceButtons.set(id, b);
      wrap.append(b);
    }
    return wrap;
  }

  /**
   * Switch the whole app to a workspace: units, snap, grid, materials, panels, plate.
   * `keepUnits` is used when opening a file (its own units win).
   */
  setWorkspace(id: WorkspaceId) {
    if (id === this.doc.workspace) return;
    this.active.cancel();
    this.applyWorkspace(id, { keepUnits: false });
    if (!this.doc.entities.length) {
      this.viewport.setView('iso', false);
      this.viewport.zoomExtents();
    }
    const ws = this.workspace;
    this.toast(`${ws.name} workspace — ${ws.units}, snap ${formatLength(this.settings.snapStep, ws.units)}`);
    saveAutosave(this.doc.toFile());
  }

  private applyWorkspace(id: WorkspaceId, opts: { keepUnits: boolean }) {
    if (!isWorkspaceId(id)) id = 'print';
    this.doc.workspace = id;
    const ws = WORKSPACES[id];
    if (!opts.keepUnits) this.doc.units = ws.units;
    this.els.units.value = this.doc.units;
    this.settings.snapStep = this.settings.snapByWorkspace[id] ?? ws.snapStep;
    this.els.snapList.replaceChildren(...ws.snapSteps.map((v) => h('option', { value: formatLength(v, this.doc.units, false) })));
    this.showSnapStep();
    this.defaultColor = ws.defaultColor;
    this.viewport.applyWorkspace(ws);
    if (ws.printPlate) this.viewport.setPlate(printerVolume(this.doc.printer), printerName(this.doc.printer));
    for (const [wid, b] of this.workspaceButtons) {
      b.classList.toggle('active', wid === id);
      b.setAttribute('aria-checked', String(wid === id));
    }
    this.updatePrintChecks();
    this.sidebar.setPanels(ws.panels);
    this.refreshEmptyCard();
  }

  private setPrinter(setting: PrinterSetting) {
    this.doc.printer = setting;
    this.viewport.setPlate(printerVolume(setting), printerName(setting));
    this.updatePrintChecks();
    this.sidebar.render(true);
    saveAutosave(this.doc.toFile());
    if (!this.doc.entities.length) this.viewport.zoomExtents();
  }

  /** Re-check parts against the build volume (cheap: bounds only, runs live while dragging). */
  private updatePrintChecks() {
    this.printIssues = this.workspace.printPlate ? checkPrintFit(this.doc.entities, printerVolume(this.doc.printer)) : [];
    const outside = this.printIssues.some((i) => i.problem === 'outside' || i.problem === 'too-tall');
    this.viewport.setWarnings(this.printIssues.map((i) => i.id), outside);
  }

  private placeOnPlate(ids: string[]) {
    const entities = ids.map((id) => this.doc.get(id)).filter(Boolean) as Entity[];
    const delta = placeOnPlateDelta(entities, printerVolume(this.doc.printer));
    if (delta.lengthSq() < 1e-12) return;
    this.doc.transact(() => {
      for (const e of entities) {
        this.doc.update(e.id, (x) => {
          x.position = [cleanNumber(x.position[0] + delta.x), cleanNumber(x.position[1] + delta.y), cleanNumber(x.position[2] + delta.z)];
        });
      }
    });
    this.toast('Centred on the bed');
  }

  private scheduleAutosave() {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => saveAutosave(this.doc.toFile()), 300);
  }

  private updateChrome() {
    this.els.undo.disabled = !this.doc.canUndo;
    this.els.redo.disabled = !this.doc.canRedo;
    // The start card has buttons; only show it while selecting, so it never eats a drawing click.
    this.els.empty.classList.toggle('visible', this.doc.entities.length === 0 && !this.doc.inTransaction && this.active?.id === 'select');
    this.els.ortho.textContent = this.viewport.isOrtho ? 'Ortho' : 'Persp';
    this.els.ortho.classList.toggle('active', this.viewport.isOrtho);
    this.els.xray.classList.toggle('active', this.viewport.xray);
    this.els.cuts.classList.toggle('active', this.viewport.showCuts);
    document.title = `${this.fileName} — Modeler`;
  }

  private showSnapStep() {
    this.els.snapStep.value = formatLength(this.settings.snapStep, this.doc.units, false);
  }

  private bindSettings() {
    const { snap, snapStep, units } = this.els;
    const showStep = () => this.showSnapStep();
    showStep();
    snap.addEventListener('change', () => {
      this.settings.snapEnabled = snap.checked;
      saveSettings(this.settings);
    });
    snapStep.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') snapStep.blur();
    });
    snapStep.addEventListener('change', () => {
      const v = parseLength(snapStep.value, this.doc.units);
      if (v && v > 0) {
        this.settings.snapStep = v;
        this.settings.snapByWorkspace[this.doc.workspace] = v;
        saveSettings(this.settings);
      }
      showStep();
    });
    units.addEventListener('change', () => {
      this.doc.units = units.value as Unit;
      showStep();
      this.els.snapList.replaceChildren(...this.workspace.snapSteps.map((v) => h('option', { value: formatLength(v, this.doc.units, false) })));
      this.sidebar.render(true);
      this.active.cancel();
      saveAutosave(this.doc.toFile());
    });
  }

  // ---- tools ----------------------------------------------------------------

  setTool(id: ToolId) {
    if (this.active) this.active.deactivate();
    this.active = this.tools[id];
    this.active.activate();
    this.viewport.canvas.style.cursor = this.active.cursor;
    for (const [tid, b] of this.toolButtons) b.classList.toggle('active', tid === id);
    if (this.els) this.updateChrome();
    if (this.tempNav) {
      if (id === this.tempNav.action) this.endTempNav(true);
      else this.applyTempNav();
    }
  }

  private navigationModeFor(id: ToolId): 'default' | 'orbit' | 'pan' {
    return id === 'orbit' ? 'orbit' : id === 'pan' ? 'pan' : 'default';
  }

  private onHoldKeyDown(e: KeyboardEvent, action: HoldAction) {
    this.heldKey = { key: e.key, dragged: false, at: performance.now() };
    // Don't hijack a drag that's already happening, or duplicate the active tool.
    if (this.tempNav || this.pointerButtons !== 0 || this.active.id === action) return;
    this.tempNav = { action, key: e.key, ending: false };
    this.applyTempNav();
  }

  private onHoldKeyUp(e: KeyboardEvent) {
    const held = this.heldKey;
    if (!held || held.key !== e.key) return;
    this.heldKey = null;
    this.endTempNav();
    // A quick tap without dragging keeps the key's tool meaning (e.g. Alt = copy / hole).
    if (!held.dragged && performance.now() - held.at < TAP_MS) this.active.keyDown(e);
  }

  private applyTempNav() {
    const nav = this.tempNav;
    if (!nav) return;
    // OrbitControls itself swaps rotate↔pan while Shift/Ctrl is held; compensate.
    this.viewport.setNavigationMode(nav.action, nav.key === 'Shift' || nav.key === 'Control');
    this.viewport.canvas.style.cursor = 'grab';
    for (const [id, b] of this.toolButtons) b.classList.toggle('temp', id === nav.action);
    this.viewport.setSnapMarker(null);
    this.viewport.setHover(null);
    const keyName = holdKeyLabel(this.keymap.holdKey(nav.action));
    this.els.hint.textContent =
      nav.action === 'pan'
        ? `Panning — drag to move the view. Release ${keyName} to go back to ${this.active.label}.`
        : `Orbiting — drag to rotate the view. Release ${keyName} to go back to ${this.active.label}.`;
  }

  private endTempNav(force = false) {
    const nav = this.tempNav;
    if (!nav) return;
    if (!force && this.pointerButtons & 1) {
      nav.ending = true; // finish the current drag first
      return;
    }
    this.tempNav = null;
    this.viewport.setNavigationMode(this.navigationModeFor(this.active.id));
    this.viewport.canvas.style.cursor = this.active.cursor;
    for (const b of this.toolButtons.values()) b.classList.remove('temp');
    this.els.hint.textContent = this.active.hint();
  }

  // ---- commands & shortcuts -------------------------------------------------

  private withTitle<T extends HTMLElement>(el: T, label: string, command: string): T {
    this.titled.push({ el, label, command });
    return el;
  }

  /** Update every tooltip / hint that mentions a shortcut. */
  private refreshShortcutHints() {
    const k = (cmd: string) => this.keymap.label(cmd);
    for (const { el, label, command } of this.titled) {
      const key = k(command);
      el.title = key ? `${label} (${key})` : label;
    }
    for (const [id, b] of this.toolButtons) {
      const key = k(`tool.${id}`);
      let title = key ? `${TOOL_NAMES[id]} (${key})` : TOOL_NAMES[id];
      if (id === 'pan' || id === 'orbit') {
        const hold = this.keymap.holdKey(id);
        if (hold !== 'none') title += ` — or hold ${holdKeyLabel(hold)} and drag, with any tool`;
      }
      b.title = title;
    }
    this.refreshEmptyCard();
    this.sidebar.render(true);
  }

  /** Empty model: pick a workspace and get started. */
  private refreshEmptyCard() {
    const k = (cmd: string) => this.keymap.label(cmd);
    const box = k('tool.box');
    const cards = WORKSPACE_IDS.map((id) => {
      const ws = WORKSPACES[id];
      return h('button', {
        class: `ws-card ${id === this.doc.workspace ? 'active' : ''}`,
        'aria-pressed': String(id === this.doc.workspace),
        onclick: () => this.setWorkspace(id),
      },
        h('span', { class: 'ws-card-icon', html: icon(ws.icon, 22) }),
        h('strong', {}, ws.name),
        h('span', { class: 'muted small' }, ws.tagline),
      );
    });
    this.els.empty.replaceChildren(
      h('div', { class: 'vp-empty-card' },
        h('strong', {}, 'What are you making?'),
        h('div', { class: 'ws-cards' }, ...cards),
        h('p', {}, box ? 'Then press ' : 'Then pick the Box tool', box ? h('kbd', {}, box) : null, ', click two corners, move up and click for the height.'),
        h('p', { class: 'muted' }, 'Type exact sizes while drawing — ', h('code', {}, '60,40'), ' Enter, then ', h('code', {}, '18'), ' Enter. All shortcuts: ', h('kbd', {}, k('help.shortcuts') || '⌨ top right'), '.'),
      ),
    );
  }

  runCommand(id: string) {
    if (id.startsWith('workspace.')) {
      const ws = id.slice(10);
      if (isWorkspaceId(ws)) this.setWorkspace(ws);
      return;
    }
    if (id.startsWith('tool.')) {
      const tool = id.slice(5) as ToolId;
      if (tool in this.tools) this.setTool(tool);
      return;
    }
    if (id.startsWith('view.') && ['iso', 'top', 'bottom', 'front', 'back', 'left', 'right'].includes(id.slice(5))) {
      this.viewport.setView(id.slice(5) as ViewName);
      return;
    }
    const selected = () => [...this.doc.selection];
    const actions: Record<string, () => void> = {
      'edit.undo': () => {
        this.doc.undo();
        this.active.cancel();
      },
      'edit.redo': () => {
        this.doc.redo();
        this.active.cancel();
      },
      'edit.delete': () => this.deleteSelection(),
      'edit.duplicate': () => this.duplicateSelection(),
      'edit.selectAll': () => this.doc.setSelection(this.doc.entities.filter((x) => x.visible).map((x) => x.id)),
      'edit.placeOnGround': () => this.placeOnGround(selected()),
      'edit.toggleHole': () => {
        const sel = this.doc.selected();
        if (!sel.length) return;
        const makeHole = !sel.every((e) => e.hole);
        this.doc.transact(() => sel.forEach((e) => this.doc.update(e.id, (x) => (x.hole = makeHole))));
      },
      'view.extents': () => this.viewport.zoomExtents(),
      'view.zoomSelection': () => this.viewport.zoomExtents(this.doc.selected()),
      'view.projection': () => this.toggleOrtho(),
      'view.xray': () => this.toggleXray(),
      'view.cuts': () => this.toggleCuts(),
      'view.snap': () => {
        this.settings.snapEnabled = !this.settings.snapEnabled;
        this.els.snap.checked = this.settings.snapEnabled;
        saveSettings(this.settings);
        this.toast(`Snap ${this.settings.snapEnabled ? 'on' : 'off'}`);
      },
      'file.new': () => this.newModel(),
      'file.open': () => void this.open(),
      'file.save': () => this.save(),
      'file.exportStl': () => this.exportStl(),
      'file.exportCutList': () => this.exportCutList(),
      'help.shortcuts': () => this.shortcuts.toggle(),
      'print.placeOnPlate': () => {
        const sel = this.doc.selected();
        this.placeOnPlate((sel.length ? sel : this.doc.entities).map((e) => e.id));
      },
    };
    actions[id]?.();
  }

  private toolEvent(e: PointerEvent | MouseEvent): ToolEvent {
    const rect = this.viewport.canvas.getBoundingClientRect();
    return {
      px: new THREE.Vector2(e.clientX - rect.left, e.clientY - rect.top),
      button: e.button,
      shift: e.shiftKey,
      mod: e.metaKey || e.ctrlKey,
      alt: e.altKey,
    };
  }

  private bindPointer() {
    const canvas = this.viewport.canvas;
    // Track pressed buttons globally (drags can end outside the canvas).
    for (const type of ['pointerdown', 'pointermove', 'pointerup'] as const) {
      window.addEventListener(type, (e) => (this.pointerButtons = e.buttons), { capture: true });
    }
    canvas.addEventListener('pointerdown', (e) => {
      if (document.activeElement !== canvas) canvas.focus({ preventScroll: true });
      if (this.heldKey) this.heldKey.dragged = true;
      if (this.tempNav) {
        if (e.button === 0) canvas.style.cursor = 'grabbing';
        return; // OrbitControls pans/orbits; the tool never sees this drag
      }
      if (e.button === 0) this.active.pointerDown(this.toolEvent(e));
    });
    canvas.addEventListener('pointermove', (e) => {
      // Ignore moves during hold-to-pan/orbit, or while middle/right-button navigating.
      if (this.tempNav || e.buttons & 6) return;
      this.active.pointerMove(this.toolEvent(e));
    });
    canvas.addEventListener('pointerup', (e) => {
      if (this.tempNav) {
        if (this.tempNav.ending) this.endTempNav();
        else canvas.style.cursor = 'grab';
        return;
      }
      this.active.pointerUp(this.toolEvent(e));
    });
    canvas.addEventListener('dblclick', (e) => {
      if (!this.tempNav) this.active.doubleClick(this.toolEvent(e));
    });
    canvas.addEventListener('pointerleave', () => {
      if (!this.active.busy) this.viewport.setSnapMarker(null);
      this.viewport.setHover(null);
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (this.shortcuts.isOpen) return; // the dialog handles its own keys
      if (e.target === this.els.vcb) return; // handled by the measurement box
      if (isTextInput(e.target)) return;

      const hold = this.keymap.holdActionFor(e.key);
      if (hold) {
        if (!e.repeat) this.onHoldKeyDown(e, hold);
        if (e.key === 'Alt') e.preventDefault(); // keep Windows browsers from focusing the menu bar
        return;
      }

      if (e.key === 'Escape') {
        if (!this.active.busy) this.doc.clearSelection();
        this.active.cancel();
        e.preventDefault();
        return;
      }

      // Tools get first pick: arrows, Enter, Backspace in Line, Alt taps, …
      if (this.active.keyDown(e)) {
        e.preventDefault();
        return;
      }

      // Typing digits/symbols goes straight into the measurement box.
      const plain = !e.altKey && !e.metaKey && !e.ctrlKey;
      if (plain && (MEASUREMENT_CHARS.test(e.key) || (e.key.length === 1 && this.active.vcbStarters.includes(e.key)))) {
        this.els.vcb.value = e.key;
        this.els.vcb.focus();
        e.preventDefault();
        return;
      }

      const combo = comboFromEvent(e);
      const command = combo ? this.keymap.commandFor(combo) : undefined;
      if (command) {
        e.preventDefault();
        this.runCommand(command);
      }
    });
    window.addEventListener('keyup', (e) => {
      // Always honour hold-key release, even if focus moved into a field meanwhile.
      if (this.heldKey?.key === e.key) {
        if (e.key === 'Alt') e.preventDefault();
        this.onHoldKeyUp(e);
        return;
      }
      if (!isTextInput(e.target)) this.active.keyUp(e);
    });
    // Losing focus while holding a key would otherwise leave us stuck in a mode.
    window.addEventListener('blur', () => {
      this.viewport.setSnapMarker(null);
      this.pointerButtons = 0;
      this.heldKey = null;
      this.endTempNav(true);
    });
  }

  private bindVcb() {
    const vcb = this.els.vcb;
    vcb.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const text = vcb.value.trim();
        if (!text) return;
        const ok = this.active.value(text);
        if (!ok) {
          vcb.classList.add('invalid');
          setTimeout(() => vcb.classList.remove('invalid'), 700);
          this.toast(`Can’t use “${text}” here`);
          return;
        }
        this.viewport.canvas.focus({ preventScroll: true });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        vcb.value = '';
        this.viewport.canvas.focus({ preventScroll: true });
      }
    });
  }

  private setMeasurement(label: string, value: string) {
    this.els.vcbLabel.textContent = label;
    if (document.activeElement !== this.els.vcb) this.els.vcb.value = value;
  }

  private bindDragDrop() {
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file) void this.openFile(file);
    });
  }

  // ---- view toggles ---------------------------------------------------------

  private toggleOrtho() {
    this.viewport.setOrtho(!this.viewport.isOrtho);
    this.updateChrome();
  }

  private toggleXray() {
    this.viewport.xray = !this.viewport.xray;
    this.viewport.updateStyles();
    this.updateChrome();
  }

  private toggleCuts() {
    this.viewport.showCuts = !this.viewport.showCuts;
    this.settings.showCuts = this.viewport.showCuts;
    saveSettings(this.settings);
    this.viewport.sync();
    this.updateChrome();
  }

  // ---- actions --------------------------------------------------------------

  private toast(text: string) {
    const el = this.els.toast;
    el.textContent = text;
    el.classList.add('visible');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('visible'), 2400);
  }

  private newModel() {
    this.active.cancel();
    if (!this.doc.entities.length) return;
    this.doc.load({ format: 'modeler', version: 1, units: this.doc.units, entities: [] }, false);
    this.fileName = 'model';
    this.updateChrome();
    this.toast('New model — Undo (⌘/Ctrl+Z) brings the old one back');
  }

  private async open() {
    const file = await pickFile('.json,application/json');
    if (file) await this.openFile(file);
  }

  private async openFile(file: File) {
    try {
      const parsed = parseDocumentFile(await file.text());
      this.active.cancel();
      this.doc.load(parsed, false);
      this.applyWorkspace(this.doc.workspace, { keepUnits: true });
      this.fileName = file.name.replace(/(\.modeler)?\.json$/i, '') || 'model';
      this.viewport.zoomExtents();
      this.updateChrome();
      this.toast(`Opened ${file.name} (${parsed.entities.length} objects)`);
    } catch (err) {
      this.toast(`Couldn’t open ${file.name}: ${(err as Error).message}`);
    }
  }

  private save() {
    downloadBlob(JSON.stringify(this.doc.toFile(), null, 1), `${this.fileName}.modeler.json`, 'application/json');
    this.toast('Project downloaded');
  }

  private exportStl() {
    const selected = this.doc.selected();
    const targets = selected.length ? selected : this.doc.entities;
    const buffer = exportStl(targets, this.doc.entities);
    if (!buffer) {
      this.toast('Nothing to export — add a solid first');
      return;
    }
    downloadBlob(buffer, `${this.fileName}${selected.length ? '-selection' : ''}.stl`, 'model/stl');
    const solids = targets.filter((e) => !e.hole && e.visible).length;
    this.toast(`Exported ${solids} solid${solids === 1 ? '' : 's'} to STL (mm, holes applied)`);
  }

  private exportCutList() {
    const csv = cutListToCsv(buildCutList(this.doc.entities), this.doc.units);
    downloadBlob(csv, `${this.fileName}-cutlist.csv`, 'text/csv');
  }

  private deleteSelection() {
    if (!this.doc.selection.size) return;
    this.doc.remove([...this.doc.selection]);
  }

  /** Copies sit right next to the originals (+X) so they're easy to grab. */
  private duplicateSelection() {
    const sel = this.doc.selected();
    if (!sel.length) return;
    const size = worldBoundsOf(sel).getSize(new THREE.Vector3());
    const offset = cleanNumber(size.x + Math.max(10, size.x * 0.1));
    const ids: string[] = [];
    this.doc.transact(() => {
      for (const e of sel) {
        const copy = structuredClone(e);
        copy.id = newId();
        copy.position = [cleanNumber(e.position[0] + offset), e.position[1], e.position[2]];
        this.doc.add(copy);
        ids.push(copy.id);
      }
    });
    this.doc.setSelection(ids);
  }

  private placeOnGround(ids: string[]) {
    const entities = ids.map((id) => this.doc.get(id)).filter(Boolean) as Entity[];
    if (!entities.length) return;
    const minZ = worldBoundsOf(entities).min.z;
    if (Math.abs(minZ) < 1e-9) return;
    this.doc.transact(() => {
      for (const e of entities) this.doc.update(e.id, (x) => (x.position[2] = cleanNumber(x.position[2] - minZ)));
    });
  }
}
