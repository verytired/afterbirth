import './style.css';
import { knobify } from './dom';
import { ctx, playing, setExt } from './state';
import { FX, channels, master, wireFx } from './audio';
import { machines, save, wireRows } from './rack';
import { make303 } from './tb303';
import { make606, make808, make909 } from './drums';
import { cur, ensureAudio, tempo, wireTransport } from './transport';
import { onMidi, wireMidi } from './midi';
import { wireRecording } from './record';
import { wireOutput } from './output';
import { song, wireSong } from './song';
import { wireSongFile } from './songfile';

machines.push(
  make303('AB-303 #1', [[0, 0, 1, 0], [0, 1, 0, 0], [-1], [12, 0, 0, 1], [3, 0, 0, 1], [0, 0, 1, 0], [7, -1, 0, 0], [-1],
    [0, 0, 0, 1], [10, 0, 1, 0], [0, 0, 0, 0], [3, 1, 0, 0], [-1], [5, 0, 1, 1], [7, 0, 0, 0], [0, -1, 0, 0]]),
  make303('AB-303 #2', [[-1], [-1], [7, 1, 1, 0], [-1], [3, 1, 0, 1], [5, 1, 0, 0], [-1], [10, 0, 1, 0],
    [-1], [-1], [7, 1, 0, 1], [10, 1, 0, 0], [-1], [3, 1, 1, 0], [-1], [0, 1, 0, 0]], { wave: 'square', cutoff: .45, reso: 8, level: .6 }),
  make808(),
  make909(),
  make606(), // last: song slots and saved files index machines by position
);
machines.forEach(m => m.rackReady?.());
knobify(); // after all machines are mounted
wireRows();

wireFx();
wireTransport();
wireMidi();
wireRecording();
wireOutput();
wireSong(); // after knobify
wireSongFile();
document.addEventListener('click', save);
document.addEventListener('change', save);

// Hook for the Playwright tests
const ab = {
  get ctx() { return ctx; }, get playing() { return playing; }, get cur() { return cur; },
  tempo, song, channels, FX, machines, master, onMidi, ensureAudio, setExt,
};
declare global { interface Window { ab: typeof ab } }
window.ab = ab;
