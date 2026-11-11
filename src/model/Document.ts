import { pruneGroups } from './groups';
import { pruneAnnotations } from './annotations';
import type { Annotation, DocumentFile, DrawingGeometry, Entity, EntityKind, Group, ReferenceDrawing, ReferenceFile, Unit } from './types';
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
  sphere: 'Sphere',
  revolve: 'Revolve',
  tube: 'Tube',
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
  /** Notes and dimensions (ADR 0015), attached to parts; never geometry. */
  annotations: Annotation[] = [];
  /** Selected annotations. UI state; exclusive with the part selection. */
  readonly annotationSelection = new Set<string>();
  /** Reference drawings (ADR 0014): traced and snapped to, never part of the model. */
  references: ReferenceDrawing[] = [];
  /**
   * Their immutable line geometry by reference id. Kept out of undo snapshots (only the
   * small metadata is snapshotted), and not pruned on delete so undo can bring it back.
   */
  private readonly drawingGeometry = new Map<string, DrawingGeometry>();
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

  getAnnotation(id: string): Annotation | undefined {
    return this.annotations.find((a) => a.id === id);
  }

  getReference(id: string): ReferenceDrawing | undefined {
    return this.references.find((r) => r.id === id);
  }

  /** Line geometry of a reference drawing. */
  geometryOf(id: string): DrawingGeometry | undefined {
    return this.drawingGeometry.get(id);
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
    return JSON.stringify({ entities: this.entities, groups: this.groups, references: this.references, annotations: this.annotations });
  }

  private restore(snapshot: string) {
    const state = JSON.parse(snapshot) as { entities: Entity[]; groups: Group[]; references: ReferenceDrawing[]; annotations: Annotation[] };
    this.entities = state.entities;
    this.groups = state.groups;
    this.references = state.references;
    this.annotations = state.annotations;
    let selectionChanged = false;
    for (const id of [...this.annotationSelection]) {
      if (!this.getAnnotation(id)) {
        this.annotationSelection.delete(id);
        selectionChanged = true;
      }
    }
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
      // Annotations attached to deleted parts go with them (ADR 0015).
      this.annotations = pruneAnnotations(this.annotations, (id) => this.get(id));
    });
    for (const id of [...this.annotationSelection]) if (!this.getAnnotation(id)) this.annotationSelection.delete(id);
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

  addAnnotation(a: Annotation): Annotation {
    this.autoTx(() => this.annotations.push(a));
    return a;
  }

  updateAnnotation(id: string, mutate: (a: Annotation) => void): void {
    const a = this.getAnnotation(id);
    if (!a) return;
    this.autoTx(() => mutate(a));
  }

  removeAnnotations(ids: Iterable<string>): void {
    const set = new Set(ids);
    if (!set.size) return;
    this.autoTx(() => {
      this.annotations = this.annotations.filter((a) => !set.has(a.id));
    });
    let changed = false;
    for (const id of set) changed = this.annotationSelection.delete(id) || changed;
    if (changed) this.emitSelection();
  }

  /** Add a reference drawing with its (immutable) geometry. */
  addReference(ref: ReferenceDrawing, geometry: DrawingGeometry): ReferenceDrawing {
    this.drawingGeometry.set(ref.id, geometry);
    this.autoTx(() => this.references.push(ref));
    return ref;
  }

  /** Mutate a reference drawing's metadata (name, units, placement, visibility). */
  updateReference(id: string, mutate: (r: ReferenceDrawing) => void): void {
    const r = this.getReference(id);
    if (!r) return;
    this.autoTx(() => mutate(r));
  }

  removeReference(id: string): void {
    if (!this.getReference(id)) return;
    this.autoTx(() => {
      this.references = this.references.filter((r) => r.id !== id);
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
    const hadAnnotations = this.annotationSelection.size > 0;
    this.annotationSelection.clear();
    if (next.size === this.selection.size && [...next].every((id) => this.selection.has(id))) {
      if (hadAnnotations) this.emitSelection();
      return;
    }
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

  /** Select annotations (clears the part selection; the two are exclusive). */
  selectAnnotations(ids: Iterable<string>, add = false): void {
    if (!add) this.annotationSelection.clear();
    for (const id of ids) {
      if (!this.getAnnotation(id)) continue;
      if (add && this.annotationSelection.has(id)) this.annotationSelection.delete(id);
      else this.annotationSelection.add(id);
    }
    this.selection.clear();
    this.emitSelection();
  }

  setOpenGroup(id: string | null): void {
    if (id === this.openGroupId) return;
    this.openGroupId = id && this.getGroup(id) ? id : null;
    this.emitSelection();
  }

  // ---- whole document -----------------------------------------------------

  toFile(): DocumentFile {
    const state = JSON.parse(this.snapshot()) as { entities: Entity[]; groups: Group[]; references: ReferenceDrawing[]; annotations: Annotation[] };
    const references: ReferenceFile[] = state.references.map((r) => ({ ...r, geometry: this.drawingGeometry.get(r.id) ?? { layers: [], paths: [] } }));
    return {
      format: 'modeler',
      version: 1,
      units: this.units,
      workspace: this.workspace,
      printer: structuredClone(this.printer),
      entities: state.entities,
      groups: state.groups,
      ...(references.length ? { references } : {}),
      ...(state.annotations.length ? { annotations: state.annotations } : {}),
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
    if (resetHistory) this.drawingGeometry.clear();
    // Geometry of replaced references stays in the map, so undoing this load restores them.
    const references = (file.references ?? []).map(({ geometry, ...meta }) => {
      this.drawingGeometry.set(meta.id, geometry);
      return meta;
    });
    if (resetHistory) {
      this.undoStack = [];
      this.redoStack = [];
      this.entities = file.entities;
      this.groups = groups;
      this.references = references;
      this.annotations = file.annotations ?? [];
      this.emitChange(true);
    } else {
      this.transact(() => {
        this.entities = file.entities;
        this.groups = groups;
        this.references = references;
        this.annotations = file.annotations ?? [];
      }, label);
    }
    this.clearSelection();
  }
}
