// Child-process runner for tests/separation-perf.test.mjs (Requirements 8.3, 8.4).
//
// Usage: node --expose-gc tests/helpers/perf-run.mjs <baseline|fast|high>
//
// Synthesises a deterministic 3-minute 44.1 kHz stereo track, runs one
// separation with consumeInput: true and prints one JSON line to stdout:
//   { "which": "...", "ms": <wall time of the separation only>,
//     "peakBytes": <peak (heapUsed + arrayBuffers) minus the value at start> }
//
// peakBytes is a delta: the start value is sampled after synthesis and gc(),
// so it already contains the input channels and the Node runtime; the delta is
// the extra memory the separation (plus the kept WAV buffers) needs. Samples
// are taken at every onProgress / onStem call and by a 50 ms interval timer.
// The stem handler mimics the app: each stem is encoded with encodeWav and the
// ArrayBuffer is kept (the app keeps 8 WAV blobs). It is identical for all
// three separators.
import { separateChannels } from '../../public/js/separator.js';
import { separateChannelsBaseline } from './baseline-separator.mjs';
import { encodeWav } from '../../public/js/wav.js';

const SAMPLE_RATE = 44100;
const DURATION_SEC = 180;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cheap synthesis: a 4-bar loop (120 bpm, 8 s) built once and tiled.
// Centre "vocal" tone with vibrato, centre bass, panned pad chord, kick-like
// clicks, panned hi-hat noise bursts and a little broadband noise.
function synthesize() {
  const sr = SAMPLE_RATE;
  const loopLen = 8 * sr;
  const total = DURATION_SEC * sr;
  const rnd = mulberry32(0x5eed);
  const lL = new Float32Array(loopLen);
  const lR = new Float32Array(loopLen);
  const TAU = 2 * Math.PI;
  const beat = sr / 2;
  const vocalNotes = [440, 494, 523, 587, 659, 587, 523, 494];
  const bassNotes = [55, 55, 73.4, 82.4];
  const pad = [261.6, 329.6, 392];
  let vPhase = 0;
  for (let i = 0; i < loopLen; i++) {
    const t = i / sr;
    const b = Math.floor(i / beat);
    const inBeat = (i % beat) / sr;
    const vf = vocalNotes[b % 8] * (1 + 0.01 * Math.sin(TAU * 5.5 * t));
    vPhase += (TAU * vf) / sr;
    const vocal = 0.25 * (Math.sin(vPhase) + 0.4 * Math.sin(2 * vPhase) + 0.2 * Math.sin(3 * vPhase));
    const bf = bassNotes[Math.floor(b / 4) % 4];
    const bass = 0.3 * (Math.sin(TAU * bf * t) + 0.3 * Math.sin(TAU * 2 * bf * t));
    let padL = 0, padR = 0;
    for (let k = 0; k < pad.length; k++) {
      const s = 0.06 * Math.sin(TAU * pad[k] * t);
      padL += s * (k === 0 ? 0.9 : 0.4);
      padR += s * (k === 2 ? 0.9 : 0.4);
    }
    const kick = inBeat < 0.08 ? 0.6 * Math.exp(-inBeat * 40) * Math.sin(TAU * 60 * inBeat) : 0;
    const halfBeat = (i % (beat / 2)) / sr;
    const hat = halfBeat < 0.03 ? 0.15 * Math.exp(-halfBeat * 150) * (rnd() * 2 - 1) : 0;
    const noise = 0.01 * (rnd() * 2 - 1);
    const c = vocal + bass + kick;
    lL[i] = c + padL + hat * 0.8 + noise;
    lR[i] = c + padR + hat * 0.4 + noise;
  }
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  for (let off = 0; off < total; off += loopLen) {
    const n = Math.min(loopLen, total - off);
    L.set(n === loopLen ? lL : lL.subarray(0, n), off);
    R.set(n === loopLen ? lR : lR.subarray(0, n), off);
  }
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const g = 0.9 / peak;
  for (let i = 0; i < total; i++) { L[i] *= g; R[i] *= g; }
  return [L, R];
}

async function main() {
  const which = process.argv[2];
  const run = {
    baseline: (ch, hooks) => separateChannelsBaseline(ch, SAMPLE_RATE, hooks, { consumeInput: true }),
    fast: (ch, hooks) => separateChannels(ch, SAMPLE_RATE, hooks, { mode: 'fast', consumeInput: true }),
    high: (ch, hooks) => separateChannels(ch, SAMPLE_RATE, hooks, { mode: 'high', consumeInput: true }),
  }[which];
  if (!run) throw new Error(`unknown separator "${which}" (expected baseline|fast|high)`);
  if (typeof globalThis.gc !== 'function') throw new Error('run with node --expose-gc');

  let channels = synthesize();
  globalThis.gc();
  globalThis.gc();
  const used = () => {
    const m = process.memoryUsage();
    return m.heapUsed + m.arrayBuffers;
  };
  const start = used();
  let peak = start;
  const sample = () => { const u = used(); if (u > peak) peak = u; };
  const timer = setInterval(sample, 50);
  timer.unref();

  const wavs = [];
  const hooks = {
    onProgress: () => { sample(); },
    onStem: (id, chs) => {
      sample();
      wavs.push(encodeWav(chs, SAMPLE_RATE));
      sample();
    },
  };
  const input = channels;
  channels = null;
  const t0 = performance.now();
  await run(input, hooks);
  const ms = performance.now() - t0;
  sample();
  clearInterval(timer);
  if (wavs.length !== 8) throw new Error(`expected 8 stems, got ${wavs.length}`);
  process.stdout.write(JSON.stringify({ which, ms: Math.round(ms), peakBytes: peak - start }) + '\n');
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
