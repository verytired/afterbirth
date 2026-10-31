// "MODS TOUR": a song in bank C that plays each Devil Fish style MODS feature as an A/B, stock first,
// with the section name shown as a caption. The button loads it and starts playback
import { $ } from './dom';
import { machines } from './rack';
import { installPreset, type Ride } from './preset';
import { resetControls } from './demo';

const REST = Array(16).fill('-').join(' ');
const P303: string[][] = [
  [ // 303 #1
    'C! C C^ C C~ D# C C^! C C G~ C^ C! A#v C^~ C', // C1 groove
    'C+^! G^ D#^ G^ A#^! G^ D#^ G^ C+^! G^ D#^ G^ G^! F^ D#^ C^', // C2: read on the kick steps while DBS A is on
    'C! - - - - - C - - - - - G - - -',              // C3 sparse, leaves room for 303 #2
  ],
  [ // 303 #2
    REST,
    'C^! - D#^ - G^~ F^ - D#^ - C^ - A# G~ - C^ -', // C2 melody for the self-oscillating filter
  ],
];
const KICK = 'x...x...x...x...', HATS = { CH: 'xx.xxx.xxx.xxx.x', OH: '..x...x...x...x.' };
const DRUMS: Record<string, string>[][] = [
  [{}, { BD: KICK }], // 808: C1 silent, C2 kick = the DBS A trigger
  [{ BD: KICK, ...HATS, CP: '....x.......x...' }, HATS, { BD: KICK }], // 909: C1 kit, C2 hats only, C3 kick only
];
// Bars: 0 intro | 4 DEVIL FISH A/B | 16 SELF OSC A/B | 28 DBS A/B | 40 all | 48 end
const SONG = `# MODS TOUR   303#1 303#2 808 909
C1 C8 C1 C3 x4    # AB-303 STOCK
C1 C8 C1 C1 x4    # DEVIL FISH: stock first...
C1 C8 C1 C1 x8    # DEVIL FISH: DRIVE + ENV MOD x3 + DECAY + FILTER FM
C3 C2 C1 C1 x4    # SELF OSC: stock resonance...
C3 C2 C1 C1 x8    # SELF OSC: the filter oscillates, TRACK plays it in tune
C1 C8 C1 C2 x4    # DBS: 909 kick, no switching...
C1 C8 C2 C2 x8    # DBS: every 808 kick reads 303#1 from bank C2
C1 C2 C2 C1 x8    # ALL MODS
END
`;
// [bar, value]. Changes land on the section boundaries so each A/B is obvious
const RIDES: Ride[] = [
  { key: '0:drive', keys: [[0, 0], [8, 0], [8.5, .6], [15.9, .6], [16, 0], [40, 0], [40.5, .35]] },
  { key: '0:env', keys: [[0, .5], [8, .5], [8.5, 1.8], [15.9, 1.8], [16, .5], [40, .5], [40.5, 1.2]] },
  { key: '0:decay', keys: [[0, .9], [8, .9], [8.5, 1.25], [15.9, 1.25], [16, .9], [40, .9], [40.5, 1.1]] },
  { key: '0:fm', keys: [[0, 0], [10, 0], [12, .3], [15.9, .3], [16, 0]] },
  { key: '0:reso', keys: [[0, 12], [8, 12], [8.5, 17], [15.9, 17], [16, 12], [40, 12], [40.5, 15]] },
  { key: '0:cutoff', keys: [[0, .3], [8, .3], [12, .42], [16, .3]] },
  { key: '1:reso', keys: [[0, 10], [20, 10], [21, 20], [27.9, 20], [28, 10], [40, 10], [41, 20]] },
  { key: '1:track', keys: [[0, 1]] },
  { key: '1:cutoff', keys: [[0, .35]] },
  { key: '1:env', keys: [[0, .3]] },
  { key: '1:send', keys: [[0, .3]] },
];

const BANK = 2; // C
const bankUsed = () => machines.some(m => m.pats.slice(BANK * 8, BANK * 8 + 8).some(p => {
  const q = p as { steps?: { note: number }[]; grid?: boolean[][] };
  return q.steps ? q.steps.some(s => s.note >= 0) : q.grid!.some(r => r.includes(true));
}));

export function wireTour() {
  $('tour').onclick = () => {
    // only ask when there is something in bank C to lose
    if (bankUsed() && !confirm('Load and play MODS TOUR? This overwrites bank C of every machine, the song and its automation.')) return;
    resetControls();
    const set = (dev: number, name: string, v: string) => {
      const el = document.querySelector<HTMLSelectElement>(`#devs .dev:nth-child(${dev}) [name=${name}]`)!;
      el.value = v; el.dispatchEvent(new Event('input'));
    };
    set(2, 'selfosc', '1'); // only oscillates while the 1:reso ride is high
    set(1, 'dbsA', '2:BD'); // the 808 kick only plays in the DBS and final sections
    installPreset({ bank: BANK, p303: P303, drums: DRUMS, song: SONG, rides: RIDES, bpm: 130 });
    $('play').click();
  };
}
