import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

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
  const an = window.ab.master.an, buf = new Float32Array(an.fftSize);
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

// Peak of one mixer channel (post-fader) over ms
const channelPeak = (page: Page, ch: number, ms: number) => page.evaluate(async ([ch, ms]) => {
  const ab = window.ab, an = ab.ctx.createAnalyser(), buf = new Float32Array(an.fftSize);
  ab.channels[ch].out.connect(an);
  let pk = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    an.getFloatTimeDomainData(buf);
    for (const x of buf) pk = Math.max(pk, Math.abs(x));
    await new Promise(r => setTimeout(r, 10));
  }
  ab.channels[ch].out.disconnect(an);
  return pk;
}, [ch, ms]);

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
  expect(info).toEqual({ state: 'running', ch: 5, pcf: 5 });
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
  expect(Object.keys(files)).toEqual(['00-master.wav', '01-ab-303-1.wav', '02-ab-303-2.wav', '03-ab-808.wav', '04-ab-909.wav', '05-ab-606.wav', '06-delay-return.wav']);
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

const engine303 = '#devs .dev:nth-child(1) [name=engine]';
const filter303 = '#devs .dev:nth-child(1) [name=filter]';

test('303 filter switches between diode and ladder while playing', async ({ page }) => {
  await play(page);
  await expect(page.locator(filter303)).toHaveValue('diode');
  for (const f of ['ladder', 'diode']) {
    await page.selectOption(filter303, f);
    expect(await channelPeak(page, 0, 1500)).toBeGreaterThan(0.05);
  }
  await page.selectOption(engine303, 'classic');
  await expect(page.locator(filter303)).toBeDisabled();
});

// RMS of one mixer channel over ms
const channelRms = (page: Page, ch: number, ms: number) => page.evaluate(async ([ch, ms]) => {
  const ab = window.ab, an = ab.ctx.createAnalyser(), buf = new Float32Array(an.fftSize);
  ab.channels[ch].out.connect(an);
  let sum = 0, n = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    an.getFloatTimeDomainData(buf);
    for (const x of buf) { sum += x * x; n++; }
    await new Promise(r => setTimeout(r, 10));
  }
  ab.channels[ch].out.disconnect(an);
  return Math.sqrt(sum / n);
}, [ch, ms]);

test('303 MODS reach the engine and are disabled for CLASSIC', async ({ page }) => {
  const dev = '#devs .dev:nth-child(1)';
  await play(page);
  const before = await channelRms(page, 0, 1500);
  await page.evaluate(sel => {
    const inp = document.querySelector<HTMLInputElement>(`${sel} [name=vegdec]`)!;
    inp.value = '0';
    inp.dispatchEvent(new Event('input'));
  }, dev);
  const after = await channelRms(page, 0, 1500);
  expect(after).toBeLessThan(before * 0.6); // VEG DEC at min fades every note quickly
  await page.selectOption(`${dev} [name=engine]`, 'classic');
  await expect(page.locator(`${dev} .mods`)).toHaveClass(/off/);
});

test('Dynamic Bank Switching reads steps from the flipped bank while held or triggered', async ({ page }) => {
  const dev = '#devs .dev:nth-child(1)';
  const bar2 = 3750; // two bars at 128 BPM, so every measurement covers whole patterns
  await play(page);
  const normal = await channelRms(page, 0, bar2);
  expect(normal).toBeGreaterThan(0.03);

  // Holding A reads A2, which is empty: silence
  const btn = page.locator(`${dev} [data-dbs=A]`);
  await btn.dispatchEvent('pointerdown');
  await page.waitForTimeout(300);
  expect(await channelRms(page, 0, 1000)).toBeLessThan(normal * 0.1);
  await btn.dispatchEvent('pointerup');

  // Triggered by the 808 BD: only the BD steps go silent
  await page.selectOption(`${dev} [name=dbsA]`, { label: '808 BD' });
  const triggered = await channelRms(page, 0, bar2);
  expect(triggered).toBeLessThan(normal * 0.95);
  expect(triggered).toBeGreaterThan(normal * 0.3);
});

test('303 runs on the WASM engine and can switch engines while playing', async ({ page }) => {
  await play(page);
  await expect(page.locator(engine303)).toHaveValue('wasm');
  expect(await channelPeak(page, 0, 1500)).toBeGreaterThan(0.05);
  for (const e of ['js', 'classic', 'wasm']) {
    await page.selectOption(engine303, e);
    await expect(page.locator(engine303)).toHaveValue(e);
    expect(await channelPeak(page, 0, 1500)).toBeGreaterThan(0.05);
  }
});

const engine909 = '#devs .dev:nth-child(4) [name=engine]';
test('909 runs on the WASM engine and can switch to JS while playing', async ({ page }) => {
  await page.evaluate(() => { const g = (window.ab.machines[3].pats[0] as unknown as { grid: boolean[][] }).grid; g[0].fill(true); g[7].fill(true); });
  await play(page);
  await expect(page.locator(engine909)).toHaveValue('wasm');
  expect(await channelPeak(page, 3, 1500)).toBeGreaterThan(0.05);
  await page.selectOption(engine909, 'js');
  await expect(page.locator(engine909)).toHaveValue('js');
  expect(await channelPeak(page, 3, 1500)).toBeGreaterThan(0.05);
});

const bd606 = async (page: Page) => { for (const c of [0, 4, 8, 12]) await page.click(`.d606 [data-r="1"][data-c="${c}"]`); };

test('606 plays on the WASM engine', async ({ page }) => {
  await bd606(page);
  await play(page);
  await expect(page.locator('.d606')).toHaveAttribute('data-engine', 'wasm');
  expect(await channelPeak(page, 4, 1500)).toBeGreaterThan(0.1);
});

test('808 plays on the WASM engine, congas included', async ({ page }) => {
  await page.selectOption('.d808 [name=LTsw]', '1');
  for (const c of [2, 6, 10, 14]) await page.click(`.d808 [data-r="5"][data-c="${c}"]`); // LT row, now LC
  await play(page); // A1 has a beat
  await expect(page.locator('.d808')).toHaveAttribute('data-engine', 'wasm');
  expect(await channelPeak(page, 2, 1500)).toBeGreaterThan(0.1);
});

test('panel title folds the panel, remembered across reloads; the machine keeps playing', async ({ page }) => {
  await page.click('.d808 > h2');
  await expect(page.locator('.d808 .drums')).toBeHidden();
  await page.reload();
  await expect(page.locator('.d808 .drums')).toBeHidden();
  await expect(page.locator('.dev.closed .mix')).toBeHidden();
  await expect(page.locator('.d909 .drums')).toBeVisible();
  await play(page);
  expect(await channelPeak(page, 2, 1500)).toBeGreaterThan(0.1);
  await page.click('.d808 > h2');
  await expect(page.locator('.d808 .drums')).toBeVisible();
});

test('falls back to the JS engine when the WASM build cannot load', async ({ page }) => {
  await page.route('**/*.wasm', r => r.abort());
  await page.goto('./');
  await play(page);
  await expect(page.locator(engine303)).toHaveValue('js');
  await expect(page.locator(`${engine303} option[value=wasm]`)).toHaveJSProperty('disabled', true); // toBeDisabled() reports <option disabled> as enabled
  await expect(page.locator(engine909)).toHaveValue('js');
  await expect(page.locator(`${engine909} option[value=wasm]`)).toHaveJSProperty('disabled', true);
  expect(await channelPeak(page, 0, 1500)).toBeGreaterThan(0.05);
  await bd606(page);
  await expect(page.locator('.d606')).toHaveAttribute('data-engine', 'js');
  expect(await channelPeak(page, 4, 1500)).toBeGreaterThan(0.1);
  await expect(page.locator('.d808')).toHaveAttribute('data-engine', 'js');
  expect(await channelPeak(page, 2, 1500)).toBeGreaterThan(0.1);
  errors = errors.filter(e => !e.includes('ERR_FAILED')); // the aborted .wasm request itself
});

test('ACID TRIP song file: song switches patterns per bar and rides the knobs', async ({ page }) => {
  await page.setInputFiles('#songfile', new URL('../public/songs/acid-trip.song.json', import.meta.url).pathname);
  await expect(page.locator('#songcap')).toHaveText('loaded acid-trip.song.json');
  const state = () => page.evaluate(() => ({
    sel: window.ab.machines.map(m => m.bank.sel),
    cutoff: +document.querySelector<HTMLInputElement>('.dev [name=cutoff]')!.value,
  }));
  const s0 = await state();
  expect(s0.sel).toEqual([26, 31, 31, 31, 0]); // D3 D8 D8 D8, 606 not in the song: stays A1
  expect(s0.cutoff).toBeCloseTo(0.05, 2);
  // Jump the song to the groove row (bar 9) by shortening the intro to 1 bar
  await page.fill('#songtext', 'D3 D8 D8 D1 x1\nD1 D8 D8 D2 x16');
  await page.evaluate(() => window.ab.tempo.set(200));
  await play(page);
  await page.waitForTimeout(1500); // > 1 bar at 200 BPM
  const s1 = await state();
  expect(s1.sel).toEqual([24, 31, 31, 25, 0]); // D1 D8 D8 D2
  expect(s1.cutoff).not.toBe(s0.cutoff);
  expect(await masterPeak(page, 300)).toBeGreaterThan(0.01);
  // END stops the transport instead of looping
  await page.click('#rec');
  const dl = page.waitForEvent('download');
  await page.fill('#songtext', 'D1 D8 D8 D2 x1\nEND');
  expect((await dl).suggestedFilename()).toMatch(/\.wav$/); // the recording finishes by itself
  expect(await page.evaluate(() => window.ab.playing)).toBe(false);
  await expect(page.locator('#songpos')).toHaveText('END');
});

test('AUTO records knob moves into the song and plays them back', async ({ page }) => {
  await page.click('#songon');
  await page.fill('#songtext', 'A1 A1 A1 A1 x1');
  await page.evaluate(() => window.ab.tempo.set(200));
  await page.click('#autorec');
  await play(page);
  const knob = '.dev [name=cutoff]';
  await page.evaluate(k => { const i = document.querySelector<HTMLInputElement>(k)!; i.value = '0.9'; i.dispatchEvent(new Event('input')); }, knob);
  await page.waitForTimeout(1300); // past the loop point, so step 0 is overwritten by the latch too
  await page.click('#autorec');
  await page.evaluate(k => { const i = document.querySelector<HTMLInputElement>(k)!; i.value = '0.1'; i.dispatchEvent(new Event('input')); }, knob);
  await page.waitForTimeout(1300); // one more loop replays 0.9
  expect(+await page.inputValue(knob)).toBeCloseTo(0.9, 3);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ab3389-song')!).auto[5]['0:cutoff'])).toBeCloseTo(0.9, 3);
});

test('song files round-trip every pattern, control, toggle and the song into a fresh browser', async ({ page, browser }) => {
  const d1 = '#devs .dev:nth-child(1)', d2 = '#devs .dev:nth-child(2)', d3 = '#devs .dev:nth-child(3)';
  const setCtl = (sel: string, v: string) => page.evaluate(([sel, v]) => {
    const el = document.querySelector<HTMLInputElement | HTMLSelectElement>(sel)!;
    el.value = v; el.dispatchEvent(new Event('input'));
  }, [sel, v]);
  await page.click(`${d1} [data-a=rand]`);
  await page.click(`${d3} .drow button[data-r="1"][data-c="3"]`); // an 808 SD hit
  const d4 = '#devs .dev:nth-child(4)';
  await page.click(`${d4} .drow button[data-r="9"][data-c="5"]`); // a 909 MT hit
  for (let k = 0; k < 4; k++) await page.click(`${d4} [data-steps] button[aria-label=down]`); // 909 STEPS 12
  await setCtl(`${d1} [name=drive]`, '0.5');
  await setCtl(`${d1} [name=muffler]`, '2');
  await setCtl(`${d2} [name=selfosc]`, '1');
  await setCtl(`${d2} [name=engine]`, 'js');
  await setCtl('#dfb', '0.7');
  await page.click(`${d3} [data-mute]`);
  await page.click(`${d2} [data-fx=DIST]`);
  await page.click('[data-pmode=bandpass]');
  await page.fill('#songtext', 'A1 A1 A1 A1 x2  # first\nB1 - - - x2\nEND');
  await page.click('#songon');

  const state = (p: typeof page) => p.evaluate(() => ({
    pats: JSON.stringify(window.ab.machines.map(m => m.pats)),
    ctl: [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.rack input[type=range], .rack select')].map(e => e.value).join('|'),
    tog: [...document.querySelectorAll('[data-mute], [data-fx], [data-unit], #mcomp, [data-pmode], [data-dmode], #songon')].map(b => b.classList.contains('on')).join(''),
    song: (document.getElementById('songtext') as HTMLTextAreaElement).value,
    tempo: window.ab.tempo.value,
  }));
  const before = await state(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#songsave')]);
  expect(dl.suggestedFilename()).toMatch(/\.song\.json$/);

  const fresh = await (await browser.newContext()).newPage(); // separate storage: nothing carried over
  await fresh.goto(page.url());
  expect((await state(fresh)).pats).not.toBe(before.pats);
  await fresh.setInputFiles('#songfile', (await dl.path())!);
  await expect(fresh.locator('#songcap')).toHaveText(/^loaded /);
  expect(await state(fresh)).toEqual(before);
});

test('loading a file that is not a song reports it and changes nothing', async ({ page }) => {
  const before = await page.evaluate(() => JSON.stringify(window.ab.machines.map(m => m.pats)));
  await page.setInputFiles('#songfile', { name: 'x.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
  await expect(page.locator('#songcap')).toHaveText('LOAD FAILED: not an AfterBirth song file');
  expect(await page.evaluate(() => JSON.stringify(window.ab.machines.map(m => m.pats)))).toBe(before);
});

test('909: older 9-row saves load, and a short pattern loops on its own length', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('ab3389', JSON.stringify({
    'AB-909': Array.from({ length: 32 }, () => ({ shuf: false, grid: Array.from({ length: 9 }, (_, r) => Array.from({ length: 16 }, (_, c) => r === 7 && c === 2)) })),
  })));
  await page.reload();
  const d4 = '#devs .dev:nth-child(4)';
  expect(await page.evaluate(() => (window.ab.machines[3].pats[0] as unknown as { grid: boolean[][] }).grid.length)).toBe(13);
  await expect(page.locator(`${d4} .drow button[data-r="7"][data-c="2"]`)).toHaveClass(/on/); // OH stays OH
  for (let k = 0; k < 13; k++) await page.click(`${d4} [data-steps] button[aria-label=down]`);
  await expect(page.locator(`${d4} [data-steps] .led`)).toHaveText('3');
  await play(page);
  const cols = new Set<string>();
  for (let k = 0; k < 30; k++) {
    cols.add(await page.evaluate(sel => document.querySelector(sel)?.getAttribute('data-c') ?? '', `${d4} .drow:first-child button.now`));
    await page.waitForTimeout(40);
  }
  cols.delete('');
  expect([...cols].sort()).toEqual(['0', '1', '2']);
});
