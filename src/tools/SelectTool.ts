import * as THREE from 'three';
import { dimensionGeometry, resolveAnchor } from '../model/annotations';
import { cleanVec, worldBoundsCorners } from '../model/geometry';
import { isInsideGroup, selectionUnitGroup } from '../model/groups';
import { openTextEditor, screenPlanePoint } from './AnnotationTools';
import { Tool, type ToolEvent } from './Tool';

/**
 * Click to select, ⌘/Ctrl-click to add/remove, drag a rectangle:
 * left→right selects objects fully inside, right→left anything it touches.
 *
 * Groups (ADR 0011): a click selects the whole group; double-click opens it so clicks pick
 * parts inside; clicking outside the open group (or Esc with nothing selected) closes it.
 */
export class SelectTool extends Tool {
  readonly id = 'select' as const;
  readonly label = 'Select';
  override readonly cursor = 'default';
  private down: { px: THREE.Vector2; add: boolean } | null = null;
  private rectEl: HTMLDivElement | null = null;
  private rectIds: string[] = [];
  /** An annotation pressed on: a click selects it, a drag moves its label / dimension line. */
  private annotationDrag: { id: string; px: THREE.Vector2; moving: boolean } | null = null;

  hint(): string {
    const open = this.doc.openGroupId ? this.doc.getGroup(this.doc.openGroupId) : null;
    if (open) return `Editing "${open.name}": click parts inside it. Click outside or press Esc to close the group.`;
    return 'Select: click an object (groups select as one; double-click to open), ⌘/Ctrl-click to add/remove, drag a box. Right-click for more.';
  }

  pointerDown(e: ToolEvent) {
    if (e.button !== 0) return;
    const ann = this.viewport.annotations.hitTest(e.px);
    if (ann) {
      if (e.mod) this.doc.selectAnnotations([ann], true);
      else if (!this.doc.annotationSelection.has(ann)) this.doc.selectAnnotations([ann]);
      this.annotationDrag = { id: ann, px: e.px.clone(), moving: false };
      return;
    }
    this.down = { px: e.px.clone(), add: e.mod };
  }

  /** Drag an annotation: a note's label moves freely, a dimension line slides sideways. */
  private dragAnnotation(e: ToolEvent) {
    const drag = this.annotationDrag!;
    if (!drag.moving) {
      if (e.px.distanceTo(drag.px) < 4) return;
      drag.moving = true;
      this.doc.begin();
    }
    const a = this.doc.getAnnotation(drag.id);
    const get = (id: string) => this.doc.get(id);
    if (!a) return;
    if (a.kind === 'note') {
      const anchor = resolveAnchor(a.anchor, get);
      const label = this.viewport.annotations.labelPoint(a.id) ?? anchor;
      const p = anchor && label && screenPlanePoint(this.viewport, e.px, label);
      if (!anchor || !p) return;
      const offset = p.sub(anchor).round();
      this.doc.updateAnnotation(a.id, (x) => (x.offset = cleanVec(offset)));
    } else {
      const g = dimensionGeometry(a, get);
      if (!g) return;
      const cam = this.viewport.camera.getWorldDirection(new THREE.Vector3());
      const n = cam.addScaledVector(g.dir, -cam.dot(g.dir));
      if (n.lengthSq() < 1e-9) return;
      const p = screenPlanePoint(this.viewport, e.px, g.a, n.normalize());
      if (!p) return;
      const off = p.sub(g.a);
      off.addScaledVector(g.dir, -off.dot(g.dir));
      const side = new THREE.Vector3(...a.offset);
      // Keep the side direction when it exists; only the distance changes.
      if (side.lengthSq() > 1e-9) {
        side.normalize();
        off.copy(side).multiplyScalar(this.ctx.snapper.round(off.dot(side)));
      }
      this.doc.updateAnnotation(a.id, (x) => (x.offset = cleanVec(off)));
    }
  }

  pointerMove(e: ToolEvent) {
    if (this.annotationDrag) {
      this.dragAnnotation(e);
      return;
    }
    if (!this.down) {
      const hit = this.viewport.pick(e.px);
      this.viewport.setHighlighted(hit ? this.unitOf(hit.entity) : []);
      return;
    }
    if (!this.rectEl && e.px.distanceTo(this.down.px) < 4) return;
    const x0 = Math.min(this.down.px.x, e.px.x);
    const x1 = Math.max(this.down.px.x, e.px.x);
    const y0 = Math.min(this.down.px.y, e.px.y);
    const y1 = Math.max(this.down.px.y, e.px.y);
    const crossing = e.px.x < this.down.px.x;
    if (!this.rectEl) {
      this.rectEl = document.createElement('div');
      this.viewport.container.appendChild(this.rectEl);
    }
    this.rectEl.className = `select-rect ${crossing ? 'crossing' : 'window'}`;
    Object.assign(this.rectEl.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
    // In the exploded view, parts are where they're drawn, not where they sit in the model.
    const corners = (e: Parameters<typeof worldBoundsCorners>[0]) => {
      const o = this.viewport.explodeOffset(e.id);
      return o ? worldBoundsCorners(e).map((p) => p.add(o)) : worldBoundsCorners(e);
    };
    this.rectIds = this.expandToUnits(this.viewport.entitiesInRect({ x0, y0, x1, y1 }, crossing ? 'crossing' : 'window', corners));
    this.viewport.setHighlighted(this.rectIds);
  }

  /** Rectangle hits → whole units; while a group is open, only parts inside it count. */
  private expandToUnits(ids: string[]): string[] {
    const open = this.doc.openGroupId;
    const out = new Set<string>();
    for (const id of ids) {
      const e = this.doc.get(id);
      if (!e || (open && !isInsideGroup(e, open, this.doc.groups))) continue;
      for (const u of this.unitOf(e)) out.add(u);
    }
    return [...out];
  }

  pointerUp(e: ToolEvent) {
    if (this.annotationDrag) {
      if (this.annotationDrag.moving) this.doc.commit('Move annotation');
      this.annotationDrag = null;
      return;
    }
    const down = this.down;
    this.down = null;
    if (!down || e.button !== 0) return;
    if (this.rectEl) {
      const ids = this.rectIds;
      this.clearRect();
      if (down.add) this.doc.setSelection([...this.doc.selection, ...ids]);
      else this.doc.setSelection(ids);
      return;
    }
    const hit = this.viewport.pick(e.px);
    const open = this.doc.openGroupId;
    if (hit && open && !isInsideGroup(hit.entity, open, this.doc.groups)) this.doc.setOpenGroup(null);
    if (hit) {
      const unit = this.unitOf(hit.entity);
      if (down.add) this.doc.toggleSelectionMany(unit);
      else this.doc.setSelection(unit);
    } else if (!down.add) {
      this.doc.clearSelection();
      if (open) this.doc.setOpenGroup(null);
    }
    this.updateHint();
  }

  doubleClick(e: ToolEvent) {
    const ann = this.viewport.annotations.hitTest(e.px);
    if (ann) {
      this.editAnnotation(ann);
      return;
    }
    const hit = this.viewport.pick(e.px);
    if (!hit) return;
    const g = selectionUnitGroup(hit.entity, this.doc.groups, this.doc.openGroupId);
    if (!g) return;
    this.doc.setOpenGroup(g);
    this.doc.setSelection(this.unitOf(hit.entity));
    this.updateHint();
  }

  /** Edit a note's text, or a dimension's text override, in place. */
  editAnnotation(id: string) {
    const a = this.doc.getAnnotation(id);
    const at = this.viewport.annotations.labelPoint(id);
    if (!a || !at) return;
    const initial = a.kind === 'note' ? a.text : (a.text ?? '');
    const placeholder = a.kind === 'note' ? 'Text' : 'Measured value (<> inserts it)';
    openTextEditor(this.viewport, at, initial, placeholder, (text) => {
      if (text === null || text === initial) return;
      if (a.kind === 'note' && !text.trim()) this.ctx.call('delete_annotations', { ids: [id] }, 'Delete text');
      else this.ctx.call('update_annotation', { id, text }, 'Edit text');
    });
  }

  private clearRect() {
    this.rectEl?.remove();
    this.rectEl = null;
    this.rectIds = [];
    this.viewport.setHighlighted([]);
  }

  override cancel() {
    if (this.annotationDrag?.moving) this.doc.cancel();
    this.annotationDrag = null;
    this.down = null;
    this.clearRect();
    super.cancel();
  }

  override deactivate() {
    super.deactivate();
    this.viewport.setHighlighted([]);
  }
}
