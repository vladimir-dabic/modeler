import { describe, expect, it } from 'vitest';
import { comboFromEvent, displayCombo, Keymap, normalizeCombo, reservedReason, type KeyLike } from '../src/keymap';

const ev = (key: string, code: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods,
});

describe('comboFromEvent', () => {
  it('uses Mod for ⌘ on mac and Ctrl elsewhere', () => {
    expect(comboFromEvent(ev('z', 'KeyZ', { metaKey: true }), true)).toBe('Mod+Z');
    expect(comboFromEvent(ev('z', 'KeyZ', { ctrlKey: true }), false)).toBe('Mod+Z');
    expect(comboFromEvent(ev('z', 'KeyZ', { ctrlKey: true }), true)).toBe('Ctrl+Z');
    expect(comboFromEvent(ev('Z', 'KeyZ', { metaKey: true, shiftKey: true }), true)).toBe('Mod+Shift+Z');
  });

  it('respects the keyboard layout for letters (QWERTZ)', () => {
    // The key labelled Z on a German/Serbian keyboard sits where Y is on QWERTY.
    expect(comboFromEvent(ev('z', 'KeyY'))).toBe('Z');
  });

  it('falls back to the physical key for non-Latin layouts and Option+letter', () => {
    expect(comboFromEvent(ev('и', 'KeyB'))).toBe('B');
    expect(comboFromEvent(ev('∫', 'KeyB', { altKey: true }), true)).toBe('Alt+B');
  });

  it('bakes Shift into symbols but keeps it for letters and digits', () => {
    expect(comboFromEvent(ev('?', 'Slash', { shiftKey: true }))).toBe('?');
    expect(comboFromEvent(ev('!', 'Digit1', { shiftKey: true }))).toBe('Shift+1');
    expect(comboFromEvent(ev('B', 'KeyB', { shiftKey: true }))).toBe('Shift+B');
  });

  it('ignores bare modifiers and names special keys', () => {
    expect(comboFromEvent(ev('Shift', 'ShiftLeft', { shiftKey: true }))).toBeNull();
    expect(comboFromEvent(ev(' ', 'Space'))).toBe('Space');
    expect(comboFromEvent(ev('Delete', 'Delete'))).toBe('Delete');
    expect(comboFromEvent(ev('F2', 'F2'))).toBe('F2');
  });
});

describe('normalizeCombo / displayCombo / reservedReason', () => {
  it('canonicalises modifier order and case', () => {
    expect(normalizeCombo('shift+cmd+z')).toBe('Mod+Shift+Z');
    expect(normalizeCombo('space')).toBe('Space');
    expect(normalizeCombo('Mod++')).toBe('Mod++');
  });

  it('formats for each platform', () => {
    expect(displayCombo('Mod+Shift+Z', true)).toBe('⇧⌘Z');
    expect(displayCombo('Mod+Shift+Z', false)).toBe('Ctrl+Shift+Z');
    expect(displayCombo('Backspace', true)).toBe('⌫');
  });

  it('reserves measurement characters and tool keys', () => {
    expect(reservedReason('5')).toMatch(/measurements/);
    expect(reservedReason('Mod+5')).toBeNull();
    expect(reservedReason('Escape')).not.toBeNull();
    expect(reservedReason('ArrowUp')).not.toBeNull();
    expect(reservedReason('B')).toBeNull();
  });
});

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

const COMMANDS = [
  { id: 'tool.box', label: 'Box', category: 'Tools', keys: ['B'] },
  { id: 'tool.cylinder', label: 'Cylinder', category: 'Tools', keys: ['C'] },
  { id: 'edit.redo', label: 'Redo', category: 'Edit', keys: ['Mod+Shift+Z', 'Mod+Y'] },
];

describe('Keymap', () => {
  it('looks up defaults', () => {
    const km = new Keymap(COMMANDS);
    expect(km.commandFor('B')).toBe('tool.box');
    expect(km.commandFor('Mod+Y')).toBe('edit.redo');
    expect(km.isAllDefault).toBe(true);
  });

  it('replacing a key frees the old one', () => {
    const km = new Keymap(COMMANDS);
    km.assign('tool.box', 'K', 'B');
    expect(km.commandFor('K')).toBe('tool.box');
    expect(km.commandFor('B')).toBeUndefined();
  });

  it('stealing a key removes it from the other command', () => {
    const km = new Keymap(COMMANDS);
    const { movedFrom } = km.assign('tool.box', 'C');
    expect(movedFrom).toBe('tool.cylinder');
    expect(km.keysFor('tool.box')).toEqual(['B', 'C']);
    expect(km.keysFor('tool.cylinder')).toEqual([]);
  });

  it('persists overrides and hold keys, and resets', () => {
    const storage = memoryStorage();
    const km = new Keymap(COMMANDS, storage);
    km.assign('tool.box', 'K', 'B');
    km.setHoldKey('orbit', 'Ctrl');
    const again = new Keymap(COMMANDS, storage);
    expect(again.commandFor('K')).toBe('tool.box');
    expect(again.holdKey('orbit')).toBe('Ctrl');
    again.resetAll();
    expect(again.commandFor('B')).toBe('tool.box');
    expect(again.holdKey('orbit')).toBe('Alt');
    expect(new Keymap(COMMANDS, storage).isAllDefault).toBe(true);
  });

  it('a hold key can only do one thing', () => {
    const km = new Keymap(COMMANDS);
    km.setHoldKey('orbit', 'Shift');
    expect(km.holdKey('orbit')).toBe('Shift');
    expect(km.holdKey('pan')).toBe('none');
    expect(km.holdActionFor('Shift')).toBe('orbit');
    expect(km.holdActionFor('Alt')).toBeNull();
  });

  it('ignores corrupt or reserved stored bindings', () => {
    const storage = memoryStorage();
    storage.setItem('modeler.keymap.v1', JSON.stringify({ version: 1, bindings: { 'tool.box': ['5'], nope: ['X'] }, holdPan: 'Hyper' }));
    const km = new Keymap(COMMANDS, storage);
    expect(km.keysFor('tool.box')).toEqual([]);
    expect(km.holdKey('pan')).toBe('Shift');
    storage.setItem('modeler.keymap.v1', '{not json');
    expect(new Keymap(COMMANDS, storage).commandFor('B')).toBe('tool.box');
  });
});
