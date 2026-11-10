/**
 * Customisable keyboard shortcuts.
 *
 * Combos are strings like "Mod+Shift+Z": modifiers in the order Mod, Ctrl, Alt, Shift, then
 * the key. "Mod" is ⌘ on macOS and Ctrl elsewhere; "Ctrl" only appears on macOS (the
 * physical Control key). Letters/digits are stored upper-case; other printable characters
 * are stored as typed (so "?" rather than "Shift+/").
 */

export type HoldKey = 'Shift' | 'Alt' | 'Ctrl' | 'none';
export type HoldAction = 'pan' | 'orbit';

export interface CommandDef {
  id: string;
  label: string;
  category: string;
  /** Default bindings. */
  keys: string[];
}

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

const MODIFIER_KEYS = new Set(['Shift', 'Alt', 'Control', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'OS']);
const NAMED_KEYS = new Set([
  'Delete', 'Backspace', 'Enter', 'Escape', 'Tab', 'Home', 'End', 'PageUp', 'PageDown', 'Insert',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);
const MOD_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift'];

/** Characters that start typing into the measurement box (never bindable on their own). */
export const MEASUREMENT_CHARS = /^[0-9.,\-+/'"*]$/;

function keyName(e: KeyLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  if (e.key === ' ' || e.code === 'Space') return 'Space';
  // Prefer the layout's own letter (QWERTZ etc.); fall back to the physical key for
  // non-Latin layouts and for Option+letter on macOS, which produces symbols.
  if (/^[a-zA-Z0-9]$/.test(e.key)) return e.key.toUpperCase();
  const m = /^(?:Key|Digit|Numpad)([A-Z0-9])$/.exec(e.code);
  if (m) return m[1];
  if (NAMED_KEYS.has(e.key)) return e.key;
  if (e.key.length === 1) return e.key;
  return null;
}

/** Turn a keyboard event into a canonical combo string, or null for bare modifier presses. */
export function comboFromEvent(e: KeyLike, mac = IS_MAC): string | null {
  const key = keyName(e);
  if (!key) return null;
  const mods: string[] = [];
  if (mac ? e.metaKey : e.ctrlKey) mods.push('Mod');
  if (mac && e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  // For symbols, Shift is already baked into the character ("?" not "Shift+/").
  const isSymbol = key.length === 1 && !/[A-Z0-9]/.test(key);
  if (e.shiftKey && !isSymbol) mods.push('Shift');
  return [...mods, key].join('+');
}

/** Put a hand-written combo ("shift+mod+z") into canonical form ("Mod+Shift+Z"). */
export function normalizeCombo(combo: string): string {
  const parts = combo.split('+');
  // A literal "+" key shows up as an empty last part.
  let key = parts.pop() ?? '';
  if (key === '' && combo.endsWith('+')) {
    key = '+';
    parts.pop();
  }
  const mods = new Set(parts.map((p) => {
    const lower = p.toLowerCase();
    if (lower === 'mod' || lower === 'cmd' || lower === 'meta') return 'Mod';
    if (lower === 'ctrl' || lower === 'control') return 'Ctrl';
    if (lower === 'alt' || lower === 'option') return 'Alt';
    if (lower === 'shift') return 'Shift';
    return p;
  }));
  if (key.length === 1) key = key.toUpperCase();
  else if (key.toLowerCase() === 'space') key = 'Space';
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+');
}

function splitCombo(combo: string): { mods: string[]; key: string } {
  if (combo === '+' || combo.endsWith('++')) return { mods: combo.slice(0, -2).split('+').filter(Boolean), key: '+' };
  const parts = combo.split('+');
  return { key: parts.pop() ?? '', mods: parts };
}

const MAC_SYMBOLS: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
const KEY_LABELS: Record<string, [mac: string, other: string]> = {
  ArrowUp: ['↑', '↑'],
  ArrowDown: ['↓', '↓'],
  ArrowLeft: ['←', '←'],
  ArrowRight: ['→', '→'],
  Delete: ['Del', 'Del'],
  Backspace: ['⌫', 'Backspace'],
  Enter: ['↵', 'Enter'],
  Escape: ['Esc', 'Esc'],
  Space: ['Space', 'Space'],
};

/** Human-readable combo: "⇧⌘Z" on macOS, "Ctrl+Shift+Z" elsewhere. */
export function displayCombo(combo: string, mac = IS_MAC): string {
  const { mods, key } = splitCombo(combo);
  const keyLabel = KEY_LABELS[key]?.[mac ? 0 : 1] ?? key;
  if (mac) {
    // macOS convention orders symbols ⌃⌥⇧⌘.
    const order = ['Ctrl', 'Alt', 'Shift', 'Mod'];
    return order.filter((m) => mods.includes(m)).map((m) => MAC_SYMBOLS[m]).join('') + keyLabel;
  }
  return [...mods.map((m) => (m === 'Mod' ? 'Ctrl' : m)), keyLabel].join('+');
}

export function holdKeyLabel(key: HoldKey, mac = IS_MAC): string {
  if (key === 'none') return 'Off';
  if (key === 'Alt') return mac ? '⌥ Option' : 'Alt';
  if (key === 'Ctrl') return mac ? '⌃ Control' : 'Ctrl';
  return mac ? '⇧ Shift' : 'Shift';
}

/** Why a combo can't be bound, or null if it's fine. */
export function reservedReason(combo: string): string | null {
  const { mods, key } = splitCombo(combo);
  const plain = mods.length === 0;
  if (plain && MEASUREMENT_CHARS.test(key)) return 'Digits and symbols are reserved for typing measurements.';
  if (plain && ['Escape', 'Enter', 'Tab'].includes(key)) return `${key} is reserved for cancelling/confirming.`;
  if (key.startsWith('Arrow') && plain) return 'Arrow keys are reserved for locking axes.';
  return null;
}

interface StoredKeymap {
  version: 1;
  bindings: Record<string, string[]>;
  holdPan: HoldKey;
  holdOrbit: HoldKey;
}

export const DEFAULT_HOLD: Record<HoldAction, HoldKey> = { pan: 'Shift', orbit: 'Alt' };
const HOLD_KEYS: HoldKey[] = ['Shift', 'Alt', 'Ctrl', 'none'];

/** The live shortcut table: defaults + user overrides, persisted to storage. */
export class Keymap {
  private overrides = new Map<string, string[]>();
  private bindings = new Map<string, string[]>();
  private byCombo = new Map<string, string>();
  private hold: Record<HoldAction, HoldKey> = { ...DEFAULT_HOLD };
  private listeners = new Set<() => void>();
  private readonly defs: Map<string, CommandDef>;

  constructor(
    readonly commands: CommandDef[],
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = null,
    private readonly storageKey = 'modeler.keymap.v1',
  ) {
    this.defs = new Map(commands.map((c) => [c.id, { ...c, keys: c.keys.map(normalizeCombo) }]));
    this.load();
    this.rebuild();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---- queries ----------------------------------------------------------------

  keysFor(id: string): string[] {
    return this.bindings.get(id) ?? [];
  }

  /** First binding, formatted for display (or '' if unbound). */
  label(id: string): string {
    const k = this.keysFor(id)[0];
    return k ? displayCombo(k) : '';
  }

  commandFor(combo: string): string | undefined {
    return this.byCombo.get(combo);
  }

  isDefault(id: string): boolean {
    return !this.overrides.has(id);
  }

  get isAllDefault(): boolean {
    return this.overrides.size === 0 && this.hold.pan === DEFAULT_HOLD.pan && this.hold.orbit === DEFAULT_HOLD.orbit;
  }

  holdKey(action: HoldAction): HoldKey {
    return this.hold[action];
  }

  /** Which hold action (if any) a pressed modifier key (`KeyboardEvent.key`) triggers. */
  holdActionFor(eventKey: string): HoldAction | null {
    const key: HoldKey | null = eventKey === 'Shift' ? 'Shift' : eventKey === 'Alt' ? 'Alt' : eventKey === 'Control' ? 'Ctrl' : null;
    if (!key) return null;
    if (this.hold.pan === key) return 'pan';
    if (this.hold.orbit === key) return 'orbit';
    return null;
  }

  // ---- edits ------------------------------------------------------------------

  /**
   * Bind `combo` to `id` (in addition to its other keys, or replacing `replace`).
   * Any other command using the combo loses it; its id is returned so the UI can say so.
   */
  assign(id: string, combo: string, replace?: string): { movedFrom?: string } {
    combo = normalizeCombo(combo);
    const movedFrom = this.byCombo.get(combo);
    if (movedFrom && movedFrom !== id) {
      this.overrides.set(movedFrom, this.keysFor(movedFrom).filter((k) => k !== combo));
    }
    const keys = this.keysFor(id).filter((k) => k !== combo);
    const at = replace ? keys.indexOf(replace) : -1;
    if (at >= 0) keys.splice(at, 1, combo);
    else keys.push(combo);
    this.overrides.set(id, keys);
    this.commit();
    return { movedFrom: movedFrom && movedFrom !== id ? movedFrom : undefined };
  }

  unbind(id: string, combo: string): void {
    this.overrides.set(id, this.keysFor(id).filter((k) => k !== combo));
    this.commit();
  }

  reset(id: string): void {
    this.overrides.delete(id);
    // A default may collide with a key the user moved elsewhere; the user's choice wins.
    this.commit();
  }

  resetAll(): void {
    this.overrides.clear();
    this.hold = { ...DEFAULT_HOLD };
    this.commit();
  }

  /** Choose the hold key for pan/orbit. Taking the other action's key turns that one off. */
  setHoldKey(action: HoldAction, key: HoldKey): void {
    const other: HoldAction = action === 'pan' ? 'orbit' : 'pan';
    if (key !== 'none' && this.hold[other] === key) this.hold[other] = 'none';
    this.hold[action] = key;
    this.commit();
  }

  // ---- internals --------------------------------------------------------------

  private commit() {
    this.prune();
    this.rebuild();
    this.save();
    for (const fn of this.listeners) fn();
  }

  /** Drop overrides that ended up identical to the defaults. */
  private prune() {
    for (const [id, keys] of this.overrides) {
      const def = this.defs.get(id)?.keys ?? [];
      if (keys.length === def.length && keys.every((k, i) => k === def[i])) this.overrides.delete(id);
    }
  }

  private rebuild() {
    this.bindings.clear();
    this.byCombo.clear();
    // User overrides claim their combos first, then defaults fill in what's left.
    for (const [id, keys] of this.overrides) {
      const kept = keys.filter((k) => !this.byCombo.has(k));
      kept.forEach((k) => this.byCombo.set(k, id));
      this.bindings.set(id, kept);
    }
    for (const def of this.defs.values()) {
      if (this.overrides.has(def.id)) continue;
      const kept = def.keys.filter((k) => !this.byCombo.has(k));
      kept.forEach((k) => this.byCombo.set(k, def.id));
      this.bindings.set(def.id, kept);
    }
  }

  private load() {
    try {
      const raw = JSON.parse(this.storage?.getItem(this.storageKey) ?? 'null') as Partial<StoredKeymap> | null;
      if (!raw || raw.version !== 1) return;
      for (const [id, keys] of Object.entries(raw.bindings ?? {})) {
        if (this.defs.has(id) && Array.isArray(keys) && keys.every((k) => typeof k === 'string')) {
          this.overrides.set(id, keys.map(normalizeCombo).filter((k) => !reservedReason(k)));
        }
      }
      if (HOLD_KEYS.includes(raw.holdPan as HoldKey)) this.hold.pan = raw.holdPan as HoldKey;
      if (HOLD_KEYS.includes(raw.holdOrbit as HoldKey)) this.hold.orbit = raw.holdOrbit as HoldKey;
      if (this.hold.pan !== 'none' && this.hold.pan === this.hold.orbit) this.hold.orbit = 'none';
      this.prune();
    } catch {
      // Corrupt storage: fall back to defaults.
    }
  }

  private save() {
    const data: StoredKeymap = {
      version: 1,
      bindings: Object.fromEntries(this.overrides),
      holdPan: this.hold.pan,
      holdOrbit: this.hold.orbit,
    };
    try {
      this.storage?.setItem(this.storageKey, JSON.stringify(data));
    } catch {
      // best-effort
    }
  }
}
