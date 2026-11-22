import { WORKSPACE_IDS, WORKSPACES, type WorkspaceId } from '../model/workspaces';
import { h } from './dom';
import { icon } from './icons';

/**
 * "What are you making?" (ADR 0023): New asks for the kind of project once, with one card
 * per workspace. The workspace can still be changed later from the badge next to the file
 * name, but it is a property of the project, not a mode you flip while working.
 */
export class NewProjectDialog {
  readonly el: HTMLDivElement;
  private onPick: ((id: WorkspaceId) => void) | null = null;

  constructor() {
    this.el = h('div', { class: 'modal-backdrop', hidden: true });
    this.el.addEventListener('pointerdown', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(current: WorkspaceId, pick: (id: WorkspaceId) => void) {
    this.onPick = pick;
    const cards = WORKSPACE_IDS.map((id) => {
      const ws = WORKSPACES[id];
      return h('button', { class: `np-card ${id === current ? 'current' : ''}`, 'data-workspace': id, onclick: () => this.pick(id) },
        h('span', { class: 'np-icon', html: icon(ws.icon, 30) }),
        h('strong', {}, ws.name),
        h('span', { class: 'np-tagline' }, ws.tagline),
      );
    });
    this.el.replaceChildren(
      h('div', { class: 'modal new-project', role: 'dialog', 'aria-label': 'New project' },
        h('div', { class: 'modal-head' },
          h('h2', {}, 'What are you making?'),
          h('button', { class: 'icon-btn', 'aria-label': 'Cancel', title: 'Cancel (Esc)', onclick: () => this.close() }, '×'),
        ),
        h('div', { class: 'np-cards' }, ...cards),
        h('p', { class: 'np-note' }, 'This sets units, snapping, panels and what Claude knows about materials. You can change it later from the badge next to the file name.'),
      ),
    );
    this.el.hidden = false;
    (this.el.querySelector(`[data-workspace="${current}"]`) as HTMLElement | null)?.focus();
  }

  close() {
    this.el.hidden = true;
    this.onPick = null;
  }

  private pick(id: WorkspaceId) {
    const fn = this.onPick;
    this.close();
    fn?.(id);
  }
}
