// AudioWorklet shell around the 909 drum engine. Same timed queue as voice-processor.ts: each render block
// is split at hit boundaries so both engines see identical call sequences
import { Drum909, recipe } from './tr909';
import type { DrumMsg, EngineName, ProcessorMsg } from './protocol';

declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, ctor: new (options: { processorOptions: Options }) => AudioWorkletProcessor): void;

interface Options { wasm: WebAssembly.Module | null; engine: EngineName; rom: Int8Array; lens: number[] }
type Engine = Pick<Drum909, 'add' | 'choke' | 'render'>;

interface WasmExports {
  memory: WebAssembly.Memory; init(sr: number): void; outPtr(): number; romPtr(): number; setRom(a: number, b: number, c: number): void;
  choke(g: number): void; add: Drum909['add']; render(n: number): void;
}

function wasmEngine(mod: WebAssembly.Module, rom: Int8Array, lens: number[]): Engine {
  const x = new WebAssembly.Instance(mod, {}).exports as unknown as WasmExports;
  x.init(sampleRate);
  new Int8Array(x.memory.buffer, x.romPtr(), rom.length).set(rom);
  x.setRom(lens[0], lens[1], lens[2]);
  const buf = new Float32Array(x.memory.buffer, x.outPtr(), 128);
  return { add: x.add, choke: x.choke, render(out, off, n) { x.render(n); out.set(buf.subarray(0, n), off); } };
}

type Hit = Extract<DrumMsg, { k: 'hit' }>;

class DrumProcessor extends AudioWorkletProcessor {
  private engines: Partial<Record<EngineName, Engine>> = {};
  private engine: Engine;
  private q: Hit[] = [];

  constructor({ processorOptions: o }: { processorOptions: Options }) {
    super();
    const js = new Drum909(sampleRate);
    js.setRom(o.rom, o.lens);
    this.engines.js = js;
    try {
      if (o.wasm) this.engines.wasm = wasmEngine(o.wasm, o.rom, o.lens);
    } catch (e) {
      this.post({ k: 'error', msg: String(e) });
    }
    const name: EngineName = o.engine === 'wasm' && this.engines.wasm ? 'wasm' : 'js';
    this.engine = this.engines[name]!;
    this.post({ k: 'engine', name });
    this.port.onmessage = (e: MessageEvent<DrumMsg>) => this.onMsg(e.data);
  }

  private post(m: ProcessorMsg) { this.port.postMessage(m); }

  private onMsg(m: DrumMsg) {
    if (m.k === 'flush') this.q = []; // queued hits only: ringing tails play out, as on the hardware
    else if (m.k === 'engine') {
      this.engine = this.engines[m.name] ?? this.engines.js!;
      this.post({ k: 'engine', name: this.engine === this.engines.wasm ? 'wasm' : 'js' });
    } else {
      let i = this.q.length;
      while (i > 0 && this.q[i - 1].t > m.t) i--;
      this.q.splice(i, 0, m);
    }
  }

  private hit(m: Hit) {
    for (const c of recipe(m.v, m.l, m.p)) {
      if (c.group) this.engine.choke(c.group);
      this.engine.add(c.kind, c.delay, c.dur, c.wave, c.f0, c.f1, c.glide, c.ft, c.ff, c.fq, c.lp, c.rom, c.rate, c.env, c.peak, c.dec, c.group);
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0][0], n = out.length;
    let pos = 0;
    while (this.q.length) {
      const frame = Math.round((this.q[0].t - currentTime) * sampleRate);
      if (frame >= n) break;
      const at = Math.max(pos, frame);
      if (at > pos) { this.engine.render(out, pos, at - pos); pos = at; }
      this.hit(this.q.shift()!);
    }
    if (pos < n) this.engine.render(out, pos, n - pos);
    return true;
  }
}

registerProcessor('drum909', DrumProcessor);
