// Output device and MULTI OUT (send to e.g. BlackHole 16ch and record in a DAW)
import { $ } from './dom';
import { ctx } from './state';
import { ensureAudio } from './transport';

// setSinkId is Chrome/Edge-only and missing from some DOM typings
type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

let multi = false, devsLoaded = false;

function applyOut() {
  if (!ctx) return;
  const n = multi ? Math.min(12, ctx.destination.maxChannelCount) : 2;
  ctx.destination.channelCount = n;
  $('multi').textContent = multi && n < 12 ? `MULTI OUT (${n}ch only)` : 'MULTI OUT';
}

export function wireOutput() {
  const sel = $<HTMLSelectElement>('outdev');
  sel.onfocus = async () => {
    if (devsLoaded) return;
    devsLoaded = true;
    const outputs = async () => (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
    let list = await outputs();
    if (list.some(d => !d.label)) { // device names need mic permission (audio is never used)
      try {
        (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop());
        list = await outputs();
      } catch { /* keep unnamed devices */ }
    }
    sel.replaceChildren(new Option('Default output', ''),
      ...list.filter(d => d.deviceId !== 'default').map((d, i) => new Option(d.label || `Output ${i + 1}`, d.deviceId)));
  };
  sel.onchange = async () => {
    await ensureAudio();
    const c = ctx as SinkContext;
    if (!c.setSinkId) { sel.title = 'This browser cannot switch output devices'; return; }
    await c.setSinkId(sel.value);
    applyOut();
  };
  $('multi').onclick = async () => {
    await ensureAudio();
    multi = !multi;
    $('multi').classList.toggle('on', multi);
    applyOut();
  };
}
