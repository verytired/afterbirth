import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import V05 from './v05.fp.json';
import { Voice303, Ladder, DiodeLadder, P_CUTOFF, P_RESO, P_ENV, P_DECAY, P_ACCENT, P_WAVE, P_FILTER, DIODE_K, LADDER_K,
  P_ACC_DECAY, P_VEG_DECAY, P_SOFT_ATTACK, P_SLIDE_TIME, P_SWEEP, P_FILTER_FM, P_TRACKING, P_DRIVE, P_MUFFLER, P_SELF_OSC } from './engine';

const SR = 48000;

interface Engine { setParam(id: number, v: number): void; noteOn(f: number, acc: number, slide: number): void; noteOff(): void; render(out: Float32Array, off: number, n: number): void }

function tsEngine(): Engine { return new Voice303(SR); }

function wasmEngine(): Engine {
  const x = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL('./voice.wasm', import.meta.url))), {}).exports as unknown as {
    memory: WebAssembly.Memory; init(sr: number): void; outPtr(): number; setParam(id: number, v: number): void;
    noteOn(f: number, acc: number, slide: number): void; noteOff(): void; render(n: number): void;
  };
  x.init(SR);
  const buf = new Float32Array(x.memory.buffer, x.outPtr(), 128);
  return {
    setParam: (id, v) => x.setParam(id, v), noteOn: (f, a, s) => x.noteOn(f, a, s), noteOff: () => x.noteOff(),
    render(out, off, n) { x.render(n); out.set(buf.subarray(0, n), off); },
  };
}

type Ev = { frame: number; run(e: Engine): void };

// A 2-bar acid line: accents, slides, rests, plus knob moves (cutoff sweep, max reso, square wave)
export function script(): Ev[] {
  const evs: Ev[] = [];
  const step = Math.round(SR * 0.115);
  const notes = [36, 48, -1, 39, 43, 36, 51, 36, 46, -1, 39, 48, 36, 43, 41, 36];
  for (let bar = 0; bar < 2; bar++)
    notes.forEach((m, i) => {
      const at = (bar * 16 + i) * step;
      if (m < 0) return;
      const acc = i % 3 === 0 ? 1 : 0, slide = i % 5 === 4 ? 1 : 0;
      evs.push({ frame: at, run: e => e.noteOn(440 * 2 ** ((m - 69) / 12), acc, slide) });
      evs.push({ frame: at + Math.round(step * 0.55), run: e => e.noteOff() });
    });
  for (let k = 0; k < 32; k++) evs.push({ frame: k * step + 7, run: e => e.setParam(P_CUTOFF, k / 31) });
  evs.push({ frame: 16 * step, run: e => { e.setParam(P_RESO, 20); e.setParam(P_WAVE, 1); } });
  return evs.sort((a, b) => a.frame - b.frame);
}

// Same splitting as the worklet: render up to each event in <=128-frame blocks
export function drive(e: Engine, evs: Ev[], frames: number, params: Record<number, number> = {}) {
  for (const id in params) e.setParam(+id, params[id]);
  const out = new Float32Array(frames);
  let pos = 0, q = 0;
  for (let block = 0; block < frames; block += 128) {
    const end = Math.min(frames, block + 128);
    while (q < evs.length && evs[q].frame < end) {
      const at = Math.max(pos, evs[q].frame);
      if (at > pos) { e.render(out, pos, at - pos); pos = at; }
      evs[q++].run(e);
    }
    if (end > pos) { e.render(out, pos, end - pos); pos = end; }
  }
  return out;
}

const peak = (a: Float32Array) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
export const FRAMES = SR * 4;

describe('Voice303', () => {
  // Output of v0.5 sampled every 500 frames. New features must leave the default sound unchanged
  for (const [name, filter] of [['ladder', 0], ['diode', 1]] as const) {
    it(`reproduces v0.5 at default settings (${name})`, () => {
      const out = drive(tsEngine(), script(), FRAMES, { [P_FILTER]: filter });
      expect(Array.from({ length: Math.floor(out.length / 500) }, (_, i) => out[i * 500])).toEqual(V05[name]);
    });
  }

  it('is deterministic', () => {
    expect(drive(tsEngine(), script(), FRAMES)).toEqual(drive(tsEngine(), script(), FRAMES));
  });

  it('makes sound at a sane level', () => {
    const p = peak(drive(tsEngine(), script(), FRAMES));
    expect(p).toBeGreaterThan(0.05);
    expect(p).toBeLessThan(1.5);
  });

  for (const filter of [0, 1]) {
    it(`stays stable with every knob at max (${filter ? 'diode' : 'ladder'})`, () => {
      const out = drive(tsEngine(), script(), FRAMES, { [P_FILTER]: filter, [P_CUTOFF]: 1, [P_RESO]: 20, [P_ENV]: 1, [P_DECAY]: 1.5, [P_ACCENT]: 1 });
      expect(out.every(Number.isFinite)).toBe(true);
      expect(peak(out)).toBeLessThan(2);
    });
    it(`keeps a similar level at the default knobs (${filter ? 'diode' : 'ladder'})`, () => {
      const p = peak(drive(tsEngine(), script(), FRAMES, { [P_FILTER]: filter }));
      expect(p).toBeGreaterThan(0.2);
      expect(p).toBeLessThan(1);
    });
  }

  it('stays stable with every knob and mod at max', () => {
    const out = drive(tsEngine(), script(), FRAMES, { [P_FILTER]: 1, [P_CUTOFF]: 1, [P_RESO]: 20, [P_ENV]: 1, [P_DECAY]: 1.5, [P_ACCENT]: 1,
      [P_ACC_DECAY]: 1, [P_SOFT_ATTACK]: 1, [P_SLIDE_TIME]: 1, [P_SWEEP]: 1, [P_FILTER_FM]: 1, [P_TRACKING]: 1, [P_DRIVE]: 1, [P_MUFFLER]: 2,
      [P_SELF_OSC]: 1 });
    expect(out.every(Number.isFinite)).toBe(true);
    expect(peak(out)).toBeLessThan(2);
  });

  // One held note: [peak, level after ms]
  const held = (params: Record<number, number>, ms: number, freq = 110) => {
    const out = drive(tsEngine(), [{ frame: 0, run: e => e.noteOn(freq, 0, 0) }], SR, params);
    return [peak(out), peak(out.subarray(ms * SR / 1000, ms * SR / 1000 + 2400))];
  };
  const brightness = (out: Float32Array) => {
    let d = 0, s = 0;
    for (let i = 1; i < out.length; i++) { d += Math.abs(out[i] - out[i - 1]); s += out[i] * out[i]; }
    return d / Math.sqrt(s * out.length);
  };

  it('VEG DECAY fades a held note, and holds it at max', () => {
    const [p, late] = held({ [P_VEG_DECAY]: 0 }, 200);
    expect(late).toBeLessThan(p * 0.1);
    const [p2, late2] = held({}, 200);
    expect(late2).toBeGreaterThan(p2 * 0.5);
  });

  it('TRACKING opens the filter for higher notes', () => {
    const tone = (freq: number, tracking: number) =>
      brightness(drive(tsEngine(), [{ frame: 0, run: e => e.noteOn(freq, 0, 0) }], SR / 4, { [P_TRACKING]: tracking, [P_ENV]: 0 }));
    expect(tone(440, 1) / tone(440, 0)).toBeGreaterThan(1.2);
  });

  it('DRIVE squashes the waveform (lower crest factor)', () => {
    const crest = (d: number) => {
      const out = drive(tsEngine(), [{ frame: 0, run: e => e.noteOn(110, 0, 0) }], SR / 4, { [P_DRIVE]: d, [P_RESO]: 0 }).subarray(SR / 20);
      let s = 0; for (const x of out) s += x * x;
      return peak(out) / Math.sqrt(s / out.length);
    };
    expect(crest(1)).toBeLessThan(crest(0));
  });

  it('decays to silence after the last note', () => {
    const out = drive(tsEngine(), [{ frame: 0, run: e => e.noteOn(110, 1, 0) }, { frame: 4800, run: e => e.noteOff() }], SR);
    expect(peak(out.subarray(SR / 2))).toBeLessThan(1e-4);
  });
});

describe('WASM engine', () => {
  for (const [label, params] of [
    ['defaults', {}],
    ['max knobs', { [P_CUTOFF]: 1, [P_RESO]: 20, [P_ENV]: 1, [P_DECAY]: 1.5, [P_ACCENT]: 1 }],
    ['dark square', { [P_CUTOFF]: 0, [P_RESO]: 5, [P_ENV]: 0.2, [P_WAVE]: 1 }],
    ['diode defaults', { [P_FILTER]: 1 }],
    ['diode max knobs', { [P_FILTER]: 1, [P_CUTOFF]: 1, [P_RESO]: 20, [P_ENV]: 1, [P_DECAY]: 1.5, [P_ACCENT]: 1 }],
    ['all mods', { [P_FILTER]: 1, [P_ACC_DECAY]: 0.8, [P_VEG_DECAY]: 0.4, [P_SOFT_ATTACK]: 0.9, [P_SLIDE_TIME]: 0.7, [P_SWEEP]: 0.2,
      [P_FILTER_FM]: 0.3, [P_TRACKING]: 0.6, [P_DRIVE]: 0.5, [P_MUFFLER]: 1 }],
    ['self osc, extended ranges', { [P_FILTER]: 1, [P_RESO]: 20, [P_SELF_OSC]: 1, [P_DECAY]: 1.5, [P_ENV]: 3, [P_ACC_DECAY]: 1, [P_DRIVE]: 1 }],
  ] as const) {
    it(`matches the TS engine (${label})`, () => {
      const a = drive(tsEngine(), script(), FRAMES, params), b = drive(wasmEngine(), script(), FRAMES, params);
      let err = 0;
      for (let i = 0; i < a.length; i++) err = Math.max(err, Math.abs(a[i] - b[i]));
      expect(err / Math.max(1e-9, peak(a))).toBeLessThan(1e-6);
    });
  }
});

// Small-signal response of a filter at f (input 0.01 keeps the tanh in its linear range)
function gainAt(make: () => { tick(x: number, g: number, k: number): number }, fc: number, k: number, f: number) {
  const fs = 96000, flt = make(), g = Math.tan(Math.PI * fc / fs);
  let pk = 0;
  for (let i = 0; i < fs / 2; i++) {
    const y = flt.tick(0.01 * Math.sin(2 * Math.PI * f * i / fs), g, k);
    if (i > fs / 4) pk = Math.max(pk, Math.abs(y));
  }
  return pk / 0.01;
}
const db = (x: number) => 20 * Math.log10(x);
const slope = (make: () => Ladder | DiodeLadder, a: number, b: number) => db(gainAt(make, 1000, 0, 1000 * b)) - db(gainAt(make, 1000, 0, 1000 * a));
// Ring-down after an impulse: late/early peak ratio < 1 means it decays
function ringRatio(make: () => Ladder | DiodeLadder, k: number) {
  const flt = make(), g = Math.tan(Math.PI * 1000 / 96000);
  flt.tick(0.01, g, k);
  let early = 0, late = 0;
  for (let i = 0; i < 96000; i++) { const y = Math.abs(flt.tick(0, g, k)); if (i < 48000) early = Math.max(early, y); else late = Math.max(late, y); }
  return late / early;
}

describe('filters', () => {
  it('ladder: unity DC gain, 24 dB/oct above cutoff', () => {
    expect(gainAt(() => new Ladder(), 1000, 0, 20)).toBeCloseTo(1, 1);
    expect(slope(() => new Ladder(), 4, 8)).toBeLessThan(-20);
  });

  it('diode ladder: unity DC gain, gentler slope near cutoff, steeper above', () => {
    expect(gainAt(() => new DiodeLadder(), 1000, 0, 20)).toBeCloseTo(1, 1);
    const near = slope(() => new DiodeLadder(), 1, 2), far = slope(() => new DiodeLadder(), 8, 16);
    expect(near).toBeGreaterThan(-15);
    expect(near).toBeLessThan(-10);
    expect(far).toBeLessThan(-22);
  });

  it('diode ladder: resonance peaks near cutoff and thins the bass', () => {
    const k = 15;
    let best = 0, bestF = 0;
    for (let f = 400; f < 2500; f *= 1.03) { const gn = gainAt(() => new DiodeLadder(), 1000, k, f); if (gn > best) { best = gn; bestF = f; } }
    expect(bestF).toBeGreaterThan(900);
    expect(bestF).toBeLessThan(1300);
    expect(best).toBeGreaterThan(gainAt(() => new DiodeLadder(), 1000, k, 50) * 5);
  });

  it('RESO max stays below self-oscillation for both filters', () => {
    expect(ringRatio(() => new Ladder(), LADDER_K)).toBeLessThan(0.5);
    expect(ringRatio(() => new DiodeLadder(), DIODE_K)).toBeLessThan(0.5);
    expect(ringRatio(() => new DiodeLadder(), 20)).toBeGreaterThan(0.9); // above it, the tanh holds a steady self-oscillation
    // SELF OSC scales the max feedback by 1.3, which must reach self-oscillation for both filters
    expect(ringRatio(() => new Ladder(), LADDER_K * 1.3)).toBeGreaterThan(0.9);
    expect(ringRatio(() => new DiodeLadder(), DIODE_K * 1.3)).toBeGreaterThan(0.9);
  });
});
