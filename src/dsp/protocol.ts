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
