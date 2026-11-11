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
