// Messages between the main thread and the 303 voice worklet
export type EngineName = 'wasm' | 'js';

export type VoiceMsg =
  | { k: 'on'; t: number; f: number; acc: number; slide: number }
  | { k: 'off'; t: number }
  | { k: 'p'; id: number; v: number }
  | { k: 'flush' }
  | { k: 'engine'; name: EngineName };

export type ProcessorMsg =
  | { k: 'engine'; name: EngineName }
  | { k: 'error'; msg: string };

// Main thread -> 606 worklet: one drum hit (v: part index, l: level with accent, s: one 16th in seconds)
export type DrumMsg = { k: 'trig'; t: number; v: number; l: number; s: number };
