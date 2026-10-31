// 303 voice DSP: PolyBLEP oscillator -> nonlinear 4-pole filter (TPT, ladder or diode ladder) -> VCA, with
// filter/amp envelopes, slide and accent sweep. Pure (no imports, no DOM, no Web Audio) so it runs in the
// AudioWorklet and in tests. assembly/index.ts is a line-by-line AssemblyScript port. Keep them in sync;
// engine.test.ts checks they match

export const P_CUTOFF = 0; // 0..1 knob
export const P_RESO = 1;   // 0..20 knob
export const P_ENV = 2;    // 0..1 knob
export const P_DECAY = 3;  // 0.05..1.5 s knob
export const P_ACCENT = 4; // 0..1 knob
export const P_WAVE = 5;   // 0 saw, 1 square
export const P_FILTER = 6; // 0 ladder, 1 diode ladder

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
  private cutoff = 0.3; private reso = 12; private env = 0.5; private decay = 0.4; private accent = 0.6; private wave = 0;
  private filter = 0;
  // oscillator
  private phase = 0; private freq = 110; private target = 110; private sliding = false;
  // envelopes
  private amp = 0; private ampTarget = 0; private fenv = 0; private fenvK = 0; private envAmt = 0; private sweep = 0;
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
    this.fenvK = Math.exp(-1 / ((a > 0 ? 0.15 : this.decay) / 3 * this.fs));
    this.ampTarget = 0.5 + 0.5 * a;
  }

  noteOff(): void { this.ampTarget = 0; }

  render(out: Float32Array, offset: number, n: number): void {
    const diode = this.filter >= 0.5;
    const k = (diode ? DIODE_K : LADDER_K) * this.reso / 20;
    const comp = 1 + k * (diode ? DIODE_COMP : LADDER_COMP);
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
        // filter
        const fc = Math.min(maxFc, Math.min(16000, base * (1 + this.envAmt * this.fenv)));
        const g = Math.tan(Math.PI * fc / this.fs);
        const y = diode ? this.diode.tick(x, g, k) : this.ladder.tick(x, g, k);
        acc += y * this.amp;
      }
      out[offset + i] = acc / OS * GAIN * comp; // decimate by averaging, make up resonance level loss
    }
  }
}
