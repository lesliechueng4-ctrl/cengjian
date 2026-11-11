// Accuracy benchmark: DSP_Separator (Fast_Mode / High_Quality_Mode) against
// Baseline_Separator on the synthetic Benchmark_Set (requirements 9.1–9.5,
// design.md Testing Strategy). The thresholds below lock the tuned values of
// QUALITY_PRESETS and the bassCrossover coefficients in public/js/separator.js.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { separateChannels } from '../public/js/separator.js';
import { separateChannelsBaseline } from './helpers/baseline-separator.mjs';
import {
  makeBenchmarkSet, evaluate, averageSdr, formatSdrTable, DERIVED_STEMS,
} from './helpers/benchmark.mjs';

// Float-rounding tolerance for the "not below baseline" comparisons only.
// Mono Fast_Mode drums is mathematically identical to the baseline (D + T =
// Mp·X) and differs by ~4e-5 dB from Float32 rounding. This is not a lowered
// threshold: the +1.0 dB / +0.5 dB margins are compared without tolerance.
const EPS_DB = 0.01;

const HQ_MARGIN_DB = 1.0; // Requirement 9.1
const FAST_MEAN_MARGIN_DB = 0.5; // Requirement 9.2

const SEPARATORS = {
  baseline: { fn: separateChannelsBaseline, opts: {} },
  fast: { fn: separateChannels, opts: { mode: 'fast' } },
  high: { fn: separateChannels, opts: { mode: 'high' } },
};

let set;
// name -> { stereo: averageSdr, mono: averageSdr, perSample: evaluate()[] }
const sdrResults = {};
// mode -> [{ name, stereo, peaks: { id: peak }, fxChannels, fxRms }]
const levelMatched = {};

function peakOf(chs) {
  let p = 0;
  for (const ch of chs) for (let i = 0; i < ch.length; i++) p = Math.max(p, Math.abs(ch[i]));
  return p;
}

function rmsOf(chs) {
  let s = 0, n = 0;
  for (const ch of chs) { for (let i = 0; i < ch.length; i++) s += ch[i] * ch[i]; n += ch.length; }
  return n ? Math.sqrt(s / n) : 0;
}

before(async () => {
  set = makeBenchmarkSet();
  const stereoSet = set.filter((s) => s.stereo);
  const monoSet = set.filter((s) => !s.stereo);

  // Run 1 (every separator): SDR without level matching, so scores measure
  // the separation itself rather than the gain stage.
  for (const [name, { fn, opts }] of Object.entries(SEPARATORS)) {
    const perSample = [];
    for (const sample of set) perSample.push(await evaluate(fn, sample, { ...opts, levelMatch: false }));
    sdrResults[name] = {
      perSample,
      stereo: averageSdr(perSample.filter((r) => r.stereo)),
      mono: averageSdr(perSample.filter((r) => !r.stereo)),
    };
  }
  assert.ok(stereoSet.length > 0 && monoSet.length > 0);

  // Run 2 (DSP_Separator modes only): levelMatch: true as the App uses it,
  // for the peak and mono 效果音 checks. Stems are reduced to stats at once.
  for (const mode of ['fast', 'high']) {
    const { fn, opts } = SEPARATORS[mode];
    levelMatched[mode] = [];
    for (const sample of set) {
      const r = await evaluate(fn, sample, { ...opts, levelMatch: true, keepStems: true });
      const peaks = {};
      for (const id of DERIVED_STEMS) peaks[id] = peakOf(r.stems[id]);
      levelMatched[mode].push({
        name: sample.name,
        stereo: sample.stereo,
        peaks,
        fxChannels: r.stems.fx.length,
        fxRms: rmsOf(r.stems.fx),
      });
    }
  }
});

function columns(kind) {
  return {
    baseline: sdrResults.baseline[kind],
    fast: sdrResults.fast[kind],
    high: sdrResults.high[kind],
    'fast-base': diff(sdrResults.fast[kind], sdrResults.baseline[kind]),
    'high-base': diff(sdrResults.high[kind], sdrResults.baseline[kind]),
  };
}

function diff(a, b) {
  const out = {};
  for (const id of [...DERIVED_STEMS, 'mean']) out[id] = a[id] - b[id];
  return out;
}

test('SDR table (Benchmark_Set, dB, levelMatch: false)', (t) => {
  t.diagnostic('stereo samples:\n' + formatSdrTable(columns('stereo')));
  t.diagnostic('mono samples:\n' + formatSdrTable(columns('mono')));
  for (const name of Object.keys(SEPARATORS)) {
    for (const id of DERIVED_STEMS) {
      assert.ok(Number.isFinite(sdrResults[name].stereo[id]), `${name} stereo ${id}`);
      assert.ok(Number.isFinite(sdrResults[name].mono[id]), `${name} mono ${id}`);
    }
  }
});

test('High_Quality_Mode stereo: every stem >= baseline + 1.0 dB (9.1)', () => {
  const base = sdrResults.baseline.stereo;
  const hq = sdrResults.high.stereo;
  for (const id of DERIVED_STEMS) {
    assert.ok(hq[id] >= base[id] + HQ_MARGIN_DB,
      `${id}: high ${hq[id].toFixed(2)} dB < baseline ${base[id].toFixed(2)} + ${HQ_MARGIN_DB} dB`);
  }
});

test('Fast_Mode stereo: every stem >= baseline, mean >= baseline mean + 0.5 dB (9.2)', () => {
  const base = sdrResults.baseline.stereo;
  const fast = sdrResults.fast.stereo;
  for (const id of DERIVED_STEMS) {
    assert.ok(fast[id] >= base[id] - EPS_DB,
      `${id}: fast ${fast[id].toFixed(4)} dB < baseline ${base[id].toFixed(4)} dB`);
  }
  assert.ok(fast.mean >= base.mean + FAST_MEAN_MARGIN_DB,
    `mean: fast ${fast.mean.toFixed(2)} dB < baseline ${base.mean.toFixed(2)} + ${FAST_MEAN_MARGIN_DB} dB`);
});

test('mono input: both modes every stem >= baseline (9.3)', () => {
  const base = sdrResults.baseline.mono;
  for (const mode of ['fast', 'high']) {
    const r = sdrResults[mode].mono;
    for (const id of DERIVED_STEMS) {
      assert.ok(r[id] >= base[id] - EPS_DB,
        `${mode} ${id}: ${r[id].toFixed(4)} dB < baseline ${base[id].toFixed(4)} dB`);
    }
  }
});

test('mono input: 效果音 is single-channel and non-zero (9.4)', () => {
  for (const mode of ['fast', 'high']) {
    for (const r of levelMatched[mode].filter((x) => !x.stereo)) {
      assert.equal(r.fxChannels, 1, `${mode} ${r.name}: fx channels`);
      assert.ok(r.fxRms > 0, `${mode} ${r.name}: fx RMS is 0`);
    }
  }
});

test('levelMatch: true: every Derived_Stem peak <= 1.0 (9.5)', () => {
  for (const mode of ['fast', 'high']) {
    for (const r of levelMatched[mode]) {
      for (const id of DERIVED_STEMS) {
        assert.ok(r.peaks[id] <= 1, `${mode} ${r.name} ${id}: peak ${r.peaks[id]}`);
      }
    }
  }
});
