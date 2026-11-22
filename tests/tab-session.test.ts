import { describe, expect, it } from 'vitest';
import { LEGACY_AUTOSAVE_KEY, TabSession } from '../src/ui/TabSession';

class Mem {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

describe('TabSession: one autosave slot per tab', () => {
  let n = 0;
  const env = (local: Mem, session = new Mem(), now = () => 100_000) => ({ local, session, now, newId: () => `t${++n}` });

  it('gives two open tabs separate slots', () => {
    const local = new Mem();
    const a = new TabSession(env(local));
    local.setItem(a.autosaveKey, 'model A');
    a.saved();
    const b = new TabSession(env(local));
    expect(b.id).not.toBe(a.id);
    // A is alive, so B doesn't take its model.
    expect(b.source).toBeNull();
    expect(local.getItem(a.autosaveKey)).toBe('model A');
  });

  it('finds its own slot again after a reload', () => {
    const local = new Mem();
    const session = new Mem();
    const a = new TabSession(env(local, session));
    local.setItem(a.autosaveKey, 'model A');
    // pagehide marks it closed; the reload has the same sessionStorage.
    const index = JSON.parse(local.getItem('modeler.tabs.v1')!);
    index[a.id].seen = 0;
    local.setItem('modeler.tabs.v1', JSON.stringify(index));
    const again = new TabSession(env(local, session));
    expect(again.id).toBe(a.id);
    expect(again.source).toBe(a.id);
  });

  it('a new tab takes over the most recent closed tab’s work', () => {
    const local = new Mem();
    let t = 100_000;
    const a = new TabSession(env(local, new Mem(), () => t));
    local.setItem(a.autosaveKey, 'old work');
    a.saved();
    t += 60_000; // A closed long ago (no heartbeat)
    const b = new TabSession(env(local, new Mem(), () => t));
    expect(b.source).toBe(a.id);
    expect(local.getItem(b.autosaveKey)).toBe('old work');
    expect(local.getItem(a.autosaveKey)).toBeNull();
    expect(b.sourceFileKey).toBe(`current:${a.id}`);
  });

  it('a duplicated tab gets its own copy while the original stays open', () => {
    const local = new Mem();
    const session = new Mem();
    const a = new TabSession(env(local, session));
    local.setItem(a.autosaveKey, 'model A');
    const dup = new TabSession(env(local, session));
    expect(dup.id).not.toBe(a.id);
    expect(local.getItem(dup.autosaveKey)).toBe('model A');
    expect(local.getItem(a.autosaveKey)).toBe('model A');
  });

  it('adopts the autosave from before tabs existed', () => {
    const local = new Mem();
    local.setItem(LEGACY_AUTOSAVE_KEY, 'legacy model');
    const s = new TabSession(env(local));
    expect(s.source).toBe('legacy');
    expect(s.sourceFileKey).toBe('current');
    expect(local.getItem(s.autosaveKey)).toBe('legacy model');
    expect(local.getItem(LEGACY_AUTOSAVE_KEY)).toBeNull();
  });
});
