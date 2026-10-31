// AssemblyScript port of src/dsp/tr808.ts (one 808 per instance). Keep the two in sync;
// src/dsp/tr808.test.ts renders both from the same events and checks they match

const LN10: f64 = 2.302585092994046;
const ATTACK: f64 = 0.0003;
const LP = 0, BP = 1, HP = 2;
const SAT: f64 = 2;

const ACC_N: StaticArray<f64> = [3.5, 3, 3.5, 3, 3.5, 3.5, 3, 3.5, 3, 2.5, 3, 3, 3.5, 3.5, 3.5, 3];
const ACC_X: StaticArray<f64> = [10, 10, 12, 11, 12, 12, 10, 12, 10, 8, 9, 5, 12, 7, 7, 6];
const TOMS: StaticArray<f64> = [80, 90, 100, 0.2, 120, 135, 160, 0.13, 165, 185, 220, 0.1, 165, 185, 220, 0.18, 250, 280, 310, 0.1, 370, 400, 455, 0.08];
const METAL: StaticArray<f64> = [205.3, 304.4, 369.6, 522.7, 540, 800];

function sat(x: f64): f64 { return SAT * Math.tanh(x / SAT); }
function k20(fs: f64, dec: f64): f64 { return Math.exp(-LN10 / (dec * fs)); }
function span(p: f64, a: f64, b: f64, c: f64): f64 { return p < 0.5 ? a * Math.pow(b / a, 2 * p) : b * Math.pow(c / b, 2 * p - 1); }

class Res {
  y1: f64 = 0; y2: f64 = 0; x: f64 = 0; r: f64 = 0; f: f64 = 100; bend: f64 = 0; bk: f64 = 0; ad: f64 = 0; lvl: f64 = 0; ref: f64 = 1; fs: f64;
  constructor(fs: f64) { this.fs = fs; }
  strike(peak: f64, f: f64, dec: f64, bend: f64, bendTau: f64, ad: f64): void {
    this.r = k20(this.fs, dec); this.f = f; this.bend = bend; this.bk = Math.exp(-1 / (bendTau * this.fs)); this.ad = ad;
    this.lvl += peak; this.ref = this.lvl;
    this.x += peak * Math.sin(2 * Math.PI * f * (1 + bend + ad) / this.fs);
  }
  tick(): f64 {
    const w = 2 * Math.PI * this.f * (1 + this.bend + this.ad * this.lvl / this.ref) / this.fs;
    const y = 2 * this.r * Math.cos(w) * this.y1 - this.r * this.r * this.y2 + this.x;
    this.x = 0; this.y2 = this.y1; this.y1 = y;
    this.lvl *= this.r; this.bend *= this.bk;
    return y;
  }
}

class Env {
  e: f64 = 0; h: f64 = 0; k: f64 = 1; a: f64 = 1; fs: f64;
  constructor(fs: f64) { this.fs = fs; }
  trig(peak: f64, dec: f64, attack: f64): void { this.h = peak; this.k = k20(this.fs, dec); this.a = 1 - Math.exp(-1 / (attack * this.fs)); }
  cut(): void { this.h = 0; }
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
let fs: f64 = 48000;
let seed: u32 = 0x808808;
let bd!: Res, sdLo!: Res, sdHi!: Res, tom0!: Res, tom1!: Res, tom2!: Res, rs1!: Res, rs2!: Res, cl!: Res;
let sdN!: Svf, tomN0!: Svf, tomN1!: Svf, tomN2!: Svf, cpF!: Svf, maF!: Svf, cbF!: Svf;
let loF!: Svf, hiF!: Svf, cyLoF!: Svf, cyMidF!: Svf, cyHiF!: Svf, ohF!: Svf, chF!: Svf;
let sdE!: Env, tomE0!: Env, tomE1!: Env, tomE2!: Env, cpRev!: Env, maE!: Env, cbFast!: Env, cbSlow!: Env;
let cyLoE!: Env, cyMidE!: Env, cyHiE!: Env, ohE!: Env, chE!: Env;
let bdY: f64 = 0, bdG: f64 = 1, click: f64 = 0, clickN: i32 = 0;
let cpN: i32 = -1, cpG: f64 = 0, cpPk: f64 = 0, cpK: f64 = 0, cpGap: i32 = 1;

export function init(sampleRate: f64): void {
  fs = sampleRate;
  bd = new Res(fs); sdLo = new Res(fs); sdHi = new Res(fs);
  sdN = new Svf(fs, 2750, 0.73, HP); sdE = new Env(fs);
  tom0 = new Res(fs); tom1 = new Res(fs); tom2 = new Res(fs);
  tomN0 = new Svf(fs, 400, 0.7, LP); tomN1 = new Svf(fs, 480, 0.7, LP); tomN2 = new Svf(fs, 720, 0.7, LP);
  tomE0 = new Env(fs); tomE1 = new Env(fs); tomE2 = new Env(fs);
  rs1 = new Res(fs); rs2 = new Res(fs); cl = new Res(fs);
  cpF = new Svf(fs, 1070, 2, BP); cpRev = new Env(fs);
  cpK = Math.exp(-1 / (0.0025 * fs)); cpGap = <i32>Math.round(0.01 * fs);
  maF = new Svf(fs, 7000, 0.7, HP); maE = new Env(fs);
  cbF = new Svf(fs, 900, 2, BP); cbFast = new Env(fs); cbSlow = new Env(fs);
  loF = new Svf(fs, 3440, 1.5, BP); hiF = new Svf(fs, 7100, 1.5, BP);
  cyLoF = new Svf(fs, 2500, 0.7, HP); cyMidF = new Svf(fs, 5000, 0.7, HP); cyHiF = new Svf(fs, 10500, 2, HP);
  ohF = new Svf(fs, 7800, 2.5, HP); chF = new Svf(fs, 11700, 2.5, HP);
  cyLoE = new Env(fs); cyMidE = new Env(fs); cyHiE = new Env(fs); ohE = new Env(fs); chE = new Env(fs);
  for (let i = 0; i < 6; i++) dts[i] = METAL[i] / fs;
}

export function outPtr(): usize { return changetype<usize>(out); }

function tomRes(i: i32): Res { return i == 0 ? tom0 : i == 1 ? tom1 : tom2; }
function tomEnv(i: i32): Env { return i == 0 ? tomE0 : i == 1 ? tomE1 : tomE2; }

export function trig(v: i32, l: f64, a: f64, p0: f64, p1: f64): void {
  const g = l * (ACC_N[v] + a * (ACC_X[v] - ACC_N[v])) / 10;
  if (g <= 0) return;
  if (v == 0) {
    bd.strike(g, 50, span(p1, 0.05, 0.3, 0.8), 1.6, 0.002, 0.06);
    click = g * 0.4; clickN = <i32>Math.round(0.001 * fs);
    bdG = 1 - Math.exp(-2 * Math.PI * span(p0, 300, 1500, 7000) / fs);
  } else if (v == 1) {
    sdLo.strike(g * (1 - 0.6 * p0), 238, 0.06, 0, 0.001, 0.02);
    sdHi.strike(g * (0.15 + 0.6 * p0), 476, 0.06, 0, 0.001, 0.02);
    sdE.trig(g * 1.6 * p1, 0.15, ATTACK);
  } else if (v <= 7) {
    const t = (v - 2) * 4, i = (v - 2) % 3;
    tomRes(i).strike(g, span(p0, TOMS[t], TOMS[t + 1], TOMS[t + 2]), TOMS[t + 3], 0, 0.001, 0.12);
    if (v <= 4) tomEnv(i).trig(g * 0.25, TOMS[t + 3] * 0.6, ATTACK);
  } else if (v == 8) { rs1.strike(g, 455, 0.01, 0, 0.001, 0); rs2.strike(g * 0.6, 1667, 0.01, 0, 0.001, 0); }
  else if (v == 9) cl.strike(g, 2500, 0.025, 0, 0.001, 0);
  else if (v == 10) { cpN = 0; cpPk = g * 2.5; cpRev.trig(g * 1.2, 0.12, 0.004); }
  else if (v == 11) maE.trig(g * 1.5, 0.03, 0.002);
  else if (v == 12) { cbFast.trig(g * 0.25, 0.02, ATTACK); cbSlow.trig(g * 0.1, 0.1, ATTACK); }
  else if (v == 13) {
    const d = span(p1, 0.35, 0.8, 1.2);
    cyLoE.trig(g * 0.5, d, ATTACK); cyMidE.trig(g * 0.5, d * 0.6, ATTACK); cyHiE.trig(g * (0.1 + 0.9 * p0), 0.15, ATTACK);
  } else if (v == 14) ohE.trig(g, span(p0, 0.09, 0.45, 0.6), ATTACK);
  else { chE.trig(g * 2, 0.05, ATTACK); ohE.cut(); }
}

export function render(n: i32): void {
  for (let i = 0; i < n; i++) {
    let s = seed;
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    seed = s;
    const nz = <f64>s / 4294967296 * 2 - 1;
    let metal: f64 = 0, cb: f64 = 0;
    for (let j = 0; j < 6; j++) {
      const p = ph[j], dt = dts[j];
      let q = p + 0.5; if (q >= 1) q -= 1;
      const sq = (p < 0.5 ? 1.0 : -1.0) + blep(p, dt) - blep(q, dt);
      metal += sq;
      if (j >= 4) cb += sq;
      let np = p + dt; if (np >= 1) np -= 1;
      ph[j] = np;
    }
    let x = bd.tick();
    if (clickN > 0) { x += click; clickN--; }
    bdY += (x - bdY) * bdG;
    let cpB: f64 = 0;
    if (cpN >= 0 && cpN < 3 * cpGap) {
      if (cpN % cpGap == 0) cpG = cpPk;
      cpB = cpG; cpG *= cpK; cpN++;
    }
    const lo = loF.tick(metal), hi = hiF.tick(metal);
    out[i] = <f32>(bdY
      + sdLo.tick() + sdHi.tick() + sdN.tick(nz) * sdE.tick()
      + tom0.tick() + tom1.tick() + tom2.tick()
      + tomN0.tick(nz) * tomE0.tick() + tomN1.tick(nz) * tomE1.tick() + tomN2.tick(nz) * tomE2.tick()
      + Math.tanh(2 * (rs1.tick() + rs2.tick())) * 0.5 + cl.tick()
      + cpF.tick(nz) * (cpB + cpRev.tick()) + maF.tick(nz) * maE.tick()
      + cbF.tick(cb) * (cbFast.tick() + cbSlow.tick())
      + sat(cyLoF.tick(lo)) * cyLoE.tick() + sat(cyMidF.tick(hi)) * cyMidE.tick() + sat(cyHiF.tick(hi)) * cyHiE.tick()
      + sat(ohF.tick(hi)) * ohE.tick() + sat(chF.tick(hi)) * chE.tick());
  }
}
