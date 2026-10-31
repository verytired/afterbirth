// AudioWorklet shell around a 303 voice engine. Holds a time-ordered event queue and splits each
// render block at event boundaries, so both engines see identical call sequences
import { Voice303 } from './engine';
import type { VoiceMsg, EngineName, ProcessorMsg } from './protocol';

// AudioWorkletGlobalScope (declared here rather than pulling worklet typings that clash with lib.dom)
declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, ctor: new (options: { processorOptions: Options }) => AudioWorkletProcessor): void;

interface Options { wasm: WebAssembly.Module | null; engine: EngineName }
interface Engine { setParam(id: number, v: number): void; noteOn(f: number, acc: number, slide: number): void; noteOff(): void; render(out: Float32Array, off: number, n: number): void }

interface WasmExports {
  memory: WebAssembly.Memory; init(sr: number): void; outPtr(): number; setParam(id: number, v: number): void;
  noteOn(f: number, acc: number, slide: number): void; noteOff(): void; render(n: number): void;
}

function wasmEngine(mod: WebAssembly.Module): Engine {
  const x = new WebAssembly.Instance(mod, {}).exports as unknown as WasmExports;
  x.init(sampleRate);
  const buf = new Float32Array(x.memory.buffer, x.outPtr(), 128);
  return {
    setParam: (id, v) => x.setParam(id, v), noteOn: (f, a, s) => x.noteOn(f, a, s), noteOff: () => x.noteOff(),
    render(out, off, n) { x.render(n); out.set(buf.subarray(0, n), off); },
  };
}

type Timed = Extract<VoiceMsg, { t: number }>;

class VoiceProcessor extends AudioWorkletProcessor {
  private engines: Partial<Record<EngineName, Engine>> = {};
  private engine: Engine;
  private q: Timed[] = [];

  constructor({ processorOptions: o }: { processorOptions: Options }) {
    super();
    this.engines.js = new Voice303(sampleRate);
    try {
      if (o.wasm) this.engines.wasm = wasmEngine(o.wasm);
    } catch (e) {
      this.post({ k: 'error', msg: String(e) });
    }
    const name: EngineName = o.engine === 'wasm' && this.engines.wasm ? 'wasm' : 'js';
    this.engine = this.engines[name]!;
    this.post({ k: 'engine', name });
    this.port.onmessage = (e: MessageEvent<VoiceMsg>) => this.onMsg(e.data);
  }

  private post(m: ProcessorMsg) { this.port.postMessage(m); }

  private onMsg(m: VoiceMsg) {
    if (m.k === 'p') { for (const e of Object.values(this.engines)) e.setParam(m.id, m.v); }
    else if (m.k === 'flush') { this.q = []; this.engine.noteOff(); }
    else if (m.k === 'engine') {
      const next = this.engines[m.name] ?? this.engines.js!;
      this.engine.noteOff();
      this.engine = next;
      this.post({ k: 'engine', name: next === this.engines.wasm ? 'wasm' : 'js' });
    } else {
      let i = this.q.length;
      while (i > 0 && this.q[i - 1].t > m.t) i--;
      this.q.splice(i, 0, m);
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
      const m = this.q.shift()!;
      if (m.k === 'on') this.engine.noteOn(m.f, m.acc, m.slide);
      else this.engine.noteOff();
    }
    if (pos < n) this.engine.render(out, pos, n - pos);
    return true;
  }
}

registerProcessor('voice303', VoiceProcessor);
