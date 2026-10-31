import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

declare global { interface Window { ab: any } }

// Fail any test that throws in the page
let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('./');
});
test.afterEach(() => expect(errors).toEqual([]));

const play = async (page: Page) => { await page.click('#play'); await page.waitForTimeout(500); };

// Peak of MASTER post-fader over ms
const masterPeak = (page: Page, ms: number) => page.evaluate(async ms => {
  const an: AnalyserNode = window.ab.master.an, buf = new Float32Array(an.fftSize);
  let pk = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    an.getFloatTimeDomainData(buf);
    for (const x of buf) pk = Math.max(pk, Math.abs(x));
    await new Promise(r => setTimeout(r, 10));
  }
  return pk;
}, ms);

const peak = (s: Int16Array) => s.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

function parseWav(b: Buffer) {
  expect(b.toString('ascii', 0, 4)).toBe('RIFF');
  expect(b.toString('ascii', 8, 16)).toBe('WAVEfmt ');
  const ch = b.readUInt16LE(22), sr = b.readUInt32LE(24), n = (b.length - 44) / 2;
  const s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = b.readInt16LE(44 + i * 2);
  return { ch, sr, sec: n / ch / sr, s };
}

// Our zip is "stored" (no compression), so entries can be sliced straight out
function parseZip(b: Buffer) {
  const e = b.length - 22;
  expect(b.readUInt32LE(e)).toBe(0x06054b50);
  const count = b.readUInt16LE(e + 10);
  let p = b.readUInt32LE(e + 16);
  const files: Record<string, Buffer> = {};
  for (let i = 0; i < count; i++) {
    const size = b.readUInt32LE(p + 20), nameLen = b.readUInt16LE(p + 28), off = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nameLen);
    files[name] = b.subarray(off + 30 + nameLen, off + 30 + nameLen + size);
    p += 46 + nameLen;
  }
  return files;
}

async function record(page: Page, button: string, ms: number) {
  await page.click(button);
  await page.waitForTimeout(ms);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(button)]);
  return { name: dl.suggestedFilename(), data: readFileSync((await dl.path())!) };
}

test('plays with sound and without clipping', async ({ page }) => {
  await play(page);
  const info = await page.evaluate(() => ({ state: window.ab.ctx.state, ch: window.ab.channels.length, pcf: window.ab.FX.PCF.nodes.length }));
  expect(info).toEqual({ state: 'running', ch: 4, pcf: 4 });
  const pk = await masterPeak(page, 3000);
  expect(pk).toBeGreaterThan(0.2);
  expect(pk).toBeLessThan(0.95);
});

test('pattern banks switch immediately when stopped and on the bar when playing', async ({ page }) => {
  const first303 = '#devs .dev:nth-child(1)';
  const step1 = `${first303} .step select`;
  await page.click(`${first303} [data-b=B]`);
  await expect(page.locator(step1).first()).toHaveValue('-1');
  await page.click(`${first303} [data-b=A]`);
  await expect(page.locator(step1).first()).toHaveValue('0');

  await play(page);
  await page.click(`${first303} [data-n="2"]`);
  await expect(page.locator(`${first303} [data-n="2"]`)).toHaveClass(/wait/);
  await page.waitForTimeout(2500); // one bar at 128 BPM is 1.875s
  await expect(page.locator(`${first303} [data-n="2"]`)).not.toHaveClass(/wait/);
  await expect(page.locator(`${first303} [data-n="2"]`)).toHaveClass(/on/);
  await expect(page.locator(step1).first()).toHaveValue('-1');
});

test('follows MIDI clock: start, 24ppqn steps, tempo, stop, song position', async ({ page }) => {
  const r = await page.evaluate(async () => {
    const ab = window.ab;
    await ab.ensureAudio();
    ab.setExt(true);
    const ev = (data: number[], ts: number) => ab.onMidi({ data: new Uint8Array(data), timeStamp: ts });
    const t0 = performance.now();
    ev([0xfa], t0);
    for (let k = 0; k < 13; k++) ev([0xf8], t0 + k * 20.833); // 120 BPM
    const afterClock = { cur: ab.cur, bpm: ab.tempo.value, playing: ab.playing };
    ev([0xfc], t0 + 300);
    const stopped = ab.playing;
    ev([0xf2, 5, 0], t0 + 310);
    return { afterClock, stopped, spp: ab.cur };
  });
  expect(r).toEqual({ afterClock: { cur: 3, bpm: 120, playing: true }, stopped: false, spp: 5 });
});

test('records MASTER to WAV', async ({ page }) => {
  await play(page);
  const { name, data } = await record(page, '#rec', 2000);
  expect(name).toMatch(/^afterbirth-\d{8}-\d{6}\.wav$/);
  const w = parseWav(data);
  expect(w.ch).toBe(2);
  expect(w.sr).toBe(await page.evaluate(() => window.ab.ctx.sampleRate));
  expect(w.sec).toBeGreaterThan(1.5);
  expect(peak(w.s)).toBeGreaterThan(1000);
});

test('exports aligned stems that sum back to MASTER', async ({ page }) => {
  await play(page);
  const { name, data } = await record(page, '#stems', 2500);
  expect(name).toMatch(/\.stems\.zip$/);
  const files = parseZip(data);
  expect(Object.keys(files)).toEqual(['00-master.wav', '01-ab-303-1.wav', '02-ab-303-2.wav', '03-ab-808.wav', '04-ab-909.wav', '05-delay-return.wav']);
  const w = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, parseWav(v)]));
  const n = w['00-master.wav'].s.length;
  for (const k in w) expect(w[k].s.length).toBe(n);
  // Master COMP is off and the master fader defaults to 0.8
  const parts = Object.keys(w).filter(k => k !== '00-master.wav').map(k => w[k].s);
  let err = 0;
  for (let i = 0; i < n; i += 3) err = Math.max(err, Math.abs(w['00-master.wav'].s[i] - 0.8 * parts.reduce((a, p) => a + p[i], 0)));
  expect(err).toBeLessThan(4);
  expect(peak(w['01-ab-303-1.wav'].s)).toBeGreaterThan(1000);
});
