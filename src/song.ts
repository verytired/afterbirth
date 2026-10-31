// SONG: a bar-by-bar pattern chain plus knob automation (step -> knob key -> value)
import { $ } from './dom';
import { playing } from './state';
import { machines } from './rack';
import { parseSong, songBars, songCaptions, songEnds, songRowAt, songRowIndexAt, type SongRow } from './lib';

export type Auto = Record<number, Record<string, number>>;
export const song = { on: false, rec: false, text: '', rows: [] as SongRow[], auto: {} as Auto };

const KEY = 'ab3389-song';
let inputs = new Map<string, HTMLInputElement>();
const touched = new Set<string>(); // knobs moved by hand during this AUTO pass (latched from then on)
let bar = -1, replaying = false;

export const resetSong = () => { bar = -1; };
export function saveSong() {
  try { localStorage.setItem(KEY, JSON.stringify({ on: song.on, text: song.text, auto: song.auto })); } catch { /* storage unavailable */ }
}
export function setSongText(t: string) {
  song.text = t; song.rows = parseSong(t);
  $<HTMLTextAreaElement>('songtext').value = t;
}
export function setSongOn(on: boolean) { song.on = on; $('songon').classList.toggle('on', on); }

// Set knobs from the automation lane at absolute step s
export function applyAuto(s: number) {
  const ev = song.auto[s];
  if (!ev) return;
  replaying = true;
  for (const k in ev) {
    const inp = inputs.get(k);
    if (!inp || (song.rec && touched.has(k))) continue;
    inp.value = String(ev[k]);
    inp.dispatchEvent(new Event('input'));
  }
  replaying = false;
}

// Called for every step before the machines play. Returns true when an END song has finished
export function songStep(i: number): boolean {
  if (!song.on) return false;
  if (i === 0) {
    bar++;
    if (bar >= songBars(song.rows) && songEnds(song.text)) { $('songpos').textContent = 'END'; return true; }
    songRowAt(song.rows, bar)?.forEach((x, k) => {
      const b = machines[k]?.bank;
      if (b && x >= 0 && x !== b.sel) b.queued = x;
    });
    const total = songBars(song.rows);
    $('songpos').textContent = total ? `${bar % total + 1}/${total}` : String(bar + 1);
    $('songcap').textContent = songCaptions(song.text)[songRowIndexAt(song.rows, bar)] ?? ''; // the row's # comment
  }
  if (bar < 0) return false; // started mid-bar
  const total = songBars(song.rows), s = (total ? bar % total : bar) * 16 + i;
  if (song.rec && s === 0) // snapshot every knob at the top so the song recalls its starting sound
    for (const [k, inp] of inputs) (song.auto[0] ??= {})[k] ??= +inp.value;
  applyAuto(s);
  if (song.rec) for (const k of touched) (song.auto[s] ??= {})[k] = +inputs.get(k)!.value;
  return false;
}

export function wireSong() {
  // Knob key: element id, or "<machine index>:<name>" for knobs inside a machine row. Run after knobify()
  const devs = [...$('devs').children];
  inputs = new Map([...document.querySelectorAll<HTMLInputElement>('input[type=range]')]
    .map(inp => [inp.id || `${devs.indexOf(inp.closest('.dev')!)}:${inp.name}`, inp]));

  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}') || {};
    song.auto = s.auto ?? {};
    setSongText(s.text ?? '');
    setSongOn(!!s.on);
  } catch { /* keep defaults */ }

  // Capture phase: knob input events do not bubble
  document.addEventListener('input', e => {
    const k = [...inputs].find(([, inp]) => inp === e.target)?.[0];
    if (k && song.rec && playing && !replaying) touched.add(k);
  }, true);
  $('songtext').addEventListener('input', e => { setSongText((e.target as HTMLTextAreaElement).value); saveSong(); });
  $('songon').onclick = () => { setSongOn(!song.on); saveSong(); };
  $('autorec').onclick = () => {
    song.rec = !song.rec;
    $('autorec').classList.toggle('on', song.rec);
    touched.clear();
    if (!song.rec) saveSong();
  };
  $('autoclr').onclick = () => { song.auto = {}; saveSong(); };
}
