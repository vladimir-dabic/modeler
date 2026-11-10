import * as THREE from 'three';
import { worldBoundsCorners } from '../model/geometry';
import { isInsideGroup, selectionUnitGroup } from '../model/groups';
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

  hint(): string {
    const open = this.doc.openGroupId ? this.doc.getGroup(this.doc.openGroupId) : null;
    if (open) return `Editing "${open.name}": click parts inside it. Click outside or press Esc to close the group.`;
    return 'Select: click an object (groups select as one; double-click to open), ⌘/Ctrl-click to add/remove, drag a box. Right-click for more.';
  }

  pointerDown(e: ToolEvent) {
    if (e.button !== 0) return;
    this.down = { px: e.px.clone(), add: e.mod };
  }

  pointerMove(e: ToolEvent) {
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
    this.rectIds = this.expandToUnits(this.viewport.entitiesInRect({ x0, y0, x1, y1 }, crossing ? 'crossing' : 'window', worldBoundsCorners));
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
    const hit = this.viewport.pick(e.px);
    if (!hit) return;
    const g = selectionUnitGroup(hit.entity, this.doc.groups, this.doc.openGroupId);
    if (!g) return;
    this.doc.setOpenGroup(g);
    this.doc.setSelection(this.unitOf(hit.entity));
    this.updateHint();
  }

  private clearRect() {
    this.rectEl?.remove();
    this.rectEl = null;
    this.rectIds = [];
    this.viewport.setHighlighted([]);
  }

  override cancel() {
    this.down = null;
    this.clearRect();
    super.cancel();
  }

  override deactivate() {
    super.deactivate();
    this.viewport.setHighlighted([]);
  }
}
