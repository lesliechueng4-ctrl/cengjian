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
