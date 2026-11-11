// Vis_Analyzer: pure functions that turn one decoded Stem into its loudness
// envelope (100 Hz, Uint8 0..255) and onset frame indices. No DOM access and no
// side effects on import, so it runs in the browser (main thread or Worker) and
// in Node tests.

import { ONSET_STEM_IDS } from './vis-data.js';

const ONSET_STEMS = new Set(ONSET_STEM_IDS);

export const SILENCE_RMS = 1e-4;
export const ONSET_RISE_DB = 6;          // rise relative to the mean level of the previous 5 frames
export const ONSET_GATE = 0.05;          // frame RMS must be at least 5% of the stem's max RMS
export const ONSET_LOOKBACK_FRAMES = 5;  // 50 ms
const PEAK_RADIUS = 2;                   // rise[i] must be the max of [i-2, i+2]
const DB_FLOOR = 1e-9;

/**
 * Per-frame RMS over all channels (sum of squares pooled across channels).
 * Frame i covers samples [floor(i*sr/fr), min(n, floor((i+1)*sr/fr))).
 * Frame count = ceil(n * fr / sr); n = 0 gives an empty array.
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {number} [frameRate=100]
 * @returns {Float64Array}
 */
export function frameRms(channels, sampleRate, frameRate = 100) {
  const chans = channels.filter(Boolean);
  const n = chans.length ? Math.min(...chans.map((c) => c.length)) : 0;
  if (n === 0 || !(sampleRate > 0)) return new Float64Array(0);
  const frames = Math.ceil((n * frameRate) / sampleRate);
  const out = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    const start = Math.floor((i * sampleRate) / frameRate);
    const end = Math.min(n, Math.floor(((i + 1) * sampleRate) / frameRate));
    const count = (end - start) * chans.length;
    if (count <= 0) continue;
    let sum = 0;
    for (const ch of chans) {
      for (let s = start; s < end; s++) sum += ch[s] * ch[s];
    }
    out[i] = Math.sqrt(sum / count);
  }
  return out;
}

function maxOf(arr) {
  let m = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return m;
}

/**
 * Envelope: env[i] = round(255 * sqrt(rms[i] / max)); all zeros when max < SILENCE_RMS.
 * @param {ArrayLike<number>} rms
 * @returns {Uint8Array}
 */
export function envelopeFromRms(rms) {
  const env = new Uint8Array(rms.length);
  const max = maxOf(rms);
  if (max < SILENCE_RMS) return env;
  for (let i = 0; i < rms.length; i++) {
    const v = Math.round(255 * Math.sqrt(rms[i] / max));
    env[i] = v > 255 ? 255 : v < 0 ? 0 : v;
  }
  return env;
}

/**
 * Onset frame indices (strictly increasing, gaps >= minGapFrames).
 *   db[i]   = 20*log10(rms[i] + 1e-9)
 *   rise[i] = db[i] - mean(db[i-5 .. i-1])  (fewer frames near the start;
 *             i = 0 uses db[0] - 20*log10(1e-9))
 *   candidate: rise[i] >= 6 dB, rms[i] >= 5% of max, and rise[i] is the maximum
 *              over the frames in [i-2, i+2] that also pass the 5% gate (ties go
 *              to the earliest frame). Gated-out neighbours are ignored, so a
 *              jump that starts at the very end of a frame (huge rise, rms just
 *              under the gate) does not suppress the next, gated-in frame.
 * Candidates are accepted in order; one closer than minGapFrames to the last
 * accepted frame is dropped. Silent stems (max < SILENCE_RMS) return [].
 * @param {ArrayLike<number>} rms
 * @param {{ minGapFrames?: number }} [opts]
 * @returns {Int32Array}
 */
export function detectOnsets(rms, { minGapFrames = 5 } = {}) {
  const frames = rms.length;
  const max = maxOf(rms);
  if (frames === 0 || max < SILENCE_RMS) return new Int32Array(0);
  const floorDb = 20 * Math.log10(DB_FLOOR);
  const db = new Float64Array(frames);
  for (let i = 0; i < frames; i++) db[i] = 20 * Math.log10(rms[i] + DB_FLOOR);
  const rise = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    if (i === 0) {
      rise[i] = db[0] - floorDb;
      continue;
    }
    const from = Math.max(0, i - ONSET_LOOKBACK_FRAMES);
    let sum = 0;
    for (let j = from; j < i; j++) sum += db[j];
    rise[i] = db[i] - sum / (i - from);
  }
  const gate = ONSET_GATE * max;
  const out = [];
  let last = -Infinity;
  for (let i = 0; i < frames; i++) {
    if (rise[i] < ONSET_RISE_DB || rms[i] < gate) continue;
    let isPeak = true;
    for (let j = Math.max(0, i - PEAK_RADIUS); j <= Math.min(frames - 1, i + PEAK_RADIUS); j++) {
      if (j === i || rms[j] < gate) continue; // gated-out neighbours can't win the peak
      if (j < i ? rise[j] >= rise[i] : rise[j] > rise[i]) { isPeak = false; break; }
    }
    if (!isPeak) continue;
    if (i - last < minGapFrames) continue;
    out.push(i);
    last = i;
  }
  return Int32Array.from(out);
}

/**
 * Analysis of one Stem.
 * @param {string} id
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @returns {{ env: Uint8Array, onsets: Int32Array|null, duration: number }}
 */
export function analyzeStem(id, channels, sampleRate) {
  const rms = frameRms(channels, sampleRate);
  const chans = channels.filter(Boolean);
  const n = chans.length ? Math.min(...chans.map((c) => c.length)) : 0;
  return {
    env: envelopeFromRms(rms),
    onsets: ONSET_STEMS.has(id) ? detectOnsets(rms) : null,
    duration: sampleRate > 0 ? n / sampleRate : 0,
  };
}
