// Builds public/songs/devil-fish.song.json: a track made only with the Devil Fish style MODS.
// Drives the running app (npm run dev) in Chrome, writes the song with the app's own preset installer,
// sets every control, then saves it with the SAVE button. Usage: node scripts/devil-fish.mjs [url]
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://localhost:5173/';
const out = new URL('../public/songs/devil-fish.song.json', import.meta.url).pathname;

const R = '- - - - - - - - - - - - - - - -';
const P303 = [
  [ // 303 #1, bank B. B2 / B4 are the DBS A partners of B1 / B3: only the open-hat steps (2, 6, 10, 14) are read from them
    'C! C C^ C~ D# C C^! C C~ G C^ C! A#v C C^~ D#',
    'C C G^! C C C D#^! C C C A#^! C C C C+^! C',
    'C!~ - C^~ - G~ - D#!~ - C - A#v~ - C^! - G~ -',
    '- - C+^! - - - G^!~ - - - D#^! - - - A#^! -',
    R, R, R, R,
  ],
  [ // 303 #2: the self-oscillating lead, played by the filter
    'G^! - - D#^~ F^ - G^ - C+^!~ - A#^ - G^ - F^ D#^',
    R, R, R, R, R, R, R,
  ],
];
const KICK = 'x...x...x...x...', CH = 'xx.xxx.xxx.xxx.x', OH = '..x...x...x...x.', CP = '....x.......x...';
const DRUMS = [
  [{}, { SD: '............x.xx' }], // 808: B2 snare fill
  [
    { BD: KICK, CH, OH, CP },                                       // B1 full kit (OH = DBS trigger)
    { BD: KICK, CH, CP, SD: '........x.x.xxxx', LT: '......x.......x.' }, // B2 fill
    { CH: 'x.x.x.x.x.x.x.x.', CP },                                 // B3 break
    { BD: KICK },                                                   // B4 kick only
  ],
];
const SONG = `# DEVIL FISH   303#1 303#2 808 909   (136 BPM)
B1 B8 B1 B4 x8    # overdriven 303 and a kick
B1 B8 B1 B1 x16   # full kit: the open hats switch the bassline to B2 (DBS)
B3 B8 B1 B1 x8    # half time, long slides
B3 B1 B1 B1 x16   # self-oscillating lead, played in tune by the filter
B1 B1 B1 B3 x8    # break: filter FM growl and ENV MOD x3 sweep
B1 B1 B2 B2 x1    # fill
B1 B1 B1 B1 x16   # peak: everything driven
B3 B8 B1 B1 x8    # comedown
B1 B8 B1 B4 x8    # outro: the filter closes
B8 B8 B8 B8 x2    # delay tail
END
`;
// [bar, value] rides. Sections start at bars 0, 8, 24, 32, 48, 56, 57, 73, 81, 89
const RIDES = [
  { key: '0:cutoff', wob: [.05, 4], keys: [[0, .12], [8, .22], [24, .3], [32, .26], [48, .18], [56, .5], [57, .38], [73, .3], [81, .25], [89, .08]] },
  { key: '0:reso', keys: [[0, 14], [24, 16], [48, 18], [57, 17], [81, 15]] },
  { key: '0:env', keys: [[0, 1], [8, 1.3], [48, 1.2], [56, 2.6], [57, 1.8], [73, 1.4], [89, .8]] },
  { key: '0:decay', keys: [[0, 1], [24, 1.2], [32, 1.05], [48, 1.3], [57, 1.1], [89, .95]] },
  { key: '0:drive', keys: [[0, .35], [8, .45], [48, .45], [56, .7], [57, .65], [73, .5], [89, .3]] },
  { key: '0:fm', keys: [[0, .05], [48, .05], [52, .35], [56, .35], [57, .2], [73, .1]] },
  { key: '0:slide', keys: [[0, .4], [24, .85], [32, .5], [73, .85], [81, .4]] },
  { key: '0:send', keys: [[0, .1], [48, .1], [49, .3], [56, .3], [57, .1], [89, .4]] },
  { key: '1:reso', keys: [[0, 18], [32, 18], [36, 20], [48, 20], [56, 19], [57, 20]] },
  { key: '1:cutoff', wob: [.04, 8], keys: [[0, .3], [32, .3], [48, .38], [57, .42], [73, .3]] },
  { key: '1:env', keys: [[0, .35]] },
  { key: '1:send', keys: [[0, .4]] },
  { key: 'dfb', keys: [[0, .5]] },
];
// Static Devil Fish settings (selects and knobs that do not ride)
const CONTROLS = {
  '#devs .dev:nth-child(1) [name=engine]': 'wasm', '#devs .dev:nth-child(1) [name=filter]': 'diode',
  '#devs .dev:nth-child(1) [name=muffler]': '1', '#devs .dev:nth-child(1) [name=accdec]': '.75',
  '#devs .dev:nth-child(1) [name=vegdec]': '.88', '#devs .dev:nth-child(1) [name=softatk]': '.6',
  '#devs .dev:nth-child(1) [name=sweep]': '.75', '#devs .dev:nth-child(1) [name=accent]': '.85',
  '#devs .dev:nth-child(1) [name=dbsA]': '3:OH',
  '#devs .dev:nth-child(2) [name=engine]': 'wasm', '#devs .dev:nth-child(2) [name=filter]': 'diode',
  '#devs .dev:nth-child(2) [name=selfosc]': '1', '#devs .dev:nth-child(2) [name=track]': '1',
  '#devs .dev:nth-child(2) [name=wave]': 'sawtooth', '#devs .dev:nth-child(2) [name=drive]': '.2',
  '#devs .dev:nth-child(2) [name=softatk]': '.8', '#devs .dev:nth-child(2) [name=slide]': '.7',
  '#devs .dev:nth-child(2) [name=level]': '.5',
};

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ acceptDownloads: true });
page.on('pageerror', e => { console.error(e); process.exit(1); });
await page.goto(url);
await page.evaluate(async ({ P303, DRUMS, SONG, RIDES, CONTROLS }) => {
  const { installPreset } = await import('/src/preset.ts');
  installPreset({ bank: 1, p303: P303, drums: DRUMS, song: SONG, rides: RIDES, bpm: 136 });
  for (const [sel, v] of Object.entries(CONTROLS)) {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`no control ${sel}`);
    el.value = v; el.dispatchEvent(new Event('input'));
  }
}, { P303, DRUMS, SONG, RIDES, CONTROLS });
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#songsave')]);
await dl.saveAs(out);
await browser.close();
console.log('wrote', out);
