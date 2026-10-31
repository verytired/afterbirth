import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Drum909, KNOBS, VOICES, makeRom, recipe, type Voice909 } from './tr909';

const SR = 48000;
const ROM = makeRom();
type Engine = Pick<Drum909, 'add' | 'choke' | 'render'>;

function tsEngine(): Engine { const e = new Drum909(SR); e.setRom(ROM.data, ROM.lens); return e; }

function wasmEngine(): Engine {
  const x = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL('./tr909.wasm', import.meta.url))), {}).exports as unknown as {
    memory: WebAssembly.Memory; init(sr: number): void; outPtr(): number; romPtr(): number; setRom(a: number, b: number, c: number): void;
    choke(g: number): void; add: Drum909['add']; render(n: number): void;
  };
  x.init(SR);
  new Int8Array(x.memory.buffer, x.romPtr(), ROM.data.length).set(ROM.data);
  x.setRom(ROM.lens[0], ROM.lens[1], ROM.lens[2]);
  const buf = new Float32Array(x.memory.buffer, x.outPtr(), 128);
  return { add: x.add, choke: x.choke, render(out, off, n) { x.render(n); out.set(buf.subarray(0, n), off); } };
}

type Hit = { frame: number; v: Voice909; l: number; p: number[] };
const knobs = (v: Voice909, x: number) => KNOBS[v].map((_, i) => (x + 0.23 * i) % 1);

// Every voice with off-center knobs (CR / RD TUNE != 1 plays the ROM at fractional positions), CH 20 ms
// after OH (choke), CP twice 11 ms apart (retrigger), and enough overlap to steal component slots
function script(): Hit[] {
  const hits: Hit[] = [], step = Math.round(SR * 0.11);
  VOICES.forEach((v, i) => hits.push({ frame: i * step, v, l: 0.8, p: knobs(v, 0.3) }));
  const t = VOICES.length * step;
  hits.push({ frame: t, v: 'OH', l: 1, p: knobs('OH', 0.9) }, { frame: t + Math.round(SR * 0.02), v: 'CH', l: 0.7, p: knobs('CH', 0.1) });
  hits.push({ frame: t + step, v: 'CP', l: 0.8, p: [] }, { frame: t + step + Math.round(SR * 0.011), v: 'CP', l: 0.8, p: [] });
  for (let k = 0; k < 24; k++) hits.push({ frame: t + 2 * step + k * 300, v: VOICES[k % VOICES.length], l: 0.6, p: knobs(VOICES[k % VOICES.length], k / 24) });
  return hits.sort((a, b) => a.frame - b.frame);
}

// Same splitting and hit-to-component order as drum-processor.ts
function drive(e: Engine, hits: Hit[], frames: number) {
  const out = new Float32Array(frames);
  let pos = 0, q = 0;
  for (let block = 0; block < frames; block += 128) {
    const end = Math.min(frames, block + 128);
    while (q < hits.length && hits[q].frame < end) {
      const at = Math.max(pos, hits[q].frame);
      if (at > pos) { e.render(out, pos, at - pos); pos = at; }
      const h = hits[q++];
      for (const c of recipe(h.v, h.l, h.p)) {
        if (c.group) e.choke(c.group);
        e.add(c.kind, c.delay, c.dur, c.wave, c.f0, c.f1, c.glide, c.ft, c.ff, c.fq, c.lp, c.rom, c.rate, c.env, c.peak, c.dec, c.group);
      }
    }
    if (end > pos) { e.render(out, pos, end - pos); pos = end; }
  }
  return out;
}

const FRAMES = SR * 3;
const peak = (a: Float32Array) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

describe('Drum909', () => {
  it('WASM build renders the same as the TS engine', () => {
    const a = drive(tsEngine(), script(), FRAMES), b = drive(wasmEngine(), script(), FRAMES);
    expect(a.reduce((m, x, i) => Math.max(m, Math.abs(x - b[i])), 0)).toBeLessThan(1e-6);
    expect(peak(a)).toBeGreaterThan(0.1);
  });

  it('is deterministic', () => {
    expect(drive(tsEngine(), script(), FRAMES)).toEqual(drive(tsEngine(), script(), FRAMES));
  });

  it('every voice sounds, at a sane level', () => {
    for (const v of VOICES) {
      const p = peak(drive(tsEngine(), [{ frame: 0, v, l: 0.8, p: KNOBS[v].map(() => 0.5) }], SR));
      expect(p, v).toBeGreaterThan(0.05);
      expect(p, v).toBeLessThan(1.5);
    }
  });

  it('a closed hat cuts a ringing open hat', () => {
    const at = Math.round(SR * 0.05), tail = (hits: Hit[]) => peak(drive(tsEngine(), hits, SR).subarray(at + 2400));
    const oh: Hit = { frame: 0, v: 'OH', l: 1, p: [0.5, 1] };
    expect(tail([oh, { frame: at, v: 'CH', l: 0.01, p: [0.5, 0] }])).toBeLessThan(tail([oh]) * 0.05);
  });

  it('ROM is 6-bit', () => {
    expect(ROM.data.every(x => x >= -31 && x <= 31)).toBe(true);
    expect(ROM.lens).toEqual([16200, 36000, 32400]);
  });
});
