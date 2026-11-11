import test from 'node:test';
import assert from 'node:assert/strict';
import {
  frameRms,
  envelopeFromRms,
  detectOnsets,
  analyzeStem,
  SILENCE_RMS,
  ONSET_RISE_DB,
  ONSET_GATE,
  ONSET_LOOKBACK_FRAMES,
} from '../public/js/vis-analysis.js';
import { forAll, gen, mulberry32 } from './helpers/prop.mjs';

const RATES = [22050, 44100, 48000];
const MIN_GAP = 5;

// ---- reference implementations (straight from the definitions) ----

function refRms(channels, sr) {
  const n = channels.length ? Math.min(...channels.map((c) => c.length)) : 0;
  const frames = Math.ceil((n * 100) / sr);
  const out = [];
  for (let i = 0; i < frames; i++) {
    const a = Math.floor((i * sr) / 100);
    const b = Math.min(n, Math.floor(((i + 1) * sr) / 100));
    let sum = 0;
    for (const ch of channels) for (let s = a; s < b; s++) sum += ch[s] * ch[s];
    out.push(b > a ? Math.sqrt(sum / ((b - a) * channels.length)) : 0);
  }
  return out;
}

function refEnvelope(rms) {
  const max = rms.reduce((m, v) => Math.max(m, v), 0);
  if (max < 1e-4) return rms.map(() => 0);
  return rms.map((v) => Math.round(255 * Math.sqrt(v / max)));
}

function refRise(rms) {
  const db = Array.from(rms, (v) => 20 * Math.log10(v + 1e-9));
  return db.map((d, i) => {
    if (i === 0) return d - 20 * Math.log10(1e-9);
    const from = Math.max(0, i - 5);
    let sum = 0;
    for (let j = from; j < i; j++) sum += db[j];
    return d - sum / (i - from);
  });
}

// ---- generators ----

/** Random noise with silent gaps; mode picks loud / weak (< 1e-4) / silent. */
function noiseChannels(rng, nch, n, amp) {
  const chans = [];
  for (let c = 0; c < nch; c++) {
    const x = new Float32Array(n);
    let i = 0;
    while (i < n) {
      const len = 1 + Math.floor(rng() * 4000);
      const silent = rng() < 0.3;
      const g = amp * (0.05 + rng());
      for (let k = 0; k < len && i < n; k++, i++) x[i] = silent ? 0 : g * (rng() * 2 - 1);
    }
    chans.push(x);
  }
  return chans;
}

const stemInput = (rng) => {
  const sr = RATES[Math.floor(rng() * RATES.length)];
  const nch = 1 + Math.floor(rng() * 2);
  // Mostly short signals to keep runtime low; occasionally up to 3 s.
  const seconds = rng() < 0.1 ? rng() * 3 : rng() * 0.4;
  const n = rng() < 0.05 ? 0 : Math.floor(seconds * sr);
  const mode = gen.oneOf('loud', 'loud', 'weak', 'silent')(rng);
  const amp = mode === 'loud' ? 0.9 : mode === 'weak' ? 8e-5 : 0;
  return { sr, mode, channels: noiseChannels(rng, nch, n, amp) };
};

// Feature: stem-visualizer, Property 1: Envelope 模型
test('Property 1: Envelope 模型', async () => {
  await forAll(stemInput, ({ sr, channels }) => {
    const n = channels[0].length;
    const a = analyzeStem('vocal', channels, sr);
    const b = analyzeStem('vocal', channels, sr);
    assert.ok(a.env instanceof Uint8Array);
    assert.equal(a.env.length, Math.ceil((n * 100) / sr));
    const rms = refRms(channels, sr);
    assert.deepEqual(Array.from(a.env), refEnvelope(rms));
    const maxRms = rms.reduce((m, v) => Math.max(m, v), 0);
    if (maxRms >= 1e-4) assert.equal(Math.max(...a.env), 255);
    else assert.ok(a.env.every((v) => v === 0));
    assert.deepEqual(Buffer.from(a.env), Buffer.from(b.env));
  });
});

// Feature: stem-visualizer, Property 2: Envelope 缩放不变
test('Property 2: Envelope 缩放不变', async () => {
  const input = (rng) => {
    const sr = RATES[Math.floor(rng() * RATES.length)];
    const nch = 1 + Math.floor(rng() * 2);
    const n = 1 + Math.floor(rng() * 0.4 * sr);
    const k = gen.float(0.1, 10)(rng);
    return { sr, k, channels: noiseChannels(rng, nch, n, 0.9) };
  };
  let checked = 0;
  await forAll(input, ({ sr, k, channels }) => {
    const rms = frameRms(channels, sr);
    if (Math.max(...rms) < 1e-3) return; // precondition: max RMS >= 1e-3
    checked++;
    const scaled = channels.map((c) => Float32Array.from(c, (v) => v * k));
    const e1 = envelopeFromRms(rms);
    const e2 = envelopeFromRms(frameRms(scaled, sr));
    assert.equal(e2.length, e1.length);
    for (let i = 0; i < e1.length; i++) {
      assert.ok(Math.abs(e1[i] - e2[i]) <= 1, `frame ${i}: ${e1[i]} vs ${e2[i]} (k=${k})`);
    }
  });
  assert.ok(checked >= 80, `only ${checked} runs met the precondition`);
});

// Feature: stem-visualizer, Property 3: Onset 不变式
test('Property 3: Onset 不变式', async () => {
  const rmsSeq = (rng) => {
    const frames = Math.floor(rng() * 400);
    const scale = rng() < 0.15 ? 5e-5 : 1; // some sequences are entirely below SILENCE_RMS
    const out = new Float64Array(frames);
    let i = 0;
    while (i < frames) {
      const kind = Math.floor(rng() * 4);
      const len = 1 + Math.floor(rng() * 40);
      const level = scale * rng();
      for (let k = 0; k < len && i < frames; k++, i++) {
        if (kind === 0) out[i] = 0;                                   // silence
        else if (kind === 1) out[i] = level * rng();                  // noise
        else if (kind === 2) out[i] = level;                          // step
        else out[i] = k === 0 ? level : scale * 1e-3 * rng();          // single-frame spike
      }
    }
    return out;
  };
  await forAll(rmsSeq, (rms) => {
    const on = detectOnsets(rms);
    assert.ok(on instanceof Int32Array);
    const max = rms.reduce((m, v) => Math.max(m, v), 0);
    if (max < SILENCE_RMS) {
      assert.equal(on.length, 0);
      return;
    }
    const rise = refRise(rms);
    for (let j = 0; j < on.length; j++) {
      const i = on[j];
      assert.ok(i >= 0 && i < rms.length, `index ${i} out of range`);
      if (j > 0) assert.ok(i - on[j - 1] >= MIN_GAP, `gap ${on[j - 1]} -> ${i}`);
      assert.ok(rise[i] >= ONSET_RISE_DB, `rise[${i}] = ${rise[i]}`);
      assert.ok(rms[i] >= ONSET_GATE * max, `rms[${i}] below gate`);
    }
  });
});

// Feature: stem-visualizer, Property 4: Onset 定位
test('Property 4: Onset 定位', async () => {
  const TAU = 0.03;
  const input = (rng) => {
    const sr = RATES[Math.floor(rng() * RATES.length)];
    const count = 1 + Math.floor(rng() * 20);
    const times = [];
    let t = 0.05 + rng() * 0.1;
    for (let j = 0; j < count; j++) {
      times.push(t);
      t += 0.15 + rng() * 0.1;
    }
    const amps = times.map(() => 0.2 + rng() * 0.8);
    const end = times[times.length - 1] + 0.1 + rng() * 0.1;
    return { sr, times, amps, end, seed: Math.floor(rng() * 2 ** 32) };
  };
  await forAll(input, ({ sr, times, amps, end, seed }) => {
    const noise = mulberry32(seed);
    const n = Math.floor(end * sr);
    const x = new Float32Array(n);
    const starts = times.map((t) => Math.round(t * sr));
    for (let j = 0; j < starts.length; j++) {
      const stop = j + 1 < starts.length ? starts[j + 1] : n;
      for (let s = starts[j]; s < stop; s++) {
        x[s] = amps[j] * (noise() * 2 - 1) * Math.exp(-(s - starts[j]) / sr / TAU);
      }
    }
    const on = analyzeStem('drums', [x], sr).onsets;
    assert.equal(on.length, times.length, `onsets ${Array.from(on)} for times ${times.map((t) => t.toFixed(4))}`);
    for (let j = 0; j < on.length; j++) {
      const err = Math.abs(on[j] / 100 - starts[j] / sr);
      assert.ok(err <= 0.02 + 1e-9, `onset ${j}: frame ${on[j]} vs ${starts[j] / sr}s (err ${err})`);
    }
  });
});

// ---- examples ----

test('frameRms: mono, 22050 Hz, length not a multiple of the frame size', () => {
  const sr = 22050;
  const x = new Float32Array(500).fill(0.5); // frames: [0,220) [220,441) [441,500)
  const rms = frameRms([x], sr);
  assert.equal(rms.length, 3);
  for (const v of rms) assert.ok(Math.abs(v - 0.5) < 1e-7);
});

test('frameRms: stereo pools both channels', () => {
  const l = new Float32Array(441).fill(1);
  const r = new Float32Array(441);
  const rms = frameRms([l, r], 44100);
  assert.equal(rms.length, 1);
  assert.ok(Math.abs(rms[0] - Math.SQRT1_2) < 1e-12);
});

test('analyzeStem: silence, empty input, onsets only for Onset_Stem', () => {
  const silent = analyzeStem('drums', [new Float32Array(4410)], 44100);
  assert.equal(silent.env.length, 10);
  assert.ok(silent.env.every((v) => v === 0));
  assert.equal(silent.onsets.length, 0);
  assert.equal(silent.duration, 0.1);

  const empty = analyzeStem('bass', [new Float32Array(0)], 48000);
  assert.equal(empty.env.length, 0);
  assert.equal(empty.onsets, null);
  assert.equal(empty.duration, 0);

  for (const id of ['drums', 'perc', 'fx', 'other']) {
    assert.ok(analyzeStem(id, [new Float32Array(100)], 44100).onsets instanceof Int32Array);
  }
  for (const id of ['vocal', 'bass', 'inst', 'harmony']) {
    assert.equal(analyzeStem(id, [new Float32Array(100)], 44100).onsets, null);
  }
  assert.equal(ONSET_LOOKBACK_FRAMES, 5);
});
