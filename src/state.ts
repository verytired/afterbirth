// Shared mutable state. Importers see live values but must use the setters to change them
export let ctx: AudioContext;
export let playing = false;
export let ext = false; // following external MIDI clock

export const initCtx = () => { ctx = new AudioContext(); };
export const setPlaying = (v: boolean) => { playing = v; };
export const setExt = (v: boolean) => { ext = v; };
