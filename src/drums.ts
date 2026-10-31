import { ctx } from './state';
import { Channel } from './audio';
import { loadPats, makeBank, mountDevice, type Machine, type Pat } from './rack';

type Hit = (t: number, level: number) => void;
interface VoiceApi {
  env(t: number, peak: number, dec: number): GainNode;
  nz(t: number, dur: number, type: BiquadFilterType, f: number, dest: AudioNode): void;
  tone(t: number, type: OscillatorType, f0: number, f1: number, drop: number, peak: number, dec: number): void;
  choke(g: GainNode | undefined, t: number): void;
  clap(t: number, l: number, f: number): void;
}
interface PatDrum extends Pat { grid: boolean[][] }

// pat: { partName: 'x...x...' } for pattern A1. voices(api) returns { partName: hit }
function makeDrum(name: string, cls: string, pat: Record<string, string>, voices: (api: VoiceApi) => Record<string, Hit>): Machine {
  const [bankEl, root, mixEl] = mountDevice(cls);
  const V = Object.keys(pat);
  const pats = loadPats<PatDrum>(name, k => ({ grid: V.map(v => [...pat[v]].map(c => k === 0 && c === 'x')) }));
  let grid = pats[0].grid;
  root.innerHTML = `<h2>${name}</h2><div class="drums">` + V.map((k, r) =>
    `<div class="drow"><b>${k}</b><input type="range" name="${k}" min="0" max="1" step="0.01" value="0.8">` +
    grid[r].map((on, c) => `<button data-r="${r}" data-c="${c}" class="${on ? 'on' : ''}" aria-label="${k} ${c + 1}"></button>`).join('') + `</div>`).join('') + `</div>`;
  const lv = (k: string) => +root.querySelector<HTMLInputElement>(`[name=${k}]`)!.value;
  const btns = [...root.querySelectorAll<HTMLButtonElement>('.drow button')];
  btns.forEach(b => b.onclick = () => {
    const r = +b.dataset.r!, c = +b.dataset.c!;
    grid[r][c] = !grid[r][c];
    b.classList.toggle('on', grid[r][c]);
  });
  const bank = makeBank(bankEl, pats, () => {
    grid = bank.pat.grid;
    btns.forEach(b => b.classList.toggle('on', grid[+b.dataset.r!][+b.dataset.c!]));
  });
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
  const hit = voices({ env, nz, tone, choke, clap });

  return {
    name, pats, bank, parts: V,
    init() {
      ch.init();
      out = ctx.createGain(); out.connect(ch.inp);
      noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const c = noise.getChannelData(0);
      for (let i = 0; i < c.length; i++) c[i] = Math.random() * 2 - 1;
    },
    play(i, t, _d, sh) {
      bank.tick(i);
      if (bank.pat.shuf) t += sh;
      V.forEach((k, r) => grid[r][i] && hit[k](t, lv(k)));
    },
    stop() { bank.tick(0); },
    highlight(i) { btns.forEach(b => b.classList.toggle('now', +b.dataset.c! === i)); },
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

// Empty by default (so it does not double the 808). Program your own
export const make909 = () => makeDrum('AB-909', 'd909',
  {
    BD: '................', SD: '................', LT: '................', HT: '................', RS: '................',
    CP: '................', CH: '................', OH: '................', CR: '................',
  },
  ({ env, nz, tone, choke, clap }) => {
    let oh: GainNode | undefined;
    return {
      BD: (t, l) => { tone(t, 'sine', 220, 50, 0.04, l, 0.45); nz(t, 0.01, 'highpass', 3000, env(t, l * 0.3, 0.01)); },
      SD: (t, l) => {
        tone(t, 'triangle', 190, 180, 0.05, l * 0.4, 0.1);
        tone(t, 'triangle', 340, 330, 0.05, l * 0.25, 0.08);
        nz(t, 0.3, 'highpass', 2000, env(t, l * 0.7, 0.28));
      },
      LT: (t, l) => tone(t, 'sine', 160, 105, 0.1, l * 0.8, 0.35),
      HT: (t, l) => tone(t, 'sine', 300, 210, 0.1, l * 0.8, 0.3),
      RS: (t, l) => { tone(t, 'square', 1700, 1700, 0.01, l * 0.25, 0.025); tone(t, 'triangle', 480, 480, 0.01, l * 0.4, 0.03); },
      CP: (t, l) => clap(t, l, 1400),
      CH: (t, l) => { choke(oh, t); nz(t, 0.08, 'highpass', 9000, env(t, l * 0.5, 0.07)); },
      OH: (t, l) => { oh = env(t, l * 0.5, 0.45); nz(t, 0.45, 'highpass', 8500, oh); },
      CR: (t, l) => nz(t, 1.5, 'highpass', 5000, env(t, l * 0.4, 1.5)),
    };
  });
