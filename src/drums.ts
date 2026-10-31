import { ctx } from './state';
import { Channel } from './audio';
import { loadPats, makeBank, mountDevice, type Machine, type Pat } from './rack';
import { numbox } from './dom';
import { config } from './config';
import { loadDrums } from './dsp/load';
import { KNOBS, VOICES, makeRom } from './dsp/tr909';
import type { DrumMsg, EngineName, ProcessorMsg } from './dsp/protocol';

type Hit = (t: number, level: number, accent: number) => void; // accent: AC amount on accented steps, else 0
interface VoiceApi {
  env(t: number, peak: number, dec: number): GainNode;
  nz(t: number, dur: number, type: BiquadFilterType, f: number, dest: AudioNode): void;
  tone(t: number, type: OscillatorType, f0: number, f1: number, drop: number, peak: number, dec: number): void;
  choke(g: GainNode | undefined, t: number): void;
  clap(t: number, l: number, f: number): void;
  kv(name: string): number;
}
interface PatDrum extends Pat { grid: boolean[][]; len?: number }
type Knob = [name: string, label: string, def: number];
// knobs: extra knobs per part (909). order: on-screen row order; grid rows stay in pat key order
interface DrumOpts {
  knobs?: Record<string, Knob[]>; order?: string[]; steps?: boolean; flam?: string[];
  head?: string; // extra controls next to STEPS
  init?: (out: AudioNode, root: HTMLElement) => Promise<void>;
}

// pat: { partName: 'x...x...' } for pattern A1. voices(api) returns { partName: hit }.
// Parts without a voice are step flags: AC = accent (its knob: amount), FL = flam (its knob: time)
function makeDrum(name: string, cls: string, pat: Record<string, string>, voices: (api: VoiceApi) => Record<string, Hit>, opt: DrumOpts = {}): Machine {
  const [bankEl, root, mixEl] = mountDevice(cls);
  const V = Object.keys(pat);
  const pats = loadPats<PatDrum>(name, k => ({ grid: V.map(v => [...pat[v]].map(c => k === 0 && c === 'x')) }));
  // Parts added later are appended, so older saves just lack the last rows
  pats.forEach(p => { while (p.grid.length < V.length) p.grid.push(Array<boolean>(16).fill(false)); });
  let grid = pats[0].grid;
  const cols = opt.knobs ? 1 + Math.max(...Object.values(opt.knobs).map(k => k.length)) : 0;
  const knob = ([n, l, d]: Knob) => cols ? `<label class="dk"><input type="range" name="${n}" min="0" max="1" step="0.01" value="${d}"><i>${l}</i></label>`
    : `<input type="range" name="${n}" min="0" max="1" step="0.01" value="${d}">`;
  const LVL: Record<string, string> = { AC: 'ACCENT', FL: 'FLAM' };
  root.innerHTML = `<h2>${name}</h2>` + (opt.steps ? `<div class="row"><label>STEPS <span data-steps></span></label>${opt.head ?? ''}</div>` : '') +
    `<div class="drums">` + (opt.order ?? V).map(k => {
      const r = V.indexOf(k), ks: Knob[] = [[k, LVL[k] ?? 'LEVEL', k === 'FL' ? 0.4 : 0.8], ...(opt.knobs?.[k] ?? [])];
      return `<div class="drow"><b>${k}</b>` + ks.map(knob).join('') + '<span></span>'.repeat(cols && cols - ks.length) +
        grid[r].map((on, c) => `<button data-r="${r}" data-c="${c}" class="${on ? 'on' : ''}" aria-label="${k} ${c + 1}"></button>`).join('') + `</div>`;
    }).join('') + `</div>`;
  const lv = (k: string) => +root.querySelector<HTMLInputElement>(`[name=${k}]`)!.value;
  const btns = [...root.querySelectorAll<HTMLButtonElement>('.drow button')];
  btns.forEach(b => b.onclick = () => {
    const r = +b.dataset.r!, c = +b.dataset.c!;
    grid[r][c] = !grid[r][c];
    b.classList.toggle('on', grid[r][c]);
  });
  const len = () => bank.pat.len ?? 16;
  const showLen = () => btns.forEach(b => b.classList.toggle('off', +b.dataset.c! >= len()));
  const bank = makeBank(bankEl, pats, () => {
    grid = bank.pat.grid;
    btns.forEach(b => b.classList.toggle('on', grid[+b.dataset.r!][+b.dataset.c!]));
    steps?.set(len());
  });
  const steps = opt.steps ? numbox(root.querySelector<HTMLElement>('[data-steps]')!, 1, 16, len(), v => { bank.pat.len = v; showLen(); }) : undefined;
  const ch = new Channel(mixEl);

  let out: GainNode, noise: AudioBuffer;
  const env = (t: number, peak: number, dec: number) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dec);
    g.connect(out);
    return g;
  };
  const nz = (t: number, dur: number, type: BiquadFilterType, f: number, dest: AudioNode) => {
    const s = ctx.createBufferSource(), fl = ctx.createBiquadFilter();
    s.buffer = noise; fl.type = type; fl.frequency.value = f;
    s.connect(fl).connect(dest); s.start(t); s.stop(t + dur);
  };
  // Oscillator whose pitch falls from f0 to f1 over drop seconds
  const tone = (t: number, type: OscillatorType, f0: number, f1: number, drop: number, peak: number, dec: number) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + drop);
    o.connect(env(t, peak, dec)); o.start(t); o.stop(t + dec);
  };
  const choke = (g: GainNode | undefined, t: number) => {
    if (!g) return;
    const p = g.gain;
    if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(t); else p.cancelScheduledValues(t);
    p.setTargetAtTime(0, t, 0.005);
  };
  const clap = (t: number, l: number, f: number) => {
    const g = ctx.createGain(); g.connect(out);
    [0, 0.01, 0.02].forEach(o => { g.gain.setValueAtTime(l * 0.7, t + o); g.gain.setTargetAtTime(0, t + o, 0.003); });
    g.gain.setValueAtTime(l * 0.7, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    nz(t, 0.3, 'bandpass', f, g);
  };
  const hit = voices({ env, nz, tone, choke, clap, kv: lv });
  const R = (k: string) => grid[V.indexOf(k)];

  let cnt = 0;
  const at: number[] = []; // global step -> pattern step, for the step LEDs
  const pos = (i: number) => len() === 16 ? i : cnt % len();
  return {
    name, pats, bank, parts: V,
    hit: (part, i) => grid[V.indexOf(part)]?.[pos(i)] ?? false,
    async init() {
      ch.init();
      out = ctx.createGain(); out.connect(ch.inp);
      noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const c = noise.getChannelData(0);
      for (let i = 0; i < c.length; i++) c[i] = Math.random() * 2 - 1;
      await opt.init?.(out, root);
    },
    // Patterns shorter than 16 steps loop on their own (polymeter) and restart when the pattern changes
    play(i, t, _d, sh) {
      const sel = bank.sel;
      bank.tick(i);
      if (bank.sel !== sel) cnt = 0;
      const p = at[i] = pos(i);
      cnt++;
      if (bank.pat.shuf) t += sh;
      const ac = R('AC')?.[p] ? lv('AC') : 0, acc = 1 + 0.6 * ac, flam = R('FL')?.[p] ? 0.004 + 0.04 * lv('FL') : 0;
      V.forEach((k, r) => {
        if (!grid[r][p] || !hit[k]) return;
        const fl = opt.flam?.includes(k) ? flam : 0;
        if (fl) hit[k](t, lv(k) * acc * 0.5, ac);
        hit[k](t + fl, lv(k) * acc, ac);
      });
    },
    stop() { bank.tick(0); cnt = 0; },
    highlight(i) { const c = i < 0 ? -1 : at[i]; btns.forEach(b => b.classList.toggle('now', +b.dataset.c! === c)); },
  };
}

export const make808 = () => makeDrum('AB-808', 'd808',
  { BD: 'x...x...x...x..x', SD: '....x.......x...', CH: 'x...x...x...x...', OH: '..x...x...x...x.', CP: '............x...' },
  ({ env, nz, tone, choke, clap }) => {
    let oh: GainNode | undefined;
    return {
      BD: (t, l) => tone(t, 'sine', 150, 45, 0.12, l, 0.6),
      SD: (t, l) => { tone(t, 'triangle', 185, 175, 0.1, l * 0.5, 0.12); nz(t, 0.2, 'highpass', 1200, env(t, l * 0.6, 0.2)); },
      CH: (t, l) => { choke(oh, t); nz(t, 0.06, 'highpass', 7000, env(t, l * 0.4, 0.05)); },
      OH: (t, l) => { oh = env(t, l * 0.4, 0.35); nz(t, 0.35, 'highpass', 7000, oh); },
      CP: (t, l) => clap(t, l, 1100),
    };
  });

// Empty by default (so it does not double the 808). Program your own.
// Grid rows keep the original part order (saved patterns are positional); the panel shows the 909's order.
// The sound is made in an AudioWorklet (src/dsp/tr909.ts, WASM build with a JS fallback); this side only
// sequences: accent (level), flam (two hits, BD / SD / toms only, as on the original) and pattern length
export const make909 = () => {
  let node: AudioWorkletNode | undefined;
  const send = (m: DrumMsg) => node?.port.postMessage(m);
  return makeDrum('AB-909', 'd909',
    {
      BD: '................', SD: '................', LT: '................', HT: '................', RS: '................',
      CP: '................', CH: '................', OH: '................', CR: '................',
      MT: '................', RD: '................', AC: '................', FL: '................',
    },
    ({ kv }) => Object.fromEntries(VOICES.map(v => [v, (t: number, l: number, a: number) => send({ k: 'hit', t, v, l, a, p: KNOBS[v].map(kv) })])),
    {
      order: ['BD', 'SD', 'LT', 'MT', 'HT', 'RS', 'CP', 'CH', 'OH', 'CR', 'RD', 'AC', 'FL'],
      flam: ['BD', 'SD', 'LT', 'MT', 'HT'],
      steps: true,
      head: '<label>ENGINE <select name="engine"><option value="wasm">WASM</option><option value="js">JS</option></select></label>',
      async init(out, root) {
        const sel = root.querySelector<HTMLSelectElement>('[name=engine]')!;
        sel.value = config.engine === 'js' ? 'js' : 'wasm';
        const wasm = await loadDrums(ctx), rom = makeRom();
        if (!wasm) {
          const o = sel.querySelector<HTMLOptionElement>('option[value=wasm]')!;
          o.disabled = true; o.textContent = 'WASM (unavailable)';
          sel.value = 'js';
        }
        node = new AudioWorkletNode(ctx, 'drum909', {
          numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
          processorOptions: { wasm, engine: sel.value as EngineName, rom: rom.data, lens: rom.lens },
        });
        node.port.onmessage = (e: MessageEvent<ProcessorMsg>) => {
          if (e.data.k === 'engine') sel.value = e.data.name;
          if (e.data.k === 'error') console.warn('909 drums:', e.data.msg);
        };
        node.connect(out);
        sel.addEventListener('input', () => send({ k: 'engine', name: sel.value as EngineName }));
      },
      knobs: {
        BD: [['BDtune', 'TUNE', 0.5], ['BDatk', 'ATTACK', 0.5], ['BDdec', 'DECAY', 0.4]],
        SD: [['SDtune', 'TUNE', 0.5], ['SDtone', 'TONE', 0.5], ['SDsnap', 'SNAPPY', 0.7]],
        LT: [['LTtune', 'TUNE', 0.5], ['LTdec', 'DECAY', 0.4]],
        MT: [['MTtune', 'TUNE', 0.5], ['MTdec', 'DECAY', 0.4]],
        HT: [['HTtune', 'TUNE', 0.5], ['HTdec', 'DECAY', 0.4]],
        CH: [['CHtune', 'TUNE', 0.5], ['CHdec', 'DECAY', 0.3]], // hat TUNE is an extension (TR-8S, Tiptop HATS909)
        OH: [['OHtune', 'TUNE', 0.5], ['OHdec', 'DECAY', 0.4]],
        CR: [['CRtune', 'TUNE', 0.5]],
        RD: [['RDtune', 'TUNE', 0.5]],
      },
    });
};
