import * as THREE from 'three';
import { worldBoundsCorners } from '../model/geometry';
import { Tool, type ToolEvent } from './Tool';

/**
 * Click to select, ⌘/Ctrl-click to add/remove, drag a rectangle:
 * left→right selects objects fully inside, right→left anything it touches.
 */
export class SelectTool extends Tool {
  readonly id = 'select' as const;
  readonly label = 'Select';
  override readonly cursor = 'default';
  private down: { px: THREE.Vector2; add: boolean } | null = null;
  private rectEl: HTMLDivElement | null = null;
  private rectIds: string[] = [];

  hint(): string {
    return 'Select: click an object, ⌘/Ctrl-click to add/remove, drag a box (→ inside only, ← touching). Delete removes.';
  }

  pointerDown(e: ToolEvent) {
    if (e.button !== 0) return;
    this.down = { px: e.px.clone(), add: e.mod };
  }

  pointerMove(e: ToolEvent) {
    if (!this.down) {
      const hit = this.viewport.pick(e.px);
      this.viewport.setHover(hit?.entity.id ?? null);
      return;
    }
    if (!this.rectEl && e.px.distanceTo(this.down.px) < 4) return;
    this.viewport.setHover(null);
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
    this.rectIds = this.viewport.entitiesInRect({ x0, y0, x1, y1 }, crossing ? 'crossing' : 'window', worldBoundsCorners);
    this.viewport.setHighlighted(this.rectIds);
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
    if (hit) {
      if (down.add) this.doc.toggleSelection(hit.entity.id);
      else this.doc.setSelection([hit.entity.id]);
    } else if (!down.add) {
      this.doc.clearSelection();
    }
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
}
