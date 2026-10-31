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
// ok: rejects saved patterns from an older layout of the machine (e.g. a drum part added)
export function loadPats<P extends Pat>(name: string, fresh: (k: number) => Omit<P, 'shuf'>, ok: (p: P) => boolean = () => true): P[] {
  const s = SAVED[name];
  return Array.isArray(s) && s.length === 32 && s.every(ok) ? s as P[] : Array.from({ length: 32 }, (_, k) => ({ shuf: true, ...fresh(k) }) as P);
}
export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(machines.map(m => [m.name, m.pats])))); } catch { /* storage unavailable */ }
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
