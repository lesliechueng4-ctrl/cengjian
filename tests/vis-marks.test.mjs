import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeStem, detectDrumHits, detectBassNotes, prominentPeaks } from '../public/js/vis-analysis.js';
import {
  createVisData, fitBeat, deriveEntries, finishVisData, shiftBeat, encodeVisPayload, decodeVisPayload,
  VisPayloadError, VIS_VERSION,
} from '../public/js/vis-data.js';

// Kick / Snare / Hi-hat 检测、贝斯音符、拍子网格、进场，以及它们在 Vis_Payload 里的编码。

const SR = 44100;

function rngOf(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 合成鼓：Kick = 60 Hz 衰减正弦；Snare = 1–6 kHz 噪声；Hi-hat = 8 kHz 以上的短噪声。 */
function synthDrums(dur, { kicks = [], snares = [], hats = [] }) {
  const n = Math.round(dur * SR);
  const x = new Float32Array(n);
  const rnd = rngOf(7);
  const noise = (len) => Float32Array.from({ length: len }, () => rnd() * 2 - 1);
  const onePole = (src, fc, high) => { // 粗略的一阶滤波，够把能量放进对应频段
    const a = Math.exp((-2 * Math.PI * fc) / SR);
    const out = new Float32Array(src.length);
    let y = 0;
    for (let i = 0; i < src.length; i++) { y = (1 - a) * src[i] + a * y; out[i] = high ? src[i] - y : y; }
    return out;
  };
  for (const t of kicks) {
    const s = Math.round(t * SR);
    for (let i = 0; i < 0.12 * SR && s + i < n; i++) x[s + i] += 0.9 * Math.sin((2 * Math.PI * 60 * i) / SR) * Math.exp(-i / (0.03 * SR));
  }
  for (const t of snares) {
    const s = Math.round(t * SR);
    const len = Math.round(0.08 * SR);
    const body = onePole(onePole(noise(len), 5000, false), 1200, true);
    for (let i = 0; i < len && s + i < n; i++) x[s + i] += 1.5 * body[i] * Math.exp(-i / (0.02 * SR));
  }
  for (const t of hats) {
    const s = Math.round(t * SR);
    const len = Math.round(0.03 * SR);
    const tick = onePole(onePole(noise(len), 9000, true), 9000, true);
    for (let i = 0; i < len && s + i < n; i++) x[s + i] += 0.5 * tick[i] * Math.exp(-i / (0.006 * SR));
  }
  return [x];
}

/** 每个期望时间附近 ±tol 秒内正好有一个检测结果，且没有多余的。 */
function assertTimes(frames, expected, tol, name) {
  const got = Array.from(frames, (f) => f / 100);
  assert.equal(got.length, expected.length, `${name}: ${got.join(' ')} vs ${expected.join(' ')}`);
  expected.forEach((t, k) => assert.ok(Math.abs(got[k] - t) <= tol, `${name}[${k}]: ${got[k]} vs ${t}`));
}

test('detectDrumHits: Kick, Snare and Hi-hat are told apart and land within 20 ms', () => {
  const kicks = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0];
  const snares = [0.75, 1.75, 2.75];
  const hats = [0.25, 0.625, 0.875, 1.25, 1.375, 2.25, 3.25];
  const m = detectDrumHits(synthDrums(3.6, { kicks, snares, hats }), SR);
  assertTimes(m.K, kicks, 0.02, 'K');
  assertTimes(m.S, snares, 0.02, 'S');
  assertTimes(m.H, hats, 0.02, 'H');
  for (const key of ['K', 'S', 'H']) {
    assert.ok(m[key] instanceof Int32Array);
    for (let i = 1; i < m[key].length; i++) assert.ok(m[key][i] > m[key][i - 1], 'strictly increasing');
  }
});

test('detectDrumHits: two Hi-hats 60 ms apart are two hits; a Hi-hat on a Snare is not counted', () => {
  const m = detectDrumHits(synthDrums(2, { snares: [1.0], hats: [0.5, 0.56, 1.0, 1.5] }), SR);
  assertTimes(m.H, [0.5, 0.56, 1.5], 0.02, 'H');
  assertTimes(m.S, [1.0], 0.02, 'S');
});

test('detectDrumHits / detectBassNotes: silence, empty input and a bad sample rate give empty marks', () => {
  for (const ch of [[new Float32Array(SR)], [new Float32Array(0)], []]) {
    const m = detectDrumHits(ch, SR);
    assert.deepEqual([m.K.length, m.S.length, m.H.length], [0, 0, 0]);
    const b = detectBassNotes(ch, SR);
    assert.deepEqual([b.B.length, b.BL.length], [0, 0]);
  }
  assert.equal(detectDrumHits([new Float32Array(100).fill(0.5)], 0).K.length, 0);
});

test('detectBassNotes: start and length of each note', () => {
  const n = 3 * SR;
  const x = new Float32Array(n);
  const notes = [[0.5, 0.4], [1.2, 0.15], [2.0, 0.6]];
  for (const [t, len] of notes) {
    const s = Math.round(t * SR);
    const L = Math.round(len * SR);
    for (let i = 0; i < L; i++) {
      const edge = Math.min(1, i / (0.005 * SR), (L - i) / (0.01 * SR));
      x[s + i] += 0.8 * edge * Math.sin((2 * Math.PI * 80 * i) / SR);
    }
  }
  const { B, BL } = detectBassNotes([x], SR);
  assertTimes(B, notes.map((v) => v[0]), 0.03, 'B');
  notes.forEach(([, len], k) => assert.ok(Math.abs(BL[k] / 100 - len) <= 0.06, `length ${k}: ${BL[k] / 100} vs ${len}`));
  assert.ok(BL.every((v) => v >= 1));
});

test('prominentPeaks: a second peak on the tail of the first is found; ripples and close neighbours are not', () => {
  const a = Float32Array.from([0, 1, 10, 6, 5, 9, 4, 3.9, 4, 1, 0, 0, 3, 0]);
  assert.deepEqual(prominentPeaks(a, { minProm: 2, relProm: 0.3 }), [2, 5, 12]);
  assert.deepEqual(prominentPeaks(a, { minProm: 2, relProm: 0.3, minDist: 4 }), [2, 12], 'the taller of two close peaks wins');
  assert.deepEqual(prominentPeaks(a, { minProm: 5 }), [2], 'prominence, not height');
  assert.deepEqual(prominentPeaks(new Float32Array(0), { minProm: 1 }), []);
});

test('analyzeStem: marks only for drums ({ K, S, H }) and bass ({ B, BL })', () => {
  const ch = synthDrums(1.5, { kicks: [0.5, 1.0], hats: [0.25] });
  assert.deepEqual(Object.keys(analyzeStem('drums', ch, SR).marks), ['K', 'S', 'H']);
  assert.deepEqual(Object.keys(analyzeStem('bass', ch, SR).marks), ['B', 'BL']);
  for (const id of ['vocal', 'perc', 'inst', 'harmony', 'fx', 'other']) assert.equal(analyzeStem(id, ch, SR).marks, undefined, id);
});

// ---------- beat grid ----------

const frames = (times) => Int32Array.from(times, (t) => Math.round(t * 100));

/** 标准的 4/4：Kick 在 1、3 拍（外加若干切分），Snare 在 2、4 拍。 */
function pattern(bpm, phase, bars, { four = false } = {}) {
  const p = 60 / bpm;
  const K = [];
  const S = [];
  for (let b = 0; b < bars; b++) {
    const t0 = phase + b * 4 * p;
    K.push(t0, t0 + 2 * p);
    if (four) K.push(t0 + p, t0 + 3 * p);
    else if (b % 2) K.push(t0 + 2.5 * p);
    S.push(t0 + p, t0 + 3 * p);
  }
  return { K: K.sort((a, b) => a - b), S, p };
}

test('fitBeat: tempo within 0.2 BPM, beat 1 on the bar start, for tempos from 72 to 138', () => {
  for (const [bpm, phase] of [[72, 0.31], [90, 1.0], [100, 0.05], [112, 0.5], [127.5, 0.77], [138, 0.2]]) {
    const { K, S, p } = pattern(bpm, phase, 12);
    const beat = fitBeat(frames(K), frames(S));
    assert.ok(beat, `${bpm}`);
    assert.ok(Math.abs(60 / beat.period - bpm) < 0.2, `${bpm}: got ${60 / beat.period}`);
    const off = ((beat.phase - phase) % (4 * p) + 4 * p) % (4 * p);
    assert.ok(Math.min(off, 4 * p - off) < 0.03, `${bpm}: phase ${beat.phase} vs ${phase}`);
    assert.ok(beat.phase >= 0 && beat.phase < 4 * beat.period + 1e-9);
  }
});

test('fitBeat: with a kick on every beat, the bass decides which of beats 1 and 3 starts the bar', () => {
  const { K, S, p } = pattern(110, 0.4, 12, { four: true });
  const bassOn = (beatIdx) => frames(Array.from({ length: 12 }, (_, b) => 0.4 + (b * 4 + beatIdx) * p));
  for (const idx of [0, 2]) {
    const beat = fitBeat(frames(K), frames(S), 100, bassOn(idx));
    const want = 0.4 + idx * p;
    const off = ((beat.phase - want) % (4 * p) + 4 * p) % (4 * p);
    assert.ok(Math.min(off, 4 * p - off) < 0.03, `bass on beat ${idx + 1}: phase ${beat.phase}`);
  }
});

test('fitBeat: null with too few hits, hits at random times, or no hits at all', () => {
  assert.equal(fitBeat(frames([0.5, 1, 1.5]), frames([0.75])), null);
  assert.equal(fitBeat(null, null), null);
  const rnd = rngOf(3);
  const random = Array.from({ length: 80 }, () => rnd() * 60).sort((a, b) => a - b);
  assert.equal(fitBeat(frames(random.filter((_, i) => i % 2)), frames(random.filter((_, i) => !(i % 2)))), null);
});

// ---------- entries ----------

test('deriveEntries: a row comes in after two bars of silence (4 s without a beat grid); the start of the file does not count', () => {
  const env = new Uint8Array(2000);
  env.fill(200, 0, 300);     // 开头就有：不算
  env.fill(20, 300, 500);    // 很小声：算安静
  env.fill(200, 900, 1000);  // 6 秒安静后进（3–9 s 低于 10%）
  env.fill(200, 1200, 1300); // 只隔 2 秒：不算
  const base = { frameRate: 100, frames: 2000, duration: 20, stems: { vocal: { env, onsets: null }, drums: { env: new Uint8Array(2000), onsets: null } } };
  const noBeat = deriveEntries({ ...base, beat: null, marks: { K: frames([0.1, 0.6, 5.0, 5.5, 12.0]) } });
  assert.deepEqual(Array.from(noBeat.vocal), [900]);
  assert.deepEqual(Array.from(noBeat.K), [500, 1200], 'gaps of 4.4 s and 6.5 s');
  assert.equal(noBeat.S, undefined, 'no row without marks');
  // 两小节 = 8 拍；每拍 0.75 秒时是 6 秒，Kick 的 4.4 秒间隔就不够了
  const slow = deriveEntries({ ...base, beat: { period: 0.75, phase: 0 }, marks: { K: frames([0.1, 0.6, 5.0, 5.5, 12.0]) } });
  assert.deepEqual(Array.from(slow.K), [1200]);
  // 贝斯：从上一个音结束算起
  const bass = deriveEntries({ ...base, beat: null, stems: { ...base.stems, bass: { env, onsets: null } }, marks: { B: frames([1, 6, 9.5]), BL: Int32Array.of(300, 50, 50) } });
  assert.deepEqual(Array.from(bass.bass), [], '1–4 s then 6 s: only 2 s of silence; 6.5 → 9.5: 3 s');
  assert.deepEqual(deriveEntries(null), {});
});

// ---------- Vis_Data and payload ----------

function sampleResults() {
  const env = new Uint8Array(800).fill(120);
  const { K, S } = pattern(120, 0.5, 4);
  return {
    drums: { env, onsets: Int32Array.of(50, 150), duration: 8, marks: { K: frames(K), S: frames(S), H: frames([0.25, 0.3, 7.99, 9]) } },
    bass: { env, onsets: null, duration: 8, marks: { B: frames([0.5, 2.5]), BL: Int32Array.of(100, 20) } },
    vocal: { env, onsets: null, duration: 8 },
  };
}

test('createVisData: collects marks (dropping frames past the end), fits the beat grid and derives entries', () => {
  const vd = createVisData(sampleResults());
  assert.equal(vd.version, VIS_VERSION);
  assert.deepEqual(Object.keys(vd.marks), ['K', 'S', 'H', 'B', 'BL']);
  assert.deepEqual(Array.from(vd.marks.H), [25, 30, 799], 'frame 900 is past the 800 frames');
  assert.ok(Math.abs(60 / vd.beat.period - 120) < 0.2);
  assert.deepEqual(Object.keys(vd.entries).sort(), ['H', 'K', 'S', 'bass', 'vocal']);
  // 没有 marks 的结果照旧可用
  const plain = createVisData({ vocal: sampleResults().vocal });
  assert.equal(plain.marks, undefined);
  assert.equal(plain.beat, null);
  // B 和 BL 长度不一致：两者都丢弃
  const bad = sampleResults();
  bad.bass.marks.BL = Int32Array.of(100);
  assert.deepEqual(Object.keys(createVisData(bad).marks), ['K', 'S', 'H']);
});

test('Vis_Payload round-trips marks and the beat grid; entries are derived again on decode', () => {
  const vd = createVisData(sampleResults());
  const text = encodeVisPayload(vd, 'drums');
  const obj = JSON.parse(text);
  assert.equal(obj.v, 2);
  assert.deepEqual(Object.keys(obj.marks), ['K', 'S', 'H', 'B', 'BL']);
  assert.deepEqual(Object.keys(obj.beat), ['period', 'phase']);
  assert.equal(obj.entries, undefined, 'entries are not sent');
  const back = decodeVisPayload(text);
  assert.equal(back.selected, 'drums');
  assert.deepEqual(back.visData, vd);
  // 没有 marks / beat 的 payload 仍然有效
  const plain = createVisData({ vocal: sampleResults().vocal });
  const plainBack = decodeVisPayload(encodeVisPayload(plain, 'vocal')).visData;
  assert.equal(plainBack.marks, undefined);
  assert.equal(plainBack.beat, null);
  assert.deepEqual(plainBack, plain);
});

test('decodeVisPayload rejects invalid marks and beat grids', () => {
  const good = JSON.parse(encodeVisPayload(createVisData(sampleResults()), 'drums'));
  const bad = (mutate) => {
    const obj = JSON.parse(JSON.stringify(good));
    mutate(obj);
    assert.throws(() => decodeVisPayload(JSON.stringify(obj)), VisPayloadError);
  };
  assert.ok(decodeVisPayload(JSON.stringify(good)));
  bad((o) => { o.v = 1; });
  bad((o) => { o.marks = []; });
  bad((o) => { o.marks = {}; });
  bad((o) => { o.marks.X = [1]; });
  bad((o) => { o.marks.K = 'no'; });
  bad((o) => { o.marks.K = [5, 5]; });
  bad((o) => { o.marks.K = [5, 3]; });
  bad((o) => { o.marks.K = [-1]; });
  bad((o) => { o.marks.K = [o.frames]; });
  bad((o) => { o.marks.K = [1.5]; });
  bad((o) => { delete o.marks.BL; });
  bad((o) => { o.marks.BL = [1]; });
  bad((o) => { o.marks.BL = [0, 1]; });
  bad((o) => { o.beat = null; });
  bad((o) => { o.beat = { period: 0.5 }; });
  bad((o) => { o.beat = { period: 0.5, phase: 0, extra: 1 }; });
  bad((o) => { o.beat = { period: 0.1, phase: 0 }; });
  bad((o) => { o.beat = { period: 0.5, phase: -0.1 }; });
  bad((o) => { o.beat = { period: 0.5, phase: 2.5 }; });
  bad((o) => { o.beat = { period: '0.5', phase: 0 }; });
  bad((o) => { o.extra = 1; });
});

test('shiftBeat moves the bar start by whole beats on a copy and wraps after four', () => {
  const vd = { frames: 1, stems: {}, beat: { period: 0.5, phase: 1.75 } };
  const one = shiftBeat(vd);
  assert.notEqual(one, vd);
  assert.deepEqual(one.beat, { period: 0.5, phase: 0.25 });
  assert.deepEqual(vd.beat, { period: 0.5, phase: 1.75 }, 'input untouched');
  assert.equal(one.stems, vd.stems);
  let v = vd;
  for (let k = 0; k < 4; k++) v = shiftBeat(v);
  assert.ok(Math.abs(v.beat.phase - 1.75) < 1e-9, 'four beats later is the same bar start');
  assert.ok(Math.abs(shiftBeat(vd, -1).beat.phase - 1.25) < 1e-9);
  const none = { stems: {}, beat: null };
  assert.equal(shiftBeat(none), none);
  assert.equal(shiftBeat(null), null);
});

test('finishVisData keeps a beat grid that is already set, including null', () => {
  const base = () => ({ frameRate: 100, frames: 800, duration: 8, stems: {}, marks: { K: frames(pattern(120, 0.5, 4).K), S: frames(pattern(120, 0.5, 4).S) } });
  assert.ok(finishVisData(base()).beat);
  assert.equal(finishVisData({ ...base(), beat: null }).beat, null);
  const fixed = { period: 0.6, phase: 0.1 };
  assert.equal(finishVisData({ ...base(), beat: fixed }).beat, fixed);
});
