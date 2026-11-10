import type { DocumentFile, Entity, EntityKind, Unit } from './types';
import { DEFAULT_PRINTER_SETTING, type PrinterSetting, type WorkspaceId } from './workspaces';

export interface ChangeEvent {
  /** True when this change closed a transaction (and was recorded for undo). */
  committed: boolean;
}

type Listener<T> = (event: T) => void;

const MAX_UNDO = 200;

const KIND_LABEL: Record<EntityKind, string> = {
  box: 'Box',
  cylinder: 'Cylinder',
  extrusion: 'Shape',
};

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * The model: a flat list of entities plus selection, with snapshot-based undo.
 *
 * Edits happen inside a transaction: `begin()` remembers the state, any number of
 * mutations follow (each emits a non-committed change so the viewport updates live),
 * then `commit()` records one undo step or `cancel()` rolls everything back.
 */
export class ModelDocument {
  entities: Entity[] = [];
  readonly selection = new Set<string>();
  units: Unit = 'mm';
  /** Document settings (not part of undo history), saved with the file. */
  workspace: WorkspaceId = 'print';
  printer: PrinterSetting = structuredClone(DEFAULT_PRINTER_SETTING);

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private txSnapshot: string | null = null;
  private changeListeners = new Set<Listener<ChangeEvent>>();
  private selectionListeners = new Set<Listener<void>>();
  /** Bumped on every change; cheap cache key for derived data. */
  version = 0;

  // ---- events -------------------------------------------------------------

  onChange(fn: Listener<ChangeEvent>): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  onSelectionChange(fn: Listener<void>): () => void {
    this.selectionListeners.add(fn);
    return () => this.selectionListeners.delete(fn);
  }

  private emitChange(committed: boolean) {
    this.version++;
    for (const fn of this.changeListeners) fn({ committed });
  }

  private emitSelection() {
    for (const fn of this.selectionListeners) fn();
  }

  // ---- queries ------------------------------------------------------------

  get(id: string): Entity | undefined {
    return this.entities.find((e) => e.id === id);
  }

  selected(): Entity[] {
    return this.entities.filter((e) => this.selection.has(e.id));
  }

  nextName(kind: EntityKind): string {
    const base = KIND_LABEL[kind];
    let max = 0;
    const re = new RegExp(`^${base} (\\d+)$`);
    for (const e of this.entities) {
      const m = re.exec(e.name);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `${base} ${max + 1}`;
  }

  // ---- transactions -------------------------------------------------------

  get inTransaction(): boolean {
    return this.txSnapshot !== null;
  }

  begin(): void {
    if (this.txSnapshot === null) this.txSnapshot = this.snapshot();
  }

  commit(): void {
    if (this.txSnapshot === null) return;
    const before = this.txSnapshot;
    this.txSnapshot = null;
    if (this.snapshot() !== before) {
      this.undoStack.push(before);
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
      this.redoStack = [];
    }
    this.emitChange(true);
  }

  cancel(): void {
    if (this.txSnapshot === null) return;
    this.restore(this.txSnapshot);
    this.txSnapshot = null;
    this.emitChange(false);
  }

  /** Run `fn` as a single undo step (joins an open transaction if there is one). */
  transact(fn: () => void): void {
    const nested = this.inTransaction;
    this.begin();
    try {
      fn();
    } catch (err) {
      if (!nested) this.cancel();
      throw err;
    }
    if (!nested) this.commit();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    this.cancel();
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push(this.snapshot());
    this.restore(prev);
    this.emitChange(true);
  }

  redo(): void {
    this.cancel();
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push(this.snapshot());
    this.restore(next);
    this.emitChange(true);
  }

  private snapshot(): string {
    return JSON.stringify(this.entities);
  }

  private restore(snapshot: string) {
    this.entities = JSON.parse(snapshot);
    let selectionChanged = false;
    for (const id of [...this.selection]) {
      if (!this.get(id)) {
        this.selection.delete(id);
        selectionChanged = true;
      }
    }
    if (selectionChanged) this.emitSelection();
  }

  // ---- mutations (call inside a transaction for undo support) -------------

  add(entity: Entity): Entity {
    this.autoTx(() => this.entities.push(entity));
    return entity;
  }

  remove(ids: Iterable<string>): void {
    const set = new Set(ids);
    if (!set.size) return;
    this.autoTx(() => {
      this.entities = this.entities.filter((e) => !set.has(e.id));
    });
    let selectionChanged = false;
    for (const id of set) selectionChanged = this.selection.delete(id) || selectionChanged;
    if (selectionChanged) this.emitSelection();
  }

  /** Mutate an entity in place. */
  update(id: string, mutate: (e: Entity) => void): void {
    const e = this.get(id);
    if (!e) return;
    this.autoTx(() => mutate(e));
  }

  /** Signal that entities were mutated directly (e.g. by a tool during a drag). */
  touch(): void {
    this.emitChange(false);
  }

  private autoTx(fn: () => void) {
    if (this.inTransaction) {
      fn();
      this.emitChange(false);
    } else {
      this.begin();
      fn();
      this.commit();
    }
  }

  // ---- selection ----------------------------------------------------------

  setSelection(ids: Iterable<string>): void {
    const next = new Set(ids);
    if (next.size === this.selection.size && [...next].every((id) => this.selection.has(id))) return;
    this.selection.clear();
    for (const id of next) if (this.get(id)) this.selection.add(id);
    this.emitSelection();
  }

  toggleSelection(id: string): void {
    if (this.selection.has(id)) this.selection.delete(id);
    else this.selection.add(id);
    this.emitSelection();
  }

  clearSelection(): void {
    this.setSelection([]);
  }

  // ---- whole document -----------------------------------------------------

  toFile(): DocumentFile {
    return {
      format: 'modeler',
      version: 1,
      units: this.units,
      workspace: this.workspace,
      printer: structuredClone(this.printer),
      entities: JSON.parse(this.snapshot()),
    };
  }

  /** Replace contents. Undoable unless `resetHistory` is set (used when opening a file). */
  load(file: DocumentFile, resetHistory: boolean): void {
    this.cancel();
    this.units = file.units;
    if (file.workspace) this.workspace = file.workspace;
    if (file.printer) this.printer = structuredClone(file.printer);
    if (resetHistory) {
      this.undoStack = [];
      this.redoStack = [];
      this.entities = file.entities;
      this.emitChange(true);
    } else {
      this.transact(() => {
        this.entities = file.entities;
      });
    }
    this.clearSelection();
  }
}
