// DEMO scenes that make the MODS easy to hear. Each one first restores every 303 control to its startup
// value, then changes a few. Startup defaults themselves are untouched
import { $ } from './dom';
import { machines, save } from './rack';

type Ctl = HTMLInputElement | HTMLSelectElement;
const controls = () => [...document.querySelectorAll<Ctl>('.d303 input, .d303 select')].filter(el => el.name);
let startup = new Map<Ctl, string>();

const set = (dev: number, name: string, v: string | number) => {
  const el = document.querySelector<Ctl>(`#devs .dev:nth-child(${dev}) [name=${name}]`)!;
  el.value = String(v);
  el.dispatchEvent(new Event('input'));
};

// A2 for 303 #1: the A1 rhythm an octave up with a different contour, so DBS swaps are obvious
const A2_303_1 = [[12, 0, 1], [10, 1], [7], [12, 0, 0, 1], [15], [12, 1, 1], [10], [7, 1],
  [12, 0, 0, 1], [3, 1, 1], [12], [10, 1], [7], [5, 1, 1, 1], [7], [12, 1]];

const SCENES: Record<string, () => void> = {
  stock: () => {},
  dbs: () => {
    machines[0].setSteps?.(1, A2_303_1);
    set(1, 'dbsA', '2:BD'); // 808 kick
  },
  selfosc: () => {
    set(2, 'selfosc', 1); set(2, 'reso', 20); set(2, 'track', 1);
    set(2, 'cutoff', 0.35); set(2, 'env', 0.3); set(2, 'wave', 'sawtooth');
  },
  devil: () => {
    set(1, 'drive', 0.55); set(1, 'muffler', 1); set(1, 'fm', 0.25);
    set(1, 'env', 1.6); set(1, 'decay', 1.2); set(1, 'accdec', 0.75); set(1, 'slide', 0.6); set(1, 'reso', 16);
  },
};

export function wireDemo() {
  startup = new Map(controls().map(el => [el, el.value]));
  const sel = $<HTMLSelectElement>('demo');
  sel.onchange = () => {
    for (const [el, v] of startup) { el.value = v; el.dispatchEvent(new Event('input')); }
    SCENES[sel.value]?.();
    save();
  };
}
