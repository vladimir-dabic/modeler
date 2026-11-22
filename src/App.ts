import * as THREE from 'three';
import { ModelerApi, type ApiResult } from './api';
import { BridgeClient, type BridgeStatus } from './bridge/BridgeClient';
import { BRIDGE_INFO_PATH } from './bridge/protocol';
import { activeCsgEngine, type CsgEngine } from './model/csg';
import { exportGlb } from './model/gltf';
import { copyParts, parseClip } from './model/clipboard';
import { canLink } from './model/parts';
import type { ExplodeAxis } from './model/explode';
import { cutListToCsv, buildCutList } from './model/cutlist';
import { ModelDocument } from './model/Document';
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
import { groupChain, groupForSelection, groupMembers, isInsideGroup, selectionUnit } from './model/groups';
import type { Entity, Unit } from './model/types';
import {
  checkPrintFit,
  isWorkspaceId,
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
import { DimensionTool, TextTool } from './tools/AnnotationTools';
import { BoxTool, CylinderTool, LineTool } from './tools/CreateTools';
import { EraseTool, OrbitTool, PanTool, TapeTool } from './tools/MiscTools';
import { MoveTool } from './tools/MoveTool';
import { PushPullTool } from './tools/PushPullTool';
import { RotateTool } from './tools/RotateTool';
import { SelectTool } from './tools/SelectTool';
import { SphereTool } from './tools/SphereTool';
import type { Tool, ToolContext, ToolEvent, ToolId } from './tools/Tool';
import { COMMANDS } from './commands';
import { comboFromEvent, holdKeyLabel, Keymap, MEASUREMENT_CHARS, type HoldAction } from './keymap';
import { h, isTextInput } from './ui/dom';
import { icon } from './ui/icons';
import { ProjectFiles, type OpenedFile, type FileHandle } from './ui/ProjectFiles';
import { ContextMenu, type MenuItem } from './ui/ContextMenu';
import { InstructionsView } from './ui/InstructionsView';
import { NewProjectDialog } from './ui/NewProjectDialog';
import { TabSession } from './ui/TabSession';
import { ShortcutsDialog } from './ui/ShortcutsDialog';
import { Sidebar } from './ui/Sidebar';
import { Snapper } from './viewport/Snapper';
import { Viewport, type ViewName } from './viewport/Viewport';

const TOOLBAR: (ToolId | '|')[] = ['select', '|', 'box', 'cylinder', 'sphere', 'line', '|', 'pushpull', 'move', 'rotate', '|', 'tape', 'dimension', 'text', 'erase', '|', 'orbit', 'pan'];

const TOOL_NAMES: Record<ToolId, string> = {
  select: 'Select',
  box: 'Box',
  cylinder: 'Cylinder / cone',
  sphere: 'Sphere',
  line: 'Line / Shape',
  pushpull: 'Push/Pull',
  move: 'Move / Copy',
  rotate: 'Rotate',
  tape: 'Tape Measure',
  dimension: 'Dimension',
  text: 'Text / note',
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


/** The last copy in this browser, for pasting when the system clipboard can't be read. */
const CLIP_KEY = 'modeler.clipboard.v1';
/** Commands the browser's own ⌘C / ⌘X / ⌘V events handle (key per command). */
const NATIVE_CLIPBOARD: Record<string, string> = { 'edit.copy': 'c', 'edit.cut': 'x', 'edit.paste': 'v' };

export class App {
  readonly doc = new ModelDocument();
  readonly settings: Settings = loadSettings();
  readonly viewport: Viewport;
  readonly snapper: Snapper;
  /** The Modeler API: every model change from the UI goes through it (ADR 0008). */
  readonly api: ModelerApi;
  /** Live link to the MCP server, opened by the "Connect AI" command (ADR 0013). */
  readonly bridge: BridgeClient;
  private readonly tools: Record<ToolId, Tool>;
  private active: Tool;
  private readonly sidebar: Sidebar;
  private readonly toolButtons = new Map<ToolId, HTMLButtonElement>();
  readonly keymap = new Keymap(COMMANDS, safeStorage());
  private readonly shortcuts: ShortcutsDialog;
  private readonly instructions: InstructionsView;
  private instructionsTimer = 0;
  private readonly contextMenu = new ContextMenu();
  /** Buttons whose tooltip shows a (customisable) shortcut. */
  private readonly titled: { el: HTMLElement; label: string; command: string }[] = [];
  private readonly workspaceChip = h('button', { class: 'ws-chip', 'aria-label': 'Workspace', 'aria-haspopup': 'menu' });
  private readonly newProject = new NewProjectDialog();
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
    groupBadge: HTMLElement;
    ortho: HTMLButtonElement;
    xray: HTMLButtonElement;
    cuts: HTMLButtonElement;
    explode: HTMLButtonElement;
    explodeControls: HTMLElement;
    explodeSlider: HTMLInputElement;
    explodeAxis: HTMLSelectElement;
    ai: HTMLButtonElement;
    docName: HTMLElement;
  };
  /** The project file being edited (ADR 0016). */
  readonly files = new ProjectFiles();
  /** This tab's autosave slot (ADR 0023). */
  private readonly session = new TabSession({ local: localStorage, session: sessionStorage });
  /** Changed since the last save or open. */
  private dirty = false;
  private defaultColor = '#d4dae3';
  private autosaveTimer = 0;
  private warnedAutosave = false;
  /**
   * Holding the pan/orbit key (Shift / Alt by default) turns the left button into
   * pan/orbit without switching tools, so an operation in progress survives.
   * `ending` = the key was released mid-drag; we leave the mode when that drag ends.
   */
  private tempNav: { action: HoldAction; key: string; ending: boolean } | null = null;
  /** The hold key currently down, to tell a tap (tool toggle) from a hold-and-drag. */
  private heldKey: { key: string; dragged: boolean; at: number } | null = null;
  private pointerButtons = 0;
  private rightDown: { x: number; y: number } | null = null;
  private toastTimer = 0;

  constructor(root: HTMLElement) {
    // ---- layout ----
    const vpEl = h('main', { class: 'viewport' });
    const empty = h('div', { class: 'vp-empty' });
    const groupBadge = h('div', { class: 'group-badge', hidden: true });
    vpEl.append(empty, groupBadge);

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
    const explode = textBtn('Explode', 'Pull the model apart to see how it fits together (view only: nothing moves in the model)', 'view.explode');
    const explodeSlider = h('input', { type: 'range', min: '5', max: '100', step: '1', value: '60', class: 'explode-slider', title: 'How far apart', 'aria-label': 'Explode amount' });
    explodeSlider.addEventListener('input', () => this.setExplode(Number(explodeSlider.value) / 100));
    const explodeAxis = h('select', { class: 'select tiny', title: 'Direction', 'aria-label': 'Explode direction' },
      ...[['', 'All'], ['x', 'X'], ['y', 'Y'], ['z', 'Z']].map(([v, l]) => h('option', { value: v }, l)),
    );
    explodeAxis.addEventListener('change', () => this.setExplode(this.viewport.explode.factor, (explodeAxis.value || null) as ExplodeAxis | null));
    // Floats over the viewport while exploded (the top bar has no room for a slider).
    const explodeControls = h('div', { class: 'explode-panel', hidden: true },
      h('span', { class: 'muted', title: 'Look only: nothing in the model moves. Assemble to edit.' }, 'Exploded view · look only'),
      explodeSlider,
      explodeAxis,
      h('button', { class: 'icon-btn', title: 'Assemble again', 'aria-label': 'Assemble again', onclick: () => this.setExplode(0) }, '×'),
    );
    vpEl.append(explodeControls);
    const ai = btn('ai', 'Let Claude edit this model through the modeler MCP server', 'ai.connect', 'Connect AI');
    ai.classList.add('ai-btn');

    const views: [ViewName, string][] = [
      ['iso', 'Iso'],
      ['top', 'Top'],
      ['front', 'Front'],
      ['right', 'Right'],
      ['left', 'Left'],
      ['back', 'Back'],
    ];

    const docName = h('span', { class: 'doc-name', title: 'The project file you are editing' });
    const recentBtn = h('button', { class: 'tb-btn caret-btn', 'aria-label': 'Open recent', title: 'Open recent', onclick: () => void this.showRecent(recentBtn) }, '▾');
    const topbar = h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', html: icon('box', 18) }), 'Modeler', docName, this.workspaceSwitcher()),
      h('div', { class: 'tb-group' },
        btn('new', 'New model', 'file.new'),
        btn('open', 'Open project…', 'file.open'),
        recentBtn,
        btn('drawing', 'Import a DXF drawing (e.g. a floor plan) to build on and snap to', 'file.importDxf'),
        btn('save', 'Save project', 'file.save'),
        btn('export', 'Export STL for 3D printing (selection, or everything)', 'file.exportStl', 'STL'),
        btn('export', 'Export GLB for SketchUp, Blender and renderers (selection, or everything)', 'file.exportGlb', 'GLB'),
        btn('book', 'Build instructions: an IKEA-style booklet with parts, cut list and steps, to print or save as PDF', 'file.instructions', 'Instructions'),
      ),
      h('div', { class: 'tb-group' }, undo, redo),
      h('div', { class: 'tb-group views' },
        ...views.map(([v, label]) => textBtn(label, `${label} view`, `view.${v}`)),
        btn('extents', 'Zoom extents', 'view.extents'),
      ),
      h('div', { class: 'tb-group' }, ortho, xray, cuts, explode),
      h('div', { class: 'tb-spacer' }),
      h('div', { class: 'tb-group settings' },
        this.withTitle(h('label', { class: 'tb-field' }, snap, h('span', {}, 'Snap')), 'Snap to grid / steps', 'view.snap'),
        snapStep,
        snapList,
        units,
      ),
      h('div', { class: 'tb-group' }, ai),
      h('div', { class: 'tb-group' }, btn('keyboard', 'Keyboard shortcuts', 'help.shortcuts')),
    );

    const toolbar = h('nav', { class: 'toolbar', 'aria-label': 'Tools' });
    const sidebarEl = h('aside', { class: 'sidebar' });
    const statusbar = h('footer', { class: 'statusbar' }, hint, h('div', { class: 'vcb-wrap' }, vcbLabel, vcb));
    this.shortcuts = new ShortcutsDialog(this.keymap);
    root.append(topbar, toolbar, vpEl, sidebarEl, statusbar, toast, this.shortcuts.el, this.newProject.el);

    this.els = { hint, vcbLabel, vcb, toast, empty, undo, redo, units, snap, snapStep, snapList, ortho, xray, cuts, groupBadge, ai, docName, explode, explodeControls, explodeSlider, explodeAxis };

    // ---- core ----
    this.viewport = new Viewport(vpEl, this.doc);
    this.instructions = new InstructionsView({
      doc: this.doc,
      renderer: this.viewport.renderer,
      name: () => this.files.name,
      call: (name, input, label) => this.uiCall(name, input, label).ok,
    });
    this.viewport.showCuts = this.settings.showCuts;
    this.snapper = new Snapper(this.viewport, this.doc, this.settings);
    this.api = new ModelerApi(this.doc, {
      renderViews: (views, size, opts) => this.viewport.renderViewImages(views, size, opts),
      setExplode: (factor, axis) => this.setExplode(factor, axis),
    });
    this.bridge = new BridgeClient(this.api, {
      port: Number(new URLSearchParams(location.search).get('aiPort')) || undefined,
      onStatus: (status, why) => this.showAiStatus(status, why),
      beforeRequest: (operation) => {
        if (this.doc.inTransaction) this.active.cancel();
        // Claude's edits land on the assembled model, where the user can see them.
        if (this.viewport.exploded && (operation === null || this.changesModel(operation))) {
          this.setExplode(0);
          this.toast('Assembled again for Claude’s change');
        }
      },
      onModelChange: (label) => this.toast(label),
    });
    // Served by the MCP server itself (ADR 0026)? Then its bridge is on that same server.
    if (!new URLSearchParams(location.search).get('aiPort')) {
      void fetch(BRIDGE_INFO_PATH, { cache: 'no-store' })
        .then((r) => (r.ok && r.headers.get('content-type')?.includes('application/json') ? r.json() : null))
        .then((info: { app?: string; port?: number } | null) => {
          if (info?.app === 'modeler' && typeof info.port === 'number') this.bridge.setPort(info.port);
        })
        .catch(() => {});
    }

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
      call: (name, input, label) => this.uiCall(name, input, label),
    };
    this.tools = {
      select: new SelectTool(ctx),
      box: new BoxTool(ctx),
      cylinder: new CylinderTool(ctx),
      sphere: new SphereTool(ctx),
      line: new LineTool(ctx),
      pushpull: new PushPullTool(ctx),
      move: new MoveTool(ctx),
      rotate: new RotateTool(ctx),
      tape: new TapeTool(ctx),
      dimension: new DimensionTool(ctx),
      text: new TextTool(ctx),
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
      zoomToReference: (id) => this.viewport.fitBox(this.viewport.referencesBox([id])),
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
      call: (name, input, label) => this.uiCall(name, input, label).ok,
      runCommand: (id) => this.runCommand(id),
    });
    sidebarEl.append(this.sidebar.el);

    this.doc.onChange((ev) => {
      this.viewport.sync();
      this.updatePrintChecks();
      if (ev.committed) {
        this.dirty = true;
        this.scheduleAutosave();
        // An open booklet follows the model (e.g. Claude rewrote the steps).
        if (this.instructions.isOpen) {
          clearTimeout(this.instructionsTimer);
          this.instructionsTimer = window.setTimeout(() => this.instructions.refresh(), 120);
        }
      }
      this.updateChrome();
    });
    this.doc.onSelectionChange(() => {
      this.viewport.updateStyles();
      this.updateGroupBadge();
      if (!this.active.busy) this.els.hint.textContent = this.active.hint();
    });
    // Document settings can change from the UI or the API (AI); react the same way.
    this.doc.onSettingsChange((change) => {
      if (change === 'workspace') {
        this.applyWorkspace();
        if (!this.doc.entities.length) {
          this.viewport.setView('iso', false);
          this.viewport.zoomExtents();
        }
        const ws = this.workspace;
        this.toast(`${ws.name} workspace — ${ws.units}, snap ${formatLength(this.settings.snapStep, ws.units)}`);
      } else if (change === 'printer') {
        this.viewport.setPlate(printerVolume(this.doc.printer), printerName(this.doc.printer));
        this.updatePrintChecks();
        this.sidebar.render(true);
        if (!this.doc.entities.length) this.viewport.zoomExtents();
      } else {
        this.els.units.value = this.doc.units;
        this.viewport.annotations.sync(); // dimension values are shown in display units
        this.viewport.requestRender();
        this.refreshSnapList();
        this.showSnapStep();
        this.sidebar.render(true);
      }
      this.dirty = true;
      this.updateChrome();
      this.autosave();
    });

    this.bindSettings();
    this.bindPointer();
    this.bindKeyboard();
    this.bindClipboard();
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
    this.files.currentKey = this.session.currentFileKey;
    this.session.start(window);
    const saved = loadAutosave(this.session.autosaveKey);
    if (saved) {
      this.doc.load(saved, true);
      // Reconnect to the file the autosaved model came from, so ⌘S saves back to it.
      const from = this.session.sourceFileKey;
      if (from) void this.files.restoreCurrent(from).then(() => this.updateChrome());
    }
    this.dirty = false;
    this.applyWorkspace();
    this.viewport.sync();
    this.viewport.setView('iso', false);
    this.viewport.zoomExtents();
  }

  // ---- workspaces -------------------------------------------------------------

  get workspace(): WorkspaceConfig {
    return WORKSPACES[this.doc.workspace];
  }

  /** The workspace as a small badge next to the file name; click to change it. */
  private workspaceSwitcher(): HTMLElement {
    const chip = this.workspaceChip;
    chip.addEventListener('click', () => {
      const r = chip.getBoundingClientRect();
      this.contextMenu.open(r.left, r.bottom + 4, WORKSPACE_IDS.map((id) => ({
        label: `${id === this.doc.workspace ? '✓ ' : ''}${WORKSPACES[id].name} — ${WORKSPACES[id].tagline}`,
        run: () => this.runCommand(`workspace.${id}`),
      })));
    });
    return chip;
  }

  /** Switch workspace (through the API, so the AI does it the same way). */
  setWorkspace(id: WorkspaceId) {
    if (id === this.doc.workspace) return;
    this.active.cancel();
    this.uiCall('set_workspace', { workspace: id });
  }

  /** Push the document's workspace into the UI: snap, grid, materials, panels, plate. */
  private applyWorkspace() {
    if (!isWorkspaceId(this.doc.workspace)) this.doc.workspace = 'print';
    const id = this.doc.workspace;
    const ws = WORKSPACES[id];
    this.els.units.value = this.doc.units;
    this.settings.snapStep = this.settings.snapByWorkspace[id] ?? ws.snapStep;
    this.refreshSnapList();
    this.showSnapStep();
    this.defaultColor = ws.defaultColor;
    this.viewport.applyWorkspace(ws);
    if (ws.printPlate) this.viewport.setPlate(printerVolume(this.doc.printer), printerName(this.doc.printer));
    this.workspaceChip.innerHTML = `${icon(ws.icon, 14)}<span>${ws.name}</span><span class="caret">▾</span>`;
    this.workspaceChip.title = `${ws.name} workspace — ${ws.tagline} Click to change.`;
    this.updatePrintChecks();
    this.sidebar.setPanels(ws.panels);
    this.refreshEmptyCard();
  }

  private refreshSnapList() {
    this.els.snapList.replaceChildren(...this.workspace.snapSteps.map((v) => h('option', { value: formatLength(v, this.doc.units, false) })));
  }

  private setPrinter(setting: PrinterSetting) {
    this.uiCall('set_printer', setting.profile === 'custom' ? { custom: setting.custom } : { profile: setting.profile });
  }

  /**
   * Run an API operation for the UI. Errors become a toast with the API's hint, so the
   * user sees the same explanation an AI client would get.
   */
  /** The geometry engine cutting holes right now (ADR 0017); for debugging and the smoke test. */
  geometryEngine(): CsgEngine {
    return activeCsgEngine();
  }

  /** Write and history operations change the model; the exploded view is look-only. */
  private changesModel(operation: string): boolean {
    const kind = this.api.operations().find((op) => op.name === operation)?.kind;
    return kind === 'write' || kind === 'history';
  }

  /** In the exploded view, edits are refused with this message. */
  private refuseWhileExploded(): boolean {
    if (!this.viewport.exploded) return false;
    this.toast(`Exploded view is look-only. Assemble it to edit (× in the panel, or ${this.keymap.label('view.explode') || 'Explode'}).`);
    return true;
  }

  uiCall(name: string, input: unknown, label?: string): ApiResult {
    if (this.changesModel(name) && this.refuseWhileExploded()) {
      return { ok: false, error: { code: 'unsupported', message: 'The exploded view is look-only' } };
    }
    const result = this.api.call(name, input, { source: 'ui', label });
    if (!result.ok) this.toast(result.error.hint ? `${result.error.message} — ${result.error.hint}` : result.error.message);
    return result;
  }

  private resultIds(result: ApiResult): string[] {
    return result.ok ? ((result.data as { ids?: string[] })?.ids ?? []) : [];
  }

  /** Re-check parts against the build volume (cheap: bounds only, runs live while dragging). */
  private updatePrintChecks() {
    this.printIssues = this.workspace.printPlate ? checkPrintFit(this.doc.entities, printerVolume(this.doc.printer)) : [];
    const outside = this.printIssues.some((i) => i.problem === 'outside' || i.problem === 'too-tall');
    this.viewport.setWarnings(this.printIssues.map((i) => i.id), outside);
  }

  private placeOnPlate(ids: string[]) {
    if (!ids.length) return;
    if (this.uiCall('place_on_plate', { target: { ids } }, 'Place on plate').ok) this.toast('Centred on the bed');
  }

  private scheduleAutosave() {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => this.autosave(), 300);
  }

  private autosave() {
    const status = saveAutosave(this.doc.toFile(), this.session.autosaveKey);
    if (status !== 'failed') this.session.saved();
    if (status === 'partial' && !this.warnedAutosave) {
      this.warnedAutosave = true;
      this.toast('The reference drawing is too large for the browser autosave. Save the project to keep it.');
    }
  }

  private updateChrome() {
    this.els.undo.disabled = this.viewport.exploded || !this.doc.canUndo;
    this.els.redo.disabled = this.viewport.exploded || !this.doc.canRedo;
    // The start card has buttons; only show it while selecting, so it never eats a drawing click.
    this.els.empty.classList.toggle('visible', this.doc.entities.length === 0 && !this.doc.inTransaction && this.active?.id === 'select');
    this.els.ortho.textContent = this.viewport.isOrtho ? 'Ortho' : 'Persp';
    this.els.ortho.classList.toggle('active', this.viewport.isOrtho);
    this.els.xray.classList.toggle('active', this.viewport.xray);
    this.els.cuts.classList.toggle('active', this.viewport.showCuts);
    const name = this.files.name;
    document.title = `${this.dirty ? '• ' : ''}${name} — Modeler`;
    this.els.docName.textContent = name;
    this.els.docName.classList.toggle('dirty', this.dirty);
    this.els.docName.title = this.dirty ? `${this.files.fileName}: unsaved changes (${this.keymap.label('file.save') || 'Save'})` : this.files.fileName;
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
      this.active.cancel();
      this.doc.setUnits(units.value as Unit);
    });
  }

  // ---- tools ----------------------------------------------------------------

  setTool(id: ToolId) {
    // The exploded view is for looking: editing tools work on the assembled model.
    if (this.viewport?.exploded && !['select', 'orbit', 'pan'].includes(id)) {
      this.setExplode(0);
      this.toast('Assembled again for editing');
    }
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
        if (this.refuseWhileExploded()) return;
        this.doc.undo();
        this.active.cancel();
      },
      'edit.redo': () => {
        if (this.refuseWhileExploded()) return;
        this.doc.redo();
        this.active.cancel();
      },
      'edit.delete': () => this.deleteSelection(),
      'edit.duplicate': () => this.duplicateSelection(),
      'edit.makeComponent': () => {
        const n = this.doc.selection.size;
        if (n > 1 && this.uiCall('make_component', { target: { selection: true } }, 'Make component').ok) this.toast(`Linked ${n} copies — editing one now edits all`);
      },
      'edit.makeUnique': () => {
        if (this.doc.selection.size && this.uiCall('make_unique', { target: { selection: true } }, 'Make unique').ok) this.toast('Unlinked — these parts can now be changed on their own');
      },
      'edit.copy': () => void this.copyToSystem(false),
      'edit.cut': () => void this.copyToSystem(true),
      'edit.paste': () => void this.pasteFromSystem(),
      'edit.selectAll': () => this.doc.setSelection(this.doc.entities.filter((x) => x.visible).map((x) => x.id)),
      'edit.placeOnGround': () => this.placeOnGround(selected()),
      'edit.toggleHole': () => {
        const sel = this.doc.selected();
        if (sel.length) this.uiCall('set_hole', { target: { selection: true }, hole: !sel.every((e) => e.hole) }, 'Solid / hole');
      },
      'edit.group': () => this.groupSelection(),
      'edit.ungroup': () => this.ungroupSelection(),
      'edit.openGroup': () => {
        const g = groupForSelection(this.doc.selection, this.doc.entities, this.doc.groups);
        if (g) {
          this.doc.setOpenGroup(g.id);
          this.doc.clearSelection();
        }
      },
      'edit.closeGroup': () => this.closeGroup(),
      'edit.hide': () => {
        if (this.doc.selection.size) this.uiCall('set_visible', { target: { selection: true }, visible: false }, 'Hide');
      },
      'edit.showHidden': () => {
        if (this.doc.entities.some((e) => !e.visible)) this.uiCall('set_visible', { target: { all: true }, visible: true }, 'Show hidden');
      },
      'view.extents': () => this.viewport.zoomExtents(),
      'view.zoomSelection': () => this.viewport.zoomExtents(this.doc.selected()),
      'view.projection': () => this.toggleOrtho(),
      'view.xray': () => this.toggleXray(),
      'view.cuts': () => this.toggleCuts(),
      'view.explode': () => this.setExplode(this.viewport.exploded ? 0 : Number(this.els.explodeSlider.value) / 100),
      'view.annotations': () => {
        this.viewport.annotations.visible = !this.viewport.annotations.visible;
        this.viewport.requestRender();
        this.toast(`Notes and dimensions ${this.viewport.annotations.visible ? 'shown' : 'hidden'}`);
      },
      'view.snap': () => {
        this.settings.snapEnabled = !this.settings.snapEnabled;
        this.els.snap.checked = this.settings.snapEnabled;
        saveSettings(this.settings);
        this.toast(`Snap ${this.settings.snapEnabled ? 'on' : 'off'}`);
      },
      'file.new': () => this.newProject.open(this.doc.workspace, (id) => this.newModel(id)),
      'file.open': () => void this.open(),
      'file.save': () => void this.save(),
      'file.saveAs': () => void this.save(true),
      'file.exportStl': () => this.exportStl(),
      'file.exportGlb': () => this.exportGlb(),
      'file.instructions': () => (this.instructions.isOpen ? this.instructions.close() : this.instructions.open()),
      'file.importDxf': () => void this.importDxf(),
      'file.exportCutList': () => this.exportCutList(),
      'help.shortcuts': () => this.shortcuts.toggle(),
      'ai.connect': () => (this.bridge.status === 'off' ? this.bridge.start() : this.bridge.stop('AI disconnected')),
      'print.split': () => this.splitForPrint(),
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
      if (e.button === 2) this.rightDown = { x: e.clientX, y: e.clientY };
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
      // Right-click (no drag) opens the context menu; right-drag pans (ADR 0012).
      if (e.button === 2 && this.rightDown) {
        const moved = Math.hypot(e.clientX - this.rightDown.x, e.clientY - this.rightDown.y);
        this.rightDown = null;
        if (moved < 4 && !this.tempNav) this.openContextMenu(e);
        return;
      }
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
      if (this.active.id !== 'move' || !this.active.busy) this.viewport.setHighlighted([]);
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (this.shortcuts.isOpen || this.newProject.isOpen) return; // dialogs handle their own keys
      // The booklet is a page over the app: only undo/redo reach the model.
      if (this.instructions.isOpen && !((e.metaKey || e.ctrlKey) && /^[zy]$/i.test(e.key))) return;
      if (e.target === this.els.vcb) return; // handled by the measurement box
      if (isTextInput(e.target)) return;

      const hold = this.keymap.holdActionFor(e.key);
      if (hold) {
        if (!e.repeat) this.onHoldKeyDown(e, hold);
        if (e.key === 'Alt') e.preventDefault(); // keep Windows browsers from focusing the menu bar
        return;
      }

      if (e.key === 'Escape') {
        // Cancel the operation first; then clear the selection; then leave an open group.
        if (this.contextMenu.isOpen) this.contextMenu.close();
        else if (this.active.busy) this.active.cancel();
        else if (this.doc.selection.size || this.doc.annotationSelection.size) this.doc.clearSelection();
        else this.closeGroup();
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
      // The browser's own ⌘C / ⌘X / ⌘V: let it fire copy/cut/paste events (handled in
      // bindClipboard), which read and write the system clipboard without a permission prompt.
      if (command && NATIVE_CLIPBOARD[command] && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === NATIVE_CLIPBOARD[command]) return;
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

  // ---- clipboard (ADR 0023) -------------------------------------------------------------

  private bindClipboard() {
    const skip = (e: ClipboardEvent) => isTextInput(e.target) || this.shortcuts.isOpen || this.instructions.isOpen;
    const copy = (e: ClipboardEvent, cut: boolean) => {
      if (skip(e) || !this.doc.selected().length) return;
      const text = this.copySelection(cut);
      if (!text || !e.clipboardData) return;
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    };
    window.addEventListener('copy', (e) => copy(e, false));
    window.addEventListener('cut', (e) => copy(e, true));
    window.addEventListener('paste', (e) => {
      if (skip(e)) return;
      e.preventDefault();
      this.pasteText(e.clipboardData?.getData('text/plain') ?? null);
    });
  }

  /** Copy (or cut) the selection; returns the clipboard text. Also kept locally as a fallback. */
  private copySelection(cut: boolean): string | null {
    const sel = this.doc.selected();
    if (!sel.length) {
      this.toast('Select parts to copy first');
      return null;
    }
    if (cut && this.refuseWhileExploded()) return null;
    const text = JSON.stringify(copyParts(sel, this.doc.entities, this.doc.groups, this.doc.annotations));
    try {
      localStorage.setItem(CLIP_KEY, text);
    } catch {
      // Too big or storage blocked: the system clipboard still has it.
    }
    const n = `${sel.length} part${sel.length === 1 ? '' : 's'}`;
    if (cut) {
      if (this.uiCall('delete_entities', { target: { ids: sel.map((e) => e.id) } }, 'Cut').ok) this.toast(`Cut ${n} — paste with ${this.keymap.label('edit.paste') || 'Paste'}`);
    } else {
      this.toast(`Copied ${n}`);
    }
    return text;
  }

  /** Menu or rebound key: use the async clipboard API (may ask for permission). */
  private async copyToSystem(cut: boolean) {
    const text = this.copySelection(cut);
    if (text) await navigator.clipboard?.writeText(text).catch(() => {});
  }

  private async pasteFromSystem() {
    let text: string | null = null;
    try {
      text = (await navigator.clipboard?.readText()) ?? null;
    } catch {
      // Permission denied or unsupported: fall back to the last copy in this browser.
    }
    this.pasteText(text);
  }

  /** Paste clipboard text: our parts, or (if the clipboard is empty or unreadable) the last copy. */
  private pasteText(text: string | null) {
    let data = parseClip(text) ? text : null;
    if (!data && !text?.trim()) {
      try {
        data = localStorage.getItem(CLIP_KEY);
      } catch {
        data = null;
      }
    }
    if (!data || !parseClip(data)) {
      this.toast('Nothing to paste — copy parts in Modeler first');
      return;
    }
    this.active.cancel();
    const result = this.uiCall('paste', { data }, 'Paste');
    if (!result.ok) return;
    const d = result.data as { ids: string[]; parts: number; moved: number[] };
    this.doc.setSelection(d.ids);
    const beside = d.moved.some((v) => v !== 0);
    this.toast(`Pasted ${d.parts} part${d.parts === 1 ? '' : 's'}${beside ? ' beside the model' : ''}`);
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
      if (file && /\.(dxf|dwg)$/i.test(file.name)) void this.importDxf(file);
      else if (file) {
        // The handle must be requested synchronously, inside the drop event.
        const item = e.dataTransfer?.items?.[0] as (DataTransferItem & { getAsFileSystemHandle?(): Promise<FileHandle | null> }) | undefined;
        void this.openFile(file, item?.getAsFileSystemHandle?.() ?? Promise.resolve(null));
      }
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

  private showAiStatus(status: BridgeStatus, why?: string) {
    const b = this.els.ai;
    const text = { off: 'Connect AI', waiting: 'Waiting for AI…', connected: 'AI connected' }[status];
    b.querySelector('span')!.textContent = text;
    b.classList.toggle('ai-waiting', status === 'waiting');
    b.classList.toggle('ai-on', status === 'connected');
    if (why) this.toast(why);
    else if (status === 'connected') this.toast('Connected: Claude can now see and edit this model');
    else if (status === 'waiting') this.toast(`Waiting for the modeler MCP server (${this.bridge.url}). Start Claude with it configured.`);
  }

  // ---- actions --------------------------------------------------------------

  private toast(text: string) {
    const el = this.els.toast;
    el.textContent = text;
    el.classList.add('visible');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('visible'), 2400);
  }

  /** A new, empty project of the chosen kind (from the New project dialog). */
  private newModel(workspace: WorkspaceId = this.doc.workspace) {
    this.active.cancel();
    this.setExplode(0);
    const hadParts = this.doc.entities.length > 0;
    if (hadParts) this.doc.load({ format: 'modeler', version: 1, units: this.doc.units, entities: [] }, false, 'New model');
    this.files.reset();
    this.setWorkspace(workspace);
    this.dirty = false;
    this.updateChrome();
    this.viewport.zoomExtents();
    const kind = WORKSPACES[workspace].name;
    this.toast(hadParts ? `New ${kind} project — Undo (⌘/Ctrl+Z) brings the old model back` : `New ${kind} project`);
  }

  private async open() {
    try {
      const opened = await this.files.open();
      if (opened) await this.loadOpened(opened);
    } catch (err) {
      this.toast(`Couldn’t open the file: ${(err as Error).message}`);
    }
  }

  /** A dropped file; with its handle (Chrome/Edge) Save writes back to it. */
  private async openFile(file: File, handle: Promise<FileHandle | null> = Promise.resolve(null)) {
    await this.loadOpened({ name: file.name, text: await file.text(), handle: await handle.catch(() => null) });
  }

  private async loadOpened(opened: OpenedFile) {
    let parsed;
    try {
      parsed = parseDocumentFile(opened.text);
    } catch (err) {
      this.toast(`Couldn’t open ${opened.name}: ${(err as Error).message}`);
      return;
    }
    this.active.cancel();
    this.setExplode(0);
    // Undoable, so opening over unsaved work can be taken back.
    this.doc.load(parsed, false, `Open ${opened.name}`);
    this.applyWorkspace();
    await this.files.adopt(opened);
    this.dirty = false;
    this.viewport.zoomExtents();
    this.updateChrome();
    this.toast(`Opened ${opened.name} (${parsed.entities.length} objects)`);
  }

  /** Recent files (where the browser can reopen them) plus Open…, under the ▾ button. */
  private async showRecent(anchor: HTMLElement) {
    const list = this.files.canSaveInPlace ? await this.files.recent() : [];
    const r = anchor.getBoundingClientRect();
    const items: MenuItem[] = list.map((f) => ({ label: f.name, run: () => void this.openRecent(f.handle) }));
    if (list.length) items.push('separator');
    items.push({ label: 'Open…', shortcut: this.keymap.label('file.open'), run: () => void this.open() });
    if (list.length) items.push({ label: 'Clear recent files', run: () => void this.files.clearRecent() });
    else if (!this.files.canSaveInPlace) items.push({ label: 'Recent files need Chrome or Edge', run: () => {} });
    this.contextMenu.open(r.left, r.bottom + 4, items);
  }

  private async openRecent(handle: FileHandle) {
    try {
      await this.loadOpened(await this.files.read(handle));
    } catch (err) {
      this.toast(`Couldn’t open ${handle.name}: ${(err as Error).message}. It may have been moved or deleted.`);
    }
  }

  /** Exploded view (display only, no undo step); also driven by the API's explode_view. */
  setExplode(factor: number, axis: ExplodeAxis | null = this.viewport.explode.axis) {
    const wasOff = !this.viewport.exploded;
    this.viewport.setExplode(factor, axis);
    const { factor: f, axis: a } = this.viewport.explode;
    if (wasOff && f > 0) this.viewport.zoomExtents(); // the parts spread beyond the old view
    if (f > 0) this.els.explodeSlider.value = String(Math.round(f * 100));
    this.els.explodeAxis.value = a ?? '';
    this.els.explode.classList.toggle('active', f > 0);
    this.els.explodeControls.hidden = f === 0;
    this.els.undo.disabled = f > 0 || !this.doc.canUndo;
    this.els.redo.disabled = f > 0 || !this.doc.canRedo;
    this.sidebar.setLocked(f > 0);
  }

  /** Split the selection horizontally through its middle, with pegs (the API does the work). */
  private splitForPrint() {
    if (!this.doc.selection.size) return;
    this.active.cancel();
    const result = this.uiCall('split_for_print', { target: { selection: true } }, 'Split for print');
    if (!result.ok) return;
    const d = result.data as { pieces: string[]; pegs: number; ids: string[]; notes?: string[]; peg?: { diameter: number; hole_diameter: number } };
    this.doc.setSelection(d.ids);
    this.viewport.zoomExtents(this.doc.selected());
    const pegs = d.pegs ? `${d.pegs} peg${d.pegs === 1 ? '' : 's'} Ø${d.peg!.diameter} (holes Ø${d.peg!.hole_diameter})` : 'no pegs';
    this.toast(`Split into ${d.pieces.join(' and ')}, ${pegs}.${d.notes ? ` ${d.notes.join(' ')}` : ''}`);
  }

  /** Import a DXF as a reference drawing (ADR 0014), then show it. */
  private async importDxf(file?: File | null) {
    file ??= await pickFile('.dxf');
    if (!file) return;
    this.active.cancel();
    this.setExplode(0);
    const result = await this.api.callAsync('import_dxf', { text: await file.text(), name: file.name.replace(/\.(dxf|dwg)$/i, '') }, { source: 'ui' });
    if (!result.ok) {
      this.toast(result.error.hint ? `${result.error.message} — ${result.error.hint}` : result.error.message);
      return;
    }
    const d = result.data as { id: string; name: string; units: string; units_from: string; size_mm: number[]; hint?: string };
    this.viewport.fitBox(this.viewport.referencesBox([d.id]));
    if (this.workspace.panels.includes('objects')) this.sidebar.setTab('objects');
    const size = d.size_mm.map((v) => formatLength(v, this.doc.units)).join(' × ');
    const assumed = d.units_from.startsWith('assumed') ? ` The file has no units; read as ${d.units}.` : '';
    this.toast(d.hint ?? `Imported ${d.name}: ${size}.${assumed} Change units or layers under Objects.`);
  }

  /** Save back to the current file (Chrome/Edge), or ask for one; elsewhere download a copy. */
  private async save(saveAs = false) {
    this.active.cancel();
    try {
      const result = await this.files.save(JSON.stringify(this.doc.toFile(), null, 1), saveAs);
      if (result === 'cancelled') return;
      this.dirty = false;
      this.updateChrome();
      this.toast(result === 'saved' ? `Saved ${this.files.fileName}` : `Downloaded ${this.files.fileName} (this browser can’t save back to a file; Chrome and Edge can)`);
    } catch (err) {
      this.toast(`Couldn’t save: ${(err as Error).message}`);
    }
  }

  private exportStl() {
    const selected = this.doc.selected();
    const targets = selected.length ? selected : this.doc.entities;
    const buffer = exportStl(targets, this.doc.entities, this.doc.groups);
    if (!buffer) {
      this.toast('Nothing to export — add a solid first');
      return;
    }
    downloadBlob(buffer, `${this.files.name}${selected.length ? '-selection' : ''}.stl`, 'model/stl');
    const solids = targets.filter((e) => !e.hole && e.visible).length;
    this.toast(`Exported ${solids} solid${solids === 1 ? '' : 's'} to STL (mm, holes applied)`);
  }

  private exportGlb() {
    const selected = this.doc.selected();
    const targets = selected.length ? selected : this.doc.entities;
    const name = `${this.files.name}${selected.length ? '-selection' : ''}`;
    const result = exportGlb(targets, this.doc.entities, this.doc.groups, { name });
    if (!result) {
      this.toast('Nothing to export — add a solid first');
      return;
    }
    downloadBlob(result.data as BlobPart, `${name}.glb`, 'model/gltf-binary');
    this.toast(`Exported ${result.parts} part${result.parts === 1 ? '' : 's'} to GLB (metres, Y-up, holes applied)`);
  }

  private exportCutList() {
    const csv = cutListToCsv(buildCutList(this.doc.entities), this.doc.units);
    downloadBlob(csv, `${this.files.name}-cutlist.csv`, 'text/csv');
  }

  private deleteSelection() {
    if (this.doc.annotationSelection.size) this.uiCall('delete_annotations', { ids: [...this.doc.annotationSelection] }, 'Delete annotation');
    else if (this.doc.selection.size) this.uiCall('delete_entities', { target: { selection: true } }, 'Delete');
  }

  /** ⌘D: one copy beside the original (whole groups are copied as groups); copies get selected. */
  private duplicateSelection() {
    if (!this.doc.selection.size) return;
    const ids = this.resultIds(this.uiCall('duplicate', { target: { selection: true } }, 'Duplicate'));
    if (ids.length) this.doc.setSelection(ids);
  }

  private placeOnGround(ids: string[]) {
    if (ids.length) this.uiCall('place_on_ground', { target: { ids } }, 'Place on ground');
  }

  private groupSelection() {
    if (!this.doc.selection.size) return;
    const result = this.uiCall('group', { target: { selection: true } }, 'Group');
    if (result.ok) this.toast(`Grouped ${this.doc.selection.size} part${this.doc.selection.size === 1 ? '' : 's'} — double-click to edit inside`);
  }

  private ungroupSelection() {
    const g = groupForSelection(this.doc.selection, this.doc.entities, this.doc.groups);
    if (!g) {
      this.toast('Select a group to ungroup');
      return;
    }
    if (this.doc.openGroupId === g.id) this.doc.setOpenGroup(g.parentId ?? null);
    this.uiCall('ungroup', { group: g.id }, 'Ungroup');
  }

  /** Leave the open group (back to its parent group, or the top level). */
  private closeGroup() {
    const open = this.doc.openGroupId ? this.doc.getGroup(this.doc.openGroupId) : null;
    if (!open) return;
    this.doc.setOpenGroup(open.parentId ?? null);
    this.doc.setSelection(groupMembers(open.id, this.doc.entities, this.doc.groups).map((e) => e.id));
  }

  // ---- context menu (ADR 0012) ------------------------------------------------

  private openContextMenu(e: PointerEvent) {
    if (this.active.busy) return; // don't interrupt a drawing/move in progress
    const hit = this.viewport.pick(this.toolEvent(e).px);
    if (hit) {
      const open = this.doc.openGroupId;
      if (open && !isInsideGroup(hit.entity, open, this.doc.groups)) this.doc.setOpenGroup(null);
      const unit = selectionUnit(hit.entity, this.doc.entities, this.doc.groups, this.doc.openGroupId);
      if (!unit.every((id) => this.doc.selection.has(id))) this.doc.setSelection(unit);
    }
    this.contextMenu.open(e.clientX, e.clientY, this.menuItems(!!hit && this.doc.selection.size > 0));
  }

  private menuItems(onSelection: boolean): MenuItem[] {
    const item = (command: string, label: string, danger = false): MenuItem => ({
      label,
      shortcut: this.keymap.label(command),
      danger,
      run: () => this.runCommand(command),
    });
    if (onSelection) {
      const group = groupForSelection(this.doc.selection, this.doc.entities, this.doc.groups);
      const sel = this.doc.selected();
      const allHoles = sel.every((x) => x.hole);
      return [
        item('edit.copy', 'Copy'),
        item('edit.cut', 'Cut'),
        item('edit.duplicate', 'Duplicate'),
        ...(canLink(sel) ? [item('edit.makeComponent', 'Make component (link copies)')] : []),
        ...(sel.some((x) => x.component) ? [item('edit.makeUnique', 'Make unique')] : []),
        item('edit.group', group ? 'Group (nest in a new group)' : 'Group'),
        ...(group ? [item('edit.ungroup', 'Ungroup'), item('edit.openGroup', 'Open group')] : []),
        'separator',
        item('edit.toggleHole', allHoles ? 'Make solid' : 'Make hole'),
        this.workspace.printPlate ? item('print.placeOnPlate', 'Place on plate') : item('edit.placeOnGround', 'Place on ground'),
        ...(this.workspace.printPlate && !allHoles ? [item('print.split', 'Split for printing (through the middle)')] : []),
        'separator',
        item('view.zoomSelection', 'Zoom to selection'),
        item('edit.hide', 'Hide'),
        'separator',
        item('edit.delete', 'Delete', true),
      ];
    }
    const items: MenuItem[] = [item('edit.paste', 'Paste'), 'separator', item('edit.selectAll', 'Select all'), item('view.extents', 'Zoom extents')];
    if (this.doc.entities.some((x) => !x.visible)) items.push(item('edit.showHidden', 'Show all hidden'));
    if (this.doc.openGroupId) items.push(item('edit.closeGroup', 'Close group'));
    items.push('separator', item('view.iso', 'Iso view'), item('view.top', 'Top view'), item('view.front', 'Front view'));
    return items;
  }

  /** "Editing: Bookcase ✕" badge while a group is open. */
  private updateGroupBadge() {
    const open = this.doc.openGroupId ? this.doc.getGroup(this.doc.openGroupId) : null;
    const badge = this.els.groupBadge;
    badge.hidden = !open;
    if (!open) return;
    const path = groupChain(open.id, this.doc.groups).reverse().map((g) => g.name).join(' › ');
    badge.replaceChildren(
      h('span', { class: 'muted' }, 'Editing group'),
      h('strong', {}, path),
      h('button', { class: 'icon-btn', title: 'Close group (Esc)', 'aria-label': 'Close group', onclick: () => this.closeGroup() }, '×'),
    );
  }
}
