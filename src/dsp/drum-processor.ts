// AudioWorklet shell around the 606 engine: WASM when it compiles, else the TS twin.
// Splits each render block at hit boundaries, like voice-processor.ts
import { Tr606 } from './tr606';
import type { DrumMsg, EngineName, ProcessorMsg } from './protocol';

declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, ctor: new (options: { processorOptions: { wasm: WebAssembly.Module | null } }) => AudioWorkletProcessor): void;

interface Engine { trig(v: number, l: number, s: number): void; render(out: Float32Array, off: number, n: number): void }

function wasmEngine(mod: WebAssembly.Module): Engine {
  const x = new WebAssembly.Instance(mod, {}).exports as unknown as {
    memory: WebAssembly.Memory; init(sr: number): void; outPtr(): number; trig(v: number, l: number, s: number): void; render(n: number): void;
  };
  x.init(sampleRate);
  const buf = new Float32Array(x.memory.buffer, x.outPtr(), 128);
  return { trig: (v, l, s) => x.trig(v, l, s), render(out, off, n) { x.render(n); out.set(buf.subarray(0, n), off); } };
}

class DrumProcessor extends AudioWorkletProcessor {
  private engine: Engine;
  private q: DrumMsg[] = [];

  constructor({ processorOptions: o }: { processorOptions: { wasm: WebAssembly.Module | null } }) {
    super();
    let name: EngineName = 'js', e: Engine | undefined;
    try {
      if (o.wasm) { e = wasmEngine(o.wasm); name = 'wasm'; }
    } catch (err) {
      this.port.postMessage({ k: 'error', msg: String(err) } satisfies ProcessorMsg);
    }
    this.engine = e ?? new Tr606(sampleRate);
    this.port.postMessage({ k: 'engine', name } satisfies ProcessorMsg);
    this.port.onmessage = (ev: MessageEvent<DrumMsg>) => {
      let i = this.q.length;
      while (i > 0 && this.q[i - 1].t > ev.data.t) i--;
      this.q.splice(i, 0, ev.data);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0][0], n = out.length;
    let pos = 0;
    while (this.q.length) {
      const frame = Math.round((this.q[0].t - currentTime) * sampleRate);
      if (frame >= n) break;
      const at = Math.max(pos, frame);
      if (at > pos) { this.engine.render(out, pos, at - pos); pos = at; }
      const m = this.q.shift()!;
      this.engine.trig(m.v, m.l, m.s);
    }
    if (pos < n) this.engine.render(out, pos, n - pos);
    return true;
  }
}

registerProcessor('tr606', DrumProcessor);
