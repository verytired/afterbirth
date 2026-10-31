// AssemblyScript port of src/dsp/engine.ts (one voice per instance). Keep the two in sync;
// src/dsp/engine.test.ts renders both from the same events and checks they match

const P_CUTOFF = 0;
const P_RESO = 1;
const P_ENV = 2;
const P_DECAY = 3;
const P_ACCENT = 4;
const P_WAVE = 5;
const P_FILTER = 6;
const P_ACC_DECAY = 7;
const P_VEG_DECAY = 8;
const P_SOFT_ATTACK = 9;
const P_SLIDE_TIME = 10;
const P_SWEEP = 11;
const P_FILTER_FM = 12;
const P_TRACKING = 13;
const P_DRIVE = 14;
const P_MUFFLER = 15;

const OS = 2;
const SLIDE_TAU: f64 = 0.03;
const ATTACK_TAU: f64 = 0.002;
const RELEASE_TAU: f64 = 0.006;
const SWEEP_TAU: f64 = 0.4;
const GAIN: f64 = 0.55;
const LADDER_K: f64 = 3.8;
const DIODE_K: f64 = 17;
const LADDER_COMP: f64 = 0.5;
const DIODE_COMP: f64 = 0.6;

const out = new StaticArray<f32>(128);

let fs: f64 = 96000;
let cutoff: f64 = 0.3; let reso: f64 = 12; let env: f64 = 0.5; let decay: f64 = 0.9; let accent: f64 = 0.6; let wave: f64 = 0;
let filter: f64 = 0;
let fm: f64 = 0; let tracking: f64 = 0; let drive: f64 = 1; let muffler: f64 = 0; let accDecay: f64 = 0.05;
let phase: f64 = 0; let freq: f64 = 110; let target: f64 = 110; let sliding = false;
let amp: f64 = 0; let ampTarget: f64 = 0; let veg: f64 = 1; let vegK: f64 = 1; let yPrev: f64 = 0; let fenv: f64 = 0; let fenvK: f64 = 0; let envAmt: f64 = 0; let sweep: f64 = 0;
let l1: f64 = 0; let l2: f64 = 0; let l3: f64 = 0; let l4: f64 = 0; // ladder states
let d1: f64 = 0; let d2: f64 = 0; let d3: f64 = 0; let d4: f64 = 0; // diode ladder states
let kSlide: f64 = 0; let kAtt: f64 = 0; let kRel: f64 = 0; let kSweep: f64 = 0;

function decayTau(knob: f64): f64 { return 0.015 * Math.pow(40, (knob - 0.05) / 1.45); }
function accDecayTau(k: f64): f64 { return 0.05 * Math.pow(10, (k - 0.5) * 2); }
function attackTau(k: f64): f64 { return ATTACK_TAU * Math.pow(10, (k - 0.5) * 2); }
function slideTau(k: f64): f64 { return SLIDE_TAU * Math.pow(6, k); }
function sweepTau(k: f64): f64 { return SWEEP_TAU * Math.pow(4, (k - 0.5) * 2); }
function vegTau(k: f64): f64 { return 0.016 * Math.pow(200, k); }

function polyBlep(t: f64, dt: f64): f64 {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

function ladderTick(x: f64, g: f64, k: f64): f64 {
  const G: f64 = g / (1 + g);
  const sum: f64 = (((l1 * (1 - G)) * G + l2 * (1 - G)) * G + l3 * (1 - G)) * G + l4 * (1 - G);
  const G4: f64 = G * G * G * G;
  const u: f64 = Math.tanh((x - k * sum) / (1 + k * G4));
  let v: f64 = G * (u - l1); const y1: f64 = v + l1; l1 = y1 + v;
  v = G * (y1 - l2); const y2: f64 = v + l2; l2 = y2 + v;
  v = G * (y2 - l3); const y3: f64 = v + l3; l3 = y3 + v;
  v = G * (y3 - l4); const y4: f64 = v + l4; l4 = y4 + v;
  return y4;
}

function diodeTick(x: f64, g: f64, k: f64): f64 {
  const d: f64 = 1 + 2 * g;
  const c1: f64 = -g / d; const m2: f64 = d + g * c1;
  const c2: f64 = -g / m2; const m3: f64 = d + g * c2;
  const c3: f64 = -g / m3; const m4: f64 = 1 + g + g * c3;
  const p1: f64 = (d1 + g * x) / d;
  const p2: f64 = (d2 + g * p1) / m2;
  const p3: f64 = (d3 + g * p2) / m3;
  const a4: f64 = (d4 + g * p3) / m4;
  const b4: f64 = g / d * g / m2 * g / m3 * g / m4;
  const u: f64 = Math.tanh(x - k * a4 / (1 + k * b4));
  const q1: f64 = (d1 + g * u) / d;
  const q2: f64 = (d2 + g * q1) / m2;
  const q3: f64 = (d3 + g * q2) / m3;
  const y4: f64 = (d4 + g * q3) / m4;
  const y3: f64 = q3 - c3 * y4;
  const y2: f64 = q2 - c2 * y3;
  const y1: f64 = q1 - c1 * y2;
  d1 = 2 * y1 - d1; d2 = 2 * y2 - d2; d3 = 2 * y3 - d3; d4 = 2 * y4 - d4;
  return y4;
}

export function init(sampleRate: f64): void {
  fs = sampleRate * OS;
  kSlide = 1 - Math.exp(-1 / (SLIDE_TAU * fs));
  kAtt = 1 - Math.exp(-1 / (ATTACK_TAU * fs));
  kRel = 1 - Math.exp(-1 / (RELEASE_TAU * fs));
  kSweep = Math.exp(-1 / (SWEEP_TAU * fs));
}

export function outPtr(): usize { return changetype<usize>(out); }

export function setParam(id: i32, v: f64): void {
  if (id == P_CUTOFF) cutoff = v;
  else if (id == P_RESO) reso = v;
  else if (id == P_ENV) env = v;
  else if (id == P_DECAY) decay = v;
  else if (id == P_ACCENT) accent = v;
  else if (id == P_WAVE) wave = v;
  else if (id == P_FILTER) filter = v;
  else if (id == P_ACC_DECAY) accDecay = accDecayTau(v);
  else if (id == P_VEG_DECAY) vegK = v >= 1 ? 1 : Math.exp(-1 / (vegTau(v) * fs));
  else if (id == P_SOFT_ATTACK) kAtt = 1 - Math.exp(-1 / (attackTau(v) * fs));
  else if (id == P_SLIDE_TIME) kSlide = 1 - Math.exp(-1 / (slideTau(v) * fs));
  else if (id == P_SWEEP) kSweep = Math.exp(-1 / (sweepTau(v) * fs));
  else if (id == P_FILTER_FM) fm = v;
  else if (id == P_TRACKING) tracking = v;
  else if (id == P_DRIVE) drive = Math.pow(10, v * 1.5);
  else if (id == P_MUFFLER) muffler = v;
}

export function noteOn(f: f64, acc: f64, slide: i32): void {
  target = f;
  if (slide != 0) { sliding = true; return; }
  sliding = false;
  freq = f;
  const a: f64 = acc != 0 ? accent : 0;
  if (a > 0) sweep = Math.min(1, sweep + 0.5 * a);
  envAmt = env * 10 * (1 + a * (1 + sweep));
  fenv = 1;
  fenvK = Math.exp(-1 / ((a > 0 ? accDecay : decayTau(decay)) * fs));
  veg = 1;
  ampTarget = 0.5 + 0.5 * a;
}

export function noteOff(): void { ampTarget = 0; }

// Renders n (<= 128) samples into the buffer at outPtr()
export function render(n: i32): void {
  const diode = filter >= 0.5;
  const k: f64 = (diode ? DIODE_K : LADDER_K) * reso / 20;
  const comp: f64 = 1 + k * (diode ? DIODE_COMP : LADDER_COMP);
  const base: f64 = 60 * Math.pow(100, cutoff);
  const maxFc: f64 = 0.45 * fs;
  for (let i = 0; i < n; i++) {
    let acc: f64 = 0;
    for (let o = 0; o < OS; o++) {
      if (sliding) freq += (target - freq) * kSlide;
      const dt: f64 = freq / fs;
      phase += dt;
      if (phase >= 1) phase -= 1;
      let x: f64;
      if (wave < 0.5) {
        x = 2 * phase - 1 - polyBlep(phase, dt);
      } else {
        let p2: f64 = phase + 0.5;
        if (p2 >= 1) p2 -= 1;
        x = (phase < 0.5 ? 1.0 : -1.0) + polyBlep(phase, dt) - polyBlep(p2, dt);
      }
      fenv *= fenvK;
      sweep *= kSweep;
      amp += (ampTarget - amp) * (ampTarget > amp ? kAtt : kRel);
      veg *= vegK;
      const mod: f64 = Math.pow(freq / 110, tracking) * Math.pow(2, fm * 8 * yPrev);
      const fc: f64 = Math.min(maxFc, Math.min(16000, base * (1 + envAmt * fenv) * mod));
      const g: f64 = Math.tan(Math.PI * fc / fs);
      x *= drive;
      const y: f64 = diode ? diodeTick(x, g, k) : ladderTick(x, g, k);
      yPrev = y * (amp * veg);
      acc += yPrev;
    }
    let o: f64 = acc / OS * GAIN * comp;
    if (muffler >= 0.5) { const m: f64 = muffler >= 1.5 ? 4 : 1.5; o = Math.tanh(o * m) / m; }
    unchecked(out[i] = <f32>o);
  }
}
