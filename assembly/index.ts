// AssemblyScript port of src/dsp/engine.ts (one voice per instance). Keep the two in sync;
// src/dsp/engine.test.ts renders both from the same events and checks they match

const P_CUTOFF = 0;
const P_RESO = 1;
const P_ENV = 2;
const P_DECAY = 3;
const P_ACCENT = 4;
const P_WAVE = 5;

const OS = 2;
const SLIDE_TAU: f64 = 0.03;
const ATTACK_TAU: f64 = 0.002;
const RELEASE_TAU: f64 = 0.006;
const SWEEP_TAU: f64 = 0.4;
const GAIN: f64 = 0.55;

const out = new StaticArray<f32>(128);

let fs: f64 = 96000;
let cutoff: f64 = 0.3; let reso: f64 = 12; let env: f64 = 0.5; let decay: f64 = 0.4; let accent: f64 = 0.6; let wave: f64 = 0;
let phase: f64 = 0; let freq: f64 = 110; let target: f64 = 110; let sliding = false;
let amp: f64 = 0; let ampTarget: f64 = 0; let fenv: f64 = 0; let fenvK: f64 = 0; let envAmt: f64 = 0; let sweep: f64 = 0;
let s1: f64 = 0; let s2: f64 = 0; let s3: f64 = 0; let s4: f64 = 0;
let kSlide: f64 = 0; let kAtt: f64 = 0; let kRel: f64 = 0; let kSweep: f64 = 0;

function polyBlep(t: f64, dt: f64): f64 {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
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
  fenvK = Math.exp(-1 / ((a > 0 ? 0.15 : decay) / 3 * fs));
  ampTarget = 0.5 + 0.5 * a;
}

export function noteOff(): void { ampTarget = 0; }

// Renders n (<= 128) samples into the buffer at outPtr()
export function render(n: i32): void {
  const k: f64 = 3.8 * reso / 20;
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
      const fc: f64 = Math.min(maxFc, Math.min(16000, base * (1 + envAmt * fenv)));
      const g: f64 = Math.tan(Math.PI * fc / fs);
      const G: f64 = g / (1 + g);
      const sum: f64 = (((s1 * (1 - G)) * G + s2 * (1 - G)) * G + s3 * (1 - G)) * G + s4 * (1 - G);
      const G4: f64 = G * G * G * G;
      const u: f64 = Math.tanh((x - k * sum) / (1 + k * G4));
      let v: f64 = G * (u - s1); const y1: f64 = v + s1; s1 = y1 + v;
      v = G * (y1 - s2); const y2: f64 = v + s2; s2 = y2 + v;
      v = G * (y2 - s3); const y3: f64 = v + s3; s3 = y3 + v;
      v = G * (y3 - s4); const y4: f64 = v + s4; s4 = y4 + v;
      acc += y4 * amp;
    }
    unchecked(out[i] = <f32>(acc / OS * GAIN * (1 + k * 0.5)));
  }
}
