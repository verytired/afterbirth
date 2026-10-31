// Builds public/songs/acid-trip.song.json: a ~6 minute early-90s acid track in the Hardfloor vein (bank D).
// Drives the running app (npm run dev) in Chrome, writes the song with the app's own preset installer,
// then saves it with the SAVE button. Usage: node scripts/acid-trip.mjs [url]
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://localhost:5173/';
const out = new URL('../public/songs/acid-trip.song.json', import.meta.url).pathname;

const P303 = [
  [ // #1
    'C! C^ C C~ C^ C C! C^~ C C C^! C C~ D#~ C^ C', // D1 root pulse with octave jumps
    'C! C^ C A#v~ C C^ G! C C C^~ C D#! C F~ G C^', // D2 with fifth and seventh
    'C! - C^ - C - C^~ C - C! - C^ C - C~ D#', // D3 sparse
    'F! F^ F F~ F^ F F! F^~ F F F^! F F~ G#~ F^ F', // D4 D1 up a fourth
    'C!~ C^~ C~ G~ C^ - C!~ D#^~ C - C^! C~ A#v~ C - C^', // D5 long slides
  ],
  [ // #2: higher call and response
    '- - G^! - - D#^~ F^ - - - A#! - G^~ F^ D#^ -',
    'C^! - - C^ - D#^~ C^ - G! - - A#~ C^ - G -',
    'G^! G^ - - A#^~ C+^ - - G^! - F^~ D#^ - - C^ -',
  ],
];
const KIT = { BD: 'x...x...x...x...', CH: 'xx.xxx.xxx.xxx.x', OH: '..x...x...x...x.', CP: '....x.......x...', RS: '.......x......x.' };
const DRUMS = [
  [ // 808
    { CP: '....x.......x...' },
    { CP: '....x.......x...', SD: '.......x..x....x' },
  ],
  [ // 909
    { BD: KIT.BD },
    { BD: KIT.BD, CH: KIT.CH, OH: KIT.OH },
    KIT,
    { CH: 'xxxxxxxxxxxxxxxx', CP: KIT.CP }, // break
    { BD: KIT.BD, SD: '........x.x.xxxx', CH: KIT.CH }, // fill
    { ...KIT, LT: '......x.......x.', HT: '...x.......x....' }, // toms
    { ...KIT, CR: 'x...............' }, // crash into a section
  ],
];
const SONG = `# 303#1 303#2 808 909   (xN = bars, - = keep, END = stop)
D3 D8 D8 D8 x4    # intro: 303 alone, filter closed
D3 D8 D8 D1 x12   # kick
D1 D8 D8 D2 x16   # groove, cutoff starts to open
D1 D8 D1 D7 x1
D1 D8 D1 D3 x15   # full kit
D2 D1 D1 D3 x16   # second 303 answers
D5 D1 D2 D6 x16   # long slides, toms, decay opens
D5 D8 D8 D4 x7    # break 1
D5 D8 D8 D5 x1
D4 D8 D1 D7 x1    # up to F
D4 D3 D1 D3 x15
D4 D3 D2 D6 x16
D1 D8 D8 D4 x14   # break 2: the big sweep
D1 D8 D8 D5 x2
D2 D2 D2 D7 x1    # peak
D2 D2 D2 D6 x15
D1 D1 D1 D3 x16
D1 D8 D8 D2 x8    # outro: filter closes
D3 D8 D8 D1 x8
D3 D8 D8 D8 x4
D8 D8 D8 D8 x2    # delay tail
END
`;
// Knob rides as [bar, value] keyframes; wob adds a slow sine (amount, period in bars)
const RIDES = [
  { key: '0:cutoff', wob: [.07, 6], keys: [[0, .05], [4, .08], [16, .12], [32, .35], [48, .45], [64, .5], [80, .45], [81, .2], [87, .72], [88, .5],
    [104, .45], [120, .5], [121, .15], [135, .85], [136, .6], [152, .62], [168, .55], [176, .4], [184, .12], [188, .05]] },
  { key: '0:reso', keys: [[0, 12], [80, 13], [87, 18], [88, 15], [120, 15], [135, 20], [136, 17], [168, 16], [190, 12]] },
  { key: '0:env', keys: [[0, .25], [32, .4], [64, .55], [88, .5], [120, .6], [136, .8], [168, .7], [190, .25]] },
  { key: '0:decay', keys: [[0, .8], [64, .8], [70, 1.04], [80, .95], [88, .86], [120, .86], [128, 1.07], [136, .92], [168, .9], [190, .8]] }, // ~100-320 ms (decayTau)
  { key: '0:accent', keys: [[0, .8]] },
  { key: '0:send', keys: [[0, 0], [80, 0], [81, .3], [87, .3], [88, 0], [120, 0], [121, .35], [135, .35], [136, 0], [176, 0], [184, .3]] }, // delay throws in the breaks
  { key: '1:cutoff', wob: [.1, 4], keys: [[0, .3], [48, .35], [64, .5], [88, .4], [136, .55], [168, .45], [190, .3]] },
  { key: '1:env', keys: [[0, .4], [136, .7], [168, .5]] },
  { key: '1:reso', keys: [[0, 12]] },
  { key: '1:send', keys: [[0, .35]] },
  { key: 'dfb', keys: [[0, .45]] },
];

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ acceptDownloads: true });
page.on('pageerror', e => { console.error(e); process.exit(1); });
await page.goto(url);
await page.evaluate(async ({ P303, DRUMS, SONG, RIDES }) => {
  const { installPreset } = await import('/src/preset.ts');
  installPreset({ bank: 3, p303: P303, drums: DRUMS, song: SONG, rides: RIDES, bpm: 130 });
}, { P303, DRUMS, SONG, RIDES });
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#songsave')]);
await dl.saveAs(out);
await browser.close();
console.log('wrote', out);
