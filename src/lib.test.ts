import { describe, it, expect } from 'vitest';
import { wav, crc32, zip, PCF_PATS, shuffleOffset, slotBank, slotNum, withBank, withNum, stemName } from './lib';

describe('wav', () => {
  it('writes a 16-bit stereo header and interleaved, clamped samples', () => {
    const b = wav([new Float32Array([0, 1, -1, 2])], [new Float32Array([0.5, -0.5, 0, -2])], 48000);
    const v = new DataView(b.buffer);
    const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 8)).toBe('WAVEfmt ');
    expect(ascii(36, 4)).toBe('data');
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(16);
    expect(b.length).toBe(44 + 16);
    const s = Array.from({ length: 8 }, (_, i) => v.getInt16(44 + i * 2, true));
    expect(s).toEqual([0, 16383, 32767, -16384, -32768, 0, 32767, -32768]);
  });

  it('concatenates blocks', () => {
    const b = wav([new Float32Array(128), new Float32Array(128)], [new Float32Array(128), new Float32Array(128)], 44100);
    expect(new DataView(b.buffer).getUint32(40, true)).toBe(256 * 4);
  });
});

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('zip', () => {
  it('stores files that can be read back through the central directory', async () => {
    const files = [{ name: 'a.txt', data: new TextEncoder().encode('hello') }, { name: 'b.bin', data: new Uint8Array([1, 2, 3]) }];
    const b = new Uint8Array(await zip(files).arrayBuffer());
    const v = new DataView(b.buffer);
    const e = b.length - 22;
    expect(v.getUint32(e, true)).toBe(0x06054b50);
    expect(v.getUint16(e + 10, true)).toBe(2);
    let p = v.getUint32(e + 16, true);
    for (const f of files) {
      expect(v.getUint32(p, true)).toBe(0x02014b50);
      const size = v.getUint32(p + 20, true), nameLen = v.getUint16(p + 28, true), off = v.getUint32(p + 42, true);
      expect(new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen))).toBe(f.name);
      expect(v.getUint32(p + 16, true)).toBe(crc32(f.data));
      expect(b.subarray(off + 30 + nameLen, off + 30 + nameLen + size)).toEqual(f.data);
      p += 46 + nameLen;
    }
    expect(p).toBe(e);
  });
});

describe('PCF_PATS', () => {
  it('has 32 patterns of 16 steps in 0..1, pattern 1 on the quarters', () => {
    expect(PCF_PATS).toHaveLength(32);
    for (const p of PCF_PATS) {
      expect(p).toHaveLength(16);
      for (const x of p) expect([0, 0.25, 0.5, 0.75, 1]).toContain(x);
    }
    expect(PCF_PATS[0]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  });
});

describe('shuffleOffset', () => {
  it('only delays odd steps, up to a third of a step', () => {
    expect(shuffleOffset(0, 1, 0.3)).toBe(0);
    expect(shuffleOffset(1, 1, 0.3)).toBeCloseTo(0.1);
    expect(shuffleOffset(3, 0.5, 0.3)).toBeCloseTo(0.05);
    expect(shuffleOffset(5, 0, 0.3)).toBe(0);
  });
});

describe('pattern slots', () => {
  it('maps bank/number to and from a slot index', () => {
    expect([slotBank(0), slotNum(0)]).toEqual([0, 0]);
    expect([slotBank(31), slotNum(31)]).toEqual([3, 7]);
    expect(withBank(2, 1)).toBe(10); // A3 -> B3
    expect(withNum(10, 6)).toBe(14); // B3 -> B7
  });
});

describe('stemName', () => {
  it('slugs machine names', () => {
    expect(stemName(1, 'AB-303 #1')).toBe('01-ab-303-1');
    expect(stemName(3, 'AB-808')).toBe('03-ab-808');
  });
});
