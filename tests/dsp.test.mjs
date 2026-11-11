import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fft, stft, istft, lowpass, highpass, rms, extractCenter, hpss, estimateBpm,
  biquadCoeffs, applyBiquad, processSegments, toMidSide, fromMidSide, medianFilter, stftPair, istftPair,
} from '../public/js/dsp.js';
import {
  separateChannels, separationLimitMessage, SEPARATION_LIMITS, STEMS,
} from '../public/js/separator.js';

const SR = 44100;

function sine(freq, seconds, amp = 0.5, sr = SR) {
  const x = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return x;
}

function clickTrack(bpm, seconds, sr = SR) {
  const x = new Float32Array(Math.round(seconds * sr));
  const period = Math.round((60 / bpm) * sr);
  for (let s = 0; s < x.length; s += period) {
    for (let i = 0; i < 200 && s + i < x.length; i++) x[s + i] = (Math.random() * 2 - 1) * Math.exp(-i / 40);
  }
  return x;
}

function maxAbsDiff(a, b, from = 0, to = a.length) {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

// Interior range avoids filter edge effects.
const mid = (x) => x.subarray(Math.floor(x.length * 0.2), Math.floor(x.length * 0.8));

test('fft then inverse fft reproduces the input', () => {
  const n = 1024;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const orig = new Float64Array(n);
  for (let i = 0; i < n; i++) { re[i] = Math.random() * 2 - 1; orig[i] = re[i]; }
  fft(re, im);
  fft(re, im, true);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(re[i] - orig[i]) < 1e-9);
    assert.ok(Math.abs(im[i]) < 1e-9);
  }
});

test('fft of a pure tone peaks at the right bin', () => {
  const n = 256;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 10 * i) / n);
  fft(re, im);
  const mag = Array.from(re, (r, i) => Math.hypot(r, im[i]));
  assert.ok(Math.abs(mag[10] - n / 2) < 1e-6);
  assert.ok(mag[11] < 1e-6);
});

test('stft then istft reconstructs the signal', () => {
  const x = new Float32Array(10000);
  for (let i = 0; i < x.length; i++) x[i] = Math.random() * 2 - 1;
  const y = istft(stft(x, 1024, 256), x.length);
  assert.ok(maxAbsDiff(x, y) < 1e-4, `max diff ${maxAbsDiff(x, y)}`);
});

test('segmented processing with identity kernel reconstructs the signal', async () => {
  const x = new Float32Array(50000);
  for (let i = 0; i < x.length; i++) x[i] = Math.random() * 2 - 1;
  const [y] = await processSegments([x], 1, { n: 1024, hop: 256, segment: 4096 }, (s) => [s[0]]);
  assert.ok(maxAbsDiff(x, y) < 1e-4);
});

test('sliding median filter matches a brute force median', () => {
  const x = new Float32Array(500);
  for (let i = 0; i < x.length; i++) x[i] = Math.round(Math.random() * 20) / 4;
  for (const k of [3, 9, 13]) {
    const got = medianFilter(x, k);
    const half = k >> 1;
    for (let i = 0; i < x.length; i++) {
      const w = [];
      for (let j = i - half; j <= i + half; j++) w.push(j >= 0 && j < x.length ? x[j] : 0);
      w.sort((a, b) => a - b);
      assert.equal(got[i], w[half], `k=${k} i=${i}`);
    }
  }
});

test('paired stft matches single stft and paired istft reconstructs both signals', () => {
  const x = new Float32Array(6000).map(() => Math.random() * 2 - 1);
  const y = new Float32Array(6000).map(() => Math.random() * 2 - 1);
  const [sx, sy] = stftPair(x, y, 512, 128);
  const ref = stft(x, 512, 128);
  assert.ok(maxAbsDiff(sx.re, ref.re) < 1e-3 && maxAbsDiff(sx.im, ref.im) < 1e-3);
  const [rx, ry] = istftPair(sx, sy, x.length);
  assert.ok(maxAbsDiff(x, rx) < 1e-4);
  assert.ok(maxAbsDiff(y, ry) < 1e-4);
});

test('segmented processing with three inputs and outputs reconstructs each', async () => {
  const xs = [0, 1, 2].map(() => new Float32Array(30000).map(() => Math.random() * 2 - 1));
  const ys = await processSegments(xs, 3, { n: 1024, hop: 256, segment: 5000 }, (s) => s);
  for (let k = 0; k < 3; k++) assert.ok(maxAbsDiff(xs[k], ys[k]) < 1e-4);
});

test('mid/side round trip', () => {
  const L = sine(300, 0.1);
  const R = sine(500, 0.1);
  const { mid: m, side } = toMidSide(L, R);
  const back = fromMidSide(m, side);
  assert.ok(maxAbsDiff(L, back.L) < 1e-6);
  assert.ok(maxAbsDiff(R, back.R) < 1e-6);
});

test('lowpass keeps 100 Hz and strongly attenuates 5 kHz', () => {
  const low = lowpass(sine(100, 1), 500, SR);
  const high = lowpass(sine(5000, 1), 500, SR);
  const lowGain = rms(mid(low)) / rms(mid(sine(100, 1)));
  const highGain = rms(mid(high)) / rms(mid(sine(5000, 1)));
  assert.ok(lowGain > 0.9, `low gain ${lowGain}`);
  assert.ok(highGain < 0.02, `high gain ${highGain}`);
});

test('highpass does the opposite of lowpass', () => {
  const low = highpass(sine(100, 1), 2000, SR);
  const high = highpass(sine(8000, 1), 2000, SR);
  assert.ok(rms(mid(low)) < 0.01);
  assert.ok(rms(mid(high)) > 0.3);
});

test('biquad bandpass has unity gain at its center frequency', () => {
  const c = biquadCoeffs('bandpass', 1000, SR, 2);
  const y = applyBiquad(sine(1000, 1), c);
  const g = rms(mid(y)) / rms(mid(sine(1000, 1)));
  assert.ok(Math.abs(g - 1) < 0.05, `gain ${g}`);
});

test('center extraction cancels a centered sine and keeps a left-only sine', async () => {
  const centered = sine(440, 1, 0.4);
  const leftOnly = sine(1500, 1, 0.4);
  const L = new Float32Array(centered.length);
  const R = new Float32Array(centered.length);
  for (let i = 0; i < L.length; i++) { L[i] = centered[i] + leftOnly[i]; R[i] = centered[i]; }
  const { center, left, right } = await extractCenter(L, R);
  // residual left channel should be close to the left-only sine
  const errLeft = rms(mid(Float32Array.from(left, (v, i) => v - leftOnly[i])));
  assert.ok(errLeft < 0.05 * rms(leftOnly), `left residual error ${errLeft}`);
  // centered content removed from right channel
  assert.ok(rms(mid(right)) < 0.05 * rms(centered), `right residual ${rms(mid(right))}`);
  const errCenter = rms(mid(Float32Array.from(center, (v, i) => v - centered[i])));
  assert.ok(errCenter < 0.1 * rms(centered), `center error ${errCenter}`);
});

test('HPSS puts a steady sine in harmonic and an impulse train in percussive', async () => {
  const tone = sine(600, 2, 0.3);
  const harm = await hpss(tone);
  assert.ok(rms(mid(harm.harmonic)) > 0.9 * rms(mid(tone)));
  assert.ok(rms(mid(harm.percussive)) < 0.1 * rms(mid(tone)));

  const clicks = new Float32Array(2 * SR);
  for (let s = 0; s < clicks.length; s += 11025) clicks[s] = 1;
  const perc = await hpss(clicks);
  const total = rms(clicks);
  assert.ok(rms(perc.percussive) > 0.85 * total, `perc ${rms(perc.percussive) / total}`);
  assert.ok(rms(perc.harmonic) < 0.15 * total, `harm ${rms(perc.harmonic) / total}`);
});

test('estimateBpm finds 120 BPM on a click track', () => {
  const bpm = estimateBpm(clickTrack(120, 12), SR);
  assert.ok(Math.abs(bpm - 120) <= 2, `bpm ${bpm}`);
});

test('estimateBpm finds 95 BPM on a click track', () => {
  const bpm = estimateBpm(clickTrack(95, 15), SR);
  assert.ok(Math.abs(bpm - 95) <= 2, `bpm ${bpm}`);
});

test('separateChannels emits every stem except the original', async () => {
  const sr = 22050;
  const voice = sine(440, 2, 0.3, sr);
  const bass = sine(80, 2, 0.3, sr);
  const drums = clickTrack(120, 2, sr);
  const L = new Float32Array(voice.length);
  const R = new Float32Array(voice.length);
  for (let i = 0; i < L.length; i++) {
    L[i] = voice[i] + bass[i] * 0.8 + drums[i] * 0.5;
    R[i] = voice[i] + bass[i] * 0.4 + drums[i] * 0.2;
  }
  const got = {};
  let lastProgress = 0;
  const { bpm } = await separateChannels([L, R], sr, {
    onProgress: (p) => { assert.ok(p >= lastProgress - 1e-9); lastProgress = p; },
    onStem: (id, chs) => { got[id] = chs; },
  });
  assert.ok(Number.isFinite(bpm));
  assert.ok(Math.abs(lastProgress - 1) < 1e-9);
  const expected = STEMS.map((s) => s.id).filter((id) => id !== 'original').sort();
  assert.deepEqual(Object.keys(got).sort(), expected);
  for (const chs of Object.values(got)) {
    assert.equal(chs.length, 2);
    assert.equal(chs[0].length, L.length);
    assert.ok(chs[0].every(Number.isFinite));
  }
  // centered 440 Hz tone dominates the vocal stem, and is reduced in the instrumental
  assert.ok(rms(mid(got.vocal[0])) > 0.5 * rms(voice));
  // bass stem mostly holds the 80 Hz tone (energy far above the vocal tone leakage)
  assert.ok(rms(mid(got.bass[0])) > 0.2);
});

test('效果音 stem stays audible when summed to mono', async () => {
  const sr = 22050;
  const n = sr * 2;
  // high-frequency noise panned hard left: pure side content above 1.5 kHz
  let seed = 12345;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    L[i] = ((seed / 2 ** 32) - 0.5) * 0.4;
  }
  const hf = highpass(highpass(L, 3000, sr), 3000, sr);
  const got = {};
  await separateChannels([hf, R], sr, { onStem: (id, chs) => { got[id] = chs; } });
  const [fl, fr] = got.fx;
  const monoSum = new Float32Array(fl.length);
  for (let i = 0; i < fl.length; i++) monoSum[i] = (fl[i] + fr[i]) / 2;
  assert.ok(rms(mid(fl)) > 0.01, `fx level ${rms(mid(fl))}`);
  assert.ok(rms(mid(monoSum)) > 0.9 * rms(mid(fl)), `mono ${rms(mid(monoSum))} vs ${rms(mid(fl))}`);
});

test('separationLimitMessage refuses long or huge files, tighter on phones', () => {
  assert.equal(separationLimitMessage({ duration: 4 * 60, mobile: true }), '');
  assert.match(separationLimitMessage({ duration: 7 * 60, mobile: true }), /6 分钟/);
  assert.equal(separationLimitMessage({ duration: 7 * 60, mobile: false }), '');
  assert.match(separationLimitMessage({ duration: 16 * 60, mobile: false }), /15 分钟/);
  assert.match(separationLimitMessage({ bytes: SEPARATION_LIMITS.mobile.bytes + 1, mobile: true }), /500 MB/);
  assert.equal(separationLimitMessage({ bytes: SEPARATION_LIMITS.mobile.bytes + 1, mobile: false }), '');
});

test('separateChannels handles mono input', async () => {
  const x = sine(300, 1, 0.3, 22050);
  const got = {};
  await separateChannels([x], 22050, { onStem: (id, chs) => { got[id] = chs; } });
  assert.equal(Object.keys(got).length, 8);
  for (const chs of Object.values(got)) assert.equal(chs.length, 1);
});

// ---------------------------------------------------------------------------
// separation-accuracy helpers (Requirements 9.1, 9.2, 10.4)
// ---------------------------------------------------------------------------

import {
  limitPeak, centerMaskPhase, freqRamp, partitionMasks, BASS_CROSSOVER_DEFAULTS,
  bassCrossover, decimatedTimeMedian, wienerRefine,
} from '../public/js/dsp.js';

function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function randArray(n, rand, lo = 0, hi = 1) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = lo + (hi - lo) * rand();
  return a;
}

function assertPartition(masks, keys, size, eps = 1e-5) {
  for (let i = 0; i < size; i++) {
    let sum = 0;
    for (const k of keys) {
      const v = masks[k][i];
      assert.ok(v >= 0 && Number.isFinite(v), `${k}[${i}] = ${v} must be non-negative`);
      sum += v;
    }
    assert.ok(Math.abs(sum - 1) < eps, `sum at ${i} = ${sum}`);
  }
}

test('centerMaskPhase: L = R gives C = 1, S = 0; L = -R and R = 0 give C = 0, S = 1', () => {
  const rand = rng(3);
  const n = 64;
  const re = randArray(n, rand, -1, 1);
  const im = randArray(n, rand, -1, 1);
  const L = { re, im };
  const same = centerMaskPhase(L, { re, im });
  const negRe = re.map((v) => -v), negIm = im.map((v) => -v);
  const anti = centerMaskPhase(L, { re: negRe, im: negIm });
  const zero = centerMaskPhase(L, { re: new Float32Array(n), im: new Float32Array(n) });
  const silent = centerMaskPhase({ re: new Float32Array(n), im: new Float32Array(n) },
    { re: new Float32Array(n), im: new Float32Array(n) });
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(same.C[i] - 1) < 1e-5 && Math.abs(same.S[i]) < 1e-5);
    assert.equal(anti.C[i], 0); assert.equal(anti.S[i], 1);
    assert.equal(zero.C[i], 0); assert.equal(zero.S[i], 1);
    assert.equal(silent.C[i], 0); assert.equal(silent.S[i], 1);
  }
  // smoothed variant keeps the same extremes
  const frames = 8, bins = 8;
  const sm = centerMaskPhase({ re, im, frames, bins }, { re, im, frames, bins }, 4, 2);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(sm.C[i] - 1) < 1e-5);
});

test('freqRamp: rising ramp goes 0 → 1 monotonically, falling ramp is its complement', () => {
  const bins = 1025, binHz = SR / 2048, f0 = 1500;
  const hi = freqRamp(bins, binHz, f0, true);
  const lo = freqRamp(bins, binHz, f0, false);
  assert.equal(hi[0], 0);
  assert.equal(hi[bins - 1], 1);
  assert.equal(lo[0], 1);
  assert.equal(lo[bins - 1], 0);
  for (let k = 1; k < bins; k++) {
    assert.ok(hi[k] >= hi[k - 1], `not monotone at ${k}`);
    assert.ok(Math.abs(hi[k] + lo[k] - 1) < 1e-6);
  }
  // 0 below f0·2^(-1/6), 1 above f0·2^(1/6)
  for (let k = 0; k < bins; k++) {
    const f = k * binHz;
    if (f <= f0 * 2 ** (-1 / 6)) assert.equal(hi[k], 0);
    if (f >= f0 * 2 ** (1 / 6)) assert.equal(hi[k], 1);
  }
});

test('partitionMasks: masks are non-negative and sum to 1 per point', () => {
  const rand = rng(7);
  const frames = 6, bins = 129, binHz = SR / 256, size = frames * bins;
  const Mh = randArray(size, rand), Mp = randArray(size, rand), Mr = randArray(size, rand);
  const band = freqRamp(bins, binHz, 300, true);
  const Cv = randArray(size, rand);
  const S = randArray(size, rand);
  const fc = randArray(frames, rand, 150, 320);
  const all = ['V', 'B', 'H', 'D', 'T', 'F', 'O'];
  const nonV = ['B', 'H', 'D', 'T', 'F', 'O'];

  // renormalize: false, stereo and mono → all atoms partition unity
  for (const side of [S, null]) {
    const m = partitionMasks({ frames, bins, binHz, Mh, Mp, Mr, band, Cv, S: side, fc, renormalize: false });
    assertPartition(m, all, size);
  }
  // renormalize: true → non-V atoms partition unity, V unchanged
  const raw = partitionMasks({ frames, bins, binHz, Mh, Mp, Mr, band, Cv, S, fc, renormalize: false });
  const re = partitionMasks({ frames, bins, binHz, Mh, Mp, Mr, band, Cv, S, fc });
  assertPartition(re, nonV, size);
  assert.deepEqual(re.V, raw.V);

  // stage 1 (Mh only) → V, B, H, Rem
  const s1 = partitionMasks({ frames, bins, binHz, Mh, band, Cv, fc: 250, renormalize: false });
  assert.deepEqual(Object.keys(s1).sort(), ['B', 'H', 'Rem', 'V']);
  assertPartition(s1, ['V', 'B', 'H', 'Rem'], size);
  const s1r = partitionMasks({ frames, bins, binHz, Mh, band, Cv, fc: 250 });
  assertPartition(s1r, ['B', 'H', 'Rem'], size);

  // all-vocal point: denominator ~0 → O = 1
  const one = new Float32Array(size).fill(1);
  const zeros = new Float32Array(size);
  const v = partitionMasks({ frames, bins, binHz, Mh: one, Mp: zeros, Mr: zeros, band: new Float32Array(bins).fill(1), Cv: 1 });
  assertPartition(v, nonV, size);
  for (let i = 0; i < size; i++) { assert.equal(v.V[i], 1); assert.equal(v.O[i], 1); }
});

test('wienerRefine: refined masks are non-negative and sum to 1 per point', () => {
  const rand = rng(11);
  const frames = 7, bins = 33, binHz = SR / 64, size = frames * bins;
  const masks = partitionMasks({
    frames, bins, binHz,
    Mh: randArray(size, rand), Mp: randArray(size, rand), Mr: randArray(size, rand),
    band: freqRamp(bins, binHz, 300, true), S: randArray(size, rand), renormalize: false,
  });
  const specs = [0, 1].map(() => ({ re: randArray(size, rand, -1, 1), im: randArray(size, rand, -1, 1) }));
  // a silent region keeps the original (already normalised) masks
  for (const sp of specs) for (let i = 0; i < bins; i++) { sp.re[i] = 0; sp.im[i] = 0; }
  const out = wienerRefine(masks, specs, frames, bins);
  assert.equal(out, masks);
  assertPartition(out, Object.keys(out), size);
});

test('limitPeak: returns input when peak ≤ 1, scales jointly to 0.98 when peak > 1', () => {
  const a = Float32Array.from([0.5, -1, 0.2]);
  const b = Float32Array.from([0.1, 0.3, -0.9]);
  const input = [a, b];
  assert.equal(limitPeak(input), input);

  const c = Float32Array.from([0.5, -2, 1]);
  const d = Float32Array.from([1.5, 0.1, 0]);
  const before = [Array.from(c), Array.from(d)];
  const out = limitPeak([c, d, c]);
  let peak = 0;
  for (const ch of out) for (const v of ch) peak = Math.max(peak, Math.abs(v));
  assert.ok(Math.abs(peak - 0.98) < 1e-6);
  assert.ok(Math.abs(out[1][0] - 1.5 * 0.49) < 1e-6);
  assert.equal(out[0], out[2]);
  assert.deepEqual([Array.from(c), Array.from(d)], before); // inputs not mutated
});

test('bassCrossover: clamps to [min, max] and falls back on silence', () => {
  const frames = 20, bins = 1025, binHz = SR / 2048, size = frames * bins;
  const { min, max, fallback, factor } = BASS_CROSSOVER_DEFAULTS;
  const tone = (k) => {
    const m = new Float32Array(size);
    for (let t = 0; t < frames; t++) m[t * bins + k] = 1;
    return m;
  };
  const near = (fHz) => Math.round(fHz / binHz);
  const low = bassCrossover(null, tone(near(40)), frames, bins, binHz);
  const high = bassCrossover(null, tone(near(290)), frames, bins, binHz);
  const kMid = near(100);
  const midFc = bassCrossover(null, tone(kMid), frames, bins, binHz);
  const silent = bassCrossover(null, new Float32Array(size), frames, bins, binHz);
  const masked = bassCrossover(new Float32Array(size), tone(kMid), frames, bins, binHz);
  for (let t = 0; t < frames; t++) {
    assert.equal(low[t], min);
    assert.equal(high[t], max);
    assert.ok(Math.abs(midFc[t] - factor * kMid * binHz) < 1e-3);
    assert.equal(silent[t], fallback);
    assert.equal(masked[t], fallback);
  }
});

test('decimatedTimeMedian: constant input gives constant output away from zero padding', () => {
  const frames = 40, bins = 5, k = 5, step = 2;
  const mag = new Float32Array(frames * bins).fill(0.7);
  const out = decimatedTimeMedian(mag, frames, bins, k, step);
  assert.equal(out.length, frames * bins);
  const edge = ((k >> 1) + 1) * step;
  for (let t = edge; t < frames - edge; t++) {
    for (let b = 0; b < bins; b++) assert.ok(Math.abs(out[t * bins + b] - 0.7) < 1e-6);
  }
  // k = 1 is the identity on the grid, so a constant stays constant everywhere
  const id = decimatedTimeMedian(mag, frames, bins, 1, step);
  for (let i = 0; i < id.length; i++) assert.ok(Math.abs(id[i] - 0.7) < 1e-6);
});
