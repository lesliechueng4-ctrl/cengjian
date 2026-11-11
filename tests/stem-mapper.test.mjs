import test from 'node:test';
import assert from 'node:assert/strict';
import { highpass } from '../public/js/dsp.js';
import { STEM_SOURCES, isMonoPair, mapDemucsStems } from '../public/js/stem-mapper.js';
import { forAll, gen } from './helpers/prop.mjs';

// Small sample rate and length keep the filters fast; 32 kHz still leaves
// room for a 10 kHz tone below Nyquist.
const SR = 32000;
const N = 8000; // 0.25 s
const IDS = ['vocal', 'drums', 'perc', 'bass', 'inst', 'harmony', 'fx', 'other'];

function sine(freq, amp = 0.2, phase = 0) {
  const x = new Float32Array(N);
  for (let i = 0; i < N; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR + phase);
  return x;
}

function add(...xs) {
  const out = new Float32Array(N);
  for (const x of xs) for (let i = 0; i < N; i++) out[i] += x[i];
  return out;
}

function sub(a, b) {
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = a[i] - b[i];
  return out;
}

function hp(x, f) {
  return highpass(highpass(x, f, SR), f, SR);
}

function peak(chs) {
  let p = 0;
  for (const ch of chs) for (const v of ch) p = Math.max(p, Math.abs(v));
  return p;
}

/** RMS over the middle half, away from filter edge effects. */
function midRms(x) {
  let s = 0, n = 0;
  for (let i = N / 4; i < (3 * N) / 4; i++) { s += x[i] * x[i]; n++; }
  return Math.sqrt(s / n);
}

function assertClose(actual, expected, tol, msg) {
  assert.equal(actual.length, expected.length, `${msg}: length`);
  for (let i = 0; i < actual.length; i++) {
    if (Math.abs(actual[i] - expected[i]) > tol) {
      assert.fail(`${msg}: sample ${i} is ${actual[i]}, expected ${expected[i]}`);
    }
  }
}

function assertPair(actual, expected, tol, msg) {
  assert.equal(actual.length, 2, `${msg}: channel count`);
  assertClose(actual[0], expected[0], tol, `${msg} L`);
  assertClose(actual[1], expected[1], tol, `${msg} R`);
}

/** Distinct stereo tones per Demucs output; `other` has a 6 kHz side part. */
function makeOutputs(model) {
  const out = {
    vocals: [sine(440), sine(440, 0.2, 0.3)],
    drums: [sine(10000, 0.15), sine(200, 0.15)],
    bass: [sine(80), sine(80, 0.18)],
    other: [add(sine(300, 0.1), sine(6000, 0.1)), sub(sine(300, 0.1), sine(6000, 0.1))],
  };
  if (model === 'htdemucs_6s') {
    out.guitar = [sine(660, 0.1), sine(660, 0.12)];
    out.piano = [sine(990, 0.1), sine(1320, 0.1)];
  }
  return out;
}

async function run(model, outputs) {
  const loaded = [];
  const emitted = new Map();
  const result = await mapDemucsStems({
    model,
    load: async (name) => {
      loaded.push(name);
      assert.ok(outputs[name], `unexpected load of ${name}`);
      return { channels: outputs[name], sampleRate: SR };
    },
    emit: (id, chs) => {
      assert.ok(!emitted.has(id), `${id} emitted twice`);
      emitted.set(id, chs);
    },
  });
  return { loaded, emitted, result };
}

test('STEM_SOURCES lists 8 Derived_Stems for each Demucs_Model', () => {
  for (const model of ['htdemucs', 'htdemucs_6s']) {
    assert.deepEqual(Object.keys(STEM_SOURCES[model]).sort(), [...IDS].sort(), model);
    for (const id of IDS) assert.ok(STEM_SOURCES[model][id].length > 0, `${model}.${id}`);
  }
});

for (const model of ['htdemucs', 'htdemucs_6s']) {
  test(`${model}: maps Demucs outputs to the 8 Derived_Stems`, async () => {
    const o = makeOutputs(model);
    const { loaded, emitted, result } = await run(model, o);

    const order = model === 'htdemucs_6s'
      ? ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']
      : ['vocals', 'drums', 'bass', 'other'];
    assert.deepEqual(loaded, order);
    assert.deepEqual([...emitted.keys()].sort(), [...IDS].sort());
    for (const [id, chs] of emitted) {
      assert.equal(chs.length, 2, `${id} has 2 channels`);
      assert.equal(chs[0].length, N);
      assert.equal(chs[1].length, N);
    }

    const tol = 1e-5;
    // 5.2 direct mappings
    assertPair(emitted.get('vocal'), o.vocals, tol, 'vocal');
    assertPair(emitted.get('drums'), o.drums, tol, 'drums');
    assertPair(emitted.get('bass'), o.bass, tol, 'bass');

    // 5.3 / 5.4 inst and harmony
    const extra = model === 'htdemucs_6s' ? [o.guitar, o.piano] : [];
    const inst = [0, 1].map((c) => add(o.drums[c], o.bass[c], o.other[c], ...extra.map((x) => x[c])));
    const harmony = [0, 1].map((c) => add(o.other[c], ...extra.map((x) => x[c])));
    assertPair(emitted.get('inst'), inst, tol, 'inst');
    assertPair(emitted.get('harmony'), harmony, tol, 'harmony');

    // 5.5 perc = drums through the 5 kHz highpass (10 kHz kept, 200 Hz removed)
    const perc = emitted.get('perc');
    assertPair(perc, [hp(o.drums[0], 5000), hp(o.drums[1], 5000)], tol, 'perc');
    assert.ok(midRms(perc[0]) > 0.8 * midRms(o.drums[0]), 'perc keeps 10 kHz');
    assert.ok(midRms(perc[1]) < 0.01 * midRms(o.drums[1]), 'perc removes 200 Hz');

    // 5.6 stereo fx: side above 1.5 kHz, identical on both channels
    const [oL, oR] = o.other;
    const side = new Float32Array(N);
    for (let i = 0; i < N; i++) side[i] = (oL[i] - oR[i]) / 2;
    const s = hp(side, 1500);
    const fx = emitted.get('fx');
    assertPair(fx, [s, s], tol, 'fx');
    assertClose(fx[1], fx[0], 0, 'fx in phase');
    const sideTone = sine(6000, 0.1);
    assert.ok(Math.abs(midRms(fx[0]) - midRms(sideTone)) < 0.05 * midRms(sideTone), 'fx is the 6 kHz side tone');

    // 5.7 other' = other − fx (side removed with original phase)
    const rest = emitted.get('other');
    assertPair(rest, [sub(oL, s), add(oR, s)], tol, 'other');
    assertClose(add(rest[0], s), oL, tol, "other'L + s = oL");
    assertClose(sub(rest[1], s), oR, tol, "other'R − s = oR");

    assert.equal(result.sampleRate, SR);
    assert.equal(result.mono, false);
    assert.ok(Math.abs(result.duration - N / SR) < 1e-9);
    assert.ok(Number.isFinite(result.bpm));
  });
}

test('mono source: fx takes other above 6 kHz', async () => {
  const fxRms = async (freq) => {
    const o = makeOutputs('htdemucs');
    const x = sine(freq, 0.2);
    o.other = [x, new Float32Array(x)];
    const { emitted, result } = await run('htdemucs', o);
    assert.equal(result.mono, true);
    const fx = emitted.get('fx');
    assertClose(fx[1], fx[0], 0, 'mono fx in phase');
    const s = hp(x, 6000);
    assertPair(fx, [s, s], 1e-5, 'mono fx');
    assertPair(emitted.get('other'), [sub(x, s), sub(x, s)], 1e-5, 'mono other');
    return midRms(fx[0]) / midRms(x);
  };
  assert.ok(await fxRms(500) < 0.01, '500 Hz is removed from fx');
  assert.ok(await fxRms(10000) > 0.9, '10 kHz is kept in fx');
});

test('isMonoPair', () => {
  const x = sine(500);
  assert.equal(isMonoPair([x, new Float32Array(x)]), true);
  assert.equal(isMonoPair([x]), true);
  assert.equal(isMonoPair([new Float32Array(N), new Float32Array(N)]), true);
  assert.equal(isMonoPair([x, sine(500, 0.19)]), false);
});

test('sums above full scale are brought to <= 1 by limitPeak', async () => {
  const o = makeOutputs('htdemucs_6s');
  const loud = sine(250, 0.6);
  for (const name of ['drums', 'bass', 'guitar', 'piano', 'other']) o[name] = [loud, loud];
  const { emitted } = await run('htdemucs_6s', o);
  // inst would peak at 3.0 and harmony at 1.8 without limiting.
  for (const id of IDS) assert.ok(peak(emitted.get(id)) <= 1, `${id} peak ${peak(emitted.get(id))}`);
  assert.ok(peak(emitted.get('inst')) > 0.9, 'inst is scaled, not silenced');
  // Shape is kept: limited inst is a scaled copy of the true sum.
  const inst = emitted.get('inst');
  const g = inst[0][100] / (5 * loud[100]);
  assertClose(inst[0], loud.map((v) => 5 * v * g), 1e-5, 'inst shape');
  // Stems already within full scale are untouched.
  assertPair(emitted.get('vocal'), o.vocals, 0, 'vocal unchanged');
});

// Property 9 uses its own short random outputs; the helpers above are fixed to N.

/** Random model plus same-length stereo Demucs outputs, each peaking at 0.19 (≤ 0.2). */
function demucsOutputs() {
  const lenGen = gen.int(256, 2048);
  const srGen = gen.oneOf(8000, 11025, 12000, 16000);
  const modelGen = gen.oneOf('htdemucs', 'htdemucs_6s');
  return (rng) => {
    const model = modelGen(rng);
    const n = lenGen(rng);
    const sampleRate = srGen(rng);
    const stereo = gen.signal({ minLength: n, maxLength: n, sampleRate, amplitude: 0.19, channels: 2 });
    const names = model === 'htdemucs_6s'
      ? ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']
      : ['vocals', 'drums', 'bass', 'other'];
    const outputs = {};
    for (const name of names) outputs[name] = stereo(rng);
    return { model, sampleRate, n, outputs };
  };
}

function sumPair(n, ...pairs) {
  return [0, 1].map((c) => {
    const out = new Float64Array(n);
    for (const p of pairs) for (let i = 0; i < n; i++) out[i] += p[c][i];
    return out;
  });
}

test('Feature: separation-accuracy, Property 9: Demucs 输出按模型线性映射', async () => {
  // **Validates: Requirements 5.2, 5.3, 5.4, 5.9**
  await forAll(demucsOutputs(), async ({ model, sampleRate, n, outputs: o }) => {
    const emitted = new Map();
    await mapDemucsStems({
      model,
      load: async (name) => {
        assert.ok(o[name], `unexpected load of ${name}`);
        return { channels: o[name], sampleRate };
      },
      emit: (id, chs) => {
        assert.ok(!emitted.has(id), `${id} emitted twice`);
        emitted.set(id, chs);
      },
    });

    assert.deepEqual([...emitted.keys()].sort(), [...IDS].sort());
    for (const [id, chs] of emitted) {
      assert.equal(chs.length, 2, `${id} has 2 channels`);
      assert.equal(chs[0].length, n, `${id} L length`);
      assert.equal(chs[1].length, n, `${id} R length`);
    }

    const tol = 1e-6;
    assertPair(emitted.get('vocal'), o.vocals, tol, 'vocal');
    assertPair(emitted.get('drums'), o.drums, tol, 'drums');
    assertPair(emitted.get('bass'), o.bass, tol, 'bass');

    const extra = model === 'htdemucs_6s' ? [o.guitar, o.piano] : [];
    assertPair(emitted.get('inst'), sumPair(n, o.drums, o.bass, o.other, ...extra), tol, 'inst');
    assertPair(emitted.get('harmony'), sumPair(n, ...extra, o.other), tol, 'harmony');
  }, { runs: 100 });
});

test('Feature: separation-accuracy, Property 10: 额外打击乐等于 drums 的 5 kHz 高通', async () => {
  // **Validates: Requirements 5.5**
  // Reuse the Property 9 outputs, but with a sample rate above 10 kHz so
  // 5 kHz is below Nyquist.
  const base = demucsOutputs();
  const srGen = gen.int(11025, 32000);
  const generator = (rng) => ({ ...base(rng), sampleRate: srGen(rng) });

  await forAll(generator, async ({ model, sampleRate, n, outputs: o }) => {
    // Expected perc, computed before the mapper sees the inputs.
    let expected = [0, 1].map((c) => highpass(highpass(o.drums[c], 5000, sampleRate), 5000, sampleRate));
    // Drums peak at 0.19, so limitPeak should not trigger; if the filter
    // overshoots past full scale anyway, apply the same 0.98 / peak scaling.
    const p = peak(expected);
    if (p > 1) expected = expected.map((ch) => ch.map((v) => v * (0.98 / p)));

    let perc;
    await mapDemucsStems({
      model,
      load: async (name) => {
        assert.ok(o[name], `unexpected load of ${name}`);
        return { channels: o[name], sampleRate };
      },
      emit: (id, chs) => { if (id === 'perc') perc = chs; },
    });

    assert.ok(perc, 'perc emitted');
    assert.equal(perc[0].length, n);
    assertPair(perc, expected, 1e-6, 'perc');
  }, { runs: 100 });
});

test('Feature: separation-accuracy, Property 11: 效果音左右同相且与其他音效还原 other', async () => {
  // **Validates: Requirements 5.6, 5.7**
  // Sample rate above 12 kHz so the 6 kHz mono highpass is below Nyquist.
  // Half the cases use a mono `other` (identical L/R copies).
  const base = demucsOutputs();
  const srGen = gen.int(12001, 48000);
  const monoGen = gen.oneOf(false, true);
  const generator = (rng) => {
    const g = base(rng);
    const mono = monoGen(rng);
    if (mono) g.outputs.other = [g.outputs.other[0], new Float32Array(g.outputs.other[0])];
    return { ...g, sampleRate: srGen(rng), mono };
  };

  await forAll(generator, async ({ model, sampleRate, n, outputs: o, mono: forcedMono }) => {
    const [oL, oR] = o.other;
    // Random stereo can still be mono-like (e.g. both channels silent), so the
    // expected branch follows isMonoPair, as the mapper does.
    const mono = isMonoPair(o.other);
    if (forcedMono) assert.equal(mono, true, 'identical L/R is detected as mono');
    const emitted = new Map();
    await mapDemucsStems({
      model,
      load: async (name) => {
        assert.ok(o[name], `unexpected load of ${name}`);
        return { channels: o[name], sampleRate };
      },
      emit: (id, chs) => { emitted.set(id, chs); },
    });

    const fx = emitted.get('fx');
    const rest = emitted.get('other');
    assert.ok(fx && rest, 'fx and other emitted');
    assert.equal(fx.length, 2, 'fx has 2 channels');
    assert.equal(rest.length, 2, 'other has 2 channels');
    assert.equal(fx[0].length, n);

    // Precondition: inputs peak at 0.19, so neither fx nor other' reaches
    // full scale and limitPeak leaves both unscaled.
    assert.ok(peak(fx) <= 1, `fx peak ${peak(fx)} <= 1`);
    assert.ok(peak(rest) <= 1, `other peak ${peak(rest)} <= 1`);

    // fx is identical on both channels.
    assertClose(fx[1], fx[0], 0, 'fx in phase');
    const s = fx[0];
    const tol = 1e-6;

    if (mono) {
      const hp6 = (x) => highpass(highpass(x, 6000, sampleRate), 6000, sampleRate);
      assertClose(s, hp6(oL), tol, 'mono fx = hp(other, 6000)');
      for (let c = 0; c < 2; c++) {
        const back = new Float64Array(n);
        for (let i = 0; i < n; i++) back[i] = rest[c][i] + s[i];
        assertClose(back, o.other[c], tol, `mono other'_${c} + fx = other_${c}`);
      }
    } else {
      const backL = new Float64Array(n);
      const backR = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        backL[i] = rest[0][i] + s[i];
        backR[i] = rest[1][i] - s[i];
      }
      assertClose(backL, oL, tol, "other'_L + fx = other_L");
      assertClose(backR, oR, tol, "other'_R − fx = other_R");
    }
  }, { runs: 100 });
});

/** Full-scale square wave of length n (in-phase copies sum to k × 1.0). */
function square(n, period) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (i % period) < period / 2 ? 1 : -1;
  return x;
}

/**
 * Loud Demucs outputs whose sums exceed full scale: each output peaks in
 * [0.3, 1.0); sometimes every output is the same full-scale square wave so
 * inst/harmony reach 3–5×. Half the cases use a mono-pair `other`.
 */
function loudDemucsOutputs() {
  const lenGen = gen.int(256, 2048);
  const srGen = gen.int(12000, 48000);
  const modelGen = gen.oneOf('htdemucs', 'htdemucs_6s');
  const ampGen = gen.float(0.3, 1.0);
  const kindGen = gen.oneOf('random', 'random', 'square');
  const monoGen = gen.oneOf(false, true);
  const periodGen = gen.int(4, 200);
  return (rng) => {
    const model = modelGen(rng);
    const n = lenGen(rng);
    const sampleRate = srGen(rng);
    const kind = kindGen(rng);
    const mono = monoGen(rng);
    const names = model === 'htdemucs_6s'
      ? ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']
      : ['vocals', 'drums', 'bass', 'other'];
    const outputs = {};
    if (kind === 'square') {
      const sq = square(n, periodGen(rng));
      for (const name of names) outputs[name] = [new Float32Array(sq), new Float32Array(sq)];
    } else {
      for (const name of names) {
        const amplitude = ampGen(rng);
        outputs[name] = gen.signal({ minLength: n, maxLength: n, sampleRate, amplitude, channels: 2 })(rng);
      }
    }
    if (mono) outputs.other = [outputs.other[0], new Float32Array(outputs.other[0])];
    return { model, sampleRate, n, kind, mono, outputs };
  };
}

test('Feature: separation-accuracy, Property 17: 输出峰值不超过满幅（Demucs 部分）', async () => {
  // **Validates: Requirements 9.5**
  let exceeded = 0;
  await forAll(loudDemucsOutputs(), async ({ model, sampleRate, n, outputs: o }) => {
    const emitted = new Map();
    await mapDemucsStems({
      model,
      load: async (name) => {
        assert.ok(o[name], `unexpected load of ${name}`);
        return { channels: o[name], sampleRate };
      },
      emit: (id, chs) => { emitted.set(id, chs); },
    });

    assert.deepEqual([...emitted.keys()].sort(), [...IDS].sort());
    for (const [id, chs] of emitted) {
      const p = peak(chs);
      assert.ok(Number.isFinite(p) && p <= 1, `${id} peak ${p} <= 1`);
    }

    // Unlimited values of the linear stems: unchanged when already ≤ 1,
    // otherwise scaled by 0.98 / peak.
    const extra = model === 'htdemucs_6s' ? [o.guitar, o.piano] : [];
    const unlimited = {
      vocal: o.vocals,
      drums: o.drums,
      bass: o.bass,
      inst: sumPair(n, o.drums, o.bass, o.other, ...extra),
      harmony: sumPair(n, ...extra, o.other),
    };
    for (const [id, raw] of Object.entries(unlimited)) {
      const p = peak(raw);
      if (p <= 1) {
        assertPair(emitted.get(id), raw, 1e-6, `${id} unchanged`);
      } else {
        exceeded++;
        const g = 0.98 / p;
        assertPair(emitted.get(id), raw.map((ch) => Array.from(ch, (v) => v * g)), 1e-5, `${id} scaled`);
      }
    }
  }, { runs: 100 });
  assert.ok(exceeded > 0, 'generator produced sums above full scale');
});
