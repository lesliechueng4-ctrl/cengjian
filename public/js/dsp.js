// Pure DSP helpers working on Float32Array. No DOM access, so this module can be
// imported by the browser (main thread or Web Worker) and by Node tests.

// ---------------------------------------------------------------------------
// FFT (iterative radix-2, in place)
// ---------------------------------------------------------------------------

const twiddleCache = new Map();

function getTwiddles(n) {
  let t = twiddleCache.get(n);
  if (!t) {
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    const rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    t = { cos, sin, rev };
    twiddleCache.set(n, t);
  }
  return t;
}

export function isPowerOfTwo(n) {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * In-place complex FFT. `re` and `im` must have the same power-of-two length.
 * When `inverse` is true the result is scaled by 1/n.
 */
export function fft(re, im, inverse = false) {
  const n = re.length;
  if (!isPowerOfTwo(n) || im.length !== n) throw new Error('fft: length must be a power of two');
  const { cos, sin, rev } = getTwiddles(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sign * sin[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

export function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// ---------------------------------------------------------------------------
// STFT / ISTFT (Hann analysis + Hann synthesis, weighted overlap-add)
// Frame t starts at sample t * hop - n so that every sample is covered by a
// full set of overlapping windows.
// ---------------------------------------------------------------------------

export function stft(x, n = 2048, hop = 512) {
  const bins = n / 2 + 1;
  const length = x.length;
  const frames = Math.floor((length - 1 + n) / hop) + 1;
  const w = hann(n);
  const re = new Float32Array(frames * bins);
  const im = new Float32Array(frames * bins);
  const fr = new Float64Array(n);
  const fi = new Float64Array(n);
  for (let t = 0; t < frames; t++) {
    const s = t * hop - n;
    for (let i = 0; i < n; i++) {
      const idx = s + i;
      fr[i] = idx >= 0 && idx < length ? x[idx] * w[i] : 0;
      fi[i] = 0;
    }
    fft(fr, fi);
    const off = t * bins;
    for (let k = 0; k < bins; k++) { re[off + k] = fr[k]; im[off + k] = fi[k]; }
  }
  return { re, im, frames, bins, n, hop, length };
}

export function istft(spec, length = spec.length) {
  const { re, im, frames, bins, n, hop } = spec;
  const w = hann(n);
  const y = new Float32Array(length);
  const wsum = new Float32Array(length);
  const fr = new Float64Array(n);
  const fi = new Float64Array(n);
  for (let t = 0; t < frames; t++) {
    const off = t * bins;
    for (let k = 0; k < bins; k++) { fr[k] = re[off + k]; fi[k] = im[off + k]; }
    for (let k = bins; k < n; k++) { fr[k] = fr[n - k]; fi[k] = -fi[n - k]; }
    fft(fr, fi, true);
    const s = t * hop - n;
    for (let i = 0; i < n; i++) {
      const idx = s + i;
      if (idx >= 0 && idx < length) {
        y[idx] += fr[i] * w[i];
        wsum[idx] += w[i] * w[i];
      }
    }
  }
  for (let i = 0; i < length; i++) if (wsum[i] > 1e-8) y[i] /= wsum[i];
  return y;
}

/** STFT of two real signals at once using one complex FFT per frame. */
export function stftPair(x, y, n = 2048, hop = 512) {
  const bins = n / 2 + 1;
  const length = x.length;
  const frames = Math.floor((length - 1 + n) / hop) + 1;
  const w = hann(n);
  const a = { re: new Float32Array(frames * bins), im: new Float32Array(frames * bins), frames, bins, n, hop, length };
  const b = { re: new Float32Array(frames * bins), im: new Float32Array(frames * bins), frames, bins, n, hop, length };
  const fr = new Float64Array(n);
  const fi = new Float64Array(n);
  for (let t = 0; t < frames; t++) {
    const s = t * hop - n;
    for (let i = 0; i < n; i++) {
      const idx = s + i;
      const inside = idx >= 0 && idx < length;
      fr[i] = inside ? x[idx] * w[i] : 0;
      fi[i] = inside ? y[idx] * w[i] : 0;
    }
    fft(fr, fi);
    const off = t * bins;
    for (let k = 0; k < bins; k++) {
      const j = (n - k) % n;
      a.re[off + k] = (fr[k] + fr[j]) / 2;
      a.im[off + k] = (fi[k] - fi[j]) / 2;
      b.re[off + k] = (fi[k] + fi[j]) / 2;
      b.im[off + k] = (fr[j] - fr[k]) / 2;
    }
  }
  return [a, b];
}

/** Inverse of stftPair: two spectra synthesised with one complex IFFT per frame. */
export function istftPair(sa, sb, length = sa.length) {
  const { frames, bins, n, hop } = sa;
  const w = hann(n);
  const ya = new Float32Array(length);
  const yb = new Float32Array(length);
  const wsum = new Float32Array(length);
  const fr = new Float64Array(n);
  const fi = new Float64Array(n);
  for (let t = 0; t < frames; t++) {
    const off = t * bins;
    for (let k = 0; k < bins; k++) {
      fr[k] = sa.re[off + k] - sb.im[off + k];
      fi[k] = sa.im[off + k] + sb.re[off + k];
    }
    for (let k = bins; k < n; k++) {
      const j = off + n - k;
      fr[k] = sa.re[j] + sb.im[j];
      fi[k] = -sa.im[j] + sb.re[j];
    }
    fft(fr, fi, true);
    const s = t * hop - n;
    for (let i = 0; i < n; i++) {
      const idx = s + i;
      if (idx >= 0 && idx < length) {
        ya[idx] += fr[i] * w[i];
        yb[idx] += fi[i] * w[i];
        wsum[idx] += w[i] * w[i];
      }
    }
  }
  for (let i = 0; i < length; i++) {
    if (wsum[i] > 1e-8) { ya[i] /= wsum[i]; yb[i] /= wsum[i]; }
  }
  return [ya, yb];
}

export function magnitude(spec) {
  const { re, im } = spec;
  const m = new Float32Array(re.length);
  for (let i = 0; i < re.length; i++) m[i] = Math.hypot(re[i], im[i]);
  return m;
}

// ---------------------------------------------------------------------------
// Segmented spectral processing. Long signals are processed in segments with
// enough padding that the result equals processing the whole signal at once,
// while keeping memory small and allowing progress reports between segments.
// kernel(specs) receives one STFT per input and returns an array of output
// spectra (same frames/bins layout).
// ---------------------------------------------------------------------------

function sliceZero(x, start, end) {
  const out = new Float32Array(end - start);
  const a = Math.max(0, start);
  const b = Math.min(x.length, end);
  if (b > a) out.set(x.subarray(a, b), a - start);
  return out;
}

export async function processSegments(inputs, numOutputs, opts, kernel, onProgress) {
  const n = opts.n ?? 2048;
  const hop = opts.hop ?? 512;
  const contextFrames = opts.contextFrames ?? 16;
  const segment = opts.segment ?? hop * 256;
  const len = inputs[0].length;
  const pad = n + contextFrames * hop;
  const outputs = Array.from({ length: numOutputs }, () => new Float32Array(len));
  for (let start = 0; start < len; start += segment) {
    const end = Math.min(len, start + segment);
    // Align the segment origin to the hop grid so frames match a whole-signal STFT.
    const s0 = start - pad - ((start - pad) % hop + hop) % hop;
    const e0 = end + pad;
    const slices = inputs.map((x) => sliceZero(x, s0, e0));
    const specs = [];
    for (let k = 0; k < slices.length; k += 2) {
      if (k + 1 < slices.length) specs.push(...stftPair(slices[k], slices[k + 1], n, hop));
      else specs.push(stft(slices[k], n, hop));
    }
    const outSpecs = kernel(specs);
    const put = (k, y) => outputs[k].set(y.subarray(start - s0, end - s0), start);
    for (let k = 0; k < numOutputs; k += 2) {
      if (k + 1 < numOutputs) {
        const [ya, yb] = istftPair(outSpecs[k], outSpecs[k + 1], e0 - s0);
        put(k, ya); put(k + 1, yb);
      } else {
        put(k, istft(outSpecs[k], e0 - s0));
      }
    }
    if (onProgress) await onProgress(end / len);
  }
  return outputs;
}

// ---------------------------------------------------------------------------
// Median filtering and harmonic / percussive separation (HPSS)
// Fitzgerald 2010 median filtering with Driedger-style margin so that a third
// "residual" part (neither clearly tonal nor clearly transient) remains.
// ---------------------------------------------------------------------------

function medianOf(buf, k) {
  // insertion sort on a small scratch buffer
  for (let i = 1; i < k; i++) {
    const v = buf[i];
    let j = i - 1;
    while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; }
    buf[j + 1] = v;
  }
  return buf[k >> 1];
}

/** Sliding median of a 1-D array with odd kernel size, zero padded at edges. */
export function medianFilter(x, k, out = new Float32Array(x.length)) {
  const n = x.length;
  const half = k >> 1;
  const at = (idx) => (idx >= 0 && idx < n ? x[idx] : 0);
  // Sorted window, updated incrementally: remove the outgoing value, insert the incoming one.
  const win = new Float32Array(k);
  for (let j = 0; j < k; j++) win[j] = at(j - half);
  medianOf(win, k);
  for (let i = 0; i < n; i++) {
    out[i] = win[half];
    if (i + 1 >= n) break;
    const outgoing = at(i - half);
    const incoming = at(i + half + 1);
    if (outgoing === incoming) continue;
    let p = 0;
    while (p < k - 1 && win[p] !== outgoing) p++;
    if (incoming > outgoing) {
      while (p < k - 1 && win[p + 1] < incoming) { win[p] = win[p + 1]; p++; }
    } else {
      while (p > 0 && win[p - 1] > incoming) { win[p] = win[p - 1]; p--; }
    }
    win[p] = incoming;
  }
  return out;
}

/**
 * Soft HPSS masks from a magnitude spectrogram laid out as [frame * bins + bin].
 * Returns { H, P, R } masks that sum to 1 per bin.
 */
export function hpssMasks(mag, frames, bins, opts = {}) {
  const kTime = opts.kTime ?? 13;
  const kFreq = opts.kFreq ?? 13;
  const beta = opts.beta ?? 1.5;
  const size = frames * bins;
  const harm = new Float32Array(size);
  const perc = new Float32Array(size);
  const col = new Float32Array(frames);
  for (let b = 0; b < bins; b++) {
    for (let t = 0; t < frames; t++) col[t] = mag[t * bins + b];
    const m = medianFilter(col, kTime);
    for (let t = 0; t < frames; t++) harm[t * bins + b] = m[t];
  }
  for (let t = 0; t < frames; t++) {
    const m = medianFilter(mag.subarray(t * bins, (t + 1) * bins), kFreq);
    perc.set(m, t * bins);
  }
  const H = new Float32Array(size);
  const P = new Float32Array(size);
  const R = new Float32Array(size);
  const b2 = beta * beta;
  for (let i = 0; i < size; i++) {
    const h2 = harm[i] * harm[i];
    const p2 = perc[i] * perc[i];
    const eps = 1e-12;
    const hm = h2 / (h2 + b2 * p2 + eps);
    const pm = p2 / (p2 + b2 * h2 + eps);
    H[i] = hm;
    P[i] = pm;
    R[i] = Math.max(0, 1 - hm - pm);
  }
  return { H, P, R };
}

export function applyMask(spec, mask) {
  const re = new Float32Array(spec.re.length);
  const im = new Float32Array(spec.im.length);
  for (let i = 0; i < re.length; i++) { re[i] = spec.re[i] * mask[i]; im[i] = spec.im[i] * mask[i]; }
  return { ...spec, re, im };
}

/** Separate a mono signal into harmonic, percussive and residual parts. */
export async function hpss(x, opts = {}, onProgress) {
  const [harmonic, percussive, residual] = await processSegments([x], 3, opts, ([spec]) => {
    const m = hpssMasks(magnitude(spec), spec.frames, spec.bins, opts);
    return [applyMask(spec, m.H), applyMask(spec, m.P), applyMask(spec, m.R)];
  }, onProgress);
  return { harmonic, percussive, residual };
}

// ---------------------------------------------------------------------------
// Stereo helpers: mid / side and spectral center extraction
// ---------------------------------------------------------------------------

export function toMidSide(L, R) {
  const mid = new Float32Array(L.length);
  const side = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) { mid[i] = (L[i] + R[i]) / 2; side[i] = (L[i] - R[i]) / 2; }
  return { mid, side };
}

export function fromMidSide(mid, side) {
  const L = new Float32Array(mid.length);
  const R = new Float32Array(mid.length);
  for (let i = 0; i < mid.length; i++) { L[i] = mid[i] + side[i]; R[i] = mid[i] - side[i]; }
  return { L, R };
}

/**
 * Inter-channel similarity mask (Avendano and Jot 2002): 1 for bins that are
 * identical in L and R (panned to center), 0 for bins present in one side only.
 */
export function centerMask(specL, specR, sharpness = 4) {
  const size = specL.re.length;
  const m = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const lr = specL.re[i], li = specL.im[i], rr = specR.re[i], ri = specR.im[i];
    const cross = Math.hypot(lr * rr + li * ri, li * rr - lr * ri);
    const pl = lr * lr + li * li;
    const pr = rr * rr + ri * ri;
    const psi = pl + pr > 1e-12 ? (2 * cross) / (pl + pr) : 0;
    m[i] = Math.pow(psi, sharpness);
  }
  return m;
}

/**
 * Split a stereo pair into a center (mono) estimate and the left / right
 * residuals with the center removed (center cancellation).
 */
export async function extractCenter(L, R, opts = {}, onProgress) {
  const sharpness = opts.sharpness ?? 4;
  const [center, left, right] = await processSegments([L, R], 3, opts, ([sl, sr]) => {
    const m = centerMask(sl, sr, sharpness);
    const size = sl.re.length;
    const c = { ...sl, re: new Float32Array(size), im: new Float32Array(size) };
    const l = { ...sl, re: new Float32Array(size), im: new Float32Array(size) };
    const r = { ...sl, re: new Float32Array(size), im: new Float32Array(size) };
    for (let i = 0; i < size; i++) {
      const cr = ((sl.re[i] + sr.re[i]) / 2) * m[i];
      const ci = ((sl.im[i] + sr.im[i]) / 2) * m[i];
      c.re[i] = cr; c.im[i] = ci;
      l.re[i] = sl.re[i] - cr; l.im[i] = sl.im[i] - ci;
      r.re[i] = sr.re[i] - cr; r.im[i] = sr.im[i] - ci;
    }
    return [c, l, r];
  }, onProgress);
  return { center, left, right };
}

// ---------------------------------------------------------------------------
// Biquad filters (RBJ Audio EQ Cookbook)
// ---------------------------------------------------------------------------

export function biquadCoeffs(type, freq, sampleRate, q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * Math.min(freq, sampleRate * 0.49)) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0, b1, b2;
  const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  switch (type) {
    case 'lowpass':
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2; break;
    case 'highpass':
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2; break;
    case 'bandpass': // constant 0 dB peak gain
      b0 = alpha; b1 = 0; b2 = -alpha; break;
    default:
      throw new Error(`biquad: unknown type ${type}`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function applyBiquad(x, c) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    y[i] = y0;
  }
  return y;
}

/** Zero-phase filtering (forward then backward) so filtered stems stay aligned. */
export function filtfilt(x, c) {
  const y = applyBiquad(x, c).reverse();
  return applyBiquad(y, c).reverse();
}

export function lowpass(x, freq, sampleRate, q) {
  return filtfilt(x, biquadCoeffs('lowpass', freq, sampleRate, q));
}

export function highpass(x, freq, sampleRate, q) {
  return filtfilt(x, biquadCoeffs('highpass', freq, sampleRate, q));
}

export function bandpass(x, low, high, sampleRate) {
  return lowpass(highpass(x, low, sampleRate), high, sampleRate);
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return x.length ? Math.sqrt(s / x.length) : 0;
}

/** Scale channels so their joint RMS equals `target`, never exceeding `maxGain`. */
export function normalizeRms(channels, target = 0.1, maxGain = 4) {
  let s = 0, n = 0;
  for (const ch of channels) { for (let i = 0; i < ch.length; i++) s += ch[i] * ch[i]; n += ch.length; }
  const cur = n ? Math.sqrt(s / n) : 0;
  if (cur < 1e-9) return channels;
  const g = Math.min(maxGain, target / cur);
  return channels.map((ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = ch[i] * g;
    return out;
  });
}

export function subtract(a, b) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] - b[i];
  return out;
}

/**
 * Estimate tempo from an onset-strength envelope (positive log-energy flux)
 * using autocorrelation over 60 to 200 BPM with a mild preference around 120.
 */
export function estimateBpm(samples, sampleRate, opts = {}) {
  const hop = opts.hop ?? 256;
  const win = opts.win ?? 1024;
  const minBpm = opts.minBpm ?? 60;
  const maxBpm = opts.maxBpm ?? 200;
  const frames = Math.floor((samples.length - win) / hop);
  if (frames < 8) return 0;
  const energy = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    let s = 0;
    const off = t * hop;
    for (let i = 0; i < win; i++) { const v = samples[off + i]; s += v * v; }
    energy[t] = Math.log(1e-10 + s / win);
  }
  const onset = new Float32Array(frames);
  let mean = 0;
  for (let t = 1; t < frames; t++) { onset[t] = Math.max(0, energy[t] - energy[t - 1]); mean += onset[t]; }
  mean /= frames;
  for (let t = 0; t < frames; t++) onset[t] -= mean;
  const frameRate = sampleRate / hop;
  const minLag = Math.max(1, Math.floor((60 * frameRate) / maxBpm));
  const maxLag = Math.min(frames - 1, Math.ceil((60 * frameRate) / minBpm));
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1 && lag < frames; lag++) {
    if (lag < 1) continue;
    let s = 0;
    for (let t = lag; t < frames; t++) s += onset[t] * onset[t - lag];
    ac[lag] = s / (frames - lag);
  }
  let best = -1, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * frameRate) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 1.0, 2));
    const score = ac[lag] * prior;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  if (best < 0 || bestScore <= 0) return 0;
  // parabolic interpolation around the peak
  let lag = best;
  const a = ac[best - 1] ?? 0, b = ac[best], c = ac[best + 1] ?? 0;
  const denom = a - 2 * b + c;
  if (Math.abs(denom) > 1e-12) lag = best + (0.5 * (a - c)) / denom;
  return Math.round(((60 * frameRate) / lag) * 10) / 10;
}
// ---------------------------------------------------------------------------
// Separation helpers (atomic mask partition, design 6.2 / 6.8)
// ---------------------------------------------------------------------------

/**
 * Scale all channels together by 0.98 / peak when their joint peak exceeds 1.
 * Returns the input array unchanged otherwise. Never mutates the inputs; a
 * channel array that appears more than once (e.g. fx = [s, s]) is scaled once
 * and shared in the output the same way.
 */
export function limitPeak(channels) {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
  }
  if (!(peak > 1)) return channels;
  const g = 0.98 / peak;
  const done = new Map();
  return channels.map((ch) => {
    if (done.has(ch)) return done.get(ch);
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = ch[i] * g;
    done.set(ch, out);
    return out;
  });
}

/**
 * Phase-aware center / side masks. With psi = 2·Re(L·conj(R)) / (|L|² + |R|²):
 *   C = max(0, psi)^sharpness   (in phase 1, anti-phase 0, one side only 0)
 *   S = 1 − max(0, psi)
 * When smoothFrames > 0 the cross and auto spectra are averaged over ±N frames
 * (per bin) before the ratio is taken. Silent bins get C = 0, S = 1.
 */
export function centerMaskPhase(specL, specR, sharpness = 4, smoothFrames = 0) {
  const size = specL.re.length;
  const bins = specL.bins ?? size;
  const frames = specL.frames ?? Math.floor(size / bins);
  const C = new Float32Array(size);
  const S = new Float32Array(size);
  const lre = specL.re, lim = specL.im, rre = specR.re, rim = specR.im;
  const N = Math.max(0, Math.floor(smoothFrames));
  const finish = (i, cross, pow) => {
    let psi = pow > 1e-12 ? (2 * cross) / pow : 0;
    if (psi < 0) psi = 0; else if (psi > 1) psi = 1;
    C[i] = Math.pow(psi, sharpness);
    S[i] = 1 - psi;
  };
  if (N === 0) {
    for (let i = 0; i < size; i++) {
      const lr = lre[i], li = lim[i], rr = rre[i], ri = rim[i];
      finish(i, lr * rr + li * ri, lr * lr + li * li + rr * rr + ri * ri);
    }
    return { C, S };
  }
  const cross = new Float64Array(frames);
  const pow = new Float64Array(frames);
  for (let b = 0; b < bins; b++) {
    for (let t = 0; t < frames; t++) {
      const i = t * bins + b;
      const lr = lre[i], li = lim[i], rr = rre[i], ri = rim[i];
      cross[t] = lr * rr + li * ri;
      pow[t] = lr * lr + li * li + rr * rr + ri * ri;
    }
    // sliding sum over [t − N, t + N]
    let sc = 0, sp = 0;
    for (let t = 0; t <= Math.min(N, frames - 1); t++) { sc += cross[t]; sp += pow[t]; }
    for (let t = 0; t < frames; t++) {
      finish(t * bins + b, sc, sp);
      const add = t + N + 1, drop = t - N;
      if (add < frames) { sc += cross[add]; sp += pow[add]; }
      if (drop >= 0) { sc -= cross[drop]; sp -= pow[drop]; }
    }
  }
  return { C, S };
}

/** hi(f, f0) for one frequency: cos² ramp on log2 f from f0·2^(−1/6) (0) to f0·2^(1/6) (1). */
function rampHi(f, f0) {
  if (!(f > 0) || !(f0 > 0)) return f0 > 0 ? 0 : 1;
  const x = Math.log2(f / f0);
  if (x <= -1 / 6) return 0;
  if (x >= 1 / 6) return 1;
  const c = Math.cos((Math.PI / 2) * (x + 1 / 6) * 3); // 1 → 0 across the ramp
  return 1 - c * c;
}

/**
 * Frequency ramp of length `bins` (bin k at k·binHz). rising = true gives
 * hi(f, f0) (0 below f0·2^(−1/6), 1 above f0·2^(1/6), cos² in between on a
 * log2 axis); rising = false gives lo(f, f0) = 1 − hi(f, f0).
 */
export function freqRamp(bins, binHz, f0, rising = true) {
  const out = new Float32Array(bins);
  for (let k = 0; k < bins; k++) {
    const h = rampHi(k * binHz, f0);
    out[k] = rising ? h : 1 - h;
  }
  return out;
}


/**
 * Combine HPSS soft masks with frequency / spatial weights into atomic masks
 * (design 6.2). All masks are laid out as [frame * bins + bin].
 *
 * groups:
 *   frames, bins, binHz         layout and bin spacing (Hz)
 *   Mh, Mp, Mr                  harmonic / percussive / residual soft masks.
 *                               Any may be omitted (treated as 0, Mr defaults to
 *                               max(0, 1 − Mh − Mp)); the three are normalised to
 *                               sum to 1 per point (all ~0 → Mr = 1).
 *   band   Float32Array(bins)   vocal band weight; omitted → no V atom weight
 *   Cv     number | Float32Array(size)  vocal center cue (default 1)
 *   fc     number | Float32Array(frames) bass crossover in Hz (default 250)
 *   S      Float32Array(size)   side-ness from centerMaskPhase; null = mono
 *   fxHz = 1500, percHz = 5000, monoFxHz = 6000
 *   renormalize = true          when true, non-V atoms are returned as
 *                               M'_j = M_j / Σ_{k≠V} M_k (to be applied to
 *                               Y_c = X_c − V); denominator < 1e-9 → M'_O = 1
 *                               (or M'_Rem = 1 without an O atom).
 *
 * Atoms returned: V, B, H when Mh is given; D, T, F, O when Mp or Mr is given;
 * with Mh given and neither Mp nor Mr, the non-harmonic part is a single atom
 * Rem = 1 − Mh (High_Quality_Mode stage 1). With renormalize = false all
 * returned masks are non-negative and sum to 1 per point; with renormalize =
 * true the non-V atoms sum to 1 per point and V is unchanged.
 */
export function partitionMasks(groups) {
  const { frames, bins, binHz } = groups;
  const size = frames * bins;
  const { Mh, Mp, band, Cv, fc, S } = groups;
  const MrIn = groups.Mr;
  const mono = !S;
  const fxHz = groups.fxHz ?? 1500;
  const percHz = groups.percHz ?? 5000;
  const monoFxHz = groups.monoFxHz ?? 6000;
  const renormalize = groups.renormalize !== false;
  const harmonic = !!Mh;
  const restOnly = harmonic && !Mp && !MrIn;
  const split = !restOnly;

  const hiFx = freqRamp(bins, binHz, fxHz, true);
  const hiPerc = freqRamp(bins, binHz, percHz, true);
  const hiMonoFx = freqRamp(bins, binHz, monoFxHz, true);
  const fcScalar = fc == null || typeof fc === 'number';
  const loBass = fcScalar ? freqRamp(bins, binHz, fc ?? 250, false) : new Float32Array(bins);

  const out = {};
  if (harmonic) { out.V = new Float32Array(size); out.B = new Float32Array(size); out.H = new Float32Array(size); }
  if (split) {
    out.D = new Float32Array(size); out.T = new Float32Array(size);
    out.F = new Float32Array(size); out.O = new Float32Array(size);
  } else {
    out.Rem = new Float32Array(size);
  }

  const oV = out.V, oB = out.B, oH = out.H, oD = out.D, oT = out.T, oF = out.F, oO = out.O, oRem = out.Rem;
  // Cv (number or per-point array, default 1) resolved once so the hot loop
  // stays monomorphic; a per-point helper call here cost ~5× the whole loop.
  const cvArr = Cv != null && typeof Cv !== 'number' ? Cv : null;
  const cvNum = typeof Cv === 'number' ? Cv : 1;
  for (let t = 0; t < frames; t++) {
    if (!fcScalar) {
      const f0 = fc[t];
      for (let k = 0; k < bins; k++) loBass[k] = 1 - rampHi(k * binHz, f0);
    }
    for (let k = 0; k < bins; k++) {
      const i = t * bins + k;
      let h = Mh ? Math.max(0, Mh[i]) : 0;
      let p = Mp ? Math.max(0, Mp[i]) : 0;
      let r = MrIn ? Math.max(0, MrIn[i]) : Math.max(0, 1 - h - p);
      const tot = h + p + r;
      if (tot > 1e-12) { h /= tot; p /= tot; r /= tot; } else { h = 0; p = 0; r = 1; }

      if (harmonic) {
        let wv = band ? band[k] * (cvArr ? cvArr[i] : cvNum) : 0;
        if (!(wv > 0)) wv = 0; else if (wv > 1) wv = 1;
        const wb = (1 - wv) * loBass[k];
        const wh = Math.max(0, 1 - wv - wb);
        oV[i] = h * wv;
        oB[i] = h * wb;
        oH[i] = h * wh;
      }
      if (split) {
        let sideW = 0;
        if (!mono) { const s = Math.min(1, Math.max(0, S[i])); sideW = s * s; }
        const wfP = mono ? 0 : sideW * hiFx[k];
        const wt = (1 - wfP) * hiPerc[k];
        const wd = Math.max(0, 1 - wfP - wt);
        const wfR = mono ? hiMonoFx[k] : sideW * hiFx[k];
        oD[i] = p * wd;
        oT[i] = p * wt;
        oF[i] = p * wfP + r * wfR;
        oO[i] = r * (1 - wfR);
      } else {
        oRem[i] = p + r;
      }

      if (renormalize) {
        if (harmonic) {
          // Σ_{k≠V} M_k computed explicitly to avoid drift
          let d = oB[i] + oH[i];
          d += split ? oD[i] + oT[i] + oF[i] + oO[i] : oRem[i];
          if (d < 1e-9) {
            oB[i] = 0; oH[i] = 0;
            if (split) { oD[i] = 0; oT[i] = 0; oF[i] = 0; oO[i] = 1; } else oRem[i] = 1;
          } else {
            const g = 1 / d;
            oB[i] *= g; oH[i] *= g;
            if (split) { oD[i] *= g; oT[i] *= g; oF[i] *= g; oO[i] *= g; } else oRem[i] *= g;
          }
        }
      }
    }
  }
  return out;
}

/** Default coefficients for bassCrossover (design 6.3); tuned on the Benchmark_Set. */
export const BASS_CROSSOVER_DEFAULTS = Object.freeze({
  factor: 2.2,
  min: 150,
  max: 320,
  fallback: 250,
  radius: 8,
  loHz: 30,
  hiHz: 300,
  minEnergy: 1e-10,
});

/**
 * Adaptive per-frame bass crossover (design 6.3):
 *   E_t(k) = Σ_{|τ|≤radius} Mh(t+τ,k)·magAvg(t+τ,k)²   for f_k ∈ [loHz, hiHz]
 *   f̄_t = Σ f_k·E_t(k) / Σ E_t(k),  fc_t = clamp(factor·f̄_t, min, max)
 * Σ E_t < minEnergy gives fc_t = fallback. Mh may be null (treated as 1).
 * Each frame depends only on ±radius frames. Returns Float32Array(frames) in Hz.
 */
export function bassCrossover(Mh, magAvg, frames, bins, binHz, opts = {}) {
  const o = { ...BASS_CROSSOVER_DEFAULTS, ...opts };
  const R = Math.max(0, Math.floor(o.radius));
  const k0 = Math.max(0, Math.ceil(o.loHz / binHz));
  const k1 = Math.min(bins - 1, Math.floor(o.hiHz / binHz));
  // per-frame weighted sums; the windowed sums are then sliding sums over frames
  const num = new Float64Array(frames);
  const den = new Float64Array(frames);
  for (let t = 0; t < frames; t++) {
    let a = 0, d = 0;
    for (let k = k0; k <= k1; k++) {
      const i = t * bins + k;
      const m = magAvg[i];
      const e = (Mh ? Math.max(0, Mh[i]) : 1) * m * m;
      a += k * binHz * e;
      d += e;
    }
    num[t] = a; den[t] = d;
  }
  const fc = new Float32Array(frames);
  for (let t = 0; t < frames; t++) {
    // direct window sum (no running sum) so the result is exact and order-independent
    let a = 0, d = 0;
    const lo = Math.max(0, t - R), hi = Math.min(frames - 1, t + R);
    for (let u = lo; u <= hi; u++) { a += num[u]; d += den[u]; }
    if (!(d >= o.minEnergy)) { fc[t] = o.fallback; continue; }
    const f = o.factor * (a / d);
    fc[t] = f < o.min ? o.min : f > o.max ? o.max : f;
  }
  return fc;
}

/**
 * Long time median: per bin, take every `step`-th frame (frames t ≡ 0 mod step),
 * run a k-point median along that decimated axis (zero padded, k forced odd),
 * then linearly interpolate back to every frame (frames past the last grid
 * point hold its value). Output frame t depends on frames within
 * ±((k >> 1) + 1)·step. For segment independence the segment origin must lie
 * on the same step grid (processSegments origins are hop-aligned; with
 * step = 2 and even contextFrames + n/hop the grid matches).
 */
export function decimatedTimeMedian(mag, frames, bins, k, step = 2) {
  const s = Math.max(1, Math.floor(step));
  let kk = Math.max(1, Math.floor(k));
  if (kk % 2 === 0) kk += 1;
  const out = new Float32Array(frames * bins);
  if (frames === 0 || bins === 0) return out;
  const D = Math.ceil(frames / s);
  const sub = new Float32Array(D);
  const med = new Float32Array(D);
  for (let b = 0; b < bins; b++) {
    for (let g = 0; g < D; g++) sub[g] = mag[g * s * bins + b];
    medianFilter(sub, kk, med);
    for (let g = 0; g < D; g++) {
      const t0 = g * s;
      const v0 = med[g];
      if (g + 1 < D) {
        const v1 = med[g + 1];
        for (let j = 0; j < s; j++) out[(t0 + j) * bins + b] = v0 + (v1 - v0) * (j / s);
      } else {
        for (let t = t0; t < frames; t++) out[t * bins + b] = v0;
      }
    }
  }
  return out;
}

/**
 * One Wiener refinement pass (design 6.5). For each atom j:
 *   v_j = box3×3( Σ_c |M_j·X_c|² )   (mean over ±1 frame, ±1 bin, edges use
 *                                    the available neighbours)
 *   M_j ← v_j / Σ_k v_k
 * Where Σ_k v_k is ~0 the original masks are kept, so masks that summed to 1
 * still sum to 1. `masks` is an object or array of Float32Array atom masks,
 * updated in place (and returned); `specs` is an array of channel spectra
 * { re, im } that the atoms apply to (X_c or Y_c = X_c − V).
 */
export function wienerRefine(masks, specs, frames, bins) {
  const list = Array.isArray(masks) ? masks : Object.values(masks);
  const size = frames * bins;
  if (list.length === 0 || size === 0) return masks;
  // channel power P = Σ_c |X_c|²
  const P = new Float32Array(size);
  for (const sp of specs) {
    const re = sp.re, im = sp.im;
    for (let i = 0; i < size; i++) P[i] += re[i] * re[i] + im[i] * im[i];
  }
  const tmp = new Float32Array(size);
  const powers = list.map((M) => {
    // frequency pass: tmp = Σ_{|δk|≤1} M²·P
    for (let t = 0; t < frames; t++) {
      const r = t * bins;
      for (let k = 0; k < bins; k++) {
        let acc = 0;
        for (let d = -1; d <= 1; d++) {
          const kk = k + d;
          if (kk < 0 || kk >= bins) continue;
          const m = M[r + kk];
          acc += m * m * P[r + kk];
        }
        tmp[r + k] = acc;
      }
    }
    // time pass
    const v = new Float32Array(size);
    for (let t = 0; t < frames; t++) {
      const t0 = Math.max(0, t - 1), t1 = Math.min(frames - 1, t + 1);
      const r = t * bins;
      for (let k = 0; k < bins; k++) {
        let acc = 0;
        for (let u = t0; u <= t1; u++) acc += tmp[u * bins + k];
        v[r + k] = acc;
      }
    }
    return v;
  });
  // The box mean's divisor is common to all atoms at a point, so plain sums give the same ratio.
  const J = list.length;
  for (let i = 0; i < size; i++) {
    let sum = 0;
    for (let j = 0; j < J; j++) sum += powers[j][i];
    if (!(sum > 1e-30)) continue;
    const g = 1 / sum;
    for (let j = 0; j < J; j++) list[j][i] = powers[j][i] * g;
  }
  return masks;
}
