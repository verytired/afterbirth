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
