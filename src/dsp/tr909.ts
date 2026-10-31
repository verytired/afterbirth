// 909 drum DSP. Every hit becomes a few components (oscillator, filtered noise, or 6-bit ROM playback), each
// through its own envelope: recipe() turns a hit into components, Drum909 renders them. Pure (no imports,
// no DOM, no Web Audio) so it runs in the AudioWorklet and in tests. assembly/tr909.ts is a line-by-line
// AssemblyScript port of Drum909. Keep them in sync; tr909.test.ts checks they match.
// Filters use the Web Audio BiquadFilterNode formulas and envelopes its ramps, so the sound carries over
// from the node-graph version

export const PCM_RATE = 18000; // the cymbal ROMs' sample clock at TUNE = center
export const VOICES = ['BD', 'SD', 'LT', 'MT', 'HT', 'RS', 'CP', 'CH', 'OH', 'CR', 'RD'] as const;
export type Voice909 = typeof VOICES[number];
// Knobs each voice reads at hit time, in the order recipe() takes them
export const KNOBS: Record<Voice909, string[]> = {
  BD: ['BDtune', 'BDatk', 'BDdec'], SD: ['SDtune', 'SDtone', 'SDsnap'],
  LT: ['LTtune', 'LTdec'], MT: ['MTtune', 'MTdec'], HT: ['HTtune', 'HTdec'], RS: [], CP: [],
  CH: ['CHtune', 'CHdec'], OH: ['OHtune', 'OHdec'], CR: ['CRtune'], RD: ['RDtune'],
};

export const K_OSC = 0, K_NOISE = 1, K_PCM = 2;
export const W_SINE = 0, W_SQUARE = 1;
export const F_NONE = 0, F_LP = 1, F_HP = 2, F_BP = 3;
export const E_EXP = 0, E_BURST = 1;
export const MAX_COMPS = 48;
const BURSTS = 4, BURST_GAP = 0.011, CHOKE_TAU = 0.005;

// One component. Times in seconds. Unused fields stay 0
export interface Comp {
  kind: number; delay: number;
  dur: number;   // osc / pcm: length; noise: how long noise is fed (the filter may ring on until dec)
  wave: number; f0: number; f1: number;
  glide: number; // > 0: f0 -> f1 exponentially over glide s, then hold; < 0: approach f1 with time constant -glide
  ft: number; ff: number; fq: number; lp: number; // noise filter type / Hz / Q (Web Audio units), then an optional lowpass
  rom: number; rate: number; // pcm: 0 HH, 1 CR, 2 RD; playback rate (TUNE)
  env: number; peak: number; dec: number; // E_EXP: peak -> 0.001 over dec s; E_BURST: four hits 11 ms apart, time constant dec
  group: number; // 1 = hats: a new hat cuts the ringing one
}
const comp = (c: Partial<Comp>): Comp => ({
  kind: 0, delay: 0, dur: 0, wave: 0, f0: 0, f1: 0, glide: 0, ft: 0, ff: 0, fq: 1, lp: 0, rom: 0, rate: 1, env: 0, peak: 0, dec: 0, group: 0, ...c,
});

const tuned = (v: number, oct: number) => 2 ** ((v - 0.5) * oct);
const osc = (f0: number, f1: number, glide: number, peak: number, dec: number, wave = W_SINE) =>
  comp({ kind: K_OSC, wave, f0, f1, glide, peak, dec, dur: dec });
const noise = (ft: number, ff: number, dur: number, peak: number, dec: number, more: Partial<Comp> = {}) =>
  comp({ kind: K_NOISE, ft, ff, dur, peak, dec, ...more });
const pcm = (rom: number, rate: number, peak: number, dec: number, group = 0) =>
  comp({ kind: K_PCM, rom, rate, peak, dec, dur: dec, group });

// A hit at level l (accent already applied) with the voice's KNOBS values p; a = accent amount (0 = none)
export function recipe(v: Voice909, l: number, p: number[], a = 0): Comp[] {
  switch (v) {
    case 'BD': { // near-sine with a pitch dive (time constant = TUNE), click of pulse + lowpassed noise (ATTACK)
      // Rest pitch about 56 Hz, set by R27 to +15 V on the original (circuit notes in HelveticaScenario/operator#169)
      // Accent also stretches the amp decay (on the original it changes EG1's level and decay; Sound On Sound)
      const d = (0.15 + 1.05 * p[2]) * (1 + 0.4 * a), atk = p[1];
      return [osc(246, 56, -(0.008 + 0.06 * p[0]), l, d), osc(1000, 1000, 0.001, l * 0.3 * atk, 0.002, W_SQUARE),
        noise(F_LP, 3000, 0.02, l * 0.5 * atk, 0.015)];
    }
    case 'SD': { // noise-led: attack crack, TONE opens the noise lowpass, SNAPPY sets its level
      const m = tuned(p[0], 0.6), tn = p[1];
      return [osc(300 * m, 190 * m, 0.02, l * 0.45, 0.07), osc(520 * m, 340 * m, 0.02, l * 0.2, 0.05),
        noise(F_HP, 200, 0.02, l * 0.5, 0.015), noise(F_HP, 500, 0.4, l * 1.1 * p[2], 0.16 + 0.14 * tn, { lp: 5000 + 13000 * tn })];
    }
    case 'LT': case 'MT': case 'HT': {
      const fr = { LT: 95, MT: 140, HT: 200 }[v] * tuned(p[0], 1), d = 0.15 + 0.7 * p[1];
      return [osc(fr * 1.6, fr, 0.08, l * 0.8, d), noise(F_LP, fr * 8, 0.05, l * 0.12, 0.05)];
    }
    case 'RS': // two resonant pings (1 ms of noise into a Q 30 bandpass) and a tick
      return [noise(F_BP, 500, 0.001, l * 24, 0.04, { fq: 30 }), noise(F_BP, 1700, 0.001, l * 16, 0.025, { fq: 30 }),
        noise(F_HP, 4000, 0.004, l * 0.3, 0.004)];
    case 'CP': // bandpassed noise hit four times 11 ms apart, then a reverb-like tail
      return [noise(F_BP, 1140, 0.05, l * 4, 0.006, { fq: 2, env: E_BURST }),
        noise(F_BP, 1140, 0.3, l * 1.6, 0.25, { fq: 2, delay: 0.033 })];
    case 'CH': return [pcm(0, tuned(p[0], 1), l * 0.7, 0.03 + 0.12 * p[1], 1)];
    case 'OH': return [pcm(0, tuned(p[0], 1), l * 0.7, 0.15 + 0.75 * p[1], 1)];
    case 'CR': return [pcm(1, tuned(p[0], 1), l * 0.6, 2)];
    case 'RD': return [pcm(2, tuned(p[0], 1), l * 0.6, 1.8)];
  }
}

// ---- ROM ----
// Stand-in for the cymbal ROMs. A real cymbal is a dense set of inharmonic partials, the high ones dying
// first, over noise; that is rendered here (seeded, so every load sounds the same), highpassed and quantised
// to 6 bits at 18 kHz. Drum909 plays it back with a zero-order hold, as the 909's DAC does
interface Metal { dur: number; n: number; lo: number; hi: number; ring: number; bell?: number[]; noise: number; crash?: number; hp: number }
const METALS: Metal[] = [
  // 909 hats and ride have marked resonances between 3 and 5 kHz (DJ TechTools / Hannes Bieger)
  { dur: 0.9, n: 60, lo: 2500, hi: 8800, ring: 0.3, bell: [3350, 4100, 4750], noise: 0.5, hp: 2500 },        // HH
  { dur: 2, n: 90, lo: 450, hi: 8800, ring: 0.9, noise: 0.6, crash: 1.2, hp: 1800 },                         // CR
  { dur: 1.8, n: 60, lo: 2000, hi: 8800, ring: 0.6, bell: [3150, 3600, 4200, 4900], noise: 0.15, hp: 1500 }, // RD
];
const hipass = (f: number, fs: number) => { // RBJ highpass, Q 1/sqrt2
  const w = 2 * Math.PI * f / fs, al = Math.sin(w) / Math.SQRT2, c = Math.cos(w), a0 = 1 + al;
  const b0 = (1 + c) / 2 / a0, b1 = -(1 + c) / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x: number) => { const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
};
function metal({ dur, n: np, lo, hi, ring, bell = [], noise, crash = 0, hp }: Metal): Int8Array {
  let seed = 909;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const parts = [
    ...Array.from({ length: np }, () => { const f = lo * (hi / lo) ** rnd(); return [f, 0.5 + rnd(), ring * Math.sqrt(lo / f) * (0.6 + 0.8 * rnd())]; }),
    ...bell.map(f => [f, 3, ring * 2]),
  ].map(([f, a, d]) => ({ w: 2 * Math.PI * f / PCM_RATE, a, k: Math.exp(-1 / (d * PCM_RATE)), ph: rnd() * 6.28 }));
  const n = dur * PCM_RATE | 0, v = new Float64Array(n), h1 = hipass(hp, PCM_RATE), h2 = hipass(hp, PCM_RATE);
  let pk = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (const p of parts) { m += p.a * Math.sin(p.w * i + p.ph); p.a *= p.k; }
    const t = i / PCM_RATE, nz = (rnd() * 2 - 1) * (noise * Math.exp(-t / ring) + crash * Math.exp(-t / 0.04));
    v[i] = h2(h1(m / Math.sqrt(parts.length) + nz));
    pk = Math.max(pk, Math.abs(v[i]));
  }
  return Int8Array.from(v, x => Math.round(x / pk * 31));
}
// All three ROMs back to back, and each one's length
export function makeRom(): { data: Int8Array; lens: number[] } {
  const roms = METALS.map(metal), data = new Int8Array(roms.reduce((a, r) => a + r.length, 0));
  roms.reduce((off, r) => { data.set(r, off); return off + r.length; }, 0);
  return { data, lens: roms.map(r => r.length) };
}

// ---- Renderer ----
export class Drum909 {
  private fs: number;
  private rom: Int8Array = new Int8Array(0); private romOff = [0, 0, 0]; private romLen = [0, 0, 0];
  private noiseState = 0x9091909;
  private chokeK: number;
  // component slots (struct of arrays, like the AssemblyScript port)
  private on = new Int32Array(MAX_COMPS); private kind = new Int32Array(MAX_COMPS); private n = new Int32Array(MAX_COMPS);
  private delay = new Int32Array(MAX_COMPS); private life = new Int32Array(MAX_COMPS); private src = new Int32Array(MAX_COMPS);
  private wave = new Int32Array(MAX_COMPS); private envMode = new Int32Array(MAX_COMPS); private group = new Int32Array(MAX_COMPS);
  private choking = new Int32Array(MAX_COMPS); private glideN = new Int32Array(MAX_COMPS); private hasLp = new Int32Array(MAX_COMPS);
  private romIdx = new Int32Array(MAX_COMPS); private burstGap = new Int32Array(MAX_COMPS);
  private freq = new Float64Array(MAX_COMPS); private f1 = new Float64Array(MAX_COMPS); private fMul = new Float64Array(MAX_COMPS);
  private fApp = new Float64Array(MAX_COMPS); private phase = new Float64Array(MAX_COMPS);
  private g = new Float64Array(MAX_COMPS); private gK = new Float64Array(MAX_COMPS); private peak = new Float64Array(MAX_COMPS);
  private pos = new Float64Array(MAX_COMPS); private step = new Float64Array(MAX_COMPS);
  // two biquads per slot: coefficients b0 b1 b2 a1 a2 and state x1 x2 y1 y2
  private bq = new Float64Array(MAX_COMPS * 18);
  private next = 0;

  constructor(sampleRate: number) {
    this.fs = sampleRate;
    this.chokeK = Math.exp(-1 / (CHOKE_TAU * sampleRate));
  }

  setRom(data: Int8Array, lens: number[]): void { // makeRom() output
    this.rom = data;
    let off = 0;
    for (let i = 0; i < 3; i++) { this.romOff[i] = off; this.romLen[i] = lens[i]; off += lens[i]; }
  }

  // Cut every ringing component of a group (the 909's hats share one voice)
  choke(group: number): void {
    for (let s = 0; s < MAX_COMPS; s++) if (this.on[s] !== 0 && this.group[s] === group) this.choking[s] = 1;
  }

  add(kind: number, delay: number, dur: number, wave: number, f0: number, f1: number, glide: number,
    ft: number, ff: number, fq: number, lp: number, rom: number, rate: number,
    env: number, peak: number, dec: number, group: number): void {
    if (peak <= 0) return;
    const fs = this.fs;
    let s = -1;
    for (let i = 0; i < MAX_COMPS; i++) if (this.on[i] === 0) { s = i; break; }
    if (s < 0) { s = this.next; this.next = (this.next + 1) % MAX_COMPS; } // all busy: steal round-robin
    this.on[s] = 1; this.kind[s] = kind; this.n[s] = 0; this.group[s] = group; this.choking[s] = 0;
    this.delay[s] = Math.round(delay * fs);
    this.src[s] = Math.round(dur * fs);
    this.life[s] = Math.round(Math.max(dur, dec) * fs);
    this.wave[s] = wave; this.envMode[s] = env; this.peak[s] = peak; this.g[s] = peak;
    if (env === E_BURST) { this.gK[s] = Math.exp(-1 / (dec * fs)); this.burstGap[s] = Math.round(BURST_GAP * fs); this.life[s] = Math.round(dur * fs); }
    else this.gK[s] = Math.pow(0.001 / peak, 1 / (dec * fs));
    this.freq[s] = f0; this.f1[s] = f1; this.phase[s] = 0;
    if (glide > 0) { this.glideN[s] = Math.round(glide * fs); this.fMul[s] = Math.pow(f1 / f0, 1 / (glide * fs)); this.fApp[s] = 0; }
    else { this.glideN[s] = 0; this.fMul[s] = 1; this.fApp[s] = glide < 0 ? 1 - Math.exp(1 / (glide * fs)) : 0; }
    this.romIdx[s] = rom; this.pos[s] = 0; this.step[s] = rate * PCM_RATE / fs;
    this.setBiquad(s * 18, ft, ff, fq);
    this.hasLp[s] = lp > 0 ? 1 : 0;
    if (lp > 0) this.setBiquad(s * 18 + 9, F_LP, lp, 1);
  }

  // BiquadFilterNode coefficients (Web Audio spec): lowpass / highpass Q in dB, bandpass Q linear
  private setBiquad(o: number, type: number, f: number, q: number): void {
    const b = this.bq;
    for (let i = 0; i < 9; i++) b[o + i] = 0;
    if (type === F_NONE) { b[o] = 1; return; }
    const w = 2 * Math.PI * Math.min(f, this.fs / 2) / this.fs, c = Math.cos(w), sn = Math.sin(w);
    const al = type === F_BP ? sn / (2 * q) : sn / (2 * Math.pow(10, q / 20));
    const a0 = 1 + al;
    if (type === F_LP) { b[o] = (1 - c) / 2 / a0; b[o + 1] = (1 - c) / a0; b[o + 2] = (1 - c) / 2 / a0; }
    else if (type === F_HP) { b[o] = (1 + c) / 2 / a0; b[o + 1] = -(1 + c) / a0; b[o + 2] = (1 + c) / 2 / a0; }
    else { b[o] = al / a0; b[o + 1] = 0; b[o + 2] = -al / a0; }
    b[o + 3] = -2 * c / a0; b[o + 4] = (1 - al) / a0;
  }

  private biquad(o: number, x: number): number {
    const b = this.bq;
    const y = b[o] * x + b[o + 1] * b[o + 5] + b[o + 2] * b[o + 6] - b[o + 3] * b[o + 7] - b[o + 4] * b[o + 8];
    b[o + 6] = b[o + 5]; b[o + 5] = x; b[o + 8] = b[o + 7]; b[o + 7] = y;
    return y;
  }

  // xorshift32 white noise in -1..1
  private white(): number {
    let x = this.noiseState;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.noiseState = x;
    return (x >>> 0) / 4294967296 * 2 - 1;
  }

  render(out: Float32Array, offset: number, n: number): void {
    for (let i = 0; i < n; i++) out[offset + i] = 0;
    for (let s = 0; s < MAX_COMPS; s++) {
      if (this.on[s] === 0) continue;
      for (let i = 0; i < n; i++) {
        if (this.delay[s] > 0) { this.delay[s]--; continue; }
        const k = this.n[s];
        let x = 0;
        if (this.kind[s] === K_OSC) {
          const dt = this.freq[s] / this.fs;
          this.phase[s] += dt;
          if (this.phase[s] >= 1) this.phase[s] -= 1;
          const ph = this.phase[s];
          if (this.wave[s] === W_SINE) x = Math.sin(2 * Math.PI * ph);
          else x = (ph < 0.5 ? 1 : -1) + polyBlep(ph, dt) - polyBlep(ph + 0.5 >= 1 ? ph - 0.5 : ph + 0.5, dt);
          if (this.glideN[s] > 0) { this.freq[s] *= this.fMul[s]; if (--this.glideN[s] === 0) this.freq[s] = this.f1[s]; }
          else this.freq[s] += (this.f1[s] - this.freq[s]) * this.fApp[s];
        } else if (this.kind[s] === K_NOISE) {
          x = this.biquad(s * 18, k < this.src[s] ? this.white() : 0);
          if (this.hasLp[s] !== 0) x = this.biquad(s * 18 + 9, x);
        } else {
          const p = Math.floor(this.pos[s]);
          if (p < this.romLen[this.romIdx[s]]) x = this.rom[this.romOff[this.romIdx[s]] + p] / 31;
          this.pos[s] += this.step[s];
        }
        if (this.envMode[s] === E_BURST && k > 0 && k % this.burstGap[s] === 0 && k / this.burstGap[s] < BURSTS) this.g[s] = this.peak[s];
        out[offset + i] += x * this.g[s];
        this.g[s] *= this.choking[s] !== 0 ? this.chokeK : this.gK[s];
        this.n[s] = k + 1;
        if (k + 1 >= this.life[s]) { this.on[s] = 0; break; }
      }
    }
  }
}

function polyBlep(t: number, dt: number): number {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
