// 303 voice DSP: PolyBLEP oscillator -> nonlinear 4-pole ladder (TPT) -> VCA, with filter/amp envelopes,
// slide and accent sweep. Pure (no imports, no DOM, no Web Audio) so it runs in the AudioWorklet and in tests.
// assembly/index.ts is a line-by-line AssemblyScript port. Keep them in sync; engine.test.ts checks they match

export const P_CUTOFF = 0; // 0..1 knob
export const P_RESO = 1;   // 0..20 knob
export const P_ENV = 2;    // 0..1 knob
export const P_DECAY = 3;  // 0.05..1.5 s knob
export const P_ACCENT = 4; // 0..1 knob
export const P_WAVE = 5;   // 0 saw, 1 square

const OS = 2;              // oversampling factor
const SLIDE_TAU = 0.03;
const ATTACK_TAU = 0.002;
const RELEASE_TAU = 0.006;
const SWEEP_TAU = 0.4;     // accent sweep capacitor discharge
const GAIN = 0.55;

function polyBlep(t: number, dt: number): number {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

export class Voice303 {
  private fs: number;
  // params
  private cutoff = 0.3; private reso = 12; private env = 0.5; private decay = 0.4; private accent = 0.6; private wave = 0;
  // oscillator
  private phase = 0; private freq = 110; private target = 110; private sliding = false;
  // envelopes
  private amp = 0; private ampTarget = 0; private fenv = 0; private fenvK = 0; private envAmt = 0; private sweep = 0;
  // ladder states
  private s1 = 0; private s2 = 0; private s3 = 0; private s4 = 0;
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
    const k = 3.8 * this.reso / 20; // ladder feedback, 4 would self-oscillate
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
        // ladder: solve the linear feedback loop (zero-delay), saturate its input
        const fc = Math.min(maxFc, Math.min(16000, base * (1 + this.envAmt * this.fenv)));
        const g = Math.tan(Math.PI * fc / this.fs);
        const G = g / (1 + g);
        const sum = (((this.s1 * (1 - G)) * G + this.s2 * (1 - G)) * G + this.s3 * (1 - G)) * G + this.s4 * (1 - G);
        const G4 = G * G * G * G;
        const u = Math.tanh((x - k * sum) / (1 + k * G4));
        let v = G * (u - this.s1); const y1 = v + this.s1; this.s1 = y1 + v;
        v = G * (y1 - this.s2); const y2 = v + this.s2; this.s2 = y2 + v;
        v = G * (y2 - this.s3); const y3 = v + this.s3; this.s3 = y3 + v;
        v = G * (y3 - this.s4); const y4 = v + this.s4; this.s4 = y4 + v;
        acc += y4 * this.amp;
      }
      out[offset + i] = acc / OS * GAIN * (1 + k * 0.5); // decimate by averaging, make up resonance level loss
    }
  }
}
