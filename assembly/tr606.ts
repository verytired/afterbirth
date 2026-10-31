// AssemblyScript port of src/dsp/tr606.ts (one 606 per instance). Keep the two in sync;
// src/dsp/tr606.test.ts renders both from the same events and checks they match

const BD = 0, SD = 1, LT = 2, HT = 3, CY = 4, CH = 5, OH = 6;
const LN1000: f64 = 6.907755278982137;
const ATTACK: f64 = 0.0003;
const LP = 0, BP = 1, HP = 2;
const SAT: f64 = 2;

function sat(x: f64): f64 { return SAT * Math.tanh(x / SAT); }

function coef(fs: f64, dec: f64): f64 { return Math.exp(-LN1000 / (dec * fs)); }

class Res {
  y1: f64 = 0; y2: f64 = 0; x: f64 = 0; a1: f64; a2: f64; s: f64;
  constructor(fs: f64, f: f64, dec: f64) {
    const r = coef(fs, dec), w = 2 * Math.PI * f / fs;
    this.a1 = 2 * r * Math.cos(w); this.a2 = r * r; this.s = Math.sin(w);
  }
  strike(peak: f64): void { this.x += peak * this.s; }
  tick(): f64 {
    const y = this.a1 * this.y1 - this.a2 * this.y2 + this.x;
    this.x = 0; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

class Env {
  e: f64 = 0; h: f64 = 0; k: f64 = 1; a: f64; fs: f64;
  constructor(fs: f64) { this.fs = fs; this.a = 1 - Math.exp(-1 / (ATTACK * fs)); }
  trig(peak: f64, dec: f64): void { this.h = peak; this.k = coef(this.fs, dec); }
  tick(): f64 { this.h *= this.k; this.e += (this.h - this.e) * this.a; return this.e; }
}

class Svf {
  ic1: f64 = 0; ic2: f64 = 0; k: f64; a1: f64; a2: f64; a3: f64; mode: i32;
  constructor(fs: f64, f: f64, q: f64, mode: i32) {
    const g = Math.tan(Math.PI * f / fs);
    this.mode = mode;
    this.k = 1 / q; this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  }
  tick(x: f64): f64 {
    const v3 = x - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    return this.mode == LP ? v2 : this.mode == BP ? v1 : x - this.k * v1 - v2;
  }
}

function blep(t: f64, dt: f64): f64 {
  if (t < dt) { const u = t / dt; return u + u - u * u - 1; }
  if (t > 1 - dt) { const u = (t - 1) / dt; return u * u + u + u + 1; }
  return 0;
}

const out = new StaticArray<f32>(128);
const ph = new StaticArray<f64>(6);
const dts = new StaticArray<f64>(6);
let seed: u32 = 0x12345678;
let bd1!: Res, bd2!: Res, sd!: Res, lt!: Res, ht!: Res;
let sdN!: Svf, ltN!: Svf, htN!: Svf, hatF!: Svf, cyLoF!: Svf, cyHiF!: Svf;
let sdE!: Env, ltE!: Env, htE!: Env, hatE!: Env, cyLoE!: Env, cyHiE!: Env;

export function init(fs: f64): void {
  bd1 = new Res(fs, 60, 0.32); bd2 = new Res(fs, 130, 0.05); sd = new Res(fs, 230, 0.07);
  lt = new Res(fs, 150, 0.25); ht = new Res(fs, 220, 0.2);
  sdN = new Svf(fs, 1500, 1, HP); ltN = new Svf(fs, 700, 1, LP); htN = new Svf(fs, 900, 1, LP);
  hatF = new Svf(fs, 7500, 1, HP); cyLoF = new Svf(fs, 3800, 1.2, BP); cyHiF = new Svf(fs, 7800, 1.2, BP);
  sdE = new Env(fs); ltE = new Env(fs); htE = new Env(fs); hatE = new Env(fs); cyLoE = new Env(fs); cyHiE = new Env(fs);
  dts[0] = 245 / fs; dts[1] = 306 / fs; dts[2] = 365 / fs; dts[3] = 415 / fs; dts[4] = 437 / fs; dts[5] = 619 / fs;
}

export function outPtr(): usize { return changetype<usize>(out); }

export function trig(v: i32, l: f64, step: f64): void {
  if (v == BD) { bd1.strike(l * 0.85); bd2.strike(l * 0.35); }
  else if (v == SD) { sd.strike(l * 0.45); sdE.trig(l * 0.6, 0.18); }
  else if (v == LT) { lt.strike(l * 0.75); ltE.trig(l * 0.12, 0.3); }
  else if (v == HT) { ht.strike(l * 0.75); htE.trig(l * 0.12, 0.25); }
  else if (v == CY) { cyLoE.trig(l * 0.2, 0.3); cyHiE.trig(l * 0.25, 1.1); }
  else if (v == CH) hatE.trig(l * 0.6, 0.04);
  else if (v == OH) hatE.trig(l * 0.6, step * 2.4);
}

export function render(n: i32): void {
  for (let i = 0; i < n; i++) {
    let s = seed;
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    seed = s;
    const nz = <f64>s / 4294967296 * 2 - 1;
    let metal: f64 = 0;
    for (let j = 0; j < 6; j++) {
      const p = ph[j], dt = dts[j];
      let q = p + 0.5; if (q >= 1) q -= 1;
      metal += (p < 0.5 ? 1.0 : -1.0) + blep(p, dt) - blep(q, dt);
      let np = p + dt; if (np >= 1) np -= 1;
      ph[j] = np;
    }
    out[i] = <f32>(bd1.tick() + bd2.tick() + sd.tick() + lt.tick() + ht.tick()
      + sdN.tick(nz) * sdE.tick() + ltN.tick(nz) * ltE.tick() + htN.tick(nz) * htE.tick()
      + sat(hatF.tick(metal)) * hatE.tick()
      + sat(cyLoF.tick(metal)) * cyLoE.tick() + sat(cyHiF.tick(metal)) * cyHiE.tick());
  }
}
