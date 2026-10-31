import { ctx } from './state';
import { Channel } from './audio';
import { loadPats, machines, makeBank, mountDevice, type Machine, type Pat } from './rack';
import { loadVoice } from './dsp/load';
import {
  P_ACCENT, P_CUTOFF, P_DECAY, P_ENV, P_FILTER, P_RESO, P_WAVE, decayTau,
  P_ACC_DECAY, P_VEG_DECAY, P_SOFT_ATTACK, P_SLIDE_TIME, P_SWEEP, P_FILTER_FM, P_TRACKING, P_DRIVE, P_MUFFLER, P_SELF_OSC,
} from './dsp/engine';
import { config, type EngineChoice } from './config';
import type { EngineName, ProcessorMsg, VoiceMsg } from './dsp/protocol';

const NOTES = ['—', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B', 'C+'];
const KNOBS = [
  ['TUNE', 'tune', -12, 12, 1, 0], ['CUTOFF', 'cutoff', 0, 1, .001, .3], ['RESO', 'reso', 0, 20, .1, 12],
  ['ENV MOD', 'env', 0, 3, .01, .5], ['DECAY', 'decay', .05, 1.5, .01, .9], ['ACCENT', 'accent', 0, 1, .01, .6],
] as const;
type KnobName = typeof KNOBS[number][1];
const PARAM_IDS: Partial<Record<KnobName, number>> = { cutoff: P_CUTOFF, reso: P_RESO, env: P_ENV, decay: P_DECAY, accent: P_ACCENT };

// MODS row, inspired by the Devil Fish modification. Every default reproduces the stock voice. WASM/JS engines only
const KNOBS_MOD = [
  ['ACC DEC', 'accdec', P_ACC_DECAY, .5], ['VEG DEC', 'vegdec', P_VEG_DECAY, 1], ['SOFT ATK', 'softatk', P_SOFT_ATTACK, .5],
  ['SLIDE', 'slide', P_SLIDE_TIME, 0], ['SWEEP', 'sweep', P_SWEEP, .5], ['FILTER FM', 'fm', P_FILTER_FM, 0],
  ['TRACK', 'track', P_TRACKING, 0], ['DRIVE', 'drive', P_DRIVE, 0],
] as const;
const MODS_HTML = `<div class="row mods"><b>MODS</b>
  ${KNOBS_MOD.map(([l, n, , def]) => `<label>${l} <input type="range" name="${n}" min="0" max="1" step="0.01" value="${def}"></label>`).join('')}
  <label>MUFFLER <select name="muffler"><option value="0">OFF</option><option value="1">SOFT</option><option value="2">HARD</option></select></label>
  <label>SELF OSC <select name="selfosc"><option value="0">OFF</option><option value="1">ON</option></select></label>
  <div class="dbs">${(['A', 'B'] as const).map(b => `<label>DBS ${b} <span class="row" style="gap:3px">
    <select name="dbs${b}" aria-label="DBS ${b} trigger"><option value="">OFF</option></select>
    <button class="tog" data-dbs="${b}" title="Hold to switch banks">${b}</button></span></label>`).join('')}</div></div>`;
type DbsBit = 'A' | 'B';

interface Step { note: number; oct: number; acc: boolean; sld: boolean } // note: -1 = rest, 0..12 = C..C+
interface Pat303 extends Pat { steps: Step[] }
export type Opt303 = Partial<Record<KnobName | 'level', number>> & { wave?: OscillatorType };

// pattern: [note, oct, acc, sld], trailing values default to 0
export function make303(name: string, pattern: number[][], opt: Opt303 = {}): Machine {
  const [bankEl, root, mixEl] = mountDevice('d303');
  const rest = (): Step => ({ note: -1, oct: 0, acc: false, sld: false });
  const pats = loadPats<Pat303>(name, k => ({
    steps: k === 0 ? pattern.map(([note, oct = 0, acc = 0, sld = 0]) => ({ note, oct, acc: !!acc, sld: !!sld }))
      : Array.from({ length: 16 }, rest),
  }));
  let steps = pats[0].steps;
  root.innerHTML = `<h2>${name}</h2><div class="row">
    <button data-a="rand">RANDOM</button><button data-a="clear">CLEAR</button>
    <label>ENGINE <select name="engine"><option value="wasm">WASM</option><option value="js">JS</option><option value="classic">CLASSIC</option></select></label>
    <label>FILTER <select name="filter"><option value="diode">DIODE</option><option value="ladder">LADDER</option></select></label>
    <label>WAVE <select name="wave"><option value="sawtooth">SAW</option><option value="square">SQUARE</option></select></label>
    ${KNOBS.map(([l, n, mn, mx, st, def]) => `<label>${l} <input type="range" name="${n}" min="${mn}" max="${mx}" step="${st}" value="${opt[n] ?? def}"></label>`).join('')}
    </div>${MODS_HTML}<div class="seq"></div>`;
  const q = <T extends Element = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const v = (n: KnobName) => +q<HTMLInputElement>(`[name=${n}]`).value;
  const wave = q<HTMLSelectElement>('[name=wave]');
  if (opt.wave) wave.value = opt.wave;
  const engineSel = q<HTMLSelectElement>('[name=engine]');
  const engine = () => engineSel.value as EngineChoice;
  const filterSel = q<HTMLSelectElement>('[name=filter]');
  engineSel.value = config.engine;
  filterSel.value = config.filter;
  const muffler = q<HTMLSelectElement>('[name=muffler]');
  const selfOsc = q<HTMLSelectElement>('[name=selfosc]');

  // Dynamic Bank Switching (Devil Fish): while the trigger drum hits on a step, or the button is held,
  // that step is read from the pattern with bit 0 (A) / bit 1 (B) of its number flipped, e.g. A1 <-> A2 / A3
  const dbsHeld: Record<DbsBit, boolean> = { A: false, B: false };
  const dbsSel: Record<DbsBit, HTMLSelectElement> = { A: q('[name=dbsA]'), B: q('[name=dbsB]') };
  root.querySelectorAll<HTMLButtonElement>('[data-dbs]').forEach(b => {
    const bit = b.dataset.dbs as DbsBit;
    const hold = (on: boolean) => { dbsHeld[bit] = on; b.classList.toggle('on', on); };
    b.onpointerdown = () => hold(true);
    b.onpointerup = b.onpointerleave = () => hold(false);
    b.onkeydown = e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); hold(true); } };
    b.onkeyup = () => hold(false);
  });
  const dbsOn = (bit: DbsBit, i: number) => {
    if (dbsHeld[bit]) return true;
    const [m, part] = dbsSel[bit].value.split(':');
    return part !== undefined && !!machines[+m]?.hit?.(part, i);
  };
  let lastStep: Step | null = null; // the step actually played last, when it came from a switched bank
  let tied = false; // the last note slid on without a gate-off, expecting a note on this step
  const syncFilterUi = () => { // CLASSIC has its own fixed filter and no mods
    filterSel.disabled = engine() === 'classic';
    q('.mods').classList.toggle('off', engine() === 'classic');
  };
  syncFilterUi();
  engineSel.addEventListener('input', syncFilterUi);

  const stepEls = steps.map((_, i) => {
    const el = document.createElement('div');
    el.className = 'step';
    el.innerHTML = `<span>${i + 1}</span><select aria-label="step ${i + 1}">${NOTES.map((n, j) => `<option value="${j - 1}">${n}</option>`).join('')}</select>` +
      ['UP', 'DN', 'ACC', 'SLD'].map(k => `<button data-k="${k}">${k}</button>`).join('');
    el.querySelector('select')!.onchange = e => { steps[i].note = +(e.target as HTMLSelectElement).value; };
    el.querySelectorAll('button').forEach(b => b.onclick = () => {
      const k = b.dataset.k, s = steps[i];
      if (k === 'UP') s.oct = s.oct === 1 ? 0 : 1;
      else if (k === 'DN') s.oct = s.oct === -1 ? 0 : -1;
      else if (k === 'ACC') s.acc = !s.acc;
      else s.sld = !s.sld;
      render(i);
    });
    q('.seq').appendChild(el);
    return el;
  });
  function render(i: number) {
    const s = steps[i], el = stepEls[i], b = el.querySelectorAll('button');
    el.querySelector('select')!.value = String(s.note);
    b[0].classList.toggle('on', s.oct === 1);
    b[1].classList.toggle('on', s.oct === -1);
    b[2].classList.toggle('on', s.acc);
    b[3].classList.toggle('on', s.sld);
  }
  const renderAll = () => steps.forEach((_, i) => render(i));
  renderAll();
  const bank = makeBank(bankEl, pats, () => { steps = bank.pat.steps; renderAll(); });
  const ch = new Channel(mixEl, opt.level);

  q<HTMLButtonElement>('[data-a=rand]').onclick = () => {
    const scale = [0, 3, 5, 7, 10, 12]; // minor pentatonic
    steps.forEach(s => {
      s.note = Math.random() < 0.2 ? -1 : scale[Math.random() * scale.length | 0];
      s.oct = [-1, 0, 0, 0, 1][Math.random() * 5 | 0];
      s.acc = Math.random() < 0.3;
      s.sld = Math.random() < 0.25;
    });
    renderAll();
  };
  q<HTMLButtonElement>('[data-a=clear]').onclick = () => { steps.forEach(s => Object.assign(s, rest())); renderAll(); };

  let osc: OscillatorNode, f1: BiquadFilterNode, f2: BiquadFilterNode, vca: GainNode, voice: AudioWorkletNode;
  const send = (m: VoiceMsg) => voice?.port.postMessage(m);
  const sendParams = () => {
    for (const [n, id] of Object.entries(PARAM_IDS)) send({ k: 'p', id, v: v(n as KnobName) });
    send({ k: 'p', id: P_WAVE, v: wave.value === 'square' ? 1 : 0 });
    send({ k: 'p', id: P_FILTER, v: filterSel.value === 'diode' ? 1 : 0 });
    for (const [, n, id] of KNOBS_MOD) send({ k: 'p', id, v: +q<HTMLInputElement>(`[name=${n}]`).value });
    send({ k: 'p', id: P_MUFFLER, v: +muffler.value });
    send({ k: 'p', id: P_SELF_OSC, v: +selfOsc.value });
  };
  const cutoffHz = () => 60 * Math.pow(100, v('cutoff')); // 60Hz..6kHz

  return {
    name, pats,
    setSteps(slot, data) {
      pats[slot].steps.forEach((s, i) => {
        const [note, oct = 0, acc = 0, sld = 0] = data[i] ?? [-1];
        Object.assign(s, { note, oct, acc: !!acc, sld: !!sld });
      });
      if (slot === bank.sel) renderAll();
    },
    rackReady() {
      const opts = machines.flatMap((m, idx) => (m.parts ?? []).map(p => new Option(`${m.name.replace(/^AB-/, '')} ${p}`, `${idx}:${p}`)));
      for (const sel of Object.values(dbsSel)) sel.append(...opts.map(o => o.cloneNode(true)));
    },
    async init() {
      ch.init();
      // classic graph
      osc = ctx.createOscillator();
      f1 = ctx.createBiquadFilter(); f1.type = 'lowpass';
      f2 = ctx.createBiquadFilter(); f2.type = 'lowpass'; f2.Q.value = 0; // two stages for a steeper, ~24dB/oct slope
      vca = ctx.createGain(); vca.gain.value = 0;
      const out = ctx.createGain(); out.gain.value = 0.4;
      osc.connect(f1).connect(f2).connect(vca).connect(out).connect(ch.inp);
      osc.start();
      const upd = () => { osc.type = wave.value as OscillatorType; f1.Q.value = v('reso'); };
      wave.addEventListener('input', upd);
      q('[name=reso]').addEventListener('input', upd);
      upd();

      // worklet voice. Falls back to the JS engine when the WASM build cannot be loaded
      const wasm = await loadVoice(ctx);
      if (!wasm) {
        const o = engineSel.querySelector<HTMLOptionElement>('option[value=wasm]')!;
        o.disabled = true; o.textContent = 'WASM (unavailable)';
        if (engine() === 'wasm') engineSel.value = 'js';
      }
      voice = new AudioWorkletNode(ctx, 'voice303', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { wasm, engine: engine() === 'js' ? 'js' : 'wasm' },
      });
      voice.port.onmessage = (e: MessageEvent<ProcessorMsg>) => {
        if (e.data.k === 'engine' && engine() !== 'classic') engineSel.value = e.data.name;
        if (e.data.k === 'error') console.warn('303 voice:', e.data.msg);
      };
      voice.connect(ch.inp);
      sendParams();
      root.querySelectorAll('input[type=range], [name=wave], [name=filter], [name=muffler], [name=selfosc]').forEach(el => el.addEventListener('input', sendParams));
      engineSel.addEventListener('input', () => {
        send({ k: 'flush' });
        vca.gain.cancelScheduledValues(ctx.currentTime);
        vca.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
        if (engine() !== 'classic') send({ k: 'engine', name: engine() as EngineName });
      });
    },
    play(i, t, d, sh) {
      bank.tick(i);
      if (bank.pat.shuf) t += sh;
      const mask = (dbsOn('A', i) ? 1 : 0) | (dbsOn('B', i) ? 2 : 0);
      const src = mask ? pats[bank.sel ^ mask].steps : steps;
      const s = src[i], prev = lastStep ?? steps[(i + 15) % 16], next = src[(i + 1) % 16];
      lastStep = mask ? s : null;
      if (s.note < 0) {
        // A tied note met a rest (DBS swapped the next step): end it here instead of letting it ring
        if (tied) {
          if (engine() !== 'classic') send({ k: 'off', t });
          else vca.gain.setTargetAtTime(0, t, 0.006);
        }
        tied = false;
        return;
      }
      const freq = 440 * 2 ** ((36 + s.note + 12 * s.oct + v('tune') - 69) / 12);
      const slidIn = prev.note >= 0 && prev.sld;
      const tieOut = s.sld && next.note >= 0;
      tied = tieOut;
      if (engine() !== 'classic') {
        send({ k: 'on', t, f: freq, acc: s.acc ? 1 : 0, slide: slidIn ? 1 : 0 });
        if (!tieOut) send({ k: 'off', t: t + d * 0.55 });
        return;
      }
      if (slidIn) {
        osc.frequency.setTargetAtTime(freq, t, 0.03);
      } else {
        osc.frequency.setValueAtTime(freq, t);
        const acc = s.acc ? v('accent') : 0;
        vca.gain.cancelScheduledValues(t);
        vca.gain.setTargetAtTime(0.5 + 0.5 * acc, t, 0.002);
        const base = cutoffHz();
        const peak = Math.min(16000, base * (1 + v('env') * 10 * (1 + acc)));
        const tau = acc ? 0.05 : Math.min(60, decayTau(v('decay'))); // max DECAY = hold
        for (const f of [f1, f2]) {
          f.frequency.cancelScheduledValues(t);
          f.frequency.setValueAtTime(peak, t);
          f.frequency.setTargetAtTime(base, t + 0.003, tau);
        }
      }
      if (!tieOut) vca.gain.setTargetAtTime(0, t + d * 0.55, 0.006);
    },
    stop() {
      bank.tick(0);
      send({ k: 'flush' });
      vca.gain.cancelScheduledValues(ctx.currentTime);
      vca.gain.setTargetAtTime(0, ctx.currentTime, 0.01);
    },
    highlight(i) { stepEls.forEach((el, j) => el.classList.toggle('now', j === i)); },
  };
}
