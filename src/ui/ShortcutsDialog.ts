import {
  comboFromEvent,
  displayCombo,
  holdKeyLabel,
  IS_MAC,
  reservedReason,
  type HoldAction,
  type HoldKey,
  type Keymap,
} from '../keymap';
import { h } from './dom';
import { icon } from './icons';

const MAX_KEYS = 3;

/** Keys that work while a tool is active; listed for reference, not rebindable. */
function fixedKeys(km: Keymap): [string, string][] {
  const tap = IS_MAC ? '⌥ Option' : 'Alt';
  const orbitHold = km.holdKey('orbit') === 'Alt';
  return [
    ['Esc', 'Cancel the current operation, or clear the selection'],
    ['0–9 . , / \' "', 'Start typing a measurement (sizes, distances, angles)'],
    ['↵', 'Confirm a typed measurement · close a Line shape'],
    ['→ ← ↑', 'Lock to the red / green / blue axis (or drawing plane)'],
    [`tap ${tap}`, `Copy while moving · solid/hole while drawing${orbitHold ? ' (a quick tap, without dragging)' : ''}`],
    ['⌫', 'Line tool: remove the last point'],
    ['x, d', 'Move: “5x” array after a copy · Cylinder: “d10” diameter'],
  ];
}

const MOUSE: [string, string][] = [
  ['Middle-drag', 'Orbit'],
  ['Right-drag', 'Pan'],
  ['Scroll / pinch', 'Zoom at the cursor'],
];

/**
 * Modal listing every shortcut. Click a key to record a new one, × to remove it,
 * + to add another, ↺ to reset. Hold-to-pan/orbit keys are chosen from a menu.
 */
export class ShortcutsDialog {
  readonly el: HTMLDivElement;
  private body: HTMLDivElement;
  private status: HTMLDivElement;
  private search: HTMLInputElement;
  private capture: { id: string; replace?: string } | null = null;
  private lastFocus: Element | null = null;
  isOpen = false;

  constructor(private readonly keymap: Keymap) {
    this.search = h('input', { type: 'search', class: 'field sc-search', placeholder: 'Search commands or keys…', 'aria-label': 'Search shortcuts' });
    this.search.addEventListener('input', () => this.render());
    this.status = h('div', { class: 'sc-status', role: 'status' });
    this.body = h('div', { class: 'sc-body' });
    const resetAll = h('button', { class: 'btn', onclick: () => this.resetAll() }, 'Reset all to defaults');
    const done = h('button', { class: 'btn primary', onclick: () => this.close() }, 'Done');
    const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sc-title' },
      h('header', { class: 'modal-head' },
        h('h2', { id: 'sc-title' }, 'Keyboard shortcuts'),
        h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => this.close(), html: '<span aria-hidden="true" style="font-size:18px;line-height:1">×</span>' }),
      ),
      h('div', { class: 'sc-tools' }, this.search),
      this.status,
      this.body,
      h('footer', { class: 'modal-foot' }, resetAll, h('span', { class: 'tb-spacer' }), done),
    );
    this.el = h('div', { class: 'modal-backdrop', hidden: true });
    this.el.append(dialog);
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el) this.close();
    });
    // Capture phase so recording a key beats every other handler.
    window.addEventListener('keydown', (e) => this.onKey(e), true);
    keymap.onChange(() => this.isOpen && this.render());
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.lastFocus = document.activeElement;
    this.el.hidden = false;
    this.capture = null;
    this.setStatus('Click a shortcut to change it. Press the new keys, or Esc to cancel.');
    this.render();
    this.search.focus();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.capture = null;
    this.el.hidden = true;
    if (this.lastFocus instanceof HTMLElement) this.lastFocus.focus({ preventScroll: true });
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  private setStatus(text: string, kind: 'info' | 'warn' | 'ok' = 'info') {
    this.status.textContent = text;
    this.status.dataset.kind = kind;
  }

  private label(id: string): string {
    return this.keymap.commands.find((c) => c.id === id)?.label ?? id;
  }

  private onKey(e: KeyboardEvent) {
    if (!this.isOpen) return;
    if (this.capture) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        this.capture = null;
        this.setStatus('Cancelled.');
        this.render();
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // just a modifier so far
      const reason = reservedReason(combo);
      if (reason) {
        this.setStatus(`${displayCombo(combo)} can't be used: ${reason}`, 'warn');
        return;
      }
      const { id, replace } = this.capture;
      this.capture = null;
      const { movedFrom } = this.keymap.assign(id, combo, replace);
      this.setStatus(
        movedFrom
          ? `${displayCombo(combo)} → ${this.label(id)} (removed from ${this.label(movedFrom)})`
          : `${displayCombo(combo)} → ${this.label(id)}`,
        movedFrom ? 'warn' : 'ok',
      );
      this.render();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (this.search.value) {
        this.search.value = '';
        this.render();
      } else this.close();
    }
  }

  private startCapture(id: string, replace?: string) {
    this.capture = { id, replace };
    this.setStatus(`Press the new shortcut for “${this.label(id)}”… (Esc to cancel)`);
    this.render();
  }

  private resetAll() {
    this.keymap.resetAll();
    this.setStatus('All shortcuts restored to defaults.', 'ok');
  }

  private holdSelect(action: HoldAction): HTMLElement {
    const select = h('select', { class: 'select', 'aria-label': action === 'pan' ? 'Hold to pan' : 'Hold to orbit' },
      ...(['Shift', 'Alt', 'Ctrl', 'none'] as HoldKey[]).map((k) =>
        h('option', { value: k, selected: this.keymap.holdKey(action) === k }, holdKeyLabel(k)),
      ),
    );
    select.addEventListener('change', () => {
      const key = select.value as HoldKey;
      const other = action === 'pan' ? 'orbit' : 'pan';
      const hadOther = this.keymap.holdKey(other) === key && key !== 'none';
      this.keymap.setHoldKey(action, key);
      let msg = `Hold ${holdKeyLabel(key)} + drag to ${action}.`;
      if (key === 'none') msg = `Hold-to-${action} turned off.`;
      if (hadOther) msg += ` (Hold-to-${other} is now off.)`;
      if (key === 'Ctrl' && IS_MAC) msg += ' Note: on a Mac, Control-click can act as a right-click.';
      if (key === 'Shift') msg += ' ⌘-click still adds to the selection.';
      this.setStatus(msg, hadOther ? 'warn' : 'ok');
    });
    return select;
  }

  private chip(id: string, combo: string): HTMLElement {
    const recording = this.capture?.id === id && this.capture.replace === combo;
    return h('span', { class: `sc-chip ${recording ? 'recording' : ''}` },
      h('button', { class: 'sc-key', title: 'Click, then press a new shortcut', onclick: () => this.startCapture(id, combo) },
        recording ? 'Press keys…' : displayCombo(combo)),
      h('button', { class: 'sc-x', title: 'Remove this shortcut', 'aria-label': `Remove ${displayCombo(combo)}`, onclick: () => this.keymap.unbind(id, combo) }, '×'),
    );
  }

  private render() {
    const q = this.search.value.trim().toLowerCase();
    const matches = (...texts: string[]) => !q || texts.some((t) => t.toLowerCase().includes(q));
    this.body.replaceChildren();

    // Navigation: hold keys + mouse reference.
    const nav = h('section', { class: 'sc-section' }, h('h3', {}, 'Navigation'));
    if (matches('pan hold', holdKeyLabel(this.keymap.holdKey('pan')))) {
      nav.append(h('div', { class: 'sc-row' }, h('span', { class: 'sc-label' }, 'Pan while held (+ drag)'), h('div', { class: 'sc-keys' }, this.holdSelect('pan'))));
    }
    if (matches('orbit hold rotate', holdKeyLabel(this.keymap.holdKey('orbit')))) {
      nav.append(h('div', { class: 'sc-row' }, h('span', { class: 'sc-label' }, 'Orbit while held (+ drag)'), h('div', { class: 'sc-keys' }, this.holdSelect('orbit'))));
    }
    for (const [keys, what] of MOUSE) {
      if (matches(keys, what)) nav.append(h('div', { class: 'sc-row' }, h('span', { class: 'sc-label' }, what), h('div', { class: 'sc-keys' }, h('kbd', {}, keys))));
    }
    if (nav.children.length > 1) this.body.append(nav);

    // Rebindable commands by category.
    const categories = [...new Set(this.keymap.commands.map((c) => c.category))];
    for (const cat of categories) {
      const section = h('section', { class: 'sc-section' }, h('h3', {}, cat));
      for (const cmd of this.keymap.commands.filter((c) => c.category === cat)) {
        const keys = this.keymap.keysFor(cmd.id);
        if (!matches(cmd.label, cat, ...keys.map((k) => displayCombo(k)))) continue;
        const adding = this.capture?.id === cmd.id && this.capture.replace === undefined;
        const controls = h('div', { class: 'sc-keys' }, ...keys.map((k) => this.chip(cmd.id, k)));
        if (adding) controls.append(h('span', { class: 'sc-chip recording' }, h('span', { class: 'sc-key' }, 'Press keys…')));
        else if (keys.length < MAX_KEYS) {
          controls.append(h('button', { class: 'sc-add', title: 'Add a shortcut', 'aria-label': `Add shortcut for ${cmd.label}`, onclick: () => this.startCapture(cmd.id) }, keys.length ? '+' : '+ Add'));
        }
        if (!this.keymap.isDefault(cmd.id)) {
          controls.append(h('button', { class: 'sc-reset', title: 'Reset to default', 'aria-label': `Reset ${cmd.label}`, onclick: () => this.keymap.reset(cmd.id), html: icon('undo', 14) }));
        }
        section.append(h('div', { class: `sc-row ${this.keymap.isDefault(cmd.id) ? '' : 'custom'}` }, h('span', { class: 'sc-label' }, cmd.label), controls));
      }
      if (section.children.length > 1) this.body.append(section);
    }

    // Fixed keys for reference.
    const fixed = h('section', { class: 'sc-section' }, h('h3', {}, 'While using a tool (fixed)'));
    for (const [keys, what] of fixedKeys(this.keymap)) {
      if (matches(keys, what)) fixed.append(h('div', { class: 'sc-row' }, h('span', { class: 'sc-label' }, what), h('div', { class: 'sc-keys' }, h('kbd', {}, keys))));
    }
    if (fixed.children.length > 1) this.body.append(fixed);

    if (!this.body.children.length) this.body.append(h('p', { class: 'muted' }, 'No shortcuts match.'));
  }
}
