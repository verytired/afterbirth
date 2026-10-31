// Song preset installer, used by the scripts that build public/songs/*.song.json
import { machines, save } from './rack';
import { stop, tempo } from './transport';
import { song, applyAuto, saveSong, setSongOn, setSongText, type Auto } from './song';
import { parse303, parseSong, songBars, lerpKeys } from './lib';
import type { Pat } from './rack';

const EMPTY303 = Array(16).fill('-').join(' ');
export interface Ride { key: string; keys: [number, number][]; wob?: [number, number] }

// A song preset: 303 patterns as text and drum parts per slot, written into one bank (slots bank*8 .. +7;
// missing slots are left empty), plus the song text and knob rides turned into automation
export interface SongPreset { bank: number; p303: string[][]; drums: Record<string, string>[][]; song: string; rides: Ride[]; bpm: number }

export function installPreset(p: SongPreset) {
  stop();
  machines.forEach((m, k) => {
    for (let n = 1; n <= 8; n++) {
      const pat = m.pats[p.bank * 8 + n - 1] as Pat & { steps?: object[]; grid?: boolean[][]; len?: number };
      if (pat.steps) parse303(p.p303[k]?.[n - 1] ?? EMPTY303).forEach((s, i) => Object.assign(pat.steps![i], s));
      else pat.grid!.forEach((row, r) => {
        const src = p.drums[k - 2]?.[n - 1]?.[m.parts![r]] ?? '';
        row.forEach((_, c) => { row[c] = src[c] === 'x'; });
      });
      pat.shuf = false;
      delete pat.len;
    }
  });
  const bars = songBars(parseSong(p.song)), auto: Auto = {};
  for (let s = 0; s < bars * 16; s += 2) // every 8th note is smooth enough
    for (const r of p.rides) {
      if (s && r.keys.length === 1) continue;
      const b = s / 16, w = r.wob ? r.wob[0] * Math.sin(2 * Math.PI * b / r.wob[1]) : 0;
      (auto[s] ??= {})[r.key] = Math.round((lerpKeys(r.keys, b) + w) * 1000) / 1000;
    }
  song.auto = auto;
  setSongText(p.song);
  setSongOn(true);
  tempo.set(p.bpm);
  applyAuto(0);
  song.rows[0].slots.forEach((x, k) => machines[k].bank.set(x));
  save(); saveSong();
}
