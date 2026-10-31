import { ctx } from './state';
import { Channel } from './audio';
import { loadPats, makeBank, mountDevice, type Machine, type Pat } from './rack';
import { loadVoice } from './dsp/load';
import { P_ACCENT, P_CUTOFF, P_DECAY, P_ENV, P_FILTER, P_RESO, P_WAVE } from './dsp/engine';
import { config, type EngineChoice } from './config';
import type { EngineName, ProcessorMsg, VoiceMsg } from './dsp/protocol';

const NOTES = ['—', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B', 'C+'];
const KNOBS = [
  ['TUNE', 'tune', -12, 12, 1, 0], ['CUTOFF', 'cutoff', 0, 1, .001, .3], ['RESO', 'reso', 0, 20, .1, 12],
  ['ENV MOD', 'env', 0, 1, .01, .5], ['DECAY', 'decay', .05, 1.5, .01, .4], ['ACCENT', 'accent', 0, 1, .01, .6],
] as const;
type KnobName = typeof KNOBS[number][1];
const PARAM_IDS: Partial<Record<KnobName, number>> = { cutoff: P_CUTOFF, reso: P_RESO, env: P_ENV, decay: P_DECAY, accent: P_ACCENT };

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
    </div><div class="seq"></div>`;
  const q = <T extends Element = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const v = (n: KnobName) => +q<HTMLInputElement>(`[name=${n}]`).value;
  const wave = q<HTMLSelectElement>('[name=wave]');
  if (opt.wave) wave.value = opt.wave;
  const engineSel = q<HTMLSelectElement>('[name=engine]');
  const engine = () => engineSel.value as EngineChoice;
  const filterSel = q<HTMLSelectElement>('[name=filter]');
  engineSel.value = config.engine;
  filterSel.value = config.filter;
  const syncFilterUi = () => { filterSel.disabled = engine() === 'classic'; }; // CLASSIC has its own fixed filter
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
  };
  const cutoffHz = () => 60 * Math.pow(100, v('cutoff')); // 60Hz..6kHz

  return {
    name, pats,
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
      root.querySelectorAll('input[type=range], [name=wave], [name=filter]').forEach(el => el.addEventListener('input', sendParams));
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
      const s = steps[i], prev = steps[(i + 15) % 16], next = steps[(i + 1) % 16];
      if (s.note < 0) return;
      const freq = 440 * 2 ** ((36 + s.note + 12 * s.oct + v('tune') - 69) / 12);
      const slidIn = prev.note >= 0 && prev.sld;
      const tieOut = s.sld && next.note >= 0;
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
        const tau = (acc ? 0.15 : v('decay')) / 3;
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
