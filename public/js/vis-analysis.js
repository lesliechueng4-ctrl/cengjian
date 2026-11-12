// Vis_Analyzer: pure functions that turn one decoded Stem into its loudness
// envelope (100 Hz, Uint8 0..255) and onset frame indices. No DOM access and no
// side effects on import, so it runs in the browser (main thread or Worker) and
// in Node tests.

import { ONSET_STEM_IDS } from './vis-data.js';
import { lowpass, highpass } from './dsp.js';

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

// ---------- Marks: Kick / Snare / Hi-hat hits and bass notes ----------
//
// A hit is a peak of a band-limited loudness curve that rises clearly out of the
// dip before it (peak prominence), so a second hit is found even while the first
// one still rings. Loudness curves use 2 ms steps; results are 100 Hz frame indices.

export const MARK_STEP_SEC = 0.002;
const MARK_SILENCE = 1e-4;
export const SNARE_MIN_LEVEL = 0.45; // of the 1–6 kHz band's 99.5th percentile
export const BASS_ON_LEVEL = 0.2;    // a bass note starts above 20% of the bass's peak level ...
export const BASS_OFF_LEVEL = 0.1;   // ... and ends below 10%

function monoOf(channels) {
  const chans = channels.filter(Boolean);
  const n = chans.length ? Math.min(...chans.map((c) => c.length)) : 0;
  const out = new Float32Array(n);
  if (n === 0) return out;
  for (const ch of chans) for (let i = 0; i < n; i++) out[i] += ch[i];
  if (chans.length > 1) for (let i = 0; i < n; i++) out[i] /= chans.length;
  return out;
}

/** Block RMS of x every `step` samples, smoothed with a 5-tap window. */
export function bandEnvelope(x, step) {
  const n = Math.floor(x.length / step);
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    const from = i * step;
    for (let j = from; j < from + step; j++) s += x[j] * x[j];
    raw[i] = Math.sqrt(s / step);
  }
  const w = [0.25, 0.75, 1, 0.75, 0.25];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j >= 0 && j < n) s += raw[j] * w[k + 2];
    }
    out[i] = s / 3;
  }
  return out;
}

function movingAverage(a, width) {
  const n = a.length;
  const out = new Float32Array(n);
  const half = Math.floor(width / 2);
  let sum = 0;
  let lo = 0;
  let hi = 0; // window [lo, hi)
  for (let i = 0; i < n; i++) {
    const to = Math.min(n, i + half + 1);
    const from = Math.max(0, i - half);
    while (hi < to) sum += a[hi++];
    while (lo < from) sum -= a[lo++];
    out[i] = sum / (hi - lo);
  }
  return out;
}

function percentile(a, p) {
  if (a.length === 0) return 0;
  const s = Float32Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

/**
 * Local maxima of `a` with prominence >= minProm and >= relProm * height, at
 * least minDist apart (taller peaks win). The prominence search looks at most
 * `walk` steps to each side. Returns indices in increasing order.
 * @returns {number[]}
 */
export function prominentPeaks(a, { minProm, relProm = 0, minDist = 1, walk = 250 }) {
  const n = a.length;
  const cand = [];
  for (let i = 1; i < n - 1; i++) {
    const v = a[i];
    if (!(v > a[i - 1] && v >= a[i + 1])) continue;
    let lmin = v;
    for (let j = i - 1; j >= Math.max(0, i - walk); j--) {
      if (a[j] > v) break;
      if (a[j] < lmin) lmin = a[j];
    }
    let rmin = v;
    for (let j = i + 1; j <= Math.min(n - 1, i + walk); j++) {
      if (a[j] > v) break;
      if (a[j] < rmin) rmin = a[j];
    }
    const prom = v - Math.max(lmin, rmin);
    if (prom >= minProm && prom >= relProm * v) cand.push(i);
  }
  cand.sort((p, q) => a[q] - a[p] || p - q);
  const taken = new Uint8Array(n);
  const out = [];
  for (const i of cand) {
    if (taken[i]) continue;
    out.push(i);
    for (let j = Math.max(0, i - minDist + 1); j <= Math.min(n - 1, i + minDist - 1); j++) taken[j] = 1;
  }
  return out.sort((p, q) => p - q);
}

/** Step of the steepest rise in the `back` steps before peak q: where the hit starts. */
function riseBefore(a, q, back) {
  let best = q;
  let bestD = -Infinity;
  for (let j = Math.max(1, q - back); j <= q; j++) {
    const d = a[j] - a[j - 1];
    if (d > bestD) { bestD = d; best = j; }
  }
  return best;
}

function toFrames(steps, stepSec, frames) {
  const out = [];
  let prev = -1;
  for (const s of steps) {
    const f = Math.min(frames - 1, Math.max(0, Math.round(s * stepSec * 100)));
    if (f > prev) { out.push(f); prev = f; }
  }
  return Int32Array.from(out);
}

function nearAny(sortedSteps, s, tol) {
  let lo = 0;
  let hi = sortedSteps.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedSteps[mid] < s - tol) lo = mid + 1;
    else hi = mid;
  }
  return lo < sortedSteps.length && sortedSteps[lo] <= s + tol;
}

/**
 * Kick (30–120 Hz), Snare / Clap (1–6 kHz, at least 45% of that band's peak level) and
 * Hi-hat (above 8 kHz; hats that coincide with a snare are dropped) hits of a
 * drum Stem, as 100 Hz frame indices.
 * @returns {{ K: Int32Array, S: Int32Array, H: Int32Array }}
 */
export function detectDrumHits(channels, sampleRate) {
  const empty = () => ({ K: new Int32Array(0), S: new Int32Array(0), H: new Int32Array(0) });
  const x = monoOf(channels);
  if (x.length === 0 || !(sampleRate > 0)) return empty();
  const step = Math.max(1, Math.round(sampleRate * MARK_STEP_SEC));
  const stepSec = step / sampleRate;
  const frames = Math.ceil((x.length * 100) / sampleRate);
  const steps = (sec) => Math.max(1, Math.round(sec / stepSec));
  const pick = (env, minRel, relProm, distSec, backSec) => {
    const top = percentile(env, 99.5);
    if (top < MARK_SILENCE) return { peaks: [], starts: [] };
    const peaks = prominentPeaks(env, { minProm: minRel * top, relProm, minDist: steps(distSec) });
    return { peaks, starts: peaks.map((q) => riseBefore(env, q, steps(backSec))) };
  };

  const lo = bandEnvelope(lowpass(highpass(x, 30, sampleRate), 120, sampleRate), step);
  const k = pick(lo, 0.2, 0.5, 0.09, 0.03);

  const mid = bandEnvelope(lowpass(highpass(x, 1000, sampleRate), 6000, sampleRate), step);
  const sAll = pick(mid, 0.25, 0.5, 0.09, 0.02);
  const midTop = percentile(mid, 99.5);
  // A kick or an open hat also leaks into this band, but far below the snares that set the band's peak level.
  const sStarts = sAll.starts.filter((_, i) => mid[sAll.peaks[i]] >= SNARE_MIN_LEVEL * midTop);

  const hi = bandEnvelope(highpass(x, 8000, sampleRate), step);
  const hAll = pick(hi, 0.08, 0.5, 0.045, 0.02);
  const hStarts = hAll.starts.filter((s) => !nearAny(sStarts, s, steps(0.03)));

  return {
    K: toFrames(k.starts, stepSec, frames),
    S: toFrames(sStarts, stepSec, frames),
    H: toFrames(hStarts, stepSec, frames),
  };
}

/**
 * Bass notes: where each one starts (B) and how long it sounds (BL), in 100 Hz
 * frames. A note starts when the loudness (below 400 Hz) rises above 20% of the
 * stem's peak level and ends when it falls below 10%; a clear new attack while
 * the previous note still sounds starts a new note at the dip between the two.
 * @returns {{ B: Int32Array, BL: Int32Array }}
 */
export function detectBassNotes(channels, sampleRate) {
  const x = monoOf(channels);
  if (x.length === 0 || !(sampleRate > 0)) return { B: new Int32Array(0), BL: new Int32Array(0) };
  const step = Math.max(1, Math.round(sampleRate * MARK_STEP_SEC));
  const stepSec = step / sampleRate;
  const frames = Math.ceil((x.length * 100) / sampleRate);
  const steps = (sec) => Math.max(1, Math.round(sec / stepSec));
  // Averaged over 24 ms so one cycle of a low note does not look like several hits.
  const env = movingAverage(bandEnvelope(lowpass(x, 400, sampleRate), step), steps(0.024));
  const top = percentile(env, 99.5);
  if (top < MARK_SILENCE) return { B: new Int32Array(0), BL: new Int32Array(0) };
  const on = BASS_ON_LEVEL * top;
  const off = BASS_OFF_LEVEL * top;
  const peaks = prominentPeaks(env, { minProm: 0.15 * top, relProm: 0.3, minDist: steps(0.1) });
  const B = [];
  const BL = [];
  let prev = -1;
  const add = (from, to) => {
    const f0 = Math.min(frames - 1, Math.max(0, Math.round(from * stepSec * 100)));
    if (f0 <= prev) return;
    B.push(f0);
    BL.push(Math.min(frames, Math.max(f0 + 1, Math.round(to * stepSec * 100))) - f0);
    prev = f0;
  };
  let pi = 0;
  let i = 0;
  while (i < env.length) {
    if (env[i] < on) { i++; continue; }
    // One sounding stretch [a, b): from the first step above `on` until the level falls below `off`.
    const a = i;
    let b = i;
    while (b < env.length && env[b] >= off) b++;
    // Re-attacks inside the stretch: split at the lowest point between two prominent peaks.
    while (pi < peaks.length && peaks[pi] < a) pi++;
    let from = a;
    let last = -1;
    for (; pi < peaks.length && peaks[pi] < b; pi++) {
      if (last >= 0) {
        let cut = last;
        for (let j = last; j <= peaks[pi]; j++) if (env[j] < env[cut]) cut = j;
        add(from, cut);
        from = cut;
      }
      last = peaks[pi];
    }
    add(from, b);
    i = b;
  }
  return { B: Int32Array.from(B), BL: Int32Array.from(BL) };
}

/**
 * Analysis of one Stem. `marks` is only present for drums ({ K, S, H }) and
 * bass ({ B, BL }).
 * @param {string} id
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @returns {{ env: Uint8Array, onsets: Int32Array|null, duration: number, marks?: object }}
 */
export function analyzeStem(id, channels, sampleRate) {
  const rms = frameRms(channels, sampleRate);
  const chans = channels.filter(Boolean);
  const n = chans.length ? Math.min(...chans.map((c) => c.length)) : 0;
  const out = {
    env: envelopeFromRms(rms),
    onsets: ONSET_STEMS.has(id) ? detectOnsets(rms) : null,
    duration: sampleRate > 0 ? n / sampleRate : 0,
  };
  if (id === 'drums') out.marks = detectDrumHits(channels, sampleRate);
  else if (id === 'bass') out.marks = detectBassNotes(channels, sampleRate);
  return out;
}
