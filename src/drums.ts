import { ctx } from './state';
import { Channel } from './audio';
import { loadPats, makeBank, mountDevice, type Machine, type Pat } from './rack';
import { numbox } from './dom';

type Hit = (t: number, level: number) => void;
interface VoiceApi {
  env(t: number, peak: number, dec: number): GainNode;
  nz(t: number, dur: number, type: BiquadFilterType, f: number, dest: AudioNode, lp?: number, q?: number): void;
  tone(t: number, type: OscillatorType, f0: number, f1: number, drop: number, peak: number, dec: number, dest?: AudioNode): void;
  choke(g: GainNode | undefined, t: number): void;
  clap(t: number, l: number, f: number): void;
  kv(name: string): number;
}
interface PatDrum extends Pat { grid: boolean[][]; len?: number }
type Knob = [name: string, label: string, def: number];
// knobs: extra knobs per part (909). order: on-screen row order; grid rows stay in pat key order
interface DrumOpts { knobs?: Record<string, Knob[]>; order?: string[]; steps?: boolean; flam?: string[]; init?: () => void }

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
  const env = (t: number, peak: number, dec: number) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dec);
    g.connect(out);
    return g;
  };
  const nz = (t: number, dur: number, type: BiquadFilterType, f: number, dest: AudioNode, lp?: number, q?: number) => {
    const s = ctx.createBufferSource(), fl = ctx.createBiquadFilter();
    s.buffer = noise; fl.type = type; fl.frequency.value = f;
    if (q) fl.Q.value = q;
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
  const hit = voices({ env, nz, tone, choke, clap, kv: lv });
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
      opt.init?.();
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
        const fl = opt.flam?.includes(k) ? flam : 0;
        if (fl) hit[k](t, lv(k) * acc * 0.5);
        hit[k](t + fl, lv(k) * acc);
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
// Voice structure follows the published descriptions of the 909: BD = near-sine (the original shapes a sawtooth;
// a band-limited saw through a sine shaper buzzes, so this starts from a sine) with a pitch envelope whose decay is TUNE, plus a click of pulse + lowpassed noise; CP = bandpassed noise hit
// four times ~11ms apart plus a reverb-like tail; hats and cymbals = 6-bit ~18kHz PCM played through analog
// envelopes (TUNE = playback rate). Flam only applies to BD, SD and the toms, as on the original
const tuned = (v: number, oct: number) => 2 ** ((v - 0.5) * oct);
const PCM_RATE = 18000;
// One RBJ highpass section
const hipass = (f: number, fs: number) => {
  const w = 2 * Math.PI * f / fs, al = Math.sin(w) / Math.SQRT2, c = Math.cos(w), a0 = 1 + al;
  const b0 = (1 + c) / 2 / a0, b1 = -(1 + c) / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x: number) => { const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
};
// Stand-in for a cymbal ROM. A real cymbal is a dense set of inharmonic partials, the high ones dying first,
// over noise; that is rendered here (seeded, so every load sounds the same), highpassed, quantised to 6 bits
// at 18kHz and held sample-by-sample at the context rate (the zero-order-hold images are the gritty top end)
interface Metal { dur: number; n: number; lo: number; hi: number; ring: number; bell?: number[]; noise: number; crash?: number; hp: number }
function pcm({ dur, n: np, lo, hi, ring, bell = [], noise, crash = 0, hp }: Metal): AudioBuffer {
  let seed = 909;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const parts = [
    ...Array.from({ length: np }, () => { const f = lo * (hi / lo) ** rnd(); return [f, 0.5 + rnd(), ring * Math.sqrt(lo / f) * (0.6 + 0.8 * rnd())]; }),
    ...bell.map(f => [f, 3, ring * 2]),
  ].map(([f, a, d]) => ({ w: 2 * Math.PI * f / PCM_RATE, a, k: Math.exp(-1 / (d * PCM_RATE)), ph: rnd() * 6.28 }));
  const n = dur * PCM_RATE | 0, v = new Float32Array(n), h1 = hipass(hp, PCM_RATE), h2 = hipass(hp, PCM_RATE);
  let pk = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const p of parts) { m += p.a * Math.sin(p.w * i + p.ph); p.a *= p.k; }
    const t = i / PCM_RATE, nz = (rnd() * 2 - 1) * (noise * Math.exp(-t / ring) + crash * Math.exp(-t / 0.04));
    v[i] = h2(h1(m / Math.sqrt(parts.length) + nz));
    pk = Math.max(pk, Math.abs(v[i]));
  }
  const buf = ctx.createBuffer(1, Math.ceil(n * ctx.sampleRate / PCM_RATE), ctx.sampleRate), d = buf.getChannelData(0);
  for (let j = 0; j < d.length; j++) d[j] = Math.round(v[Math.min(n - 1, j * PCM_RATE / ctx.sampleRate | 0)] / pk * 31) / 31;
  return buf;
}
const PCM: Record<string, () => AudioBuffer> = {
  // 909 hats and ride have marked resonances between 3 and 5kHz (DJ TechTools / Hannes Bieger)
  HH: () => pcm({ dur: 0.9, n: 60, lo: 2500, hi: 8800, ring: 0.3, bell: [3350, 4100, 4750], noise: 0.5, hp: 2500 }),
  CR: () => pcm({ dur: 2, n: 90, lo: 450, hi: 8800, ring: 0.9, noise: 0.6, crash: 1.2, hp: 1800 }),
  RD: () => pcm({ dur: 1.8, n: 60, lo: 2000, hi: 8800, ring: 0.6, bell: [3150, 3600, 4200, 4900], noise: 0.15, hp: 1500 }),
};
const pcmBufs: Record<string, AudioBuffer> = {};
const playPcm = (k: string, t: number, rate: number, dest: AudioNode, dur: number) => {
  const s = ctx.createBufferSource();
  s.buffer = pcmBufs[k] ??= PCM[k]();
  s.playbackRate.value = rate;
  s.connect(dest); s.start(t); s.stop(t + dur);
};
export const make909 = () => makeDrum('AB-909', 'd909',
  {
    BD: '................', SD: '................', LT: '................', HT: '................', RS: '................',
    CP: '................', CH: '................', OH: '................', CR: '................',
    MT: '................', RD: '................', AC: '................', FL: '................',
  },
  ({ env, nz, tone, choke, kv }) => {
    let oh: GainNode | undefined;
    const tom = (f: number, k: string) => (t: number, l: number) => {
      const fr = f * tuned(kv(k + 'tune'), 1), dec = 0.15 + 0.7 * kv(k + 'dec');
      tone(t, 'sine', fr * 1.6, fr, 0.08, l * 0.8, dec);
      nz(t, 0.05, 'lowpass', fr * 8, env(t, l * 0.12, 0.05));
    };
    // Short resonant ping: a 1ms noise burst through a high-Q bandpass
    const ping = (t: number, f: number, peak: number, dec: number) => nz(t, 0.001, 'bandpass', f, env(t, peak, dec), undefined, 30);
    return {
      BD: (t, l) => {
        const dec = 0.15 + 1.05 * kv('BDdec'), o = ctx.createOscillator();
        o.frequency.setValueAtTime(220, t);
        o.frequency.setTargetAtTime(50, t, 0.008 + 0.06 * kv('BDtune'));
        o.connect(env(t, l, dec)); o.start(t); o.stop(t + dec);
        const atk = kv('BDatk');
        tone(t, 'square', 1000, 1000, 0.001, l * 0.3 * atk, 0.002);
        nz(t, 0.02, 'lowpass', 3000, env(t, l * 0.5 * atk, 0.015));
      },
      // 909 snare vs 808: the noise leads (bright, broadband, with a short crack on the attack) and the two
      // shells drop in pitch fast and die early. TONE opens the noise lowpass, SNAPPY sets the noise level
      SD: (t, l) => {
        const m = tuned(kv('SDtune'), 0.6), tn = kv('SDtone');
        tone(t, 'sine', 300 * m, 190 * m, 0.02, l * 0.45, 0.07);
        tone(t, 'sine', 520 * m, 340 * m, 0.02, l * 0.2, 0.05);
        nz(t, 0.02, 'highpass', 200, env(t, l * 0.5, 0.015));
        nz(t, 0.4, 'highpass', 500, env(t, l * 1.1 * kv('SDsnap'), 0.16 + 0.14 * tn), 5000 + 13000 * tn);
      },
      LT: tom(95, 'LT'), MT: tom(140, 'MT'), HT: tom(200, 'HT'),
      RS: (t, l) => { ping(t, 500, l * 24, 0.04); ping(t, 1700, l * 16, 0.025); nz(t, 0.004, 'highpass', 4000, env(t, l * 0.3, 0.004)); },
      CP: (t, l) => {
        const g = ctx.createGain(); g.connect(env(t, 1, 10)); // flat over the bursts
        [0, 0.011, 0.022, 0.033].forEach(o => { g.gain.setValueAtTime(l * 4, t + o); g.gain.setTargetAtTime(0, t + o, 0.006); });
        nz(t, 0.05, 'bandpass', 1140, g, undefined, 2);
        nz(t + 0.033, 0.3, 'bandpass', 1140, env(t + 0.033, l * 1.6, 0.25), undefined, 2);
      },
      // CH and OH are one voice on the 909: each hit cuts whatever hat is still ringing
      CH: (t, l) => { choke(oh, t); const dec = 0.03 + 0.12 * kv('CHdec'); oh = env(t, l * 0.7, dec); playPcm('HH', t, 1, oh, dec); },
      OH: (t, l) => { choke(oh, t); const dec = 0.15 + 0.75 * kv('OHdec'); oh = env(t, l * 0.7, dec); playPcm('HH', t, 1, oh, dec); },
      CR: (t, l) => playPcm('CR', t, tuned(kv('CRtune'), 1), env(t, l * 0.6, 2), 2),
      RD: (t, l) => playPcm('RD', t, tuned(kv('RDtune'), 1), env(t, l * 0.6, 1.8), 1.8),
    };
  },
  {
    order: ['BD', 'SD', 'LT', 'MT', 'HT', 'RS', 'CP', 'CH', 'OH', 'CR', 'RD', 'AC', 'FL'],
    flam: ['BD', 'SD', 'LT', 'MT', 'HT'],
    init: () => Object.keys(PCM).forEach(k => pcmBufs[k] ??= PCM[k]()), // render the cymbal ROMs up front
    steps: true,
    knobs: {
      BD: [['BDtune', 'TUNE', 0.5], ['BDatk', 'ATTACK', 0.5], ['BDdec', 'DECAY', 0.4]],
      SD: [['SDtune', 'TUNE', 0.5], ['SDtone', 'TONE', 0.5], ['SDsnap', 'SNAPPY', 0.7]],
      LT: [['LTtune', 'TUNE', 0.5], ['LTdec', 'DECAY', 0.4]],
      MT: [['MTtune', 'TUNE', 0.5], ['MTdec', 'DECAY', 0.4]],
      HT: [['HTtune', 'TUNE', 0.5], ['HTdec', 'DECAY', 0.4]],
      CH: [['CHdec', 'DECAY', 0.3]],
      OH: [['OHdec', 'DECAY', 0.4]],
      CR: [['CRtune', 'TUNE', 0.5]],
      RD: [['RDtune', 'TUNE', 0.5]],
    },
  });
