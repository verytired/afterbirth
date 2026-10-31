import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Voice303, P_CUTOFF, P_RESO, P_ENV, P_DECAY, P_ACCENT, P_WAVE } from './engine';

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
function script(): Ev[] {
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
function drive(e: Engine, evs: Ev[], frames: number, params: Record<number, number> = {}) {
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
const FRAMES = SR * 4;

describe('Voice303', () => {
  it('is deterministic', () => {
    expect(drive(tsEngine(), script(), FRAMES)).toEqual(drive(tsEngine(), script(), FRAMES));
  });

  it('makes sound at a sane level', () => {
    const p = peak(drive(tsEngine(), script(), FRAMES));
    expect(p).toBeGreaterThan(0.05);
    expect(p).toBeLessThan(1.5);
  });

  it('stays stable with every knob at max', () => {
    const out = drive(tsEngine(), script(), FRAMES, { [P_CUTOFF]: 1, [P_RESO]: 20, [P_ENV]: 1, [P_DECAY]: 1.5, [P_ACCENT]: 1 });
    expect(out.every(Number.isFinite)).toBe(true);
    expect(peak(out)).toBeLessThan(2);
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
  ] as const) {
    it(`matches the TS engine (${label})`, () => {
      const a = drive(tsEngine(), script(), FRAMES, params), b = drive(wasmEngine(), script(), FRAMES, params);
      let err = 0;
      for (let i = 0; i < a.length; i++) err = Math.max(err, Math.abs(a[i] - b[i]));
      expect(err / Math.max(1e-9, peak(a))).toBeLessThan(1e-6);
    });
  }
});
