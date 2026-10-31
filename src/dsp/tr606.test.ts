import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Tr606, BD, SD, LT, HT, CY, CH, OH } from './tr606';

const SR = 48000;
interface Engine { trig(v: number, l: number, s: number): void; render(out: Float32Array, off: number, n: number): void }

function wasmEngine(): Engine {
  const x = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL('./tr606.wasm', import.meta.url))), {}).exports as unknown as {
    memory: WebAssembly.Memory; init(sr: number): void; outPtr(): number; trig(v: number, l: number, s: number): void; render(n: number): void;
  };
  x.init(SR);
  const buf = new Float32Array(x.memory.buffer, x.outPtr(), 128);
  return { trig: (v, l, s) => x.trig(v, l, s), render(out, off, n) { x.render(n); out.set(buf.subarray(0, n), off); } };
}

type Hit = [frame: number, v: number, l: number];
const STEP = 0.125; // 120 BPM

// Render in 128-frame blocks, split at hits like tr606-processor.ts
function drive(e: Engine, hits: Hit[], frames: number) {
  const out = new Float32Array(frames);
  let h = 0;
  for (let b = 0; b < frames; b += 128) {
    const n = Math.min(128, frames - b);
    let pos = 0;
    while (h < hits.length && hits[h][0] < b + n) {
      const at = hits[h][0] - b;
      if (at > pos) { e.render(out, b + pos, at - pos); pos = at; }
      e.trig(hits[h][1], hits[h][2], STEP); h++;
    }
    if (pos < n) e.render(out, b + pos, n - pos);
  }
  return out;
}
const peak = (a: Float32Array, from = 0, to = a.length) => { let p = 0; for (let i = from; i < to; i++) p = Math.max(p, Math.abs(a[i])); return p; };
const ts = () => new Tr606(SR);

describe('TR-606 engine', () => {
  it('WASM matches the TS engine', () => {
    const s = Math.round(SR * STEP), hits: Hit[] = [];
    for (let i = 0; i < 32; i++) {
      if (i % 4 === 0) hits.push([i * s, BD, i % 8 ? 0.8 : 1.2]);
      if (i % 8 === 4) hits.push([i * s, SD, 0.8]);
      hits.push([i * s, i % 4 === 2 ? OH : CH, 0.7]);
      if (i === 14) hits.push([i * s, LT, 0.8]);
      if (i === 15) hits.push([i * s + 7, HT, 0.8]);
      if (i === 16) hits.push([i * s, CY, 0.8]);
    }
    const n = 33 * s, a = drive(ts(), hits, n), b = drive(wasmEngine(), hits, n);
    let err = 0;
    for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(a[i] - b[i]));
    expect(peak(a)).toBeGreaterThan(0.3);
    expect(err / peak(a)).toBeLessThan(1e-6);
  });

  for (const [name, v] of Object.entries({ BD, SD, LT, HT, CY, CH, OH }))
    it(`${name}: sensible level and dies away`, () => {
      const a = drive(ts(), [[0, v, 0.8]], SR * 2);
      expect(peak(a)).toBeGreaterThan(0.2);
      expect(peak(a)).toBeLessThan(1.2);
      expect(peak(a, SR * 1.8)).toBeLessThan(0.01);
    });

  it('BD rings at 60 Hz (bridged-T, no pitch sweep)', () => {
    const a = drive(ts(), [[0, BD, 0.8]], SR);
    let zc = 0;
    for (let i = SR * 0.1; i < SR * 0.3; i++) if (a[i - 1] < 0 !== a[i] < 0) zc++;
    expect(zc / 2 / 0.2).toBeCloseTo(60, -1);
  });

  it('CH cuts a ringing OH', () => {
    const at = SR * 0.05, oh = drive(ts(), [[0, OH, 0.8]], SR), cut = drive(ts(), [[0, OH, 0.8], [at, CH, 0.8]], SR);
    expect(peak(cut, at + SR * 0.1, SR * 0.2)).toBeLessThan(peak(oh, at + SR * 0.1, SR * 0.2) / 10);
  });

  it('metal needles stay near the typical peak whatever the oscillator phases at the hit', () => {
    for (const v of [CY, OH]) {
      const pk: number[] = [];
      for (let k = 0; k < 60; k++) {
        const e = ts(), pre = new Float32Array(1000 + k * 997), o = new Float32Array(4800);
        e.render(pre, 0, pre.length); e.trig(v, 0.8, STEP); e.render(o, 0, o.length);
        pk.push(peak(o));
      }
      pk.sort((a, b) => a - b);
      expect(pk[59] / pk[30]).toBeLessThan(1.6); // without the ceiling: ~2.8 for CY
    }
  });

  it('OH decay follows the clock', () => {
    const run = (step: number) => { const e = ts(), o = new Float32Array(SR); e.trig(OH, 0.8, step); e.render(o, 0, SR); return peak(o, SR * 0.3, SR * 0.4); };
    expect(run(0.08)).toBeLessThan(run(0.16) / 4);
  });
});
