// Loads the voice worklet once, and compiles the WASM engine if it can (null means use the JS engine)
import processorUrl from './voice-processor.ts?worker&url';
import wasmUrl from './voice.wasm?url';

let ready: Promise<WebAssembly.Module | null> | undefined;

export function loadVoice(ctx: AudioContext) {
  return ready ??= (async () => {
    await ctx.audioWorklet.addModule(processorUrl);
    try {
      return await WebAssembly.compile(await (await fetch(wasmUrl)).arrayBuffer());
    } catch {
      return null;
    }
  })();
}
