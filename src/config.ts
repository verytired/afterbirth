// Startup defaults, bundled at build time
import type { EngineName } from './dsp/protocol';

// wasm/js = the 303 voice in an AudioWorklet (same DSP, two builds); classic = the original BiquadFilter graph
export type EngineChoice = EngineName | 'classic';
export type FilterName = 'diode' | 'ladder';

export const config: { engine: EngineChoice; filter: FilterName } = {
  engine: 'wasm',
  filter: 'diode',
};
