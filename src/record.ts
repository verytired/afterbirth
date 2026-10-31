// Recording (WAV / stems) and video
import { $ } from './dom';
import { ctx } from './state';
import { channels, delay, master } from './audio';
import { machines } from './rack';
import { ensureAudio } from './transport';
import { stemName, wav, zip } from './lib';

// One AudioWorklet with an input per source, so all sources stay sample-aligned. Connections made while
// audio runs can land in different render blocks, so every tap opens at one shared block boundary and the
// worklet only keeps blocks from that frame on
// ponytail: buffers everything in memory (~200MB per 10 min per stereo source). Stream to disk for long takes
const REC_WORKLET = `registerProcessor('rec', class extends AudioWorkletProcessor {
  constructor() { super(); this.from = Infinity; this.port.onmessage = e => { this.from = e.data; }; }
  process(inputs) { if (currentFrame >= this.from) this.port.postMessage(inputs.map(inp => inp.map(c => c.slice()))); return true; }
});`;
let recReady = false;

interface Source { name: string; node: AudioNode; gain?: number }
interface Recorder { stop(): { name: string; data: Uint8Array }[] }
let wavRec: Recorder | null = null, stemRec: Recorder | null = null, vidRec: MediaRecorder | null = null, recT0 = 0;

export function download(blob: Blob, ext: string) {
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `afterbirth-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function startRecorder(sources: Source[]): Promise<Recorder> {
  if (!recReady) {
    await ctx.audioWorklet.addModule('data:text/javascript,' + encodeURIComponent(REC_WORKLET)); // data URL so it also loads from file://
    recReady = true;
  }
  const node = new AudioWorkletNode(ctx, 'rec', { numberOfInputs: sources.length, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
  const from = Math.ceil((ctx.currentTime + 0.1) * ctx.sampleRate / 128) * 128; // a block boundary safely ahead
  node.port.postMessage(from);
  const taps = sources.map((s, i) => {
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(s.gain ?? 1, from / ctx.sampleRate);
    s.node.connect(g).connect(node, 0, i);
    return g;
  });
  const data = sources.map((): [Float32Array[], Float32Array[]] => [[], []]);
  node.port.onmessage = (e: MessageEvent<Float32Array[][]>) => e.data.forEach((inp, i) => {
    const silent = new Float32Array(128);
    data[i][0].push(inp[0] ?? silent);
    data[i][1].push(inp[1] ?? inp[0] ?? silent);
  });
  return {
    stop() {
      sources.forEach((s, i) => s.node.disconnect(taps[i]));
      node.port.onmessage = null;
      return sources.map((s, i) => ({ name: s.name, data: wav(data[i][0], data[i][1], ctx.sampleRate) }));
    },
  };
}

function recTimer() {
  const on = wavRec || stemRec || vidRec;
  if (on && !recT0) recT0 = Date.now();
  if (!on) recT0 = 0;
  const sec = recT0 ? (Date.now() - recT0) / 1000 | 0 : 0;
  $('rectime').textContent = `${sec / 60 | 0}:${String(sec % 60).padStart(2, '0')}`;
}

export function wireRecording() {
  setInterval(recTimer, 250);
  // A song that hits END finishes any running recording once the tail has rung out
  document.addEventListener('songend', () => setTimeout(() =>
    ['rec', 'stems', 'vid'].forEach(id => $(id).classList.contains('recording') && $(id).click()), 2000));

  $('rec').onclick = async () => {
    await ensureAudio();
    if (wavRec) {
      download(new Blob([wavRec.stop()[0].data as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'wav');
      wavRec = null;
    } else {
      wavRec = await startRecorder([{ name: 'master', node: master.lvl }]);
    }
    $('rec').classList.toggle('recording', !!wavRec);
    recTimer();
  };

  // Stems are taken post-fader/inserts with the same -6dB master trim, so they sum back to the
  // mix (before master COMP and master fader). DELAY gets its own stem since it only feeds MASTER
  $('stems').onclick = async () => {
    await ensureAudio();
    if (stemRec) {
      download(zip(stemRec.stop().map(f => ({ name: f.name + '.wav', data: f.data }))), 'stems.zip');
      stemRec = null;
    } else {
      const trim = master.inp.gain.value;
      stemRec = await startRecorder([
        { name: stemName(0, 'master'), node: master.lvl },
        ...machines.map((m, i) => ({ name: stemName(i + 1, m.name), node: channels[i].out, gain: trim })),
        { name: stemName(machines.length + 1, 'delay return'), node: delay.ret, gain: trim },
      ]);
    }
    $('stems').classList.toggle('recording', !!stemRec);
    recTimer();
  };

  // Video = tab screen share + MASTER audio. Stopping the share also ends the recording
  $('vid').onclick = async () => {
    await ensureAudio();
    if (vidRec) { vidRec.stop(); return; }
    let scr: MediaStream;
    try {
      scr = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false, preferCurrentTab: true } as DisplayMediaStreamOptions);
    } catch { return; } // cancelled
    const dest = ctx.createMediaStreamDestination();
    master.lvl.connect(dest);
    const type = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
    const mr = new MediaRecorder(new MediaStream([...scr.getVideoTracks(), ...dest.stream.getAudioTracks()]), { mimeType: type, videoBitsPerSecond: 8e6 });
    const chunks: Blob[] = [];
    mr.ondataavailable = e => chunks.push(e.data);
    mr.onstop = () => {
      scr.getTracks().forEach(t => t.stop());
      master.lvl.disconnect(dest);
      download(new Blob(chunks, { type }), type?.startsWith('video/mp4') ? 'mp4' : 'webm');
      vidRec = null;
      $('vid').classList.remove('recording');
      recTimer();
    };
    scr.getVideoTracks()[0].onended = () => { if (mr.state !== 'inactive') mr.stop(); };
    mr.start(1000);
    vidRec = mr;
    $('vid').classList.add('recording');
    recTimer();
  };
}
