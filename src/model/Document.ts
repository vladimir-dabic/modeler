import { pruneGroups } from './groups';
import type { DocumentFile, Entity, EntityKind, Group, Unit } from './types';
import { DEFAULT_PRINTER_SETTING, type PrinterSetting, type WorkspaceId } from './workspaces';

export interface ChangeEvent {
  /** True when this change closed a transaction (and was recorded for undo). */
  committed: boolean;
}

/** Which document setting changed (settings are saved with the file but not undoable). */
export type SettingsChange = 'units' | 'workspace' | 'printer';

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

interface UndoEntry {
  snapshot: string;
  label?: string;
}

/**
 * The model: a flat list of entities and groups, plus selection, with snapshot undo.
 *
 * Edits happen inside a transaction: `begin()` remembers the state, any number of
 * mutations follow (each emits a non-committed change so the viewport updates live),
 * then `commit()` records one undo step or `cancel()` rolls everything back.
 * See ADR 0002. Most callers should go through the Modeler API (src/api) instead.
 */
export class ModelDocument {
  entities: Entity[] = [];
  groups: Group[] = [];
  readonly selection = new Set<string>();
  /** The group being edited ("opened"); clicks then pick parts inside it. UI state only. */
  openGroupId: string | null = null;
  units: Unit = 'mm';
  /** Document settings (not part of undo history), saved with the file. */
  workspace: WorkspaceId = 'print';
  printer: PrinterSetting = structuredClone(DEFAULT_PRINTER_SETTING);

  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private txSnapshot: string | null = null;
  private changeListeners = new Set<Listener<ChangeEvent>>();
  private selectionListeners = new Set<Listener<void>>();
  private settingsListeners = new Set<Listener<SettingsChange>>();
  /** Bumped on every change; cheap cache key for derived data. */
  version = 0;

  // ---- events -------------------------------------------------------------

  onChange(fn: Listener<ChangeEvent>): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  /** Selection or open-group context changed. */
  onSelectionChange(fn: Listener<void>): () => void {
    this.selectionListeners.add(fn);
    return () => this.selectionListeners.delete(fn);
  }

  onSettingsChange(fn: Listener<SettingsChange>): () => void {
    this.settingsListeners.add(fn);
    return () => this.settingsListeners.delete(fn);
  }

  private emitChange(committed: boolean) {
    this.version++;
    for (const fn of this.changeListeners) fn({ committed });
  }

  private emitSelection() {
    for (const fn of this.selectionListeners) fn();
  }

  private emitSettings(change: SettingsChange) {
    for (const fn of this.settingsListeners) fn(change);
  }

  // ---- queries ------------------------------------------------------------

  get(id: string): Entity | undefined {
    return this.entities.find((e) => e.id === id);
  }

  getGroup(id: string): Group | undefined {
    return this.groups.find((g) => g.id === id);
  }

  selected(): Entity[] {
    return this.entities.filter((e) => this.selection.has(e.id));
  }

  nextName(kind: EntityKind): string {
    return this.nextNameFor(KIND_LABEL[kind]);
  }

  /** "Base 1", "Base 2", … across entity and group names. */
  nextNameFor(base: string): string {
    let max = 0;
    const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`);
    for (const n of [...this.entities.map((e) => e.name), ...this.groups.map((g) => g.name)]) {
      const m = re.exec(n);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `${base} ${max + 1}`;
  }

  // ---- settings (saved, not undoable) -------------------------------------

  setUnits(units: Unit) {
    if (units === this.units) return;
    this.units = units;
    this.emitSettings('units');
  }

  setWorkspace(workspace: WorkspaceId) {
    if (workspace === this.workspace) return;
    this.workspace = workspace;
    this.emitSettings('workspace');
  }

  setPrinter(printer: PrinterSetting) {
    this.printer = structuredClone(printer);
    this.emitSettings('printer');
  }

  // ---- transactions -------------------------------------------------------

  get inTransaction(): boolean {
    return this.txSnapshot !== null;
  }

  begin(): void {
    if (this.txSnapshot === null) this.txSnapshot = this.snapshot();
  }

  /** Close the transaction; `label` names the undo step (e.g. "AI: add 4 shelves"). */
  commit(label?: string): void {
    if (this.txSnapshot === null) return;
    const before = this.txSnapshot;
    this.txSnapshot = null;
    if (this.snapshot() !== before) {
      this.undoStack.push({ snapshot: before, label });
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
  transact(fn: () => void, label?: string): void {
    const nested = this.inTransaction;
    this.begin();
    try {
      fn();
    } catch (err) {
      if (!nested) this.cancel();
      throw err;
    }
    if (!nested) this.commit(label);
  }

  /** Opaque state token; `rollback(token)` restores it (used for atomic API batches). */
  checkpoint(): string {
    return this.snapshot();
  }

  rollback(token: string): void {
    this.restore(token);
    this.emitChange(false);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Label of the step `undo()` would revert, if it has one. */
  get undoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label;
  }

  undo(): void {
    this.cancel();
    const prev = this.undoStack.pop();
    if (prev === undefined) return;
    this.redoStack.push({ snapshot: this.snapshot(), label: prev.label });
    this.restore(prev.snapshot);
    this.emitChange(true);
  }

  redo(): void {
    this.cancel();
    const next = this.redoStack.pop();
    if (next === undefined) return;
    this.undoStack.push({ snapshot: this.snapshot(), label: next.label });
    this.restore(next.snapshot);
    this.emitChange(true);
  }

  private snapshot(): string {
    return JSON.stringify({ entities: this.entities, groups: this.groups });
  }

  private restore(snapshot: string) {
    const state = JSON.parse(snapshot) as { entities: Entity[]; groups: Group[] };
    this.entities = state.entities;
    this.groups = state.groups;
    let selectionChanged = false;
    for (const id of [...this.selection]) {
      if (!this.get(id)) {
        this.selection.delete(id);
        selectionChanged = true;
      }
    }
    if (this.openGroupId && !this.getGroup(this.openGroupId)) {
      this.openGroupId = null;
      selectionChanged = true;
    }
    if (selectionChanged) this.emitSelection();
  }

  // ---- mutations (call inside a transaction for undo support) -------------

  add(entity: Entity): Entity {
    this.autoTx(() => this.entities.push(entity));
    return entity;
  }

  addGroup(group: Group): Group {
    this.autoTx(() => this.groups.push(group));
    return group;
  }

  /** Remove entities; groups left without members disappear too. */
  remove(ids: Iterable<string>): void {
    const set = new Set(ids);
    if (!set.size) return;
    this.autoTx(() => {
      this.entities = this.entities.filter((e) => !set.has(e.id));
      this.groups = pruneGroups(this.entities, this.groups);
    });
    let selectionChanged = false;
    for (const id of set) selectionChanged = this.selection.delete(id) || selectionChanged;
    if (this.openGroupId && !this.getGroup(this.openGroupId)) {
      this.openGroupId = null;
      selectionChanged = true;
    }
    if (selectionChanged) this.emitSelection();
  }

  /** Replace the group list (group/ungroup operations); empty groups are pruned. */
  setGroups(groups: Group[]): void {
    this.autoTx(() => {
      this.groups = pruneGroups(this.entities, groups);
    });
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

  // ---- selection & open group ---------------------------------------------

  setSelection(ids: Iterable<string>): void {
    const next = new Set(ids);
    if (next.size === this.selection.size && [...next].every((id) => this.selection.has(id))) return;
    this.selection.clear();
    for (const id of next) if (this.get(id)) this.selection.add(id);
    this.emitSelection();
  }

  toggleSelection(id: string): void {
    this.toggleSelectionMany([id]);
  }

  /** Toggle a whole unit (e.g. all members of a group) as one. */
  toggleSelectionMany(ids: string[]): void {
    const allSelected = ids.every((id) => this.selection.has(id));
    for (const id of ids) {
      if (allSelected) this.selection.delete(id);
      else if (this.get(id)) this.selection.add(id);
    }
    this.emitSelection();
  }

  clearSelection(): void {
    this.setSelection([]);
  }

  setOpenGroup(id: string | null): void {
    if (id === this.openGroupId) return;
    this.openGroupId = id && this.getGroup(id) ? id : null;
    this.emitSelection();
  }

  // ---- whole document -----------------------------------------------------

  toFile(): DocumentFile {
    const state = JSON.parse(this.snapshot()) as { entities: Entity[]; groups: Group[] };
    return {
      format: 'modeler',
      version: 1,
      units: this.units,
      workspace: this.workspace,
      printer: structuredClone(this.printer),
      entities: state.entities,
      groups: state.groups,
    };
  }

  /** Replace contents. Undoable (as `label`) unless `resetHistory` is set (used when opening a file). */
  load(file: DocumentFile, resetHistory: boolean, label?: string): void {
    this.cancel();
    this.units = file.units;
    if (file.workspace) this.workspace = file.workspace;
    if (file.printer) this.printer = structuredClone(file.printer);
    this.openGroupId = null;
    const groups = file.groups ?? [];
    if (resetHistory) {
      this.undoStack = [];
      this.redoStack = [];
      this.entities = file.entities;
      this.groups = groups;
      this.emitChange(true);
    } else {
      this.transact(() => {
        this.entities = file.entities;
        this.groups = groups;
      }, label);
    }
    this.clearSelection();
  }
}
