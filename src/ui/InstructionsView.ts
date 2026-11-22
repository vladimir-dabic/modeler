import type * as THREE from 'three';
import { resolveInstructions, type InstructionsLanguage, type PartType, type ResolvedInstructions, type ResolvedStep } from '../model/instructions';
import type { ModelDocument } from '../model/Document';
import { formatLength } from '../model/units';
import { InstructionImages } from '../viewport/InstructionImages';
import { h } from './dom';

/**
 * The build-instructions booklet (ADR 0021): A4 pages over the app, printed or saved as PDF
 * with the browser's print dialog. Cover, parts (lettered, with pictures), cut list, then
 * the steps, two per page. Title, intro and step texts can be edited in place; every edit
 * goes through the API (`set_instructions`) as one undo step.
 */

const STRINGS = {
  en: {
    booklet: 'Build instructions',
    size: 'Overall size',
    partsCount: (n: number) => `${n} part${n === 1 ? '' : 's'}`,
    parts: 'Parts',
    cutList: 'Cut list',
    cutListNote: 'Sizes are finished sizes. Thickness × width × length.',
    letter: 'Part',
    name: 'Name',
    qty: 'Qty',
    thickness: 'Thickness',
    width: 'Width',
    length: 'Length',
    colour: 'Colour',
    material: 'Material',
    banding: 'Edge banding',
    bandingText: (long: number, short: number) => [long ? `${long} long` : '', short ? `${short} short` : ''].filter(Boolean).join(', '),
    step: 'Step',
    add: (count: number, letter: string, name: string) => `Add ${count} × ${letter} (${name}).`,
    done: 'Done!',
    doneText: 'Check that everything is tight and square.',
    suggested: 'Steps are suggested from the model. Click a text to change it, or ask Claude to write the steps.',
    print: 'Print / Save PDF',
    close: 'Close',
    editHint: 'Click to edit',
    introPlaceholder: 'Add a short description…',
    stepPlaceholder: 'Add an explanation…',
    page: (n: number, total: number) => `${n} / ${total}`,
  },
  sr: {
    booklet: 'Uputstvo za izradu',
    size: 'Ukupne mere',
    partsCount: (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'deo' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'dela' : 'delova'}`,
    parts: 'Delovi',
    cutList: 'Krojna lista',
    cutListNote: 'Mere su gotove mere. Debljina × širina × dužina.',
    letter: 'Deo',
    name: 'Naziv',
    qty: 'Kom.',
    thickness: 'Debljina',
    width: 'Širina',
    length: 'Dužina',
    colour: 'Boja',
    material: 'Materijal',
    banding: 'Kant',
    bandingText: (long: number, short: number) => [long ? `${long} ${long === 1 ? 'duža' : 'duže'}` : '', short ? `${short} ${short === 1 ? 'kraća' : 'kraće'}` : ''].filter(Boolean).join(', '),
    step: 'Korak',
    add: (count: number, letter: string, name: string) => `Postavite ${count} × ${letter} (${name}).`,
    done: 'Gotovo!',
    doneText: 'Proverite da je sve čvrsto i pod pravim uglom.',
    suggested: 'Koraci su predloženi iz modela. Kliknite na tekst da ga promenite, ili zamolite Claude-a da napiše korake.',
    print: 'Štampaj / Sačuvaj PDF',
    close: 'Zatvori',
    editHint: 'Kliknite za izmenu',
    introPlaceholder: 'Dodajte kratak opis…',
    stepPlaceholder: 'Dodajte objašnjenje…',
    page: (n: number, total: number) => `${n} / ${total}`,
  },
} satisfies Record<InstructionsLanguage, unknown>;

export interface InstructionsHost {
  doc: ModelDocument;
  renderer: THREE.WebGLRenderer;
  /** The project's name, the title until one is set. */
  name(): string;
  call(name: string, input: unknown, label?: string): boolean;
}

export class InstructionsView {
  private root: HTMLElement | null = null;
  private images: InstructionImages | null = null;
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !(e.target instanceof HTMLElement && e.target.isContentEditable)) this.close();
  };

  constructor(private readonly host: InstructionsHost) {}

  get isOpen(): boolean {
    return !!this.root;
  }

  open() {
    this.close();
    this.root = h('div', { class: 'ins-overlay', role: 'dialog', 'aria-label': 'Build instructions' });
    document.body.append(this.root);
    document.body.classList.add('ins-open');
    window.addEventListener('keydown', this.onKey);
    this.render();
  }

  close() {
    if (!this.root) return;
    this.root.remove();
    this.root = null;
    this.images?.dispose();
    this.images = null;
    document.body.classList.remove('ins-open');
    window.removeEventListener('keydown', this.onKey);
  }

  /** Re-render after a model change (e.g. Claude rewrote the steps). */
  refresh() {
    if (this.root) this.render();
  }

  private render() {
    const root = this.root!;
    const { doc } = this.host;
    const r = resolveInstructions(doc.entities, doc.instructions, this.host.name());
    const t = STRINGS[r.language];
    const scroll = root.querySelector('.ins-pages')?.scrollTop ?? 0;

    const language = h('select', { class: 'select', 'aria-label': 'Language' },
      h('option', { value: 'en', selected: r.language === 'en' }, 'English'),
      h('option', { value: 'sr', selected: r.language === 'sr' }, 'Srpski'),
    );
    language.addEventListener('change', () => this.host.call('set_instructions', { language: language.value }, 'Instructions language'));
    const toolbar = h('div', { class: 'ins-toolbar' },
      h('strong', {}, t.booklet),
      h('span', { class: 'ins-spacer' }),
      language,
      h('button', { class: 'btn primary', onclick: () => window.print() }, t.print),
      h('button', { class: 'btn', onclick: () => this.close() }, t.close),
    );

    const pages = h('div', { class: 'ins-pages' });
    if (!r.parts.length) {
      pages.append(h('section', { class: 'ins-page' }, h('p', { class: 'ins-empty' }, 'Add some parts to the model first.')));
      root.replaceChildren(toolbar, pages);
      return;
    }

    this.images?.dispose();
    this.images = new InstructionImages(this.host.renderer, doc.entities, doc.groups);
    const partImages = new Map(r.parts.map((p) => [p.letter, this.images!.part(p, 220, 150)]));
    const letterOf = new Map<string, string>();
    for (const p of r.parts) for (const id of p.ids) letterOf.set(id, p.letter);

    const list: HTMLElement[] = [this.cover(r, t), this.partsPage(r, t, partImages)];
    for (let i = 0; i < r.steps.length; i += 2) {
      list.push(h('section', { class: 'ins-page ins-steps' }, ...r.steps.slice(i, i + 2).map((s) => this.stepCard(s, r, t, partImages, letterOf))));
    }
    list.push(h('section', { class: 'ins-page ins-done' },
      h('h2', {}, t.done),
      h('img', { class: 'ins-hero', src: this.images.overview(640, 460), alt: '' }),
      h('p', {}, t.doneText),
    ));
    list.forEach((page, i) => page.append(h('footer', { class: 'ins-folio' }, h('span', {}, r.title), h('span', {}, t.page(i + 1, list.length)))));
    pages.append(...list);
    root.replaceChildren(toolbar, pages);
    pages.scrollTop = scroll;
  }

  private cover(r: ResolvedInstructions, t: (typeof STRINGS)['en']): HTMLElement {
    const units = this.host.doc.units;
    const [x, y, z] = r.size;
    const title = this.editable('h1', r.title, '', (text) => this.host.call('set_instructions', { title: text || this.host.name() }, 'Instructions title'));
    const intro = this.editable('p', r.intro ?? '', t.introPlaceholder, (text) => this.host.call('set_instructions', { intro: text || null }, 'Instructions intro'));
    intro.classList.add('ins-intro');
    return h('section', { class: 'ins-page ins-cover' },
      h('div', { class: 'ins-kicker' }, t.booklet),
      title,
      intro,
      h('img', { class: 'ins-hero', src: this.images!.overview(640, 520), alt: '' }),
      h('div', { class: 'ins-facts' },
        h('div', {}, h('span', {}, t.size), h('strong', {}, `${formatLength(x, units, false)} × ${formatLength(y, units, false)} × ${formatLength(z, units)}`)),
        h('div', {}, h('span', {}, t.parts), h('strong', {}, t.partsCount(r.parts.reduce((n, p) => n + p.quantity, 0)))),
      ),
      r.suggested ? h('p', { class: 'ins-note no-print' }, t.suggested) : null,
    );
  }

  private partsPage(r: ResolvedInstructions, t: (typeof STRINGS)['en'], images: Map<string, string>): HTMLElement {
    const units = this.host.doc.units;
    const dims = (p: PartType) => p.dims.map((d) => formatLength(d, units, false)).join(' × ');
    const grid = h('div', { class: 'ins-parts' },
      ...r.parts.map((p) => h('div', { class: 'ins-part' },
        h('div', { class: 'ins-part-head' }, h('span', { class: 'ins-letter' }, p.letter), h('span', { class: 'ins-qty' }, `× ${p.quantity}`)),
        h('img', { src: images.get(p.letter)!, alt: '' }),
        h('div', { class: 'ins-part-name' }, p.name),
        h('div', { class: 'ins-part-dims' }, `${dims(p)} ${units}`),
        p.material || p.finish ? h('div', { class: 'ins-part-dims' }, [p.material, p.finish].filter(Boolean).join(' · ')) : null,
      )),
    );
    const withMaterial = r.parts.some((p) => p.material);
    const withBanding = r.parts.some((p) => p.banding);
    const band = (p: PartType) => (p.banding ? `${t.bandingText(p.banding.long, p.banding.short)}${p.banding.thickness ? ` · ${p.banding.thickness} mm` : ''}` : '');
    const head = h('tr', {}, ...[t.letter, t.name, t.qty, `${t.thickness} (${units})`, `${t.width} (${units})`, `${t.length} (${units})`, ...(withMaterial ? [t.material] : []), ...(withBanding ? [t.banding] : []), t.colour].map((c) => h('th', {}, c)));
    const rows = r.parts.map((p) => h('tr', {},
      h('td', {}, h('span', { class: 'ins-letter small' }, p.letter)),
      h('td', {}, p.name),
      h('td', { class: 'num' }, String(p.quantity)),
      ...p.dims.map((d) => h('td', { class: 'num' }, formatLength(d, units, false))),
      withMaterial ? h('td', {}, p.material ?? '') : null,
      withBanding ? h('td', {}, band(p)) : null,
      h('td', {}, h('span', { class: 'ins-swatch', style: `background:${p.color}` })),
    ));
    return h('section', { class: 'ins-page' },
      h('h2', {}, t.parts),
      grid,
      h('h2', {}, t.cutList),
      h('table', { class: 'ins-table' }, h('thead', {}, head), h('tbody', {}, ...rows)),
      h('p', { class: 'ins-small' }, t.cutListNote),
    );
  }

  private stepCard(s: ResolvedStep, r: ResolvedInstructions, t: (typeof STRINGS)['en'], images: Map<string, string>, letterOf: Map<string, string>): HTMLElement {
    const byLetter = new Map(r.parts.map((p) => [p.letter, p]));
    const fallback = s.letters.map((l) => t.add(l.count, l.letter, byLetter.get(l.letter)!.name)).join(' ');
    const text = this.editable('p', s.text ?? '', fallback || t.stepPlaceholder, (value) => this.saveStepText(r, s.number, value), !s.text);
    text.classList.add('ins-step-text');
    return h('article', { class: s.add.length ? 'ins-step' : 'ins-step text-only' },
      h('div', { class: 'ins-step-head' },
        h('span', { class: 'ins-step-no' }, String(s.number)),
        h('div', { class: 'ins-need' },
          ...s.letters.map((l) => h('div', { class: 'ins-chip' },
            h('img', { src: images.get(l.letter)!, alt: '' }),
            h('span', {}, `${l.count} ×`),
            h('span', { class: 'ins-letter small' }, l.letter),
          )),
        ),
      ),
      s.add.length ? h('img', { class: 'ins-step-img', src: this.images!.step(s, letterOf, 640, 330), alt: `${t.step} ${s.number}` }) : null,
      text,
    );
  }

  /** Editing one step's text stores the whole (possibly suggested) step list. */
  private saveStepText(r: ResolvedInstructions, number: number, value: string) {
    const steps = r.steps.map((s) => {
      const text = s.number === number ? value : s.text;
      return { ...(s.add.length ? { parts: { ids: s.add } } : {}), ...(text ? { text } : {}) };
    }).filter((s) => 'parts' in s || 'text' in s);
    if (steps.length) this.host.call('set_instructions', { steps }, `Step ${number} text`);
  }

  /** Text edited in place; saved on blur or Enter, Escape reverts. Shows a placeholder when empty. */
  private editable(tag: 'h1' | 'p', value: string, placeholder: string, save: (text: string) => void, showPlaceholderAsText = false): HTMLElement {
    const el = h(tag, { class: 'ins-edit', contenteditable: 'plaintext-only', spellcheck: 'false', title: 'Click to edit', 'data-placeholder': placeholder }, value);
    if (!value && showPlaceholderAsText) el.classList.add('ins-auto');
    el.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        el.blur();
      } else if (e.key === 'Escape') {
        el.textContent = value;
        el.blur();
      }
    });
    el.addEventListener('blur', () => {
      const text = (el.textContent ?? '').trim();
      if (text !== value.trim()) save(text);
    });
    return el;
  }
}
