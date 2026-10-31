import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Tr808, V808, VOICES808 } from './tr808';

const SR = 48000;
interface Engine { trig(v: number, l: number, a: number, p0: number, p1: number): void; render(out: Float32Array, off: number, n: number): void }

function wasmEngine(): Engine {
  const x = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL('./tr808.wasm', import.meta.url))), {}).exports as unknown as {
    memory: WebAssembly.Memory; init(sr: number): void; outPtr(): number; trig: Engine['trig']; render(n: number): void;
  };
  x.init(SR);
  const buf = new Float32Array(x.memory.buffer, x.outPtr(), 128);
  return { trig: (v, l, a, p0, p1) => x.trig(v, l, a, p0, p1), render(out, off, n) { x.render(n); out.set(buf.subarray(0, n), off); } };
}

type Hit = [frame: number, v: number, l: number, a?: number, p0?: number, p1?: number];

// Render in 128-frame blocks, split at hits like tr808-processor.ts
function drive(e: Engine, hits: Hit[], frames: number) {
  const out = new Float32Array(frames);
  let h = 0;
  for (let b = 0; b < frames; b += 128) {
    const n = Math.min(128, frames - b);
    let pos = 0;
    while (h < hits.length && hits[h][0] < b + n) {
      const [f, v, l, a = 0, p0 = 0.5, p1 = 0.5] = hits[h];
      if (f - b > pos) { e.render(out, b + pos, f - b - pos); pos = f - b; }
      e.trig(v, l, a, p0, p1); h++;
    }
    if (pos < n) e.render(out, b + pos, n - pos);
  }
  return out;
}
const peak = (a: Float32Array, from = 0, to = a.length) => { let p = 0; for (let i = from; i < to; i++) p = Math.max(p, Math.abs(a[i])); return p; };
// Last sample above 1/10 of the peak: the Service Notes' decay time
const decay = (a: Float32Array) => { const p = peak(a); let t = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > p / 10) t = i; return t / SR; };
const ts = () => new Tr808(SR);
const one = (v: number, a = 0, p0 = 0.5, p1 = 0.5, sec = 2) => drive(ts(), [[0, v, 0.8, a, p0, p1]], SR * sec);

describe('TR-808 engine', () => {
  it('WASM matches the TS engine', () => {
    const s = SR / 8, hits: Hit[] = [];
    for (let i = 0; i < 32; i++) {
      const v = i % 16;
      hits.push([i * s, V808.BD, 0.8, i % 4 ? 0 : 0.7, i / 32, 1 - i / 32]);
      hits.push([i * s + 5, v, 0.7, i % 3 ? 0 : 1, (i * 7 % 10) / 10, (i * 3 % 10) / 10]);
      hits.push([i * s + 300, i % 2 ? V808.CH : V808.OH, 0.6]);
    }
    const n = 33 * s, a = drive(ts(), hits, n), b = drive(wasmEngine(), hits, n);
    let err = 0;
    for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(a[i] - b[i]));
    expect(peak(a)).toBeGreaterThan(0.3);
    expect(err / peak(a)).toBeLessThan(1e-6);
  });

  for (const v of VOICES808)
    it(`${v}: sensible level, accent louder, dies away`, () => {
      const a = one(V808[v]), acc = one(V808[v], 1);
      expect(peak(a)).toBeGreaterThan(0.1);
      expect(peak(acc)).toBeLessThan(1.5);
      expect(peak(acc)).toBeGreaterThan(peak(a) * 1.4);
      expect(peak(a, SR * 1.8)).toBeLessThan(0.01);
    });

  it('decay times follow the Service Notes chart', () => {
    const near = (got: number, want: number) => expect(Math.abs(got / want - 1)).toBeLessThan(0.25);
    near(decay(one(V808.BD, 0, 0.5, 0)), 0.05); near(decay(one(V808.BD, 0, 0.5, 0.5)), 0.3); near(decay(one(V808.BD, 0, 0.5, 1)), 0.8);
    near(decay(one(V808.LT)), 0.2); near(decay(one(V808.HC)), 0.08); near(decay(one(V808.CL)), 0.025);
    near(decay(one(V808.OH, 0, 0)), 0.09); near(decay(one(V808.OH, 0, 1)), 0.6); near(decay(one(V808.CH)), 0.05);
    near(decay(one(V808.CY, 0, 0.5, 1, 3)), 1.2);
  });

  it('BD rings near 50 Hz; TUNING moves a tom through its chart range', () => {
    const hz = (a: Float32Array, from: number, to: number) => { let zc = 0; for (let i = from + 1; i < to; i++) if (a[i - 1] < 0 !== a[i] < 0) zc++; return zc / 2 / ((to - from) / SR); };
    expect(hz(one(V808.BD, 0, 0.5, 1), SR * 0.1, SR * 0.4)).toBeCloseTo(50, -1);
    // late in the ring, where the diode pitch sweep has died away
    expect(hz(one(V808.LT, 0, 0), SR * 0.15, SR * 0.4)).toBeCloseTo(80, -1);
    expect(hz(one(V808.LT, 0, 1), SR * 0.15, SR * 0.4)).toBeCloseTo(100, -1);
  });

  it('CH cuts a ringing OH', () => {
    const at = SR * 0.05, oh = drive(ts(), [[0, V808.OH, 0.8, 0, 1]], SR), cut = drive(ts(), [[0, V808.OH, 0.8, 0, 1], [at, V808.CH, 0.8]], SR);
    expect(peak(cut, at + SR * 0.15, SR * 0.3)).toBeLessThan(peak(oh, at + SR * 0.15, SR * 0.3) / 10);
  });

  it('LEVEL 0 is silent', () => {
    for (let v = 0; v < 16; v++) expect(peak(drive(ts(), [[0, v, 0, 1]], SR / 4))).toBe(0);
  });
});
