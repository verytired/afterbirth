import { $, fv, numbox } from './dom';
import { ctx, initCtx, playing, setPlaying, ext } from './state';
import { delay, master, pcfStep, refresh } from './audio';
import { machines } from './rack';
import { shuffleOffset } from './lib';

export const tempo = numbox($('tempo'), 60, 200, 128);
export let cur = 0;
export const setCur = (i: number) => { cur = i; };
let nextT = 0, timer: ReturnType<typeof setInterval> | undefined;

export async function ensureAudio() {
  if (!ctx) {
    initCtx();
    master.init(); delay.init();
    machines.forEach(m => m.init());
    refresh();
  }
  await ctx.resume();
}

// Play one step at time t (shared by internal and MIDI clock)
export function playStep(i: number, t: number, d: number) {
  const sh = shuffleOffset(i, fv('shuffle'), d);
  machines.forEach(m => m.play(i, t, d, sh));
  pcfStep(i, t);
  delay.setTime(d);
  setTimeout(() => playing && machines.forEach(m => m.highlight(i)), Math.max(0, (t - ctx.currentTime) * 1000));
}

function tick() {
  while (nextT < ctx.currentTime + 0.1) {
    const d = 60 / tempo.value / 4;
    playStep(cur, nextT, d);
    nextT += d;
    cur = (cur + 1) % 16;
  }
}

export function start() { setPlaying(true); $('play').classList.add('on'); }
export function stop() {
  if (!playing) return;
  setPlaying(false);
  $('play').classList.remove('on');
  clearInterval(timer);
  machines.forEach(m => { m.stop(); m.highlight(-1); });
}

export function wireTransport() {
  $('play').onclick = async () => {
    await ensureAudio();
    if (playing || ext) return;
    start();
    cur = 0; nextT = ctx.currentTime + 0.05;
    timer = setInterval(tick, 25);
  };
  $('stop').onclick = () => { if (!ext) stop(); };
}
