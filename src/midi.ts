// MIDI clock sync (follow Live etc. 24ppqn, so one 16th = 6 clocks)
import { $ } from './dom';
import { ctx, playing, ext, setExt } from './state';
import { cur, setCur, playStep, start, stop, tempo, ensureAudio } from './transport';

// ponytail: fixed latency after receipt. Trim drift with Live's "MIDI Clock Sync Delay"
const MIDI_LAT = 0.05;
let midi: MIDIAccess | undefined, clocks = 0, lastClock = -Infinity, clockMs = 0;

export function onMidi(e: { data: Uint8Array | null; timeStamp: number }) {
  if (!ext || !e.data) return;
  const [st, a, b] = e.data;
  if (st === 0xfa) { stop(); setCur(0); clocks = 0; start(); }        // Start
  else if (st === 0xfb) { clocks = 0; start(); }                     // Continue
  else if (st === 0xfc) stop();                                      // Stop
  else if (st === 0xf2) { setCur((a | b << 7) % 16); clocks = 0; }   // Song Position (in 16ths)
  else if (st === 0xf8) {                                            // Clock
    const dt = e.timeStamp - lastClock;
    lastClock = e.timeStamp;
    if (dt > 5 && dt < 200) clockMs = clockMs ? clockMs * 0.9 + dt * 0.1 : dt;
    if (!playing || clocks++ % 6) return;
    const d = clockMs ? clockMs * 6 / 1000 : 60 / tempo.value / 4;
    const t = ctx.currentTime + MIDI_LAT - (performance.now() - e.timeStamp) / 1000;
    playStep(cur, t, d);
    setCur((cur + 1) % 16);
    if (clockMs) tempo.set(60000 / (clockMs * 24));
    if (clocks % 24 === 1) { $('beat').classList.add('on'); setTimeout(() => $('beat').classList.remove('on'), 80); }
  }
}

export function wireMidi() {
  const btn = $('ext');
  btn.onclick = async () => {
    if (!navigator.requestMIDIAccess) { btn.textContent = 'NO MIDI'; return; }
    await ensureAudio();
    if (!midi) {
      try { midi = await navigator.requestMIDIAccess(); } catch { btn.textContent = 'MIDI DENIED'; return; }
      const m = midi;
      const hook = () => m.inputs.forEach(i => { i.onmidimessage = onMidi; });
      hook();
      m.onstatechange = hook;
    }
    stop();
    setExt(!ext);
    btn.classList.toggle('on', ext);
    btn.title = [...midi.inputs.values()].map(i => i.name).join(', ') || 'No input ports';
  };
}
