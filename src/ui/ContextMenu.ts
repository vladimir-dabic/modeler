import { h } from './dom';

export type MenuItem = { label: string; shortcut?: string; danger?: boolean; run: () => void } | 'separator';

/**
 * A small right-click menu (ADR 0012). Items are built by App from commands, so they
 * show the current shortcut and run the same code as the keyboard and the AI.
 * Keyboard: ↑/↓ move, Enter runs, Esc closes.
 */
export class ContextMenu {
  readonly el: HTMLDivElement;
  isOpen = false;

  constructor() {
    this.el = h('div', { class: 'context-menu', role: 'menu', hidden: true });
    document.body.appendChild(this.el);
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (this.isOpen && !this.el.contains(e.target as Node)) this.close();
      },
      true,
    );
    window.addEventListener('blur', () => this.close());
    window.addEventListener('resize', () => this.close());
    window.addEventListener('wheel', () => this.close(), { passive: true });
    window.addEventListener('keydown', (e) => this.onKey(e), true);
  }

  open(clientX: number, clientY: number, items: MenuItem[]) {
    const cleaned = items.filter((it, i, arr) => it !== 'separator' || (i > 0 && i < arr.length - 1 && arr[i - 1] !== 'separator'));
    if (!cleaned.length) return;
    this.el.replaceChildren(
      ...cleaned.map((item) =>
        item === 'separator'
          ? h('div', { class: 'cm-sep', role: 'separator' })
          : h('button', {
              class: `cm-item ${item.danger ? 'danger' : ''}`,
              role: 'menuitem',
              onclick: () => {
                this.close();
                item.run();
              },
            },
              h('span', {}, item.label),
              item.shortcut ? h('kbd', {}, item.shortcut) : null,
            ),
      ),
    );
    this.el.hidden = false;
    this.isOpen = true;
    // Keep the menu on screen.
    const { width, height } = this.el.getBoundingClientRect();
    const x = Math.min(clientX, window.innerWidth - width - 4);
    const y = Math.min(clientY, window.innerHeight - height - 4);
    this.el.style.left = `${Math.max(4, x)}px`;
    this.el.style.top = `${Math.max(4, y)}px`;
    this.buttons()[0]?.focus({ preventScroll: true });
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.hidden = true;
  }

  private buttons(): HTMLButtonElement[] {
    return [...this.el.querySelectorAll<HTMLButtonElement>('.cm-item')];
  }

  private onKey(e: KeyboardEvent) {
    if (!this.isOpen) return;
    const buttons = this.buttons();
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') this.close();
    else if (e.key === 'ArrowDown') buttons[(at + 1) % buttons.length]?.focus();
    else if (e.key === 'ArrowUp') buttons[(at - 1 + buttons.length) % buttons.length]?.focus();
    else if (e.key === 'Enter' && at >= 0) buttons[at].click();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
}
