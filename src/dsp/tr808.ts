// TR-808 voice engine: all sixteen voices, sample by sample. AssemblyScript twin: assembly/tr808.ts — keep the
// two in sync; src/dsp/tr808.test.ts renders both from the same events and checks they match.
// Numbers from the TR-808 Service Notes (1981) chart on p.14 (frequency, decay to 1/10 at SHORT / MID / LONG,
// normal / accented level) unless marked. Werner, Abel & Smith (DAFx-14) for the BD, Werner (ICMC 2014) for
// the six metal oscillators and band-passes. "unsourced" = picked by ear
export const V808 = { BD: 0, SD: 1, LT: 2, MT: 3, HT: 4, LC: 5, MC: 6, HC: 7, RS: 8, CL: 9, CP: 10, MA: 11, CB: 12, CY: 13, OH: 14, CH: 15 } as const;
export type Voice808 = typeof V808[keyof typeof V808];
export const VOICES808 = Object.keys(V808) as (keyof typeof V808)[];
// Knobs each voice reads at hit time (p0, p1). Congas share the toms' TUNING knobs, as on the 808
export const KNOBS808: Record<string, string[]> = {
  BD: ['BDtone', 'BDdec'], SD: ['SDtone', 'SDsnap'], LT: ['LTtune'], MT: ['MTtune'], HT: ['HTtune'],
  LC: ['LTtune'], MC: ['MTtune'], HC: ['HTtune'], CY: ['CYtone', 'CYdec'], OH: ['OHdec'],
  RS: [], CL: [], CP: [], MA: [], CB: [], CH: [],
};

const LN10 = 2.302585092994046; // decay times are to 1/10, as in the Service Notes chart
const ATTACK = 0.0003;
const LP = 0, BP = 1, HP = 2;
const SAT = 2;
const sat = (x: number) => SAT * Math.tanh(x / SAT);
// Output level per voice, Vpp: normal, then accented with ACCENT at max (SN p.14; CP's printed 2 Vpp read as 9)
const ACC_N = [3.5, 3, 3.5, 3, 3.5, 3.5, 3, 3.5, 3, 2.5, 3, 3, 3.5, 3.5, 3.5, 3];
const ACC_X = [10, 10, 12, 11, 12, 12, 10, 12, 10, 8, 9, 5, 12, 7, 7, 6];
// Toms then congas: TUNING low / mid / high Hz, decay s (SN p.14)
const TOMS = [[80, 90, 100, 0.2], [120, 135, 160, 0.13], [165, 185, 220, 0.1], [165, 185, 220, 0.18], [250, 280, 310, 0.1], [370, 400, 455, 0.08]];
const TOM_NOISE = [400, 480, 720]; // pink-ish noise low-pass per tom (calc from the schematic; LT unsourced)
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800]; // Werner 2014; the last two are the cowbell's

const k20 = (fs: number, dec: number) => Math.exp(-LN10 / (dec * fs));
// Knob 0..1 through the chart's SHORT / MID / LONG (or low / mid / high) points, exponentially
export const span = (p: number, a: number, b: number, c: number) => p < 0.5 ? a * Math.pow(b / a, 2 * p) : b * Math.pow(c / b, 2 * p - 1);

// Bridged-T: a two-pole resonator struck by the trigger. Linear, so a new hit adds to the ringing one.
// bend: extra pitch at the attack, dying with bendTau (BD). ad: pitch rises with the ring's level (the diodes
// across the toms' and BD's resonators: high while loud, falling as it dies)
class Res {
  y1 = 0; y2 = 0; x = 0; r = 0; f = 100; bend = 0; bk = 0; ad = 0; lvl = 0; ref = 1;
  constructor(private fs: number) {}
  strike(peak: number, f: number, dec: number, bend: number, bendTau: number, ad: number) {
    this.r = k20(this.fs, dec); this.f = f; this.bend = bend; this.bk = Math.exp(-1 / (bendTau * this.fs)); this.ad = ad;
    this.lvl += peak; this.ref = this.lvl;
    this.x += peak * Math.sin(2 * Math.PI * f * (1 + bend + ad) / this.fs);
  }
  tick(): number {
    const w = 2 * Math.PI * this.f * (1 + this.bend + this.ad * this.lvl / this.ref) / this.fs;
    const y = 2 * this.r * Math.cos(w) * this.y1 - this.r * this.r * this.y2 + this.x;
    this.x = 0; this.y2 = this.y1; this.y1 = y;
    this.lvl *= this.r; this.bend *= this.bk;
    return y;
  }
}

// Exponential decay VCA with a short attack. cut(): the CH ending an OH (SN p.6: Q23 closes the OH decay)
class Env {
  e = 0; h = 0; k = 1; a = 1;
  constructor(private fs: number) {}
  trig(peak: number, dec: number, attack: number) { this.h = peak; this.k = k20(this.fs, dec); this.a = 1 - Math.exp(-1 / (attack * this.fs)); }
  cut() { this.h = 0; }
  tick(): number { this.h *= this.k; this.e += (this.h - this.e) * this.a; return this.e; }
}

// 2-pole state variable filter (TPT)
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

function blep(t: number, dt: number): number {
  if (t < dt) { const u = t / dt; return u + u - u * u - 1; }
  if (t > 1 - dt) { const u = (t - 1) / dt; return u * u + u + u + 1; }
  return 0;
}

export class Tr808 {
  private seed = 0x808808;
  private bd: Res; private bdY = 0; private bdG = 1; private click = 0; private clickN = 0;
  private sdLo: Res; private sdHi: Res; private sdN: Svf; private sdE: Env;
  private tom: Res[]; private tomN: Svf[]; private tomE: Env[];
  private rs1: Res; private rs2: Res; private cl: Res;
  private cpF: Svf; private cpRev: Env; private cpN = -1; private cpG = 0; private cpPk = 0; private cpK: number; private cpGap: number;
  private maF: Svf; private maE: Env;
  private cbF: Svf; private cbFast: Env; private cbSlow: Env;
  private loF: Svf; private hiF: Svf; private cyLoF: Svf; private cyMidF: Svf; private cyHiF: Svf; private ohF: Svf; private chF: Svf;
  private cyLoE: Env; private cyMidE: Env; private cyHiE: Env; private ohE: Env; private chE: Env;
  private ph = new Float64Array(6); private dt = new Float64Array(6);

  constructor(private fs: number) {
    this.bd = new Res(fs); this.sdLo = new Res(fs); this.sdHi = new Res(fs);
    this.sdN = new Svf(fs, 2750, 0.73, HP); this.sdE = new Env(fs); // calc: C66/C67, R201/R202 Sallen-Key
    this.tom = [new Res(fs), new Res(fs), new Res(fs)]; // a conga is its tom with a capacitor switched (SW8-10)
    this.tomN = TOM_NOISE.map(f => new Svf(fs, f, 0.7, LP)); this.tomE = [new Env(fs), new Env(fs), new Env(fs)];
    this.rs1 = new Res(fs); this.rs2 = new Res(fs); this.cl = new Res(fs);
    this.cpF = new Svf(fs, 1070, 2, BP); this.cpRev = new Env(fs); // calc 1.07 kHz; Q unsourced
    this.cpK = Math.exp(-1 / (0.0025 * fs)); this.cpGap = Math.round(0.01 * fs); // three saws in 30 ms (SN Fig.13)
    this.maF = new Svf(fs, 7000, 0.7, HP); this.maE = new Env(fs); // corner: calc 5-10 kHz
    this.cbF = new Svf(fs, 900, 2, BP); this.cbFast = new Env(fs); this.cbSlow = new Env(fs); // band-pass unsourced
    this.loF = new Svf(fs, 3440, 1.5, BP); this.hiF = new Svf(fs, 7100, 1.5, BP); // Q unsourced
    this.cyLoF = new Svf(fs, 2500, 0.7, HP); this.cyMidF = new Svf(fs, 5000, 0.7, HP); this.cyHiF = new Svf(fs, 10500, 2, HP);
    this.ohF = new Svf(fs, 7800, 2.5, HP); this.chF = new Svf(fs, 11700, 2.5, HP); // calc
    this.cyLoE = new Env(fs); this.cyMidE = new Env(fs); this.cyHiE = new Env(fs); this.ohE = new Env(fs); this.chE = new Env(fs);
    for (let i = 0; i < 6; i++) this.dt[i] = METAL[i] / fs;
  }

  // l: LEVEL knob, a: ACCENT amount on accented steps (else 0), p0 / p1: the voice's KNOBS808
  trig(v: number, l: number, a: number, p0: number, p1: number) {
    const g = l * (ACC_N[v] + a * (ACC_X[v] - ACC_N[v])) / 10;
    if (g <= 0) return;
    if (v === 0) { // ~50 Hz (Werner; the chart says 56). Attack: >1 octave up for a few ms. TONE: 1-pole low-pass
      this.bd.strike(g, 50, span(p1, 0.05, 0.3, 0.8), 1.6, 0.002, 0.06);
      this.click = g * 0.4; this.clickN = Math.round(0.001 * this.fs);
      this.bdG = 1 - Math.exp(-2 * Math.PI * span(p0, 300, 1500, 7000) / this.fs);
    } else if (v === 1) { // 238 / 476 Hz, TONE mixes them, SNAPPY sets the noise (its decay unsourced)
      this.sdLo.strike(g * (1 - 0.6 * p0), 238, 0.06, 0, 0.001, 0.02);
      this.sdHi.strike(g * (0.15 + 0.6 * p0), 476, 0.06, 0, 0.001, 0.02);
      this.sdE.trig(g * 1.6 * p1, 0.15, ATTACK);
    } else if (v <= 7) { // toms and congas; pitch sweep depth unsourced
      const t = TOMS[v - 2], i = (v - 2) % 3;
      this.tom[i].strike(g, span(p0, t[0], t[1], t[2]), t[3], 0, 0.001, 0.12);
      if (v <= 4) this.tomE[i].trig(g * 0.25, t[3] * 0.6, ATTACK);
    } else if (v === 8) { this.rs1.strike(g, 455, 0.01, 0, 0.001, 0); this.rs2.strike(g * 0.6, 1667, 0.01, 0, 0.001, 0); }
    else if (v === 9) this.cl.strike(g, 2500, 0.025, 0, 0.001, 0);
    else if (v === 10) { this.cpN = 0; this.cpPk = g * 2.5; this.cpRev.trig(g * 1.2, 0.12, 0.004); }
    else if (v === 11) this.maE.trig(g * 1.5, 0.03, 0.002);
    else if (v === 12) { this.cbFast.trig(g * 0.25, 0.02, ATTACK); this.cbSlow.trig(g * 0.1, 0.1, ATTACK); } // two-stage (SN p.6), 50 ms overall
    else if (v === 13) { // DECAY sets the low bands, the top band is short; TONE mostly that top band (Werner)
      const d = span(p1, 0.35, 0.8, 1.2);
      this.cyLoE.trig(g * 0.5, d, ATTACK); this.cyMidE.trig(g * 0.5, d * 0.6, ATTACK); this.cyHiE.trig(g * (0.1 + 0.9 * p0), 0.15, ATTACK);
    } else if (v === 14) this.ohE.trig(g, span(p0, 0.09, 0.45, 0.6), ATTACK);
    else { this.chE.trig(g * 2, 0.05, ATTACK); this.ohE.cut(); }
  }

  render(out: Float32Array, off: number, n: number) {
    for (let i = 0; i < n; i++) {
      let s = this.seed;
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      this.seed = s;
      const nz = (s >>> 0) / 4294967296 * 2 - 1;
      let metal = 0, cb = 0;
      for (let j = 0; j < 6; j++) {
        const p = this.ph[j], dt = this.dt[j];
        let q = p + 0.5; if (q >= 1) q -= 1;
        const sq = (p < 0.5 ? 1 : -1) + blep(p, dt) - blep(q, dt);
        metal += sq;
        if (j >= 4) cb += sq;
        let np = p + dt; if (np >= 1) np -= 1;
        this.ph[j] = np;
      }
      let x = this.bd.tick();
      if (this.clickN > 0) { x += this.click; this.clickN--; }
      this.bdY += (x - this.bdY) * this.bdG;
      let cpB = 0;
      if (this.cpN >= 0 && this.cpN < 3 * this.cpGap) {
        if (this.cpN % this.cpGap === 0) this.cpG = this.cpPk;
        cpB = this.cpG; this.cpG *= this.cpK; this.cpN++;
      }
      const lo = this.loF.tick(metal), hi = this.hiF.tick(metal);
      out[off + i] = this.bdY
        + this.sdLo.tick() + this.sdHi.tick() + this.sdN.tick(nz) * this.sdE.tick()
        + this.tom[0].tick() + this.tom[1].tick() + this.tom[2].tick()
        + this.tomN[0].tick(nz) * this.tomE[0].tick() + this.tomN[1].tick(nz) * this.tomE[1].tick() + this.tomN[2].tick(nz) * this.tomE[2].tick()
        + Math.tanh(2 * (this.rs1.tick() + this.rs2.tick())) * 0.5 + this.cl.tick() // RS: the swing VCA's harmonics (SN p.6)
        + this.cpF.tick(nz) * (cpB + this.cpRev.tick()) + this.maF.tick(nz) * this.maE.tick()
        + this.cbF.tick(cb) * (this.cbFast.tick() + this.cbSlow.tick())
        + sat(this.cyLoF.tick(lo)) * this.cyLoE.tick() + sat(this.cyMidF.tick(hi)) * this.cyMidE.tick() + sat(this.cyHiF.tick(hi)) * this.cyHiE.tick()
        + sat(this.ohF.tick(hi)) * this.ohE.tick() + sat(this.chF.tick(hi)) * this.chE.tick();
    }
  }
}
