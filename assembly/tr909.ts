// AssemblyScript port of Drum909 in src/dsp/tr909.ts (the renderer only; recipes and the ROM are made in
// TS and handed over). Keep the two in sync; src/dsp/tr909.test.ts renders both from the same hits and
// checks they match

const PCM_RATE: f64 = 18000;
const K_OSC = 0;
const K_NOISE = 1;
const W_SINE = 0;
const F_NONE = 0;
const F_LP = 1;
const F_HP = 2;
const F_BP = 3;
const E_BURST = 1;
const MAX_COMPS = 48;
const BURSTS = 4;
const BURST_GAP: f64 = 0.011;
const CHOKE_TAU: f64 = 0.005;
const ROM_MAX = 84600; // HH 0.9 s + CR 2 s + RD 1.8 s at 18 kHz

const out = new StaticArray<f32>(128);
const rom = new StaticArray<i8>(ROM_MAX);
const romOff = new StaticArray<i32>(3);
const romLen = new StaticArray<i32>(3);

let fs: f64 = 48000;
let noiseState: u32 = 0x9091909;
let chokeK: f64 = 0;
let next = 0;

const on = new StaticArray<i32>(MAX_COMPS);
const kind = new StaticArray<i32>(MAX_COMPS);
const cn = new StaticArray<i32>(MAX_COMPS);
const delay = new StaticArray<i32>(MAX_COMPS);
const life = new StaticArray<i32>(MAX_COMPS);
const src = new StaticArray<i32>(MAX_COMPS);
const wave = new StaticArray<i32>(MAX_COMPS);
const envMode = new StaticArray<i32>(MAX_COMPS);
const group = new StaticArray<i32>(MAX_COMPS);
const choking = new StaticArray<i32>(MAX_COMPS);
const glideN = new StaticArray<i32>(MAX_COMPS);
const hasLp = new StaticArray<i32>(MAX_COMPS);
const romIdx = new StaticArray<i32>(MAX_COMPS);
const burstGap = new StaticArray<i32>(MAX_COMPS);
const freq = new StaticArray<f64>(MAX_COMPS);
const f1s = new StaticArray<f64>(MAX_COMPS);
const fMul = new StaticArray<f64>(MAX_COMPS);
const fApp = new StaticArray<f64>(MAX_COMPS);
const phase = new StaticArray<f64>(MAX_COMPS);
const g = new StaticArray<f64>(MAX_COMPS);
const gK = new StaticArray<f64>(MAX_COMPS);
const peaks = new StaticArray<f64>(MAX_COMPS);
const pos = new StaticArray<f64>(MAX_COMPS);
const step = new StaticArray<f64>(MAX_COMPS);
const bq = new StaticArray<f64>(MAX_COMPS * 18);

export function init(sampleRate: f64): void {
  fs = sampleRate;
  chokeK = Math.exp(-1 / (CHOKE_TAU * sampleRate));
}

export function outPtr(): usize { return changetype<usize>(out); }
export function romPtr(): usize { return changetype<usize>(rom); }

export function setRom(l0: i32, l1: i32, l2: i32): void {
  romOff[0] = 0; romLen[0] = l0;
  romOff[1] = l0; romLen[1] = l1;
  romOff[2] = l0 + l1; romLen[2] = l2;
}

export function choke(grp: i32): void {
  for (let s = 0; s < MAX_COMPS; s++) if (on[s] != 0 && group[s] == grp) choking[s] = 1;
}

export function add(kd: i32, dl: f64, dur: f64, wv: i32, f0: f64, f1: f64, glide: f64,
  ft: i32, ff: f64, fq: f64, lp: f64, rm: i32, rate: f64,
  env: i32, peak: f64, dec: f64, grp: i32): void {
  if (peak <= 0) return;
  let s = -1;
  for (let i = 0; i < MAX_COMPS; i++) if (on[i] == 0) { s = i; break; }
  if (s < 0) { s = next; next = (next + 1) % MAX_COMPS; }
  on[s] = 1; kind[s] = kd; cn[s] = 0; group[s] = grp; choking[s] = 0;
  delay[s] = <i32>Math.round(dl * fs);
  src[s] = <i32>Math.round(dur * fs);
  life[s] = <i32>Math.round(Math.max(dur, dec) * fs);
  wave[s] = wv; envMode[s] = env; peaks[s] = peak; g[s] = peak;
  if (env == E_BURST) { gK[s] = Math.exp(-1 / (dec * fs)); burstGap[s] = <i32>Math.round(BURST_GAP * fs); life[s] = <i32>Math.round(dur * fs); }
  else gK[s] = Math.pow(0.001 / peak, 1 / (dec * fs));
  freq[s] = f0; f1s[s] = f1; phase[s] = 0;
  if (glide > 0) { glideN[s] = <i32>Math.round(glide * fs); fMul[s] = Math.pow(f1 / f0, 1 / (glide * fs)); fApp[s] = 0; }
  else { glideN[s] = 0; fMul[s] = 1; fApp[s] = glide < 0 ? 1 - Math.exp(1 / (glide * fs)) : 0; }
  romIdx[s] = rm; pos[s] = 0; step[s] = rate * PCM_RATE / fs;
  setBiquad(s * 18, ft, ff, fq);
  hasLp[s] = lp > 0 ? 1 : 0;
  if (lp > 0) setBiquad(s * 18 + 9, F_LP, lp, 1);
}

function setBiquad(o: i32, type: i32, f: f64, q: f64): void {
  for (let i = 0; i < 9; i++) bq[o + i] = 0;
  if (type == F_NONE) { bq[o] = 1; return; }
  const w: f64 = 2 * Math.PI * Math.min(f, fs / 2) / fs; const c: f64 = Math.cos(w); const sn: f64 = Math.sin(w);
  const al: f64 = type == F_BP ? sn / (2 * q) : sn / (2 * Math.pow(10, q / 20));
  const a0: f64 = 1 + al;
  if (type == F_LP) { bq[o] = (1 - c) / 2 / a0; bq[o + 1] = (1 - c) / a0; bq[o + 2] = (1 - c) / 2 / a0; }
  else if (type == F_HP) { bq[o] = (1 + c) / 2 / a0; bq[o + 1] = -(1 + c) / a0; bq[o + 2] = (1 + c) / 2 / a0; }
  else { bq[o] = al / a0; bq[o + 1] = 0; bq[o + 2] = -al / a0; }
  bq[o + 3] = -2 * c / a0; bq[o + 4] = (1 - al) / a0;
}

function biquad(o: i32, x: f64): f64 {
  const y: f64 = bq[o] * x + bq[o + 1] * bq[o + 5] + bq[o + 2] * bq[o + 6] - bq[o + 3] * bq[o + 7] - bq[o + 4] * bq[o + 8];
  bq[o + 6] = bq[o + 5]; bq[o + 5] = x; bq[o + 8] = bq[o + 7]; bq[o + 7] = y;
  return y;
}

function white(): f64 {
  let x = noiseState;
  x ^= x << 13; x ^= x >> 17; x ^= x << 5;
  noiseState = x;
  return <f64>x / 4294967296 * 2 - 1;
}

function polyBlep(t: f64, dt: f64): f64 {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

// Renders n (<= 128) samples into the buffer at outPtr()
export function render(n: i32): void {
  for (let i = 0; i < n; i++) unchecked(out[i] = 0);
  for (let s = 0; s < MAX_COMPS; s++) {
    if (on[s] == 0) continue;
    for (let i = 0; i < n; i++) {
      if (delay[s] > 0) { delay[s]--; continue; }
      const k = cn[s];
      let x: f64 = 0;
      if (kind[s] == K_OSC) {
        const dt: f64 = freq[s] / fs;
        phase[s] += dt;
        if (phase[s] >= 1) phase[s] -= 1;
        const ph = phase[s];
        if (wave[s] == W_SINE) x = Math.sin(2 * Math.PI * ph);
        else x = (ph < 0.5 ? 1.0 : -1.0) + polyBlep(ph, dt) - polyBlep(ph + 0.5 >= 1 ? ph - 0.5 : ph + 0.5, dt);
        if (glideN[s] > 0) { freq[s] *= fMul[s]; glideN[s]--; if (glideN[s] == 0) freq[s] = f1s[s]; }
        else freq[s] += (f1s[s] - freq[s]) * fApp[s];
      } else if (kind[s] == K_NOISE) {
        x = biquad(s * 18, k < src[s] ? white() : 0);
        if (hasLp[s] != 0) x = biquad(s * 18 + 9, x);
      } else {
        const p = <i32>Math.floor(pos[s]);
        if (p < romLen[romIdx[s]]) x = <f64>rom[romOff[romIdx[s]] + p] / 31;
        pos[s] += step[s];
      }
      if (envMode[s] == E_BURST && k > 0 && k % burstGap[s] == 0 && k / burstGap[s] < BURSTS) g[s] = peaks[s];
      unchecked(out[i] = <f32>(<f64>out[i] + x * g[s]));
      g[s] *= choking[s] != 0 ? chokeK : gK[s];
      cn[s] = k + 1;
      if (k + 1 >= life[s]) { on[s] = 0; break; }
    }
  }
}
