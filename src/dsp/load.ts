// Loads each worklet once, and compiles its WASM engine if it can (null means use the JS engine)
import voiceUrl from './voice-processor.ts?worker&url';
import voiceWasm from './voice.wasm?url';
import drumUrl from './drum-processor.ts?worker&url';
import drumWasm from './tr909.wasm?url';
import url606 from './tr606-processor.ts?worker&url';
import wasm606 from './tr606.wasm?url';
import url808 from './tr808-processor.ts?worker&url';
import wasm808 from './tr808.wasm?url';

const ready = new Map<string, Promise<WebAssembly.Module | null>>();

function load(ctx: AudioContext, processorUrl: string, wasmUrl: string) {
  let p = ready.get(processorUrl);
  if (!p) ready.set(processorUrl, p = (async () => {
    await ctx.audioWorklet.addModule(processorUrl);
    try {
      return await WebAssembly.compile(await (await fetch(wasmUrl)).arrayBuffer());
    } catch {
      return null;
    }
  })());
  return p;
}

export const loadVoice = (ctx: AudioContext) => load(ctx, voiceUrl, voiceWasm);
export const loadDrums = (ctx: AudioContext) => load(ctx, drumUrl, drumWasm);
export const load606 = (ctx: AudioContext) => load(ctx, url606, wasm606);
export const load808 = (ctx: AudioContext) => load(ctx, url808, wasm808);
