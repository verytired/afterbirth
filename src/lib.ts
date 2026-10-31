// Pure helpers (no DOM, no audio). Unit-tested in lib.test.ts

// 16-bit stereo PCM WAV from per-block Float32 channel data
export function wav(L: Float32Array[], R: Float32Array[], sr: number): Uint8Array {
  const n = L.reduce((a, c) => a + c.length, 0), v = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 4, true);
  let o = 44;
  for (let k = 0; k < L.length; k++)
    for (let i = 0; i < L[k].length; i++)
      for (const ch of [L, R]) {
        const x = Math.max(-1, Math.min(1, ch[k][i]));
        v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
        o += 2;
      }
  return new Uint8Array(v.buffer);
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(b: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

// Minimal ZIP writer (stored, no compression)
export function zip(files: { name: string; data: Uint8Array }[]): Blob {
  const parts: BlobPart[] = [], dir: BlobPart[] = [];
  let off = 0, dirSize = 0;
  for (const f of files) {
    const name = new TextEncoder().encode(f.name), crc = crc32(f.data), n = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true);
    h.setUint32(14, crc, true); h.setUint32(18, n, true); h.setUint32(22, n, true); h.setUint16(26, name.length, true);
    parts.push(h, name, f.data as Uint8Array<ArrayBuffer>);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint32(16, crc, true); c.setUint32(20, n, true); c.setUint32(24, n, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    dir.push(c, name);
    dirSize += 46 + name.length;
    off += 30 + name.length + n;
  }
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, dirSize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...dir, e], { type: 'application/zip' });
}

// PCF: per-step filter open amounts (1 is four-on-the-floor, 2+ are fixed pseudo-random)
export const PCF_PATS: number[][] = Array.from({ length: 32 }, (_, p) => Array.from({ length: 16 }, (_, s) => {
  if (p === 0) return s % 4 === 0 ? 1 : 0;
  const r = Math.abs(Math.sin((p + 1) * 91.7 + (s + 1) * 12.9898) * 43758.5453) % 1;
  return r < 0.4 ? 0 : Math.ceil(r * 4) / 4;
}));

// Off-beat 16ths are pushed late by up to 1/3 step (triplet feel at amount 1)
export const shuffleOffset = (i: number, amount: number, d: number) => (i % 2 ? amount * d / 3 : 0);

// Pattern slot index = bank * 8 + number, banks A-D, numbers 1-8 (0-based here)
export const BANKS = 'ABCD';
export const slotBank = (x: number) => x >> 3;
export const slotNum = (x: number) => x & 7;
export const withBank = (x: number, bank: number) => bank * 8 + (x & 7);
export const withNum = (x: number, num: number) => (x & ~7) + num;

// "AB-303 #1" -> "01-ab-303-1"
export const stemName = (i: number, name: string) =>
  `${String(i).padStart(2, '0')}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')}`;

// Song text: one row per line, one slot per machine (A1-D8, "-" keeps the current pattern), then "xN" for N bars (default 1).
// "#" starts a comment, a line "END" stops the song there instead of looping. e.g. "D1 - D8 D2 x16"
export interface SongRow { slots: number[]; bars: number }
export function parseSong(text: string): SongRow[] {
  return text.split('\n').map(l => l.replace(/#.*/, '').trim()).filter(l => l && !/^end$/i.test(l)).map(l => {
    const row: SongRow = { slots: [], bars: 1 };
    for (const tok of l.split(/\s+/)) {
      const x = /^x(\d+)$/i.exec(tok), b = BANKS.indexOf(tok[0].toUpperCase()), n = +tok.slice(1);
      if (x) row.bars = Math.max(1, +x[1]);
      else row.slots.push(tok.length === 2 && b >= 0 && n >= 1 && n <= 8 ? b * 8 + n - 1 : -1);
    }
    return row;
  });
}
export const songEnds = (text: string) => /^\s*end\s*(#.*)?$/im.test(text);
export const songBars = (rows: SongRow[]) => rows.reduce((a, r) => a + r.bars, 0);
// Comment of each song row, in parseSong order, for on-screen captions
export function songCaptions(text: string): string[] {
  return text.split('\n')
    .filter(l => { const c = l.replace(/#.*/, '').trim(); return c && !/^end$/i.test(c); })
    .map(l => (/#(.*)/.exec(l)?.[1] ?? '').trim());
}
// Index of the row playing at bar (the song loops), or -1 for an empty song
export function songRowIndexAt(rows: SongRow[], bar: number): number {
  const total = songBars(rows);
  if (!total) return -1;
  let b = bar % total;
  for (let i = 0; i < rows.length; i++) { if (b < rows[i].bars) return i; b -= rows[i].bars; }
  return -1;
}

// Slots for bar (the song loops), or null for an empty song
export function songRowAt(rows: SongRow[], bar: number): number[] | null {
  const total = songBars(rows);
  if (!total) return null;
  let b = bar % total;
  for (const r of rows) { if (b < r.bars) return r.slots; b -= r.bars; }
  return null;
}

// 303 steps as text: C..B, C+ (high C) or "-" (rest), with suffixes ^ up, v down, ! accent, ~ slide. e.g. "C! C^~ - D#v"
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B', 'C+'];
export function parse303(s: string) {
  return s.trim().split(/\s+/).map(t => {
    const m = /^(-|[A-G]#?\+?)([\^v!~]*)$/.exec(t), note = m ? (m[1] === '-' ? -1 : NOTE_NAMES.indexOf(m[1])) : -2;
    if (!m || note < -1) throw new Error(`bad 303 step "${t}"`);
    const f = m[2];
    return { note, oct: f.includes('^') ? 1 : f.includes('v') ? -1 : 0, acc: f.includes('!'), sld: f.includes('~') };
  });
}

// Piecewise-linear value at x over sorted [x, value] keyframes
export function lerpKeys(keys: [number, number][], x: number): number {
  if (x <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [x0, v0] = keys[i - 1], [x1, v1] = keys[i];
    if (x <= x1) return v0 + (v1 - v0) * (x - x0) / (x1 - x0);
  }
  return keys[keys.length - 1][1];
}
