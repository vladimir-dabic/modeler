import { downloadBlob, pickFile } from '../model/io';

/**
 * Project files in the browser (ADR 0016). Where the File System Access API exists
 * (Chrome, Edge), Save writes back to the file that was opened or saved, and the file
 * handles are remembered (IndexedDB) for "Open recent" and across reloads. Elsewhere,
 * Save downloads a copy and Open uses a file input.
 */

/** The parts of the File System Access API we use (not in every TS DOM lib). */
interface Writable {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}
export interface FileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<Writable>;
  queryPermission?(opts: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(opts: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  isSameEntry?(other: FileHandle): Promise<boolean>;
}
interface PickerWindow {
  showOpenFilePicker?(opts: object): Promise<FileHandle[]>;
  showSaveFilePicker?(opts: object): Promise<FileHandle>;
}

export interface RecentFile {
  name: string;
  handle: FileHandle;
  at: number;
}

export interface OpenedFile {
  name: string;
  text: string;
  handle: FileHandle | null;
}

export type SaveResult = 'saved' | 'downloaded' | 'cancelled';

const EXT = '.modeler.json';
const PICKER_TYPES = [{ description: 'Modeler project', accept: { 'application/json': ['.json'] } }];
const MAX_RECENT = 8;

/** "kitchen.modeler.json" → "kitchen". */
export function baseName(fileName: string): string {
  return fileName.replace(/(\.modeler)?\.json$/i, '') || 'Untitled';
}

export class ProjectFiles {
  /** The file being edited: its name (without extension) and handle, if it has one. */
  name = 'Untitled';
  handle: FileHandle | null = null;

  constructor(private readonly win: PickerWindow = window as unknown as PickerWindow) {}

  /** True where Save can write back to the opened file. */
  get canSaveInPlace(): boolean {
    return typeof this.win.showSaveFilePicker === 'function';
  }

  get fileName(): string {
    return this.handle?.name ?? `${this.name}${EXT}`;
  }

  /** Forget the current file (New model). */
  reset(name = 'Untitled') {
    this.name = name;
    this.handle = null;
    void this.storeCurrent();
  }

  /** Ask for a project file. Null if cancelled. */
  async open(): Promise<OpenedFile | null> {
    if (typeof this.win.showOpenFilePicker === 'function') {
      let handles: FileHandle[];
      try {
        handles = await this.win.showOpenFilePicker({ types: PICKER_TYPES, id: 'modeler-projects', multiple: false });
      } catch (err) {
        if (isAbort(err)) return null;
        throw err;
      }
      return this.read(handles[0]);
    }
    const file = await pickFile('.json,application/json');
    return file ? { name: file.name, text: await file.text(), handle: null } : null;
  }

  /** Read a handle (from the picker, a drop or the recent list), asking for permission if needed. */
  async read(handle: FileHandle): Promise<OpenedFile> {
    if (!(await ensurePermission(handle, 'read'))) throw new Error(`No permission to read ${handle.name}`);
    const file = await handle.getFile();
    return { name: file.name, text: await file.text(), handle };
  }

  /** The file is now the current one (after it was opened and loaded). */
  async adopt(opened: OpenedFile) {
    this.name = baseName(opened.name);
    this.handle = opened.handle;
    if (opened.handle) await this.addRecent(opened.handle);
    await this.storeCurrent();
  }

  /**
   * Save. Writes back to the current file when possible; `saveAs` (or no current file)
   * asks for a new one. Without the File System Access API, downloads a copy.
   */
  async save(text: string, saveAs = false): Promise<SaveResult> {
    if (!this.canSaveInPlace) {
      downloadBlob(text, `${this.name}${EXT}`, 'application/json');
      return 'downloaded';
    }
    let handle = saveAs ? null : this.handle;
    if (handle && !(await ensurePermission(handle, 'readwrite'))) handle = null;
    if (!handle) {
      try {
        handle = await this.win.showSaveFilePicker!({ suggestedName: `${this.name}${EXT}`, types: PICKER_TYPES, id: 'modeler-projects' });
      } catch (err) {
        if (isAbort(err)) return 'cancelled';
        throw err;
      }
    }
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    this.handle = handle;
    this.name = baseName(handle.name);
    await this.addRecent(handle);
    await this.storeCurrent();
    return 'saved';
  }

  // ---- recent files and the current file across reloads (IndexedDB) ------------------------

  async recent(): Promise<RecentFile[]> {
    return ((await idbGet<RecentFile[]>('recent')) ?? []).filter((r) => r && r.handle && r.name);
  }

  async clearRecent() {
    await idbSet('recent', []);
  }

  private async addRecent(handle: FileHandle) {
    const list = await this.recent();
    const rest: RecentFile[] = [];
    for (const r of list) if (!(await sameEntry(r.handle, handle))) rest.push(r);
    await idbSet('recent', [{ name: handle.name, handle, at: Date.now() }, ...rest].slice(0, MAX_RECENT));
  }

  /** Remember which file the autosaved model belongs to. */
  private async storeCurrent() {
    await idbSet('current', { name: this.name, handle: this.handle });
  }

  /** After a reload restored the autosave: reconnect to its file (permission is asked on the next save). */
  async restoreCurrent(): Promise<void> {
    const cur = await idbGet<{ name: string; handle: FileHandle | null }>('current');
    if (!cur) return;
    this.name = typeof cur.name === 'string' && cur.name ? cur.name : 'Untitled';
    this.handle = cur.handle ?? null;
  }
}

function isAbort(err: unknown): boolean {
  return (err as { name?: string })?.name === 'AbortError';
}

async function ensurePermission(handle: FileHandle, mode: 'read' | 'readwrite'): Promise<boolean> {
  if (!handle.queryPermission) return true;
  if ((await handle.queryPermission({ mode })) === 'granted') return true;
  return (await handle.requestPermission?.({ mode })) === 'granted';
}

async function sameEntry(a: FileHandle, b: FileHandle): Promise<boolean> {
  if (a === b) return true;
  try {
    return a.isSameEntry ? await a.isSameEntry(b) : a.name === b.name;
  } catch {
    return false;
  }
}

// ---- a tiny IndexedDB key/value store; best-effort (private windows may block it) ------------

const DB = 'modeler';
const STORE = 'files';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      // A handle that can't be cloned (e.g. a test fake) is simply not remembered.
      resolve();
    }
  });
}
