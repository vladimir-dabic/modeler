/**
 * One browser tab's slot for the autosave and the "current file" (ADR 0023). Before this,
 * every tab wrote the same autosave key, so two open tabs overwrote each other's work.
 *
 * - Each tab has an id, kept in sessionStorage, so a reload finds its own slot again.
 * - Open tabs write a heartbeat into a small index in localStorage.
 * - A new tab takes over the most recent slot that no open tab owns (the work you closed
 *   last), or starts empty. A duplicated tab (same session id while the original is still
 *   alive) gets its own id and a copy of the original's model.
 * - Old slots are pruned (the 12 most recent are kept).
 */

const INDEX_KEY = 'modeler.tabs.v1';
const SESSION_KEY = 'modeler.tab';
export const LEGACY_AUTOSAVE_KEY = 'modeler.autosave.v1';
const HEARTBEAT_MS = 4000;
const ALIVE_MS = 12000;
const KEEP = 12;

interface Entry {
  /** Last heartbeat (ms); 0 once the tab closed. */
  seen: number;
  /** Last autosave (ms). */
  saved: number;
}

type Index = Record<string, Entry>;

export interface SessionStorages {
  local: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  session: Pick<Storage, 'getItem' | 'setItem'>;
  now?: () => number;
  newId?: () => string;
}

export class TabSession {
  readonly id: string;
  /**
   * Whose saved model this tab starts from: its own id after a reload, another tab's id
   * (taken over or copied), 'legacy' for the pre-tabs autosave, or null (start empty).
   */
  readonly source: string | null;
  private timer = 0;

  constructor(private readonly s: SessionStorages) {
    const now = this.now();
    const index = this.readIndex();
    const alive = (e: Entry | undefined) => !!e && e.seen > now - ALIVE_MS;
    const own = s.session.getItem(SESSION_KEY);
    let id: string;
    let source: string | null = null;
    let copy = false;
    if (own && index[own] && !alive(index[own])) {
      // A reload of this tab.
      id = own;
      source = own;
    } else if (own && alive(index[own])) {
      // A duplicated tab: the original is still open. Start from a copy of its model.
      id = this.newId();
      source = own;
      copy = true;
    } else {
      id = this.newId();
      const free = Object.entries(index)
        .filter(([, e]) => !alive(e))
        .sort((a, b) => b[1].saved - a[1].saved)[0];
      if (free) source = free[0];
      else if (s.local.getItem(LEGACY_AUTOSAVE_KEY) !== null) source = 'legacy';
    }
    this.id = id;
    this.source = source;
    s.session.setItem(SESSION_KEY, id);

    // Claim the slot now, so a tab opened right after doesn't take the same one.
    if (source && source !== id) {
      const data = s.local.getItem(this.keyFor(source));
      if (data !== null) this.trySet(this.autosaveKey, data);
      if (!copy) this.forget(source, index);
    }
    index[id] = { seen: now, saved: index[id]?.saved ?? index[source ?? '']?.saved ?? now };
    this.writeIndex(this.prune(index));
  }

  get autosaveKey(): string {
    return this.keyFor(this.id);
  }

  /** IndexedDB key of the file this tab's model belongs to. */
  get currentFileKey(): string {
    return `current:${this.id}`;
  }

  /** The current-file key of the slot this tab started from ('current' for the legacy one). */
  get sourceFileKey(): string | null {
    if (!this.source) return null;
    return this.source === 'legacy' ? 'current' : `current:${this.source}`;
  }

  /** Start the heartbeat and release the slot when the tab closes. */
  start(win: Pick<Window, 'addEventListener' | 'setInterval'>) {
    this.timer = win.setInterval(() => this.touch({ seen: this.now() }), HEARTBEAT_MS);
    win.addEventListener('pagehide', () => this.touch({ seen: 0 }));
  }

  /** Call after each autosave. */
  saved() {
    this.touch({ seen: this.now(), saved: this.now() });
  }

  private touch(patch: Partial<Entry>) {
    const index = this.readIndex();
    index[this.id] = { ...(index[this.id] ?? { seen: 0, saved: 0 }), ...patch };
    this.writeIndex(index);
  }

  private keyFor(id: string): string {
    return id === 'legacy' ? LEGACY_AUTOSAVE_KEY : `${LEGACY_AUTOSAVE_KEY}:${id}`;
  }

  private forget(id: string, index: Index) {
    this.s.local.removeItem(this.keyFor(id));
    delete index[id];
  }

  private prune(index: Index): Index {
    const sorted = Object.entries(index).sort((a, b) => b[1].saved - a[1].saved);
    for (const [id] of sorted.slice(KEEP)) if (id !== this.id) this.forget(id, index);
    return index;
  }

  private readIndex(): Index {
    try {
      const raw = JSON.parse(this.s.local.getItem(INDEX_KEY) ?? '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  private writeIndex(index: Index) {
    this.trySet(INDEX_KEY, JSON.stringify(index));
  }

  private trySet(key: string, value: string) {
    try {
      this.s.local.setItem(key, value);
    } catch {
      // Storage full or blocked: autosave is best-effort.
    }
  }

  private now(): number {
    return (this.s.now ?? Date.now)();
  }

  private newId(): string {
    return (this.s.newId ?? (() => Math.random().toString(36).slice(2, 10)))();
  }

  stop() {
    clearInterval(this.timer);
  }
}
