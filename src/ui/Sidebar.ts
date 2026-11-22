import * as THREE from 'three';
import { buildWorldGeometries, fuseGeometries } from '../model/csg';
import { buildCutList } from '../model/cutlist';
import type { ModelDocument } from '../model/Document';
import { localBounds, worldBounds, worldBoundsOf } from '../model/geometry';
import { footprintMm2 } from '../model/quantities';
import { tubeLength } from '../model/shapes';
import { groupChain, groupForSelection, groupMembers } from '../model/groups';
import { anchoredIds, dimensionGeometry } from '../model/annotations';
import { DRAWING_UNITS, referenceBounds } from '../model/references';
import type { Annotation, Entity, Group, Vec3 } from '../model/types';
import { formatLength, parseAngle, parseLength, trimNumber } from '../model/units';
import {
  FILAMENTS,
  meshVolume,
  PRINTERS,
  printerVolume,
  type FitIssue,
  type PanelId,
  type PrinterSetting,
  type WorkspaceConfig,
} from '../model/workspaces';
import { canLink } from '../model/parts';
import { h, isTextInput } from './dom';
import { icon } from './icons';

export interface SidebarActions {
  placeOnGround(ids: string[]): void;
  duplicateSelection(): void;
  deleteSelection(): void;
  zoomTo(ids: string[]): void;
  zoomToReference(id: string): void;
  exportCutList(): void;
  setDefaultColor(color: string): void;
  /** Current shortcut for a command, for display ('' if unbound). */
  keyLabel(command: string): string;
  holdLabel(action: 'pan' | 'orbit'): string;
  workspace(): WorkspaceConfig;
  printIssues(): FitIssue[];
  setPrinter(setting: PrinterSetting): void;
  filament(): string;
  setFilament(id: string): void;
  placeOnPlate(ids: string[]): void;
  exportStl(): void;
  /** Run a Modeler API operation; false (and a toast) if it was rejected. */
  call(name: string, input: unknown, label?: string): boolean;
  runCommand(id: string): void;
}

type Tab = PanelId;

const TAB_LABEL: Record<PanelId, string> = {
  properties: 'Properties',
  objects: 'Objects',
  cutlist: 'Cut list',
  print: 'Print',
  quantities: 'Quantities',
};

const KIND_ICON: Record<Entity['kind'], string> = { box: 'box', cylinder: 'cylinder', extrusion: 'shape', sphere: 'sphere', revolve: 'revolve', tube: 'tube' };
const KIND_NAME: Record<Entity['kind'], string> = { box: 'Box', cylinder: 'Cylinder', extrusion: 'Extruded shape', sphere: 'Sphere', revolve: 'Revolved shape', tube: 'Tube' };

export class Sidebar {
  readonly el: HTMLElement;
  private tab: Tab = 'properties';
  private preferredTab: Tab = 'properties';
  private body: HTMLElement;
  private tabsEl: HTMLElement;
  private tabButtons = new Map<Tab, HTMLButtonElement>();
  private dirty = false;
  /** Mesh volumes (mm³, holes applied) per entity, computed when the model is idle. */
  private volumeCache: { version: number; byId: Map<string, number>; total: number } | null = null;
  private volumeTimer = 0;
  /** Look-only (the exploded view): fields read-only, actions hidden behind a note. */
  private locked = false;

  setLocked(locked: boolean) {
    if (locked === this.locked) return;
    this.locked = locked;
    this.el.classList.toggle('locked', locked);
    this.render(true);
  }

  /** Reference drawings whose layer list is open (UI only). */
  private readonly expandedRefs = new Set<string>();
  /** Groups collapsed in the Objects tree (UI only). */
  private readonly collapsed = new Set<string>();

  constructor(
    private readonly doc: ModelDocument,
    private readonly actions: SidebarActions,
  ) {
    try {
      const saved = localStorage.getItem('modeler.sidebarTab') as Tab | null;
      if (saved && saved in TAB_LABEL) this.preferredTab = saved;
    } catch {
      // ignore
    }
    this.tabsEl = h('div', { class: 'tabs', role: 'tablist' });
    this.body = h('div', { class: 'sidebar-body' });
    this.el = h('div', { class: 'sidebar-inner' }, this.tabsEl, this.body);

    this.el.addEventListener('focusout', () => {
      // Re-render once the user leaves a field, if the model changed meanwhile.
      setTimeout(() => {
        if (this.dirty && !this.isEditing()) this.render();
      });
    });
    doc.onChange(() => this.render());
    doc.onSelectionChange(() => {
      this.render(true);
    });
    this.setPanels(actions.workspace().panels);
  }

  /** Show the tabs a workspace uses; keeps the user's last tab if it's still there. */
  setPanels(panels: PanelId[]) {
    this.tabsEl.replaceChildren();
    this.tabButtons.clear();
    for (const id of panels) {
      const btn = h('button', { class: 'tab', role: 'tab', onclick: () => this.setTab(id) }, TAB_LABEL[id]);
      this.tabButtons.set(id, btn);
      this.tabsEl.append(btn);
    }
    this.tab = panels.includes(this.preferredTab) ? this.preferredTab : panels[0];
    this.render(true);
  }

  setTab(tab: Tab) {
    this.tab = tab;
    this.preferredTab = tab;
    try {
      localStorage.setItem('modeler.sidebarTab', tab);
    } catch {
      // ignore
    }
    this.render(true);
  }

  private isEditing(): boolean {
    const active = document.activeElement;
    return !!active && this.el.contains(active) && isTextInput(active);
  }

  render(force = false) {
    if (!force && this.isEditing()) {
      this.dirty = true;
      return;
    }
    this.dirty = false;
    for (const [id, btn] of this.tabButtons) {
      btn.classList.toggle('active', id === this.tab);
      btn.setAttribute('aria-selected', String(id === this.tab));
    }
    const scroll = this.body.scrollTop;
    this.body.replaceChildren();
    if (this.locked) {
      this.body.append(h('p', { class: 'lock-note' }, 'Exploded view: look only. Assemble it (× at the top of the view) to edit.'));
    }
    if (this.tab === 'properties') this.renderProperties();
    else if (this.tab === 'objects') this.renderObjects();
    else if (this.tab === 'print') this.renderPrint();
    else if (this.tab === 'quantities') this.renderQuantities();
    else this.renderCutList();
    this.body.scrollTop = scroll;
  }

  private get units() {
    return this.doc.units;
  }

  // ---- properties ---------------------------------------------------------

  private renderProperties() {
    if (this.doc.annotationSelection.size) return this.renderAnnotations([...this.doc.annotationSelection].map((id) => this.doc.getAnnotation(id)!).filter(Boolean));
    const sel = this.doc.selected();
    if (!sel.length) return this.renderEmpty();
    const g = groupForSelection(this.doc.selection, this.doc.entities, this.doc.groups);
    if (g && !(sel.length === 1 && this.doc.openGroupId === g.id)) return this.renderGroup(g, sel);
    if (sel.length === 1) return this.renderSingle(sel[0]);
    return this.renderMulti(sel);
  }

  /** Properties of selected notes / dimensions (ADR 0015). */
  private renderAnnotations(list: Annotation[]) {
    const doc = this.doc;
    const del = h('button', { class: 'btn danger', title: 'Delete (Del)', onclick: () => this.actions.deleteSelection(), html: `${icon('trash', 16)}<span>Delete</span>` });
    if (list.length !== 1) {
      this.body.append(this.section(`${list.length} annotations`, h('div', { class: 'prop-actions' }, del)));
      return;
    }
    const a = list[0];
    const parts = anchoredIds(a).map((id) => doc.get(id)?.name).filter(Boolean);
    const attached = this.row('Attached to', h('span', { class: parts.length ? '' : 'muted' }, parts.length ? [...new Set(parts)].join(', ') : 'fixed point'));
    const textArea = (value: string, placeholder: string, commit: (text: string) => void) => {
      const el = h('textarea', { class: 'field note-field', rows: 3, placeholder, spellcheck: 'false' });
      el.value = value;
      el.addEventListener('keydown', (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          el.blur();
        } else if (e.key === 'Escape') {
          el.value = value;
          el.blur();
        }
      });
      el.addEventListener('change', () => commit(el.value));
      return el;
    };
    if (a.kind === 'note') {
      this.body.append(
        this.section('Text',
          textArea(a.text, 'Text', (t) => {
            if (t.trim()) this.call('update_annotation', { id: a.id, text: t }, 'Edit text');
          }),
          attached,
          h('p', { class: 'muted small' }, 'Drag the text in the view to move it; double-click to edit it there.'),
          h('div', { class: 'prop-actions' }, del),
        ),
      );
      return;
    }
    const g = dimensionGeometry(a, (id) => doc.get(id));
    const offset = Math.hypot(...a.offset);
    this.body.append(
      this.section('Dimension',
        this.row('Measures', h('span', {}, g ? `${formatLength(g.value, this.units)}${a.axis ? ` along ${a.axis.toUpperCase()}` : ''}` : '—')),
        this.row('Text', this.input(a.text ?? '', (t) => this.call('update_annotation', { id: a.id, text: t }, 'Dimension text'), { title: 'Replaces the value; <> inserts it. Empty = the measured value.' })),
        this.row('Offset', this.input(formatLength(offset, this.units, false), (t) => {
          const v = parseLength(t, this.units);
          return v !== null && v >= 0 && this.call('update_annotation', { id: a.id, offset: v }, 'Dimension offset');
        }, { suffix: this.units })),
        attached,
        h('p', { class: 'muted small' }, 'Updates when the parts it is attached to move or change size. Drag it in the view to move the line.'),
        h('div', { class: 'prop-actions' }, del),
      ),
    );
  }

  private renderEmpty() {
    const count = this.doc.entities.length;
    this.body.append(
      h('div', { class: 'empty' },
        h('p', { class: 'muted' }, count ? `Nothing selected · ${count} object${count === 1 ? '' : 's'} in the model` : 'The model is empty.'),
        h('h4', {}, 'Quick start'),
        h('ol', { class: 'tips' },
          h('li', {}, this.key('tool.box', 'Box'), ' — click two corners on the grid, then move up and click for the height.'),
          h('li', {}, 'While drawing, just type sizes — e.g. ', h('code', {}, '600,400'), ' Enter, then ', h('code', {}, '18'), ' Enter.'),
          h('li', {}, this.key('tool.pushpull', 'Push/Pull'), ' a face to resize. Push a circle into a face to drill a hole.'),
          h('li', {}, this.key('tool.move', 'Move'), ' — snap a corner onto another corner. Tap ', h('kbd', {}, 'Alt'), ' to copy, then type ', h('code', {}, '4x'), ' for an array.'),
          this.navTip(),
        ),
        h('p', { class: 'muted small' }, 'All shortcuts (and changing them): ', this.key('help.shortcuts', 'keyboard button, top right')),
      ),
    );
  }

  /** <kbd> with the command's current key, or the plain name if it has none. */
  private key(command: string, name: string): Node {
    const k = this.actions.keyLabel(command);
    return k ? h('span', {}, h('kbd', {}, k), ` ${name}`) : document.createTextNode(name);
  }

  private navTip(): HTMLElement {
    const pan = this.actions.holdLabel('pan');
    const orbit = this.actions.holdLabel('orbit');
    const parts: (Node | string)[] = ['Scroll zooms; middle-drag orbits, right-drag pans.'];
    if (orbit !== 'Off') parts.push(' Hold ', h('kbd', {}, orbit), ' + drag to orbit');
    if (pan !== 'Off') parts.push(orbit !== 'Off' ? ', ' : ' Hold ', h('kbd', {}, pan), ' + drag to pan');
    if (orbit !== 'Off' || pan !== 'Off') parts.push(' — with any tool.');
    return h('li', {}, ...parts);
  }

  private section(title: string, ...children: (Node | null)[]): HTMLElement {
    return h('section', { class: 'prop-section' }, h('h4', {}, title), ...children);
  }

  private row(label: string, control: Node, title?: string): HTMLElement {
    return h('div', { class: 'prop-row', title }, h('span', { class: 'prop-label' }, label), control);
  }

  /** Text input that commits a parsed value on Enter/blur and reverts on Escape/invalid. */
  private input(value: string, commit: (text: string) => boolean, opts: { suffix?: string; cls?: string; title?: string } = {}): HTMLElement {
    const input = h('input', { type: 'text', class: `field ${opts.cls ?? ''}`, value, spellcheck: 'false', title: opts.title });
    const revert = () => {
      input.value = value;
    };
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') {
        revert();
        input.blur();
      }
    });
    input.addEventListener('focus', () => input.select());
    input.addEventListener('change', () => {
      if (input.value === value) return;
      if (!commit(input.value)) {
        input.classList.add('invalid');
        setTimeout(() => input.classList.remove('invalid'), 900);
        revert();
      }
    });
    return opts.suffix ? h('span', { class: 'field-wrap' }, input, h('span', { class: 'suffix' }, opts.suffix)) : input;
  }

  private lengthInput(mm: number, apply: (v: number) => boolean, min?: number): HTMLElement {
    return this.input(
      formatLength(mm, this.units, false),
      (text) => {
        const v = parseLength(text, this.units);
        if (v === null || (min !== undefined && v < min)) return false;
        return apply(v);
      },
      { suffix: this.units, title: 'Type a value; units like mm, cm, in or 1/2" are fine' },
    );
  }

  private vecInputs(values: Vec3, apply: (axis: number, v: number) => boolean, kind: 'length' | 'angle', min?: number): HTMLElement {
    const wrap = h('div', { class: 'vec3' });
    ['X', 'Y', 'Z'].forEach((axis, i) => {
      const field =
        kind === 'length'
          ? this.lengthInput(values[i], (v) => apply(i, v), min)
          : this.input(trimNumber(values[i], 3), (t) => {
              const v = parseAngle(t);
              if (v === null) return false;
              return apply(i, v);
            }, { suffix: '°' });
      wrap.append(h('span', { class: `axis-field axis-${axis.toLowerCase()}` }, h('span', { class: 'axis-tag' }, axis), field));
    });
    return wrap;
  }

  /** Every edit goes through the Modeler API (ADR 0008). */
  private call(name: string, input: unknown, label?: string): boolean {
    return this.actions.call(name, input, label);
  }

  private typeToggle(entities: Entity[]): HTMLElement {
    const ids = entities.map((e) => e.id);
    const allHole = entities.every((e) => e.hole);
    const allSolid = entities.every((e) => !e.hole);
    const btn = (label: string, active: boolean, hole: boolean, title: string) =>
      h('button', { class: `seg ${active ? 'active' : ''}`, title, onclick: () => this.call('set_hole', { target: { ids }, hole }, hole ? 'Make hole' : 'Make solid') }, label);
    const toggle = h('div', { class: 'segmented' },
      btn('Solid', allSolid, false, 'A normal solid part'),
      btn('Hole', allHole, true, 'Subtracted from every solid it overlaps (shown red, cut on export)'),
    );
    // Holes in a group can be limited to cutting that group only.
    if (!allHole || !entities.every((e) => e.groupId)) return toggle;
    const scoped = entities.every((e) => e.holeScope === 'group');
    const box = h('input', { type: 'checkbox', checked: scoped });
    box.addEventListener('change', () => this.call('set_hole', { target: { ids }, hole: true, only_own_group: box.checked }, box.checked ? 'Hole cuts its group only' : 'Hole cuts everything'));
    return h('div', {}, toggle, h('label', { class: 'check-row', title: 'On: this hole cuts only parts in its own group, not neighbouring parts it overlaps' }, box, h('span', {}, 'Cuts only its own group')));
  }

  private colorPicker(entities: Entity[]): HTMLElement {
    const ids = entities.map((e) => e.id);
    const current = entities[0].color;
    const set = (color: string) => {
      if (this.call('set_color', { target: { ids }, color }, 'Colour')) this.actions.setDefaultColor(color);
    };
    const swatches = h('div', { class: 'swatches' });
    for (const s of this.actions.workspace().swatches) {
      swatches.append(
        h('button', {
          class: `swatch ${s.color === current ? 'active' : ''}`,
          style: `background:${s.color}`,
          title: s.name,
          'aria-label': s.name,
          onclick: () => set(s.color),
        }),
      );
    }
    const custom = h('input', { type: 'color', class: 'color-input', value: current, title: 'Custom colour' });
    custom.addEventListener('change', () => set(custom.value));
    swatches.append(custom);
    return swatches;
  }

  private boundsText(entities: Entity[]): string {
    const size = worldBoundsOf(entities).getSize(new THREE.Vector3());
    return `${[size.x, size.y, size.z].map((v) => formatLength(v, this.units, false)).join(' × ')} ${this.units}`;
  }

  private actionsRow(ids: string[], extra: HTMLElement[] = []): HTMLElement {
    return h('div', { class: 'prop-actions' },
      ...extra,
      h('button', { class: 'btn', title: 'Drop so the lowest point sits on the ground (z = 0)', onclick: () => this.actions.placeOnGround(ids), html: `${icon('ground', 16)}<span>On ground</span>` }),
      h('button', { class: 'btn', title: 'Duplicate (⌘/Ctrl+D)', onclick: () => this.actions.duplicateSelection(), html: `${icon('duplicate', 16)}<span>Duplicate</span>` }),
      h('button', { class: 'btn danger', title: 'Delete (Del)', onclick: () => this.actions.deleteSelection(), html: `${icon('trash', 16)}<span>Delete</span>` }),
    );
  }

  private renderSingle(e: Entity) {
    const id = e.id;
    const set = (patch: Record<string, unknown>, label = 'Edit') => this.call('update_entity', { id, set: patch }, label);

    const name = this.input(e.name, (t) => {
      const v = t.trim();
      return !!v && set({ name: v }, 'Rename');
    }, { cls: 'name-field' });

    const group = e.groupId ? this.doc.getGroup(e.groupId) : undefined;
    const header = h('div', { class: 'prop-header' },
      h('span', { class: 'kind-icon', html: icon(KIND_ICON[e.kind], 18) }),
      h('div', { class: 'prop-title' }, name, h('span', { class: 'muted small' }, KIND_NAME[e.kind], group ? ` · in “${group.name}”` : '')),
    );

    const size: HTMLElement[] = [];
    if (e.kind === 'box') {
      size.push(this.row('Size', this.vecInputs(e.size, (i, v) => {
        const next = [...e.size];
        next[i] = v;
        return set({ size: next }, 'Resize');
      }, 'length', 0.01)));
      size.push(this.row('Round edges', this.lengthInput(e.edgeRadius ?? 0, (v) => set({ edge_radius: v }, 'Round edges'), 0), 'Radius that rounds every edge and corner; 0 = sharp'));
    } else if (e.kind === 'cylinder') {
      size.push(
        this.row(e.radiusTop === undefined ? 'Diameter' : 'Base ⌀', this.lengthInput(e.radius * 2, (v) => set({ diameter: v }, 'Resize'), 0.01)),
        this.row('Top ⌀', this.lengthInput((e.radiusTop ?? e.radius) * 2, (v) => set({ diameter_top: v }, 'Taper'), 0), 'A different top makes a cone: 0 = pointed. Equal to the base = a cylinder.'),
        this.row('Height', this.lengthInput(e.height, (v) => set({ height: v }, 'Resize'), 0.01)),
        this.row('Segments', this.input(String(e.segments), (t) => {
          const v = parseInt(t, 10);
          return v >= 3 && v <= 256 && set({ segments: v });
        }), 'Smoothness of the round surface (3–256). 64 is plenty for printing.'),
      );
    } else if (e.kind === 'sphere') {
      const round = e.radii[0] === e.radii[1] && e.radii[1] === e.radii[2];
      size.push(
        round
          ? this.row('Diameter', this.lengthInput(e.radii[0] * 2, (v) => set({ diameter: v }, 'Resize'), 0.01))
          : this.row('Diameters', this.vecInputs(e.radii.map((r) => r * 2) as Vec3, (i, v) => set({ radii: e.radii.map((r, k) => (k === i ? v / 2 : r)) }, 'Resize'), 'length', 0.01)),
      );
      if (round) size.push(this.row('Stretch', h('button', { class: 'btn small', onclick: () => set({ radii: [e.radii[0], e.radii[1], e.radii[2] * 1.5] }, 'Make ellipsoid') }, 'Make ellipsoid'), 'Give it different X/Y/Z diameters'));
    } else if (e.kind === 'revolve') {
      const b = localBounds(e).getSize(new THREE.Vector3());
      size.push(
        this.row('Diameter', h('span', { class: 'muted' }, formatLength(b.x, this.units))),
        this.row('Height', h('span', { class: 'muted' }, formatLength(b.z, this.units))),
        this.row('Profile', h('span', { class: 'muted' }, `${e.profile.length} points (edit through the API / AI)`)),
      );
    } else if (e.kind === 'tube') {
      size.push(
        e.radii
          ? this.row('Diameter', h('span', { class: 'muted' }, `${formatLength(Math.min(...e.radii) * 2, this.units)} – ${formatLength(Math.max(...e.radii) * 2, this.units)} (tapered)`))
          : this.row('Diameter', this.lengthInput(e.radius * 2, (v) => set({ diameter: v }, 'Resize'), 0.01)),
        this.row('Length', h('span', { class: 'muted' }, formatLength(tubeLength(e), this.units))),
        this.row('Path', h('span', { class: 'muted' }, `${e.path.length} points, ${e.smooth ? 'smooth' : 'straight segments'}`)),
      );
    } else {
      size.push(
        this.row('Thickness', this.lengthInput(e.height, (v) => set({ height: v }, 'Resize'), 0.01)),
        this.row('Outline', h('span', { class: 'muted' }, `${e.points.length} points`)),
      );
    }

    const sections: HTMLElement[] = [header, this.section('Type', this.typeToggle([e]))];
    if (!e.hole) sections.push(this.section('Colour', this.colorPicker([e])));
    const vec3 = (values: number[], i: number, v: number) => {
      const next = [...values];
      next[i] = v;
      return next;
    };
    this.body.append(
      ...sections,
      this.section('Dimensions', ...size, this.row('Bounds', h('span', { class: 'muted' }, this.boundsText([e])))),
      this.section('Position',
        this.row(e.kind === 'box' ? 'Corner' : e.kind === 'sphere' ? 'Centre' : e.kind === 'tube' ? 'Start' : 'Base', this.vecInputs(e.position, (i, v) => set({ position: vec3(e.position, i, v) }, 'Move'), 'length')),
        this.row('Rotation', this.vecInputs(e.rotation, (i, v) => set({ rotation: vec3(e.rotation, i, v) }, 'Rotate'), 'angle')),
      ),
      this.partSection([e]),
      this.actionsRow([id], [this.commandButton('edit.group', 'group', 'Group')]),
    );
  }

  /**
   * What the parts are made of (ADR 0025): material, finish, edge banding, part number,
   * note, and whether they are linked copies. Several parts: a field shows a value only
   * when they all share it; typing sets it on all.
   */
  private partSection(entities: Entity[]): Node {
    // 3D prints are one material (the filament, chosen in the Print tab).
    if (this.actions.workspace().printPlate) return document.createDocumentFragment();
    const target = { ids: entities.map((e) => e.id) };
    const shared = <T>(get: (e: Entity) => T): T | undefined => {
      const v = get(entities[0]);
      return entities.every((e) => JSON.stringify(get(e)) === JSON.stringify(v)) ? v : undefined;
    };
    const set = (patch: Record<string, unknown>, label: string) => this.call('set_properties', { target, ...patch }, label);
    const text = (field: 'material' | 'finish' | 'partNo' | 'note', key: string, label: string, placeholder: string, list?: string) => {
      const value = (shared((e) => e[field]) as string | undefined) ?? '';
      const el = this.input(value, (t) => set({ [key]: t.trim() || null }, label), { title: placeholder, cls: 'text-field' });
      const input = (el instanceof HTMLInputElement ? el : el.querySelector('input'))!;
      input.placeholder = entities.length > 1 && shared((e) => e[field]) === undefined ? 'mixed' : placeholder;
      if (list) input.setAttribute('list', list);
      return el;
    };
    // Materials already used in the model, offered while typing.
    const materials = [...new Set(this.doc.entities.map((e) => e.material).filter(Boolean))] as string[];
    const datalist = h('datalist', { id: 'materials-list' }, ...materials.map((m) => h('option', { value: m })));
    const rows: (HTMLElement | null)[] = [
      this.row('Material', text('material', 'material', 'Material', 'e.g. Oak veneered MDF', 'materials-list')),
      this.row('Finish', text('finish', 'finish', 'Finish', 'e.g. Oiled, black powder coat')),
    ];
    if (entities.every((e) => e.kind === 'box' && !e.hole)) {
      const b = shared((e) => e.banding ?? null);
      const count = (which: 'long' | 'short') => {
        const sel = h('select', { class: 'select tiny', 'aria-label': `${which} edges banded` },
          ...[0, 1, 2].map((n) => h('option', { value: String(n), selected: (b?.[which] ?? 0) === n }, String(n))));
        sel.addEventListener('change', () => {
          const next = { long: b?.long ?? 0, short: b?.short ?? 0, ...(b?.thickness ? { thickness: b.thickness } : {}), [which]: Number(sel.value) };
          set({ banding: next.long || next.short ? next : null }, 'Edge banding');
        });
        return sel;
      };
      rows.push(this.row('Edge banding', h('span', { class: 'banding' }, count('long'), h('span', { class: 'muted small' }, 'long'), count('short'), h('span', { class: 'muted small' }, 'short')), 'How many long and short edges get edge banding'));
    }
    rows.push(
      this.row('Part no.', text('partNo', 'part_no', 'Part number', 'optional')),
      this.row('Note', text('note', 'note', 'Note', 'for the maker, e.g. grain lengthwise')),
    );
    const component = shared((e) => e.component);
    const copies = component ? this.doc.entities.filter((e) => e.component === component).length : 0;
    const link = component
      ? h('div', { class: 'prop-row' }, h('span', { class: 'prop-label' }, 'Linked'), h('span', {}, `${copies} copies — editing one edits all `, h('button', { class: 'btn small', onclick: () => this.actions.runCommand('edit.makeUnique') }, 'Make unique')))
      : canLink(entities)
        ? h('div', { class: 'prop-row' }, h('span', { class: 'prop-label' }, 'Linked'), h('button', { class: 'btn small', title: 'Link these identical parts: editing one edits all', onclick: () => this.actions.runCommand('edit.makeComponent') }, 'Make component'))
        : null;
    return this.section('Part', datalist, ...rows, link);
  }

  private commandButton(command: string, iconName: string, label: string, danger = false): HTMLElement {
    const key = this.actions.keyLabel(command);
    return h('button', {
      class: `btn ${danger ? 'danger' : ''}`,
      title: key ? `${label} (${key})` : label,
      onclick: () => this.actions.runCommand(command),
      html: `${icon(iconName, 16)}<span>${label}</span>`,
    });
  }

  /** A whole group is selected: rename it, recolour/retype all members, move it, or open/ungroup it. */
  private renderGroup(g: Group, members: Entity[]) {
    const name = this.input(g.name, (t) => !!t.trim() && this.call('rename_group', { group: g.id, name: t.trim() }, 'Rename group'), { cls: 'name-field' });
    const parent = g.parentId ? this.doc.getGroup(g.parentId) : undefined;
    const box = worldBoundsOf(members);
    const min = [box.min.x, box.min.y, box.min.z];
    const sections: HTMLElement[] = [
      h('div', { class: 'prop-header' },
        h('span', { class: 'kind-icon', html: icon('group', 18) }),
        h('div', { class: 'prop-title' }, name, h('span', { class: 'muted small' }, `Group · ${members.length} part${members.length === 1 ? '' : 's'}`, parent ? ` · in “${parent.name}”` : '')),
      ),
      this.section('Type', this.typeToggle(members)),
    ];
    if (!members.every((m) => m.hole)) sections.push(this.section('Colour', this.colorPicker(members)));
    this.body.append(
      ...sections,
      this.section('Dimensions', this.row('Bounds', h('span', { class: 'muted' }, this.boundsText(members)))),
      this.section('Position',
        this.row('Corner', this.vecInputs(min as Vec3, (i, v) => {
          const to = [...min];
          to[i] = v;
          return this.call('move', { target: { group: g.id }, to, anchor: 'min' }, 'Move group');
        }, 'length'), 'Lowest corner of the group’s bounds'),
      ),
      this.partSection(members.filter((m) => !m.hole).length ? members.filter((m) => !m.hole) : members),
      this.actionsRow(members.map((m) => m.id), [
        this.commandButton('edit.openGroup', 'openGroup', 'Open'),
        this.commandButton('edit.ungroup', 'ungroup', 'Ungroup'),
      ]),
    );
  }

  private renderMulti(entities: Entity[]) {
    const ids = entities.map((e) => e.id);
    this.body.append(
      h('div', { class: 'prop-header' }, h('div', { class: 'prop-title' }, h('strong', {}, `${entities.length} objects selected`))),
      this.section('Type', this.typeToggle(entities)),
      this.section('Colour', this.colorPicker(entities)),
      this.section('Bounds', h('div', { class: 'muted' }, this.boundsText(entities))),
      this.partSection(entities),
      this.actionsRow(ids, [this.commandButton('edit.group', 'group', 'Group')]),
    );
  }

  // ---- objects --------------------------------------------------------------

  /** Objects tab: reference drawings, annotations, then a tree of groups and parts in model order. */
  private renderObjects() {
    if (this.doc.references.length) this.renderReferences();
    if (this.doc.annotations.length) this.renderAnnotationList();
    if (!this.doc.entities.length) {
      this.body.append(h('p', { class: 'muted empty' }, 'No objects yet.'));
      if (!this.doc.references.length) {
        this.body.append(h('p', { class: 'muted small' }, 'Have a floor plan? Import it as a DXF drawing (top bar, or drop the file here) and draw on top of it.'));
      }
      return;
    }
    const list = h('ul', { class: 'outliner' });
    const doc = this.doc;
    const childGroups = (parent: string | undefined) => doc.groups.filter((g) => g.parentId === parent);
    const renderGroup = (g: Group, depth: number) => {
      const members = groupMembers(g.id, doc.entities, doc.groups);
      const selected = members.length > 0 && members.every((m) => doc.selection.has(m.id));
      const collapsed = this.collapsed.has(g.id);
      const anyVisible = members.some((m) => m.visible);
      list.append(
        h('li', {
          class: `outliner-item group ${selected ? 'selected' : ''} ${doc.openGroupId === g.id ? 'open' : ''}`,
          style: `padding-left:${6 + depth * 14}px`,
          title: 'Click to select the group, double-click to open it',
          onclick: (ev: MouseEvent) => {
            const ids = members.map((m) => m.id);
            if (ev.shiftKey || ev.metaKey || ev.ctrlKey) doc.toggleSelectionMany(ids);
            else doc.setSelection(ids);
          },
          ondblclick: () => {
            doc.setOpenGroup(g.id);
            doc.clearSelection();
          },
        },
          h('button', {
            class: 'icon-btn caret',
            'aria-label': collapsed ? 'Expand' : 'Collapse',
            onclick: (ev: MouseEvent) => {
              ev.stopPropagation();
              if (collapsed) this.collapsed.delete(g.id);
              else this.collapsed.add(g.id);
              this.render(true);
            },
          }, collapsed ? '▸' : '▾'),
          h('span', { class: 'chip group-chip', html: icon('group', 14) }),
          h('span', { class: 'outliner-name' }, g.name),
          h('span', { class: 'muted small' }, `${members.length}`),
          this.eye(anyVisible, () => this.call('set_visible', { target: { group: g.id }, visible: !anyVisible }, anyVisible ? 'Hide' : 'Show')),
        ),
      );
      if (collapsed) return;
      for (const sub of childGroups(g.id)) renderGroup(sub, depth + 1);
      for (const e of doc.entities.filter((x) => x.groupId === g.id)) renderEntity(e, depth + 1);
    };
    const renderEntity = (e: Entity, depth: number) => {
      list.append(
        h('li', {
          class: `outliner-item ${doc.selection.has(e.id) ? 'selected' : ''} ${e.visible ? '' : 'hidden'}`,
          style: `padding-left:${6 + depth * 14 + (depth ? 20 : 0)}px`,
          title: 'Click to select, ⌘/Ctrl-click to add, double-click to zoom',
          onclick: (ev: MouseEvent) => {
            if (ev.shiftKey || ev.metaKey || ev.ctrlKey) doc.toggleSelection(e.id);
            else doc.setSelection([e.id]);
          },
          ondblclick: () => this.actions.zoomTo([e.id]),
        },
          h('span', { class: 'chip', style: `background:${e.hole ? 'transparent' : e.color}`, html: e.hole ? icon('hole', 14) : '' }),
          h('span', { class: 'outliner-name' }, e.name),
          h('span', { class: 'muted small' }, this.sizeSummary(e)),
          this.eye(e.visible, () => this.call('set_visible', { target: { ids: [e.id] }, visible: !e.visible }, e.visible ? 'Hide' : 'Show')),
        ),
      );
    };
    // Top-level groups appear where their first part is in model order.
    const shown = new Set<string>();
    for (const e of doc.entities) {
      if (!e.groupId) {
        renderEntity(e, 0);
        continue;
      }
      // An operation can be mid-way (group op: parts point at the new group before it is
      // added), and the outliner re-renders on every change; treat an unknown group as none.
      const top = groupChain(e.groupId, doc.groups).at(-1);
      if (!top) {
        renderEntity(e, 0);
        continue;
      }
      if (!shown.has(top.id)) {
        shown.add(top.id);
        renderGroup(top, 0);
      }
    }
    this.body.append(list);
  }

  /** Reference drawings (ADR 0014): units, visibility, layers, delete. Not selectable. */
  private renderReferences() {
    const doc = this.doc;
    const list = h('ul', { class: 'outliner references' });
    for (const r of doc.references) {
      const g = doc.geometryOf(r.id);
      const expanded = this.expandedRefs.has(r.id);
      const b = g ? referenceBounds({ ...r, hiddenLayers: [] }, g).getSize(new THREE.Vector3()) : null;
      const size = b ? `${formatLength(b.x, this.units, false)}×${formatLength(b.y, this.units, false)}` : '';
      const units = h(
        'select',
        {
          class: 'select tiny',
          title: 'Units the drawing was made in (rescales it)',
          onclick: (ev: MouseEvent) => ev.stopPropagation(),
          onchange: (ev: Event) => this.call('update_reference', { reference: r.id, units: (ev.target as HTMLSelectElement).value }, 'Drawing units'),
        },
        ...DRAWING_UNITS.map((u) => h('option', { value: u, selected: u === r.units }, u)),
      );
      list.append(
        h('li', {
          class: `outliner-item reference ${r.visible ? '' : 'hidden'}`,
          title: `${r.name}: a reference drawing to snap to, not part of the model. Click for units and layers, double-click to zoom.`,
          onclick: () => this.toggleRef(r.id),
          ondblclick: () => this.actions.zoomToReference(r.id),
        },
          h('button', { class: 'icon-btn caret', 'aria-label': expanded ? 'Hide layers' : 'Show layers' }, expanded ? '▾' : '▸'),
          h('span', { class: 'chip ref-chip', html: icon('drawing', 14) }),
          h('span', { class: 'outliner-name' }, r.name),
          h('span', { class: 'muted small' }, size),
          this.eye(r.visible, () => this.call('update_reference', { reference: r.id, visible: !r.visible }, r.visible ? 'Hide drawing' : 'Show drawing')),
          h('button', {
            class: 'icon-btn',
            title: 'Remove this drawing (undoable)',
            html: icon('trash', 15),
            onclick: (ev: MouseEvent) => {
              ev.stopPropagation();
              this.call('delete_reference', { reference: r.id }, 'Remove drawing');
            },
          }),
        ),
      );
      if (!expanded || !g) continue;
      list.append(h('li', { class: 'outliner-item layer', style: 'padding-left:34px' }, h('span', { class: 'outliner-name muted' }, 'Drawn in'), units));
      const counts = new Map<number, number>();
      for (const p of g.paths) counts.set(p.layer, (counts.get(p.layer) ?? 0) + 1);
      const hidden = new Set(r.hiddenLayers);
      g.layers.forEach((layer, i) => {
        const on = !hidden.has(layer);
        list.append(
          h('li', { class: `outliner-item layer ${on ? '' : 'hidden'}`, style: 'padding-left:34px' },
            h('span', { class: 'outliner-name', title: layer }, layer),
            h('span', { class: 'muted small' }, String(counts.get(i) ?? 0)),
            this.eye(on, () => this.call('update_reference', { reference: r.id, [on ? 'hide_layers' : 'show_layers']: [layer] }, on ? 'Hide layer' : 'Show layer')),
          ),
        );
      });
    }
    this.body.append(this.section(`Reference drawings`, list));
  }

  private renderAnnotationList() {
    const doc = this.doc;
    const list = h('ul', { class: 'outliner annotations' });
    for (const a of doc.annotations) {
      const g = a.kind === 'dimension' ? dimensionGeometry(a, (id) => doc.get(id)) : null;
      const text = a.kind === 'note' ? a.text : a.text ? a.text.replace(/<>/g, g ? formatLength(g.value, this.units) : '') : g ? formatLength(g.value, this.units) : '—';
      list.append(
        h('li', {
          class: `outliner-item ${doc.annotationSelection.has(a.id) ? 'selected' : ''}`,
          title: 'Click to select',
          onclick: (ev: MouseEvent) => doc.selectAnnotations([a.id], ev.metaKey || ev.ctrlKey || ev.shiftKey),
        },
          h('span', { class: 'chip ref-chip', html: icon(a.kind === 'note' ? 'text' : 'dimension', 14) }),
          h('span', { class: 'outliner-name' }, text.split('\n')[0]),
        ),
      );
    }
    this.body.append(this.section('Notes and dimensions', list));
  }

  private toggleRef(id: string) {
    if (this.expandedRefs.has(id)) this.expandedRefs.delete(id);
    else this.expandedRefs.add(id);
    this.render(true);
  }

  private eye(visible: boolean, toggle: () => void): HTMLElement {
    return h('button', {
      class: 'icon-btn eye',
      title: visible ? 'Hide' : 'Show',
      html: icon(visible ? 'eye' : 'eyeOff', 16),
      onclick: (ev: MouseEvent) => {
        ev.stopPropagation();
        toggle();
      },
    });
  }

  private sizeSummary(e: Entity): string {
    const f = (v: number) => formatLength(v, this.units, false);
    if (e.kind === 'box') return e.size.map(f).join('×');
    if (e.kind === 'cylinder') return e.radiusTop === undefined ? `Ø${f(e.radius * 2)}×${f(e.height)}` : `Ø${f(e.radius * 2)}→${f(e.radiusTop * 2)}×${f(e.height)}`;
    if (e.kind === 'sphere' && e.radii[0] === e.radii[1] && e.radii[1] === e.radii[2]) return `Ø${f(e.radii[0] * 2)}`;
    const s = worldBounds(e).getSize(new THREE.Vector3());
    return `${f(s.x)}×${f(s.y)}×${f(s.z)}`;
  }

  // ---- cut list -------------------------------------------------------------

  private renderCutList() {
    const rows = buildCutList(this.doc.entities);
    if (!rows.length) {
      this.body.append(h('p', { class: 'muted empty' }, 'Add some boards (boxes) to see a cut list. Holes and hidden objects are skipped.'));
      return;
    }
    const f = (v: number) => formatLength(v, this.units, false);
    const table = h('table', { class: 'cutlist' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Part'), h('th', {}, 'Qty'), h('th', { class: 'num' }, `T × W × L (${this.units})`))),
    );
    const tbody = h('tbody');
    let total = 0;
    for (const r of rows) {
      total += r.quantity;
      tbody.append(
        h('tr', {},
          h('td', { title: r.names.join(', ') }, r.names.length > 2 ? `${r.names.slice(0, 2).join(', ')} +${r.names.length - 2}` : r.names.join(', '), r.note ? h('div', { class: 'muted small' }, r.note) : null),
          h('td', { class: 'num' }, String(r.quantity)),
          h('td', { class: 'num' }, `${f(r.thickness)} × ${f(r.width)} × ${f(r.length)}`),
        ),
      );
    }
    table.append(tbody);
    this.body.append(
      h('p', { class: 'muted small' }, `${total} part${total === 1 ? '' : 's'}, ${rows.length} unique. Sizes are each part's own dimensions, sorted thickness ≤ width ≤ length.`),
      table,
      h('div', { class: 'prop-actions' }, h('button', { class: 'btn', onclick: () => this.actions.exportCutList(), html: `${icon('export', 16)}<span>Export CSV</span>` })),
    );
  }

  // ---- volumes (shared by Print and Quantities) ---------------------------

  /** Cached per-entity volumes, or null while (re)computing after a change. */
  private volumes(): Map<string, number> | null {
    if (this.volumeCache && this.volumeCache.version === this.doc.version) return this.volumeCache.byId;
    clearTimeout(this.volumeTimer);
    this.volumeTimer = window.setTimeout(() => {
      if (this.doc.inTransaction) return; // still dragging; a later change will reschedule
      const byId = new Map<string, number>();
      const parts = buildWorldGeometries(this.doc.entities, this.doc.entities, this.doc.groups);
      for (const { entity, geometry } of parts) byId.set(entity.id, meshVolume(geometry));
      // The total fuses overlapping parts, so they count once.
      const fused = fuseGeometries(parts.map((p) => p.geometry));
      const total = fused ? meshVolume(fused) : [...byId.values()].reduce((a, b) => a + b, 0);
      fused?.dispose();
      for (const p of parts) p.geometry.dispose();
      this.volumeCache = { version: this.doc.version, byId, total };
      if (this.tab === 'print' || this.tab === 'quantities') this.render();
    }, 250);
    return null;
  }

  private solids(): Entity[] {
    return this.doc.entities.filter((e) => e.visible && !e.hole);
  }

  /** True if any two solids' bounding boxes overlap (their volumes would double count). */
  private hasOverlaps(solids: Entity[]): boolean {
    const boxes = solids.map(worldBounds);
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (a.min.x < b.max.x - 0.01 && a.max.x > b.min.x + 0.01 && a.min.y < b.max.y - 0.01 && a.max.y > b.min.y + 0.01 && a.min.z < b.max.z - 0.01 && a.max.z > b.min.z + 0.01) return true;
      }
    return false;
  }

  // ---- print ------------------------------------------------------------------

  private renderPrint() {
    const setting = this.doc.printer;
    const [W, D, H] = printerVolume(setting);

    const printer = h('select', { class: 'select wide', 'aria-label': 'Printer' },
      ...PRINTERS.map((p) => h('option', { value: p.id, selected: setting.profile === p.id }, p.name)),
      h('option', { value: 'custom', selected: setting.profile === 'custom' }, 'Custom size…'),
    );
    printer.addEventListener('change', () => this.actions.setPrinter({ ...setting, profile: printer.value }));

    const printerSection = this.section('Printer', printer);
    if (setting.profile === 'custom') {
      const dims = h('div', { class: 'vec3' });
      ['X', 'Y', 'Z'].forEach((axis, i) => {
        const field = this.input(String(setting.custom[i]), (t) => {
          const v = parseLength(t, 'mm');
          if (v === null || v <= 0 || v > 5000) return false;
          const custom = [...setting.custom] as [number, number, number];
          custom[i] = Math.round(v * 10) / 10;
          this.actions.setPrinter({ ...setting, custom });
          return true;
        }, { suffix: 'mm' });
        dims.append(h('span', { class: `axis-field axis-${axis.toLowerCase()}` }, h('span', { class: 'axis-tag' }, axis), field));
      });
      printerSection.append(this.row('Volume', dims));
    } else {
      printerSection.append(h('p', { class: 'muted small' }, `Build volume ${W} × ${D} × ${H} mm. Bed origin is the front-left corner, like your slicer.`));
    }

    const solids = this.solids();
    const issues = this.actions.printIssues();
    let status: HTMLElement;
    if (!solids.length) {
      status = h('div', { class: 'status-card' }, 'Nothing to print yet — draw a part on the bed.');
    } else if (!issues.length) {
      status = h('div', { class: 'status-card ok' }, `✓ ${solids.length === 1 ? 'The part fits' : `All ${solids.length} parts fit`} on the bed.`);
    } else {
      const list = h('ul', { class: 'issues' });
      for (const issue of issues) {
        list.append(h('li', {},
          h('button', { class: 'link', title: 'Select and zoom to it', onclick: () => { this.doc.setSelection([issue.id]); this.actions.zoomTo([issue.id]); } }, issue.name),
          ` ${issue.message}`,
        ));
      }
      status = h('div', { class: 'status-card warn' }, h('strong', {}, `${issues.length} problem${issues.length === 1 ? '' : 's'}`), list);
    }

    const sel = this.doc.selected().filter((e) => !e.hole);
    const placeIds = sel.length ? sel.map((e) => e.id) : solids.map((e) => e.id);
    const actions = h('div', { class: 'prop-actions flush' },
      h('button', { class: 'btn', disabled: !solids.length, title: 'Centre on the bed and set down on it', onclick: () => this.actions.placeOnPlate(placeIds), html: `${icon('ground', 16)}<span>${sel.length ? 'Place selection on plate' : 'Place on plate'}</span>` }),
      h('button', { class: 'btn', disabled: !solids.length, onclick: () => this.actions.exportStl(), html: `${icon('export', 16)}<span>Export STL</span>` }),
    );

    const fitSection = this.section('Fit check', status, actions);

    // Size, volume and weight.
    const material = h('select', { class: 'select', 'aria-label': 'Filament' },
      ...FILAMENTS.map((f) => h('option', { value: f.id, selected: this.actions.filament() === f.id }, f.name)),
    );
    material.addEventListener('change', () => this.actions.setFilament(material.value));
    const filament = FILAMENTS.find((f) => f.id === this.actions.filament()) ?? FILAMENTS[0];
    const total = this.volumes() ? this.volumeCache!.total : null;
    const size = solids.length ? worldBoundsOf(solids).getSize(new THREE.Vector3()) : null;
    const f1 = (v: number) => trimNumber(v, 1);
    const modelSection = this.section('Model',
      this.row('Size', h('span', { class: 'muted' }, size ? `${f1(size.x)} × ${f1(size.y)} × ${f1(size.z)} mm` : '—')),
      this.row('Volume', h('span', { class: 'muted' }, total === null ? 'calculating…' : `${trimNumber(total / 1000, 2)} cm³`)),
      this.row('Material', material),
      this.row('Weight', h('span', { class: 'muted' }, total === null ? '…' : `${trimNumber((total / 1000) * filament.density, 1)} g solid`)),
      h('p', { class: 'muted small' },
        'Weight assumes 100% infill — your slicer’s estimate will be lower.',
        solids.length > 1 && this.hasOverlaps(solids) ? ' Overlapping parts are counted separately.' : '',
      ),
    );

    this.body.append(printerSection, fitSection, modelSection);
  }

  // ---- quantities (Build) -------------------------------------------------------

  /** Area seen from above in the object's own frame (m²). */
  private footprint(e: Entity): number {
    return footprintMm2(e) / 1e6;
  }

  private renderQuantities() {
    const solids = this.solids();
    if (!solids.length) {
      this.body.append(h('p', { class: 'muted empty' }, 'Add walls, slabs and other parts to see areas and volumes.'));
      return;
    }
    const vols = this.volumes();
    const m3 = (mm3: number) => trimNumber(mm3 / 1e9, 3);
    const m2 = (v: number) => trimNumber(v, 2);
    const size = worldBoundsOf(solids).getSize(new THREE.Vector3());
    const m = (mm: number) => trimNumber(mm / 1000, 2);
    const total = vols ? this.volumeCache!.total : null;

    const table = h('table', { class: 'cutlist' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Object'), h('th', { class: 'num' }, 'Footprint m²'), h('th', { class: 'num' }, 'Volume m³'))),
    );
    const tbody = h('tbody');
    for (const e of solids) {
      tbody.append(h('tr', {},
        h('td', {}, h('button', { class: 'link', onclick: () => this.doc.setSelection([e.id]) }, e.name)),
        h('td', { class: 'num' }, m2(this.footprint(e))),
        h('td', { class: 'num' }, vols ? m3(vols.get(e.id) ?? 0) : '…'),
      ));
    }
    table.append(tbody);
    this.body.append(
      this.section('Totals',
        this.row('Objects', h('span', { class: 'muted' }, String(solids.length))),
        this.row('Extent', h('span', { class: 'muted' }, `${m(size.x)} × ${m(size.y)} × ${m(size.z)} m`)),
        this.row('Volume', h('span', { class: 'muted' }, total === null ? 'calculating…' : `${m3(total)} m³`)),
      ),
      table,
      h('p', { class: 'muted small' },
        'Footprint is each object’s area seen from above. Volumes have holes (openings) removed.',
        this.hasOverlaps(solids) ? ' Overlapping objects are counted separately.' : '',
      ),
    );
  }
}
