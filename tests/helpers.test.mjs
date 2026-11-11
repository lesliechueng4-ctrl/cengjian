// 测试辅助（tests/helpers/prop.mjs、tests/helpers/benchmark.mjs）的单元测试。
// _Requirements: 10.5_
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { forAll, gen } from './helpers/prop.mjs';
import { makeBenchmarkSet, sdr, DERIVED_STEMS } from './helpers/benchmark.mjs';

// makeBenchmarkSet 约需 2 秒，整个文件只生成一次。
const SET = makeBenchmarkSet();

test('sdr: identical signals give 100 dB', () => {
  const x = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i * 0.05) * 0.5);
  assert.equal(sdr([x], [Float32Array.from(x)]), 100);
  assert.equal(sdr([x, x], [x, x]), 100);
});

test('sdr: all-zero estimate gives about 0 dB', () => {
  const x = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i * 0.05) * 0.5);
  const zero = new Float32Array(x.length);
  assert.ok(Math.abs(sdr([x], [zero])) < 1e-9);
  // Missing estimate channels count as silence.
  assert.ok(Math.abs(sdr([x, x], [x]) - 10 * Math.log10(2)) < 1e-9);
});

test('Benchmark_Set: 3 stereo + 2 mono samples with all derived references', () => {
  assert.equal(SET.length, 5);
  assert.equal(SET.filter((s) => s.stereo).length, 3);
  assert.equal(SET.filter((s) => !s.stereo).length, 2);
  for (const s of SET) {
    const nch = s.stereo ? 2 : 1;
    assert.equal(s.channels.length, nch, `${s.name} mix channels`);
    for (const id of DERIVED_STEMS) {
      assert.ok(s.refs[id], `${s.name} missing ref ${id}`);
      assert.equal(s.refs[id].length, nch, `${s.name} ${id} channels`);
      for (const ch of s.refs[id]) assert.equal(ch.length, s.channels[0].length);
    }
  }
});

test('Benchmark_Set: independent component references sum to the mix (<= 1e-6)', () => {
  // mix_c = vocal + drums + bass + harmony + fxSign(c)·fx + other
  // (perc ⊂ drums; inst = mix − vocal; stereo fx ref is [e, e] while the mix has L=+e, R=−e)
  for (const s of SET) {
    const { vocal, drums, bass, harmony, fx, other, inst } = s.refs;
    let maxErr = 0, maxInstErr = 0;
    for (let c = 0; c < s.channels.length; c++) {
      const mix = s.channels[c];
      const sign = c === 1 ? -1 : 1;
      for (let i = 0; i < mix.length; i++) {
        const sum = vocal[c][i] + drums[c][i] + bass[c][i] + harmony[c][i] + sign * fx[c][i] + other[c][i];
        maxErr = Math.max(maxErr, Math.abs(sum - mix[i]));
        maxInstErr = Math.max(maxInstErr, Math.abs(inst[c][i] + vocal[c][i] - mix[i]));
      }
    }
    assert.ok(maxErr <= 1e-6, `${s.name}: components sum error ${maxErr}`);
    assert.ok(maxInstErr <= 1e-6, `${s.name}: inst + vocal error ${maxInstErr}`);
  }
});

test('forAll: same seed reproduces the same generated sequence', async () => {
  const g = gen.array(gen.oneOf(gen.int(-1000, 1000), gen.float(-1, 1), gen.string()), { maxLength: 8 });
  const collect = async () => {
    const values = [];
    const res = await forAll(g, (v) => { values.push(v); }, { runs: 50, seed: 12345 });
    return { values, seed: res.seed };
  };
  const a = await collect();
  const b = await collect();
  assert.equal(a.seed, b.seed);
  assert.equal(a.values.length, 50);
  assert.deepEqual(a.values, b.values);

  const sig = gen.signal({ minLength: 64, maxLength: 256, channels: [1, 2] });
  const sigs = async () => {
    const out = [];
    await forAll(sig, (v) => { out.push(v.map((ch) => Array.from(ch))); }, { runs: 10, seed: 777 });
    return out;
  };
  assert.deepEqual(await sigs(), await sigs());
});
