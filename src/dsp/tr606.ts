// TR-606 voice engine: all seven parts, sample by sample. AssemblyScript twin: assembly/tr606.ts — keep the
// two in sync; src/dsp/tr606.test.ts renders both from the same events and checks they match.
// Circuit model: bridged-T resonators struck by the trigger (drums), white noise through 2-pole filters
// (snare, tom tails), six square oscillators mixed into one metal source (hats, cymbal), CH and OH on one VCA
export const BD = 0, SD = 1, LT = 2, HT = 3, CY = 4, CH = 5, OH = 6;

const LN1000 = 6.907755278982137; // decay times are to -60dB
const ATTACK = 0.0003; // VCA attack time constant: no click when a hat retriggers (or chokes) mid-decay
// Metal path ceiling: the circuit cannot swing past its supply, so the needles where several square edges
// line up come out rounded instead of towering over the hat (and clipping 16-bit stems)
const SAT = 2; // ~3x the metal's RMS: ordinary waveforms pass, only the needles bend
const sat = (x: number) => SAT * Math.tanh(x / SAT);
const METAL = [245, 306, 365, 415, 437, 619];
const LP = 0, BP = 1, HP = 2;

const coef = (fs: number, dec: number) => Math.exp(-LN1000 / (dec * fs));

// Bridged-T: two-pole resonator. An impulse of peak * sin(w) rings as peak * sin, down 60dB after dec seconds
class Res {
  y1 = 0; y2 = 0; x = 0; a1: number; a2: number; s: number;
  constructor(fs: number, f: number, dec: number) {
    const r = coef(fs, dec), w = 2 * Math.PI * f / fs;
    this.a1 = 2 * r * Math.cos(w); this.a2 = r * r; this.s = Math.sin(w);
  }
  strike(peak: number) { this.x += peak * this.s; }
  tick(): number {
    const y = this.a1 * this.y1 - this.a2 * this.y2 + this.x;
    this.x = 0; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

// Exponential decay VCA with a short attack
class Env {
  e = 0; h = 0; k = 1; a: number;
  constructor(private fs: number) { this.a = 1 - Math.exp(-1 / (ATTACK * fs)); }
  trig(peak: number, dec: number) { this.h = peak; this.k = coef(this.fs, dec); }
  tick(): number { this.h *= this.k; this.e += (this.h - this.e) * this.a; return this.e; }
}

// 2-pole state variable filter (TPT): same response as a bilinear (RBJ) biquad
class Svf {
  ic1 = 0; ic2 = 0; k: number; a1: number; a2: number; a3: number;
  constructor(fs: number, f: number, q: number, private mode: number) {
    const g = Math.tan(Math.PI * f / fs);
    this.k = 1 / q; this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  }
  tick(x: number): number {
    const v3 = x - this.ic2, v1 = this.a1 * this.ic1 + this.a2 * v3, v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    return this.mode === LP ? v2 : this.mode === BP ? v1 : x - this.k * v1 - v2;
  }
}

// Band-limited square (polyBLEP): the hats sit above 7kHz, where a naive square would alias
function blep(t: number, dt: number): number {
  if (t < dt) { const u = t / dt; return u + u - u * u - 1; }
  if (t > 1 - dt) { const u = (t - 1) / dt; return u * u + u + u + 1; }
  return 0;
}

export class Tr606 {
  private bd1: Res; private bd2: Res; private sd: Res; private lt: Res; private ht: Res;
  private sdN: Svf; private ltN: Svf; private htN: Svf; private hatF: Svf; private cyLoF: Svf; private cyHiF: Svf;
  private sdE: Env; private ltE: Env; private htE: Env; private hatE: Env; private cyLoE: Env; private cyHiE: Env;
  private ph = new Float64Array(6); private dt = new Float64Array(6);
  private seed = 0x12345678;

  constructor(fs: number) {
    this.bd1 = new Res(fs, 60, 0.32); this.bd2 = new Res(fs, 130, 0.05); this.sd = new Res(fs, 230, 0.07);
    this.lt = new Res(fs, 150, 0.25); this.ht = new Res(fs, 220, 0.2);
    this.sdN = new Svf(fs, 1500, 1, HP); this.ltN = new Svf(fs, 700, 1, LP); this.htN = new Svf(fs, 900, 1, LP);
    this.hatF = new Svf(fs, 7500, 1, HP); this.cyLoF = new Svf(fs, 3800, 1.2, BP); this.cyHiF = new Svf(fs, 7800, 1.2, BP);
    this.sdE = new Env(fs); this.ltE = new Env(fs); this.htE = new Env(fs);
    this.hatE = new Env(fs); this.cyLoE = new Env(fs); this.cyHiE = new Env(fs);
    for (let i = 0; i < 6; i++) this.dt[i] = METAL[i] / fs;
  }

  // l: level with accent applied. step: one 16th in seconds (the 606 derives OH decay from its clock)
  trig(v: number, l: number, step: number) {
    if (v === BD) { this.bd1.strike(l * 0.85); this.bd2.strike(l * 0.35); }
    else if (v === SD) { this.sd.strike(l * 0.45); this.sdE.trig(l * 0.6, 0.18); }
    else if (v === LT) { this.lt.strike(l * 0.75); this.ltE.trig(l * 0.12, 0.3); }
    else if (v === HT) { this.ht.strike(l * 0.75); this.htE.trig(l * 0.12, 0.25); }
    else if (v === CY) { this.cyLoE.trig(l * 0.2, 0.3); this.cyHiE.trig(l * 0.25, 1.1); }
    else if (v === CH) this.hatE.trig(l * 0.6, 0.04);
    else if (v === OH) this.hatE.trig(l * 0.6, step * 2.4);
  }

  render(out: Float32Array, off: number, n: number) {
    for (let i = 0; i < n; i++) {
      let s = this.seed;
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      this.seed = s;
      const nz = (s >>> 0) / 4294967296 * 2 - 1;
      let metal = 0;
      for (let j = 0; j < 6; j++) {
        const p = this.ph[j], dt = this.dt[j];
        let q = p + 0.5; if (q >= 1) q -= 1;
        metal += (p < 0.5 ? 1 : -1) + blep(p, dt) - blep(q, dt);
        let np = p + dt; if (np >= 1) np -= 1;
        this.ph[j] = np;
      }
      out[off + i] = this.bd1.tick() + this.bd2.tick() + this.sd.tick() + this.lt.tick() + this.ht.tick()
        + this.sdN.tick(nz) * this.sdE.tick() + this.ltN.tick(nz) * this.ltE.tick() + this.htN.tick(nz) * this.htE.tick()
        + sat(this.hatF.tick(metal)) * this.hatE.tick()
        + sat(this.cyLoF.tick(metal)) * this.cyLoE.tick() + sat(this.cyHiF.tick(metal)) * this.cyHiE.tick();
    }
  }
}
