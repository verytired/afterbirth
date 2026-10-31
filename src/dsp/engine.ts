// 303 voice DSP: PolyBLEP oscillator -> nonlinear 4-pole filter (TPT, ladder or diode ladder) -> VCA, with
// filter/amp envelopes, slide and accent sweep. Pure (no imports, no DOM, no Web Audio) so it runs in the
// AudioWorklet and in tests. assembly/index.ts is a line-by-line AssemblyScript port. Keep them in sync;
// engine.test.ts checks they match

export const P_CUTOFF = 0; // 0..1 knob
export const P_RESO = 1;   // 0..20 knob
export const P_ENV = 2;    // 0..1 knob
export const P_DECAY = 3;  // 0.05..1.5 knob, see decayTau
export const P_ACCENT = 4; // 0..1 knob
export const P_WAVE = 5;   // 0 saw, 1 square
export const P_FILTER = 6; // 0 ladder, 1 diode ladder
// MODS (Devil Fish style), all 0..1 knobs whose defaults reproduce the stock voice
export const P_ACC_DECAY = 7;   // accented notes' filter decay, default 0.5
export const P_VEG_DECAY = 8;   // volume decay while the note is held, default 1 = no decay
export const P_SOFT_ATTACK = 9; // attack of non-accented notes, default 0.5
export const P_SLIDE_TIME = 10; // default 0
export const P_SWEEP = 11;      // accent sweep speed, default 0.5
export const P_FILTER_FM = 12;  // cutoff modulated by the voice's own output, default 0
export const P_TRACKING = 13;   // cutoff follows the note, 1 = full, default 0
export const P_DRIVE = 14;      // filter input gain, default 0
export const P_MUFFLER = 15;    // output soft clip: 0 off, 1 soft, 2 hard
export const P_SELF_OSC = 16;   // 1 = RESO can push the filter into self-oscillation

const OS = 2;              // oversampling factor
const SLIDE_TAU = 0.03;
const ATTACK_TAU = 0.002;
const RELEASE_TAU = 0.006;
const SWEEP_TAU = 0.4;     // accent sweep capacitor discharge
const GAIN = 0.55;
export const LADDER_K = 3.8;   // feedback at RESO max (self-oscillates at 4)
export const DIODE_K = 17;     // feedback at RESO max (self-oscillates at about 18.5)
const LADDER_COMP = 0.5;   // output make-up per unit of feedback (resonance thins the passband)
const DIODE_COMP = 0.6;

// DECAY knob -> filter envelope time constant: exponential 15 ms .. 600 ms, so the short, audible
// range gets most of the knob (a 16th at 128 BPM only sounds for about 65 ms)
// Above the default (0.9) it stretches to 3 s, and the max position holds (Devil Fish ranges)
const DECAY_09 = 0.015 * Math.pow(40, 0.85 / 1.45);
export function decayTau(knob: number): number {
  if (knob >= 1.5) return Infinity;
  if (knob <= 0.9) return 0.015 * Math.pow(40, (knob - 0.05) / 1.45);
  return DECAY_09 * Math.pow(3 / DECAY_09, (knob - 0.9) / 0.6);
}

// Knob -> time constant maps. Each returns exactly the stock value at its default position
export const accDecayTau = (k: number) => // 16 ms .. 3 s, max = no decay
  k >= 1 ? Infinity : k < 0.5 ? 0.05 * Math.pow(0.32, (0.5 - k) * 2) : 0.05 * Math.pow(60, (k - 0.5) * 2);
export const attackTau = (k: number) => ATTACK_TAU * Math.pow(10, (k - 0.5) * 2); // 0.2 ms .. 20 ms
export const slideTau = (k: number) => SLIDE_TAU * Math.pow(5, k);              // up to 5x the stock slide
export const sweepTau = (k: number) => SWEEP_TAU * Math.pow(4, (k - 0.5) * 2);  // 0.1 .. 1.6 s
export const vegTau = (k: number) => 0.016 * Math.pow(200, k);                  // 16 ms .. 3.2 s, max = hold

function polyBlep(t: number, dt: number): number {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

// Transistor-style 4-pole ladder: four identical one-poles, feedback from the last.
// The linear loop is solved without delay, then its input is saturated
export class Ladder {
  private s1 = 0; private s2 = 0; private s3 = 0; private s4 = 0;
  // g = tan(pi * fc / fs)
  tick(x: number, g: number, k: number): number {
    const G = g / (1 + g);
    const sum = (((this.s1 * (1 - G)) * G + this.s2 * (1 - G)) * G + this.s3 * (1 - G)) * G + this.s4 * (1 - G);
    const G4 = G * G * G * G;
    const u = Math.tanh((x - k * sum) / (1 + k * G4));
    let v = G * (u - this.s1); const y1 = v + this.s1; this.s1 = y1 + v;
    v = G * (y1 - this.s2); const y2 = v + this.s2; this.s2 = y2 + v;
    v = G * (y2 - this.s3); const y3 = v + this.s3; this.s3 = y3 + v;
    v = G * (y3 - this.s4); const y4 = v + this.s4; this.s4 = y4 + v;
    return y4;
  }
}

// Diode ladder (TB-303 style): the stages are coupled, each capacitor also sees the next stage
//   y1' = w(u - 2y1 + y2), y2' = w(y1 - 2y2 + y3), y3' = w(y2 - 2y3 + y4), y4' = w(y3 - y4), u = x - k*y4
// Trapezoidal integration gives a tridiagonal system per sample, solved directly. Gentler slope near
// cutoff (about -12 to -18 dB/oct) than the ladder, and resonance thins the bass much more
export class DiodeLadder {
  private s1 = 0; private s2 = 0; private s3 = 0; private s4 = 0;
  tick(x: number, g: number, k: number): number {
    // forward elimination coefficients of (I - gA), which only depend on g
    const d = 1 + 2 * g;
    const c1 = -g / d; const m2 = d + g * c1;
    const c2 = -g / m2; const m3 = d + g * c2;
    const c3 = -g / m3; const m4 = 1 + g + g * c3;
    // y4 for the input x with no feedback (a4) and per unit of input (b4); then close the loop
    const p1 = (this.s1 + g * x) / d;
    const p2 = (this.s2 + g * p1) / m2;
    const p3 = (this.s3 + g * p2) / m3;
    const a4 = (this.s4 + g * p3) / m4;
    const b4 = g / d * g / m2 * g / m3 * g / m4;
    const u = Math.tanh(x - k * a4 / (1 + k * b4));
    // solve again with the saturated input
    const q1 = (this.s1 + g * u) / d;
    const q2 = (this.s2 + g * q1) / m2;
    const q3 = (this.s3 + g * q2) / m3;
    const y4 = (this.s4 + g * q3) / m4;
    const y3 = q3 - c3 * y4;
    const y2 = q2 - c2 * y3;
    const y1 = q1 - c1 * y2;
    this.s1 = 2 * y1 - this.s1; this.s2 = 2 * y2 - this.s2; this.s3 = 2 * y3 - this.s3; this.s4 = 2 * y4 - this.s4;
    return y4;
  }
}

export class Voice303 {
  private fs: number;
  // params
  private cutoff = 0.3; private reso = 12; private env = 0.5; private decay = 0.9; private accent = 0.6; private wave = 0;
  private filter = 0;
  private fm = 0; private tracking = 0; private drive = 1; private muffler = 0; private accDecay = 0.05; private selfOsc = 0;
  // oscillator
  private phase = 0; private freq = 110; private target = 110; private sliding = false;
  // envelopes
  private amp = 0; private ampTarget = 0; private veg = 1; private vegK = 1; private yPrev = 0; private fenv = 0; private fenvK = 0; private envAmt = 0; private sweep = 0;
  // filters
  private ladder = new Ladder();
  private diode = new DiodeLadder();
  // per-sample coefficients
  private kSlide: number; private kAtt: number; private kRel: number; private kSweep: number;

  constructor(sampleRate: number) {
    this.fs = sampleRate * OS;
    this.kSlide = 1 - Math.exp(-1 / (SLIDE_TAU * this.fs));
    this.kAtt = 1 - Math.exp(-1 / (ATTACK_TAU * this.fs));
    this.kRel = 1 - Math.exp(-1 / (RELEASE_TAU * this.fs));
    this.kSweep = Math.exp(-1 / (SWEEP_TAU * this.fs));
  }

  setParam(id: number, v: number): void {
    if (id === P_CUTOFF) this.cutoff = v;
    else if (id === P_RESO) this.reso = v;
    else if (id === P_ENV) this.env = v;
    else if (id === P_DECAY) this.decay = v;
    else if (id === P_ACCENT) this.accent = v;
    else if (id === P_WAVE) this.wave = v;
    else if (id === P_FILTER) this.filter = v;
    else if (id === P_ACC_DECAY) this.accDecay = accDecayTau(v);
    else if (id === P_VEG_DECAY) this.vegK = v >= 1 ? 1 : Math.exp(-1 / (vegTau(v) * this.fs));
    else if (id === P_SOFT_ATTACK) this.kAtt = 1 - Math.exp(-1 / (attackTau(v) * this.fs));
    else if (id === P_SLIDE_TIME) this.kSlide = 1 - Math.exp(-1 / (slideTau(v) * this.fs));
    else if (id === P_SWEEP) this.kSweep = Math.exp(-1 / (sweepTau(v) * this.fs));
    else if (id === P_FILTER_FM) this.fm = v;
    else if (id === P_TRACKING) this.tracking = v;
    else if (id === P_DRIVE) this.drive = Math.pow(10, v * 1.8235); // up to x66.6
    else if (id === P_MUFFLER) this.muffler = v;
    else if (id === P_SELF_OSC) this.selfOsc = v;
  }

  // slide = 1: glide from the previous note without retriggering the envelopes (303 slide)
  noteOn(freq: number, acc: number, slide: number): void {
    this.target = freq;
    if (slide !== 0) { this.sliding = true; return; }
    this.sliding = false;
    this.freq = freq;
    const a = acc !== 0 ? this.accent : 0;
    if (a > 0) this.sweep = Math.min(1, this.sweep + 0.5 * a); // consecutive accents open the filter further
    this.envAmt = this.env * 10 * (1 + a * (1 + this.sweep));
    this.fenv = 1;
    this.fenvK = Math.exp(-1 / ((a > 0 ? this.accDecay : decayTau(this.decay)) * this.fs)); // accented notes have their own decay
    this.veg = 1;
    this.ampTarget = 0.5 + 0.5 * a;
  }

  noteOff(): void { this.ampTarget = 0; }

  render(out: Float32Array, offset: number, n: number): void {
    const diode = this.filter >= 0.5;
    const kStock = (diode ? DIODE_K : LADDER_K) * this.reso / 20;
    const k = this.selfOsc >= 0.5 ? kStock * 1.3 : kStock; // 1.3x reaches past self-oscillation for both filters
    const comp = 1 + kStock * (diode ? DIODE_COMP : LADDER_COMP);
    const base = 60 * Math.pow(100, this.cutoff);
    const maxFc = 0.45 * this.fs;
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let o = 0; o < OS; o++) {
        // oscillator
        if (this.sliding) this.freq += (this.target - this.freq) * this.kSlide;
        const dt = this.freq / this.fs;
        this.phase += dt;
        if (this.phase >= 1) this.phase -= 1;
        let x: number;
        if (this.wave < 0.5) {
          x = 2 * this.phase - 1 - polyBlep(this.phase, dt);
        } else {
          let p2 = this.phase + 0.5;
          if (p2 >= 1) p2 -= 1;
          x = (this.phase < 0.5 ? 1 : -1) + polyBlep(this.phase, dt) - polyBlep(p2, dt);
        }
        // envelopes
        this.fenv *= this.fenvK;
        this.sweep *= this.kSweep;
        this.amp += (this.ampTarget - this.amp) * (this.ampTarget > this.amp ? this.kAtt : this.kRel);
        this.veg *= this.vegK;
        // filter: envelope, key tracking, audio-rate FM from the previous output
        const mod = Math.pow(this.freq / 110, this.tracking) * Math.pow(2, this.fm * 8 * this.yPrev);
        const fc = Math.min(maxFc, Math.min(16000, base * (1 + this.envAmt * this.fenv) * mod));
        const g = Math.tan(Math.PI * fc / this.fs);
        x *= this.drive;
        const y = diode ? this.diode.tick(x, g, k) : this.ladder.tick(x, g, k);
        this.yPrev = y * (this.amp * this.veg);
        acc += this.yPrev;
      }
      let o = acc / OS * GAIN * comp; // decimate by averaging, make up resonance level loss
      if (this.muffler >= 0.5) { const m = this.muffler >= 1.5 ? 4 : 1.5; o = Math.tanh(o * m) / m; }
      out[offset + i] = o;
    }
  }
}
