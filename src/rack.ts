import { $ } from './dom';
import { playing } from './state';
import { BANKS, slotBank, slotNum, withBank, withNum } from './lib';

export interface Pat { shuf: boolean }

export interface Machine {
  name: string;
  pats: Pat[];
  bank: Bank<Pat>;
  parts?: string[]; // drum voice names, in grid row order
  hit?(part: string, i: number): boolean; // does this drum part play on step i of the current pattern
  rackReady?(): void; // called once every machine exists
  init(): void | Promise<void>;
  play(i: number, t: number, d: number, shuffle: number): void;
  stop(): void;
  highlight(i: number): void;
}

export const machines: Machine[] = [];

// Patterns autosave to localStorage (knob and mixer values are not saved)
const KEY = 'ab3389';
const SAVED: Record<string, unknown> = (() => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') || {}; } catch { return {}; }
})();
export function loadPats<P extends Pat>(name: string, fresh: (k: number) => Omit<P, 'shuf'>): P[] {
  const s = SAVED[name];
  return Array.isArray(s) && s.length === 32 ? s as P[] : Array.from({ length: 32 }, (_, k) => ({ shuf: true, ...fresh(k) }) as P);
}
export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(machines.map(m => [m.name, m.pats])))); } catch { /* storage unavailable */ }
}

// A panel's title folds the machine's row (pattern and MIX columns too) to that line on click, and moves the
// row when dragged (or Alt+Up / Down). Display only: machines[] keeps its order (song slots, outputs).
// Both remembered per machine
const FOLD = 'ab3389-fold', ORDER = 'ab3389-order';
const load = (k: string): string[] => { try { return JSON.parse(localStorage.getItem(k) ?? '[]') || []; } catch { return []; } };
const store = (k: string, sel: string) => {
  try { localStorage.setItem(k, JSON.stringify([...document.querySelectorAll(sel)].map(e => e.textContent!))); } catch { /* storage unavailable */ }
};
export function wireRows() {
  const devs = $('devs'), closed = load(FOLD), order = load(ORDER), titles = '.dev .panel > h2';
  const rank = (r: Element) => { const i = order.indexOf(r.querySelector('.panel > h2')!.textContent!); return i < 0 ? order.length : i; };
  [...devs.children].sort((x, y) => rank(x) - rank(y)).forEach(r => devs.append(r));
  let dragging: HTMLElement | null = null;
  document.querySelectorAll<HTMLElement>(titles).forEach(h => {
    const row = h.parentElement!.parentElement!;
    const set = (shut: boolean) => { row.classList.toggle('closed', shut); h.setAttribute('aria-expanded', String(!shut)); };
    h.tabIndex = 0; h.setAttribute('role', 'button');
    set(closed.includes(h.textContent!));
    h.onclick = () => { set(!row.classList.contains('closed')); store(FOLD, '.dev.closed .panel > h2'); };
    h.onkeydown = e => {
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const to = e.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling?.nextElementSibling ?? null;
        if (e.key === 'ArrowDown' && !row.nextElementSibling) return;
        devs.insertBefore(row, to); h.focus(); store(ORDER, titles);
      } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); h.click(); }
    };
    // Only the title starts a drag, so knobs and faders keep working
    h.onpointerdown = () => { row.draggable = true; };
    h.onpointerup = () => { row.draggable = false; };
    row.ondragstart = e => { dragging = row; row.classList.add('dragging'); e.dataTransfer?.setData('text/plain', ''); };
    row.ondragend = () => { dragging = null; row.draggable = false; row.classList.remove('dragging'); store(ORDER, titles); };
  });
  devs.ondragover = e => {
    if (!dragging) return;
    e.preventDefault();
    const over = (e.target as Element).closest<HTMLElement>('.dev');
    if (!over || over === dragging) return;
    const r = over.getBoundingClientRect();
    devs.insertBefore(dragging, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
  };
}

// One machine row: pattern column / panel / MIX column
export function mountDevice(cls: string): [HTMLElement, HTMLElement, HTMLElement] {
  const row = document.createElement('div');
  row.className = 'dev';
  row.innerHTML = `<div class="box bankbox"></div><div class="panel ${cls}"></div><div class="box mix"></div>`;
  $('devs').appendChild(row);
  return [...row.children] as [HTMLElement, HTMLElement, HTMLElement];
}

export interface Bank<P> { sel: number; queued: number | null; readonly pat: P; tick(i: number): void; set(idx: number): void }

// 32 patterns A1-D8. While playing, a switch takes effect at the next bar
export function makeBank<P extends Pat>(el: HTMLElement, pats: P[], onChange: () => void): Bank<P> {
  el.innerHTML = '<div class="hdr">PATTERN</div><div class="bank">' +
    [1, 2, 3, 4, 5, 6, 7, 8].map(n => `<button data-n="${n}">${n}</button>`).join('') +
    [...BANKS].map(b => `<button data-b="${b}">${b}</button>`).join('') + '<button data-s>SHUFFLE</button></div>';
  const bar = el.querySelector<HTMLElement>('.bank')!;
  const bank: Bank<P> = {
    sel: 0, queued: null,
    get pat() { return pats[this.sel]; },
    // Called every step. On the downbeat, switch to the queued pattern
    tick(i) {
      if (i !== 0 || bank.queued === null) return;
      bank.sel = bank.queued; bank.queued = null;
      onChange(); show();
    },
    set: idx => go(idx),
  };
  const show = () => {
    const x = bank.queued ?? bank.sel;
    bar.querySelectorAll<HTMLElement>('[data-b]').forEach(b => b.classList.toggle('on', BANKS.indexOf(b.dataset.b!) === slotBank(x)));
    bar.querySelectorAll<HTMLElement>('[data-n]').forEach(b => {
      const hit = +b.dataset.n! - 1 === slotNum(x);
      b.classList.toggle('on', hit);
      b.classList.toggle('wait', hit && bank.queued !== null);
    });
    bar.querySelector('[data-s]')!.classList.toggle('on', bank.pat.shuf);
  };
  const go = (idx: number) => {
    if (playing) bank.queued = idx === bank.sel ? null : idx;
    else { bank.sel = idx; onChange(); }
    show();
  };
  bar.onclick = e => {
    const b = (e.target as HTMLElement).dataset, x = bank.queued ?? bank.sel;
    if (b.b) go(withBank(x, BANKS.indexOf(b.b)));
    else if (b.n) go(withNum(x, +b.n - 1));
    else if ('s' in b) { bank.pat.shuf = !bank.pat.shuf; show(); }
  };
  show();
  return bank;
}
