// Messages between the main thread and the 303 voice / 909 drum worklets
import type { Voice909 } from './tr909';

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

export type DrumMsg =
  | { k: 'hit'; t: number; v: Voice909; l: number; a: number; p: number[] } // a: accent amount, p: the voice's KNOBS values
  | { k: 'flush' }
  | { k: 'engine'; name: EngineName };
