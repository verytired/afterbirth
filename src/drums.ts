import { ctx } from './state';
import { Channel } from './audio';
import { loadPats, makeBank, mountDevice, type Machine, type Pat } from './rack';
import { numbox } from './dom';

type Hit = (t: number, level: number) => void;
interface VoiceApi {
  env(t: number, peak: number, dec: number): GainNode;
  nz(t: number, dur: number, type: BiquadFilterType, f: number, dest: AudioNode, lp?: number): void;
  tone(t: number, type: OscillatorType, f0: number, f1: number, drop: number, peak: number, dec: number, dest?: AudioNode): void;
  choke(g: GainNode | undefined, t: number): void;
  clap(t: number, l: number, f: number): void;
  metal(t: number, freqs: number[], dur: number, hp: number, dest: AudioNode): void;
  sat(): AudioNode;
  kv(name: string): number;
}
interface PatDrum extends Pat { grid: boolean[][]; len?: number }
type Knob = [name: string, label: string, def: number];
// knobs: extra knobs per part (909). order: on-screen row order; grid rows stay in pat key order
interface DrumOpts { knobs?: Record<string, Knob[]>; order?: string[]; steps?: boolean }

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
  root.innerHTML = `<h2>${name}</h2>` + (opt.steps ? '<div class="row"><label>STEPS <span data-steps></span></label></div>' : '') +
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
  const curve = new Float32Array(257).map((_, i) => Math.tanh(2 * (i / 128 - 1)) / Math.tanh(2));
  const env = (t: number, peak: number, dec: number) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dec);
    g.connect(out);
    return g;
  };
  const nz = (t: number, dur: number, type: BiquadFilterType, f: number, dest: AudioNode, lp?: number) => {
    const s = ctx.createBufferSource(), fl = ctx.createBiquadFilter();
    s.buffer = noise; fl.type = type; fl.frequency.value = f;
    s.connect(fl);
    if (lp) { const l = ctx.createBiquadFilter(); l.frequency.value = lp; fl.connect(l).connect(dest); } else fl.connect(dest);
    s.start(t); s.stop(t + dur);
  };
  // Oscillator whose pitch falls from f0 to f1 over drop seconds
  const tone = (t: number, type: OscillatorType, f0: number, f1: number, drop: number, peak: number, dec: number, dest?: AudioNode) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + drop);
    const g = env(t, peak, dec);
    if (dest) { g.disconnect(); g.connect(dest); }
    o.connect(g); o.start(t); o.stop(t + dec);
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
  // Six detuned squares through a highpass: the metallic core of hats and cymbals
  const metal = (t: number, freqs: number[], dur: number, hp: number, dest: AudioNode) => {
    const f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type = 'highpass'; f.frequency.value = hp; g.gain.value = 0.2;
    g.connect(f).connect(dest);
    for (const fr of freqs) { const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = fr; o.connect(g); o.start(t); o.stop(t + dur); }
  };
  // Soft clip into the output (the 909 kick's rounded-off attack)
  const sat = () => { const w = ctx.createWaveShaper(); w.curve = curve; w.connect(out); return w; };
  const hit = voices({ env, nz, tone, choke, clap, metal, sat, kv: lv });
  const R = (k: string) => grid[V.indexOf(k)];

  let cnt = 0;
  const at: number[] = []; // global step -> pattern step, for the step LEDs
  const pos = (i: number) => len() === 16 ? i : cnt % len();
  return {
    name, pats, bank, parts: V,
    hit: (part, i) => grid[V.indexOf(part)]?.[pos(i)] ?? false,
    init() {
      ch.init();
      out = ctx.createGain(); out.connect(ch.inp);
      noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const c = noise.getChannelData(0);
      for (let i = 0; i < c.length; i++) c[i] = Math.random() * 2 - 1;
    },
    // Patterns shorter than 16 steps loop on their own (polymeter) and restart when the pattern changes
    play(i, t, _d, sh) {
      const sel = bank.sel;
      bank.tick(i);
      if (bank.sel !== sel) cnt = 0;
      const p = at[i] = pos(i);
      cnt++;
      if (bank.pat.shuf) t += sh;
      const acc = R('AC')?.[p] ? 1 + 0.6 * lv('AC') : 1, flam = R('FL')?.[p] ? 0.004 + 0.04 * lv('FL') : 0;
      V.forEach((k, r) => {
        if (!grid[r][p] || !hit[k]) return;
        if (flam) hit[k](t, lv(k) * acc * 0.5);
        hit[k](t + flam, lv(k) * acc);
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
// Grid rows keep the original part order (saved patterns are positional); the panel shows the 909's order
const HAT = [205.3, 304.4, 369.6, 522.7, 540, 800].map(f => f * 1.5);
const RIDE = [340, 456, 588, 710, 905, 1170];
const tuned = (v: number, oct: number) => 2 ** ((v - 0.5) * oct);
export const make909 = () => makeDrum('AB-909', 'd909',
  {
    BD: '................', SD: '................', LT: '................', HT: '................', RS: '................',
    CP: '................', CH: '................', OH: '................', CR: '................',
    MT: '................', RD: '................', AC: '................', FL: '................',
  },
  ({ env, nz, tone, choke, clap, metal, sat, kv }) => {
    let oh: GainNode | undefined;
    const tom = (f: number, k: string) => (t: number, l: number) => {
      const fr = f * tuned(kv(k + 'tune'), 1), dec = 0.15 + 0.7 * kv(k + 'dec');
      tone(t, 'sine', fr * 1.6, fr, 0.08, l * 0.8, dec);
      nz(t, 0.05, 'lowpass', fr * 8, env(t, l * 0.12, 0.05));
    };
    return {
      // Sine with a fast pitch dive, soft-clipped; ATTACK adds the beater click
      BD: (t, l) => {
        const f = 55 * tuned(kv('BDtune'), 0.6), dec = 0.15 + 1.05 * kv('BDdec');
        tone(t, 'sine', f * 5, f, 0.035, l * 1.2, dec, sat());
        nz(t, 0.012, 'highpass', 1500, env(t, l * 0.6 * kv('BDatk'), 0.01), 7000);
      },
      // Two bending oscillators + noise: TONE opens the noise filter, SNAPPY sets its level
      SD: (t, l) => {
        const m = tuned(kv('SDtune'), 0.6);
        tone(t, 'triangle', 238 * m, 180 * m, 0.04, l * 0.5, 0.12);
        tone(t, 'triangle', 370 * m, 330 * m, 0.04, l * 0.3, 0.08);
        nz(t, 0.3, 'highpass', 900, env(t, l * 0.8 * kv('SDsnap'), 0.12 + 0.16 * kv('SDtone')), 3000 + 12000 * kv('SDtone'));
      },
      LT: tom(95, 'LT'), MT: tom(140, 'MT'), HT: tom(200, 'HT'),
      RS: (t, l) => { tone(t, 'square', 1700, 1700, 0.01, l * 0.25, 0.025); tone(t, 'triangle', 480, 480, 0.01, l * 0.4, 0.03); },
      CP: (t, l) => clap(t, l, 1400),
      CH: (t, l) => {
        choke(oh, t);
        const dec = 0.03 + 0.12 * kv('CHdec'), g = env(t, l * 0.5, dec);
        metal(t, HAT, dec, 7000, g); nz(t, dec, 'highpass', 9000, g);
      },
      OH: (t, l) => {
        const dec = 0.15 + 0.75 * kv('OHdec');
        oh = env(t, l * 0.5, dec);
        metal(t, HAT, dec, 7000, oh); nz(t, dec, 'highpass', 8500, oh);
      },
      CR: (t, l) => {
        const g = env(t, l * 0.45, 1.6);
        metal(t, HAT.map(f => f * 0.8 * tuned(kv('CRtune'), 1)), 1.6, 4500, g); nz(t, 1.6, 'highpass', 5000, g);
      },
      RD: (t, l) => {
        const g = env(t, l * 0.5, 1.4);
        metal(t, RIDE.map(f => f * 2 * tuned(kv('RDtune'), 1)), 1.4, 3000, g); nz(t, 1.4, 'highpass', 9000, env(t, l * 0.1, 1.4));
      },
    };
  },
  {
    order: ['BD', 'SD', 'LT', 'MT', 'HT', 'RS', 'CP', 'CH', 'OH', 'CR', 'RD', 'AC', 'FL'],
    steps: true,
    knobs: {
      BD: [['BDtune', 'TUNE', 0.5], ['BDatk', 'ATTACK', 0.5], ['BDdec', 'DECAY', 0.4]],
      SD: [['SDtune', 'TUNE', 0.5], ['SDtone', 'TONE', 0.5], ['SDsnap', 'SNAPPY', 0.6]],
      LT: [['LTtune', 'TUNE', 0.5], ['LTdec', 'DECAY', 0.4]],
      MT: [['MTtune', 'TUNE', 0.5], ['MTdec', 'DECAY', 0.4]],
      HT: [['HTtune', 'TUNE', 0.5], ['HTdec', 'DECAY', 0.4]],
      CH: [['CHdec', 'DECAY', 0.3]],
      OH: [['OHdec', 'DECAY', 0.4]],
      CR: [['CRtune', 'TUNE', 0.5]],
      RD: [['RDtune', 'TUNE', 0.5]],
    },
  });
