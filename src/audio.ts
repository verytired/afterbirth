// Effects, master bus, delay and mixer channels
import { $, fv, numbox } from './dom';
import { ctx } from './state';
import { PCF_PATS } from './lib';

type FxName = 'DIST' | 'PCF' | 'COMP';
const FX_NAMES: FxName[] = ['DIST', 'PCF', 'COMP'];
interface FxIO { in: AudioNode; out: AudioNode }

// Insert slot that just switches wet/dry
function stage(input: AudioNode, fx: FxIO) {
  const dry = ctx.createGain(), wet = ctx.createGain(), out = ctx.createGain();
  input.connect(dry).connect(out);
  input.connect(fx.in); fx.out.connect(wet).connect(out);
  wet.gain.value = 0;
  return { out, set(on: boolean) { dry.gain.value = on ? 0 : 1; wet.gain.value = on ? 1 : 0; } };
}

// DIST / PCF / COMP have one instance per channel; the knobs drive all instances
export const FX = {
  DIST: {
    enabled: true, nodes: [] as WaveShaperNode[],
    curve() {
      const k = 1 + fv('damt') * 50, sh = fv('dshape'), c = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) {
        const x = i / 511.5 - 1;
        c[i] = (1 - sh) * Math.tanh(k * x) / Math.tanh(k) + sh * Math.sin(k * x * Math.PI / 2); // SHAPE morphs soft clip -> wavefold
      }
      return c;
    },
    make(): FxIO { const n = ctx.createWaveShaper(); n.oversample = '4x'; this.nodes.push(n); this.update(); return { in: n, out: n }; },
    update() { const c = this.curve(); this.nodes.forEach(n => { n.curve = c; }); },
  },
  PCF: {
    enabled: true, nodes: [] as BiquadFilterNode[], mode: 'lowpass' as BiquadFilterType,
    make(): FxIO { const n = ctx.createBiquadFilter(); this.nodes.push(n); this.update(); return { in: n, out: n }; },
    update() {
      this.nodes.forEach(n => { n.type = this.mode; n.Q.value = this.mode === 'lowpass' ? fv('pq') * 20 : 0.5 + fv('pq') * 15; });
    },
  },
  COMP: {
    enabled: true, nodes: [] as [DynamicsCompressorNode, GainNode][],
    make(): FxIO {
      const n = ctx.createDynamicsCompressor(), g = ctx.createGain();
      n.attack.value = 0.003; n.release.value = 0.1;
      n.connect(g); this.nodes.push([n, g]); this.update();
      return { in: n, out: g };
    },
    update() {
      const thr = -fv('cthr') * 50, ratio = fv('cratio');
      this.nodes.forEach(([n, g]) => {
        n.threshold.value = thr; n.ratio.value = ratio;
        g.gain.value = 10 ** (-thr * (1 - 1 / ratio) * 0.5 / 20); // rough makeup gain
      });
    },
  },
};

export const pcfNum = numbox($('pcfnum'), 1, 32, 1);
export function pcfStep(i: number, t: number) {
  const base = 80 * Math.pow(100, fv('pfreq'));
  const peak = Math.min(16000, base * (1 + fv('pamt') * PCF_PATS[pcfNum.value - 1][i] * 15));
  for (const n of FX.PCF.nodes) {
    n.frequency.cancelScheduledValues(t);
    n.frequency.setValueAtTime(peak, t);
    n.frequency.setTargetAtTime(base, t + 0.002, (0.02 + fv('pdec') * 0.5) / 3);
  }
}

export const dSteps = numbox($('dsteps'), 1, 16, 3);
class Delay {
  enabled = true; mode = 1; time = 0;
  inp!: GainNode; d!: DelayNode; fb!: GainNode; pan!: StereoPannerNode; ret!: GainNode;
  init() {
    this.inp = ctx.createGain(); this.d = ctx.createDelay(4); this.fb = ctx.createGain();
    this.pan = ctx.createStereoPanner(); this.ret = ctx.createGain();
    this.inp.connect(this.d);
    this.d.connect(this.fb).connect(this.d);
    this.d.connect(this.pan).connect(this.ret).connect(master.inp);
    ['dpan', 'dfb'].forEach(id => $(id).addEventListener('input', () => this.update()));
    this.update();
  }
  update() {
    if (!this.d) return;
    this.fb.gain.value = fv('dfb') * 0.9;
    this.pan.pan.value = fv('dpan');
    this.ret.gain.value = this.enabled ? 1 : 0;
  }
  setTime(d: number) {
    const time = Math.min(4, dSteps.value * d * (this.mode === 3 ? 2 / 3 : 1));
    if (time !== this.time) { this.time = time; this.d.delayTime.setTargetAtTime(time, ctx.currentTime, 0.02); }
  }
}
export const delay = new Delay();

// Send a stereo node to output channels ch, ch+1
function tapTo(node: AudioNode, ch: number) {
  const sp = ctx.createChannelSplitter(2);
  node.connect(sp);
  sp.connect(master.merger, 0, ch);
  sp.connect(master.merger, 1, ch + 1);
}

class Master {
  inp!: GainNode; lvl!: GainNode; an!: AnalyserNode; merger!: ChannelMergerNode;
  comp!: ReturnType<typeof stage>;
  init() {
    this.inp = ctx.createGain();
    this.inp.gain.value = 0.5; // -6dB headroom: the four machines together exceed 1.0
    this.comp = stage(this.inp, FX.COMP.make());
    this.lvl = ctx.createGain(); this.an = ctx.createAnalyser(); this.an.fftSize = 1024;
    // 10ch output: 1/2 MASTER, 3/4 onward one pair per machine (ch 3+ only audible with MULTI OUT)
    this.merger = ctx.createChannelMerger(10);
    ctx.destination.channelInterpretation = 'discrete';
    this.merger.connect(ctx.destination);
    tapTo(this.comp.out.connect(this.lvl), 0);
    this.lvl.connect(this.an);
    $('mvol').addEventListener('input', () => this.update());
    this.update();
    const buf = new Float32Array(this.an.fftSize);
    const draw = () => {
      this.an.getFloatTimeDomainData(buf);
      let pk = 0;
      for (const x of buf) pk = Math.max(pk, Math.abs(x));
      $('meter').style.height = Math.max(0, Math.min(100, (20 * Math.log10(pk || 1e-5) + 48) / 48 * 100)) + '%';
      $('clip').classList.toggle('on', pk >= 1);
      requestAnimationFrame(draw);
    };
    draw();
  }
  update() {
    if (!this.lvl) return;
    this.lvl.gain.value = fv('mvol');
    this.comp.set($('mcomp').classList.contains('on') && FX.COMP.enabled);
  }
}
export const master = new Master();

// ---------- Mixer ----------
export const channels: Channel[] = [];
export const refresh = () => { channels.forEach(c => c.update()); master.update(); delay.update(); };

export class Channel {
  on: Record<FxName, boolean> = { DIST: false, PCF: false, COMP: false };
  inp!: GainNode;
  out!: GainNode; // post-fader, post-inserts
  update = () => {};
  private q = <T extends Element>(s: string) => this.el.querySelector<T>(s)!;
  private v = (n: string) => +this.q<HTMLInputElement>(`[name=${n}]`).value;

  constructor(private el: HTMLElement, level = 0.8) {
    el.innerHTML = `<div class="hdr"><button class="led-btn on" data-mute aria-label="mute"></button>MIX</div>
      <div class="row"><label>PAN <input type="range" name="pan" min="-1" max="1" step="0.01" value="0"></label>
      <label>DELAY <input type="range" name="send" min="0" max="1" step="0.01" value="0"></label></div>
      <div class="row" style="margin-top:8px"><input class="fader" type="range" name="level" min="0" max="1" step="0.01" value="${level}" aria-label="level">
      <div class="ins">${FX_NAMES.map(k => `<button class="tog" data-fx="${k}">${k}</button>`).join('')}</div></div>`;
    this.q<HTMLButtonElement>('[data-mute]').onclick = e => { (e.target as HTMLElement).classList.toggle('on'); this.update(); };
    el.querySelectorAll<HTMLElement>('[data-fx]').forEach(b => b.onclick = () => {
      const k = b.dataset.fx as FxName;
      this.on[k] = !this.on[k];
      b.classList.toggle('on', this.on[k]);
      this.update();
    });
    channels.push(this);
  }

  init() {
    this.inp = ctx.createGain();
    const stages = {} as Record<FxName, ReturnType<typeof stage>>;
    let node: AudioNode = this.inp;
    for (const k of FX_NAMES) { stages[k] = stage(node, FX[k].make()); node = stages[k].out; }
    const pan = ctx.createStereoPanner(), lvl = ctx.createGain(), send = ctx.createGain();
    node.connect(pan).connect(lvl).connect(master.inp);
    lvl.connect(send).connect(delay.inp);
    this.out = lvl;
    tapTo(lvl, 2 + 2 * channels.indexOf(this));
    this.update = () => {
      pan.pan.value = this.v('pan');
      send.gain.value = this.v('send');
      lvl.gain.value = this.q('[data-mute]').classList.contains('on') ? this.v('level') : 0;
      for (const k of FX_NAMES) stages[k].set(this.on[k] && FX[k].enabled);
    };
    this.el.querySelectorAll('input').forEach(i => i.addEventListener('input', this.update));
    this.update();
  }
}

// Effect-panel controls
export function wireFx() {
  $('damt').addEventListener('input', () => FX.DIST.update());
  $('dshape').addEventListener('input', () => FX.DIST.update());
  $('pq').addEventListener('input', () => FX.PCF.update());
  ['cratio', 'cthr'].forEach(id => $(id).addEventListener('input', () => FX.COMP.update()));
  document.querySelectorAll<HTMLElement>('[data-pmode]').forEach(b => b.onclick = () => {
    FX.PCF.mode = b.dataset.pmode as BiquadFilterType;
    document.querySelectorAll('[data-pmode]').forEach(x => x.classList.toggle('on', x === b));
    FX.PCF.update();
  });
  document.querySelectorAll<HTMLElement>('[data-dmode]').forEach(b => b.onclick = () => {
    delay.mode = +b.dataset.dmode!;
    document.querySelectorAll('[data-dmode]').forEach(x => x.classList.toggle('on', x === b));
  });
  $('mcomp').onclick = e => { (e.target as HTMLElement).classList.toggle('on'); master.update(); };
  document.querySelectorAll<HTMLElement>('[data-unit]').forEach(b => b.onclick = () => {
    b.classList.toggle('on');
    const on = b.classList.contains('on'), k = b.dataset.unit!;
    if (k === 'DELAY') delay.enabled = on; else FX[k as FxName].enabled = on;
    refresh();
  });
}
