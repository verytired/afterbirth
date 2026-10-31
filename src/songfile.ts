// Song files: one JSON with everything needed to recreate a track: every pattern, the song and its
// automation, tempo, every knob / select and toggle button. LOAD replaces the current state
import { $ } from './dom';
import { machines, save, type Pat } from './rack';
import { song, applyAuto, saveSong, setSongOn, setSongText } from './song';
import { stop, tempo } from './transport';
import { dSteps, pcfNum } from './audio';
import { download } from './record';
import { SONG_FORMAT, checkSongFile, type SongFileData } from './lib';

type Ctl = HTMLInputElement | HTMLSelectElement;
type AnyPat = Pat & { steps?: object[]; grid?: boolean[][]; len?: number };
const devIndex = (el: Element) => [...$('devs').children].indexOf(el.closest('.dev')!);
// Same keys as song automation: element id, or "<machine index>:<name>" inside a machine row
const ctlKey = (el: Ctl) => el.id || `${devIndex(el)}:${el.name}`;
const controls = () => [...document.querySelectorAll<Ctl>('.rack input[type=range], .rack select')]
  .filter(el => el.id !== 'outdev' && (el.id || el.name)); // the output device belongs to this computer, not the song
// Toggle buttons keep their state in the "on" class and are restored by clicking them
const toggles = () => [...document.querySelectorAll<HTMLElement>('[data-mute], [data-fx], [data-unit], #mcomp, [data-pmode], [data-dmode]')];
const togKey = (b: HTMLElement) => b.id ||
  (b.closest('.dev') ? `${devIndex(b)}:` : '') + Object.entries(b.dataset).map(([k, v]) => (v ? `${k}=${v}` : k)).join(',');

function collect(): SongFileData {
  return {
    format: SONG_FORMAT, version: 1, tempo: tempo.value,
    patterns: Object.fromEntries(machines.map(m => [m.name, m.pats])),
    song: { text: song.text, on: song.on, auto: song.auto },
    controls: { ...Object.fromEntries(controls().map(el => [ctlKey(el), el.value])), pcfnum: String(pcfNum.value), dsteps: String(dSteps.value) },
    toggles: Object.fromEntries(toggles().map(b => [togKey(b), b.classList.contains('on')])),
  };
}

// Copy a saved pattern into the live one in place (other code holds references to it)
function copyInto(dst: AnyPat, src: Partial<AnyPat> | undefined) {
  dst.shuf = !!src?.shuf;
  if (dst.grid) dst.len = src?.len;
  dst.steps?.forEach((s, i) => Object.assign(s, (src?.steps?.[i]) ?? { note: -1, oct: 0, acc: false, sld: false }));
  dst.grid?.forEach((row, r) => row.forEach((_, c) => { row[c] = !!src?.grid?.[r]?.[c]; }));
}

export function loadSongFile(f: SongFileData) {
  stop();
  for (const m of machines) {
    const src = f.patterns[m.name];
    if (!Array.isArray(src) || src.length !== m.pats.length) continue;
    m.pats.forEach((p, i) => copyInto(p as AnyPat, src[i] as Partial<AnyPat>));
    m.bank.set(m.bank.sel); // redraw the pattern on screen
  }
  for (const el of controls()) {
    const v = f.controls[ctlKey(el)];
    if (v !== undefined) { el.value = v; el.dispatchEvent(new Event('input')); }
  }
  if (f.controls.pcfnum) pcfNum.set(+f.controls.pcfnum);
  if (f.controls.dsteps) dSteps.set(+f.controls.dsteps);
  for (const b of toggles()) {
    const want = f.toggles[togKey(b)];
    if (want === undefined || want === b.classList.contains('on')) continue;
    if (want || !b.matches('[data-pmode], [data-dmode]')) b.click(); // mode buttons are exclusive: click the one to turn on
  }
  tempo.set(f.tempo);
  song.auto = f.song.auto;
  setSongText(f.song.text);
  setSongOn(f.song.on);
  if (f.song.on && song.rows[0]) {
    applyAuto(0);
    song.rows[0].slots.forEach((x, k) => { if (x >= 0) machines[k]?.bank.set(x); });
  }
  save(); saveSong();
}

export function wireSongFile() {
  $('songsave').onclick = () => download(new Blob([JSON.stringify(collect())], { type: 'application/json' }), 'song.json');
  const input = $<HTMLInputElement>('songfile');
  $('songload').onclick = () => input.click();
  input.onchange = async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      loadSongFile(checkSongFile(JSON.parse(await file.text())));
      $('songcap').textContent = `loaded ${file.name}`;
    } catch (e) {
      $('songcap').textContent = `LOAD FAILED: ${(e as Error).message}`;
    }
  };
}
