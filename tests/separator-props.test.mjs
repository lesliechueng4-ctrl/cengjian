// Property tests for the DSP_Separator (spec: separation-accuracy, design.md Correctness Properties).
import test from 'node:test';
import assert from 'node:assert/strict';
import { separateChannels } from '../public/js/separator.js';
import { forAll, gen } from './helpers/prop.mjs';

const SR = 16000;

function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

function peakOf(chs) {
  let p = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) p = Math.max(p, Math.abs(c[i]));
  return p;
}

/** RMS of (Σ plus − Σ minus) over a channel, all arrays the same length. */
function residualRms(len, plus, minus) {
  let s = 0;
  for (let i = 0; i < len; i++) {
    let e = 0;
    for (const a of plus) e += a[i];
    for (const a of minus) e -= a[i];
    s += e * e;
  }
  return Math.sqrt(s / Math.max(1, len));
}

/** Runs separateChannels and returns copies of every stem and the raw F atom. */
async function separate(input, mode, extra = {}) {
  const stems = {};
  let F = null;
  const result = await separateChannels(input.map((c) => c.slice()), SR, {
    onStem: (id, chs) => { stems[id] = chs.map((c) => Float32Array.from(c)); },
    onAtom: (name, chs) => { if (name === 'F') F = chs.map((c) => Float32Array.from(c)); },
  }, { mode, levelMatch: false, ...extra });
  return { stems, F, result };
}

// Property 14. Tolerance: per channel, error RMS ≤ 1e-4 · input RMS over the whole
// signal (no edge trimming; processSegments reconstructs the edges exactly enough).
// The perc ⊂ drums band-energy clause is not an exact identity and is left out here.
// limitPeak precondition: it only scales stems whose peak exceeds 1 (to exactly 0.98),
// so the input peak is kept at 0.5 and every emitted stem is asserted to peak < 0.97.
test('Feature: separation-accuracy, Property 14: 原子掩码划分守恒', async (t) => {
  for (const mode of ['fast', 'high']) {
    await t.test(`mode ${mode}`, async () => {
      await forAll(
        gen.signal({ minLength: 4000, maxLength: 8000, sampleRate: SR, amplitude: 0.5, channels: [1, 2] }),
        async (input) => {
          const { stems, F, result } = await separate(input, mode);
          assert.equal(result.mode, mode);
          for (const id of ['vocal', 'inst', 'bass', 'harmony', 'perc', 'drums', 'fx', 'other']) {
            assert.ok(stems[id], `stem ${id} emitted`);
            assert.ok(peakOf(stems[id]) < 0.97, `limitPeak precondition: stem ${id} peak < 0.97`);
          }
          assert.ok(F, 'onAtom F reported');
          const stereo = input.length === 2;
          assert.equal(F.length, stereo ? 2 : 1);
          const n = input[0].length;
          for (let c = 0; c < input.length; c++) {
            const tol = 1e-4 * rms(input[c]) + 1e-9;
            const pick = (id) => stems[id][Math.min(c, stems[id].length - 1)];
            const e1 = residualRms(n, [pick('vocal'), pick('inst')], [input[c]]);
            assert.ok(e1 <= tol, `ch ${c}: vocal + inst − x RMS ${e1} > ${tol}`);
            const e2 = residualRms(n,
              [pick('bass'), pick('harmony'), pick('drums'), F[c], pick('other')], [pick('inst')]);
            assert.ok(e2 <= tol, `ch ${c}: bass + harmony + drums + F + other − inst RMS ${e2} > ${tol}`);
          }
          // fx = [s, s]: stereo s = (F_L − F_R)/2, mono s = F.
          const fx = stems.fx;
          const tolS = 1e-4 * Math.max(...input.map(rms)) + 1e-9;
          for (const ch of fx) {
            let s = 0;
            for (let i = 0; i < n; i++) {
              const want = stereo ? (F[0][i] - F[1][i]) / 2 : F[0][i];
              s += (ch[i] - want) ** 2;
            }
            const e3 = Math.sqrt(s / n);
            assert.ok(e3 <= tolS, `fx vs F: RMS ${e3} > ${tolS}`);
          }
        },
        { runs: 100 },
      );
    });
  }
});

// Property 15. Segment sizes are 2048·k (a multiple of 2·hop for every pass: fast
// hop 512, HQ hops 1024 and 256), so segmentOpts keeps them unchanged. kA ∈ [1, 2]
// and length > 4096 guarantee the smaller size splits every pass into ≥ 2 segments
// (asserted); kB ∈ [kA + 1, 4] makes the two sizes differ.
const STEM_IDS = ['vocal', 'inst', 'bass', 'harmony', 'perc', 'drums', 'fx', 'other'];
const SEG_UNIT = 2048;

test('Feature: separation-accuracy, Property 15: 分段无关性', async (t) => {
  const signalGen = gen.signal({ minLength: 4200, maxLength: 9000, sampleRate: SR, amplitude: 0.5, channels: [1, 2] });
  const kAGen = gen.int(1, 2);
  const caseGen = (rng) => {
    const input = signalGen(rng);
    const kA = kAGen(rng);
    const kB = gen.int(kA + 1, 4)(rng);
    return { input, segA: SEG_UNIT * kA, segB: SEG_UNIT * kB };
  };
  for (const mode of ['fast', 'high']) {
    await t.test(`mode ${mode}`, async () => {
      await forAll(caseGen, async ({ input, segA, segB }) => {
        const n = input[0].length;
        assert.ok(Math.ceil(n / segA) > 1, `segment ${segA} gives > 1 segment for length ${n}`);
        const a = await separate(input, mode, { segment: segA });
        const b = await separate(input, mode, { segment: segB });
        for (const id of STEM_IDS) {
          const sa = a.stems[id], sb = b.stems[id];
          assert.ok(sa && sb, `stem ${id} emitted`);
          assert.equal(sa.length, sb.length);
          for (let c = 0; c < sa.length; c++) {
            let d = 0;
            for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(sa[c][i] - sb[c][i]));
            assert.ok(d <= 1e-5, `stem ${id} ch ${c}: max |diff| ${d} > 1e-5 (segments ${segA} vs ${segB})`);
          }
        }
      }, { runs: 100 });
    });
  }
});

// Property 16. Precondition (design.md): the mono input contains a noise component
// above 6 kHz (monoFxHz) with RMS ≥ 0.01. Each input is a random gen.signal base
// (peak 0.4) plus white noise of RMS σ ∈ [0.05, 0.2]; at SR 16 kHz a quarter of white
// noise power lies in 6–8 kHz, so the >6 kHz noise RMS is σ/2 ≥ 0.025. Optionally a
// tone at 6.5–7.8 kHz is added too. The noise is box-muller Gaussian (deterministic
// from the forAll rng). Asserted: fx is a single channel of the input length with
// RMS > 0 (finite), in both modes, with levelMatch false and true.
function gaussian(rng) {
  const u = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

const monoFxCaseGen = (() => {
  const base = gen.signal({ minLength: 4000, maxLength: 6000, sampleRate: SR, amplitude: 0.4, channels: 1 });
  const sigma = gen.float(0.05, 0.2);
  const toneOn = gen.int(0, 1);
  const toneHz = gen.float(6500, 7800);
  const toneAmp = gen.float(0.02, 0.2);
  const lm = gen.int(0, 1);
  return (rng) => {
    const [x] = base(rng);
    const s = sigma(rng);
    for (let i = 0; i < x.length; i++) x[i] += s * gaussian(rng);
    const tone = toneOn(rng) === 1;
    if (tone) {
      const w = 2 * Math.PI * toneHz(rng) / SR, a = toneAmp(rng), ph = rng() * 2 * Math.PI;
      for (let i = 0; i < x.length; i++) x[i] += a * Math.sin(w * i + ph);
    }
    return { input: [x], sigma: s, tone, levelMatch: lm(rng) === 1 };
  };
})();

test('Feature: separation-accuracy, Property 16: 单声道效果音非零', async (t) => {
  for (const mode of ['fast', 'high']) {
    await t.test(`mode ${mode}`, async () => {
      await forAll(monoFxCaseGen, async ({ input, levelMatch }) => {
        const n = input[0].length;
        const { stems, result } = await separate(input, mode, { levelMatch });
        assert.equal(result.mode, mode);
        const fx = stems.fx;
        assert.ok(fx, 'fx emitted');
        assert.equal(fx.length, 1, 'mono input → fx has exactly 1 channel');
        assert.equal(fx[0].length, n, 'fx length equals input length');
        const r = rms(fx[0]);
        assert.ok(Number.isFinite(r) && r > 0, `fx RMS ${r} must be > 0`);
      }, { runs: 100 });
    });
  }
});

// Property 17 (DSP part; the Stem_Mapper part lives in tests/stem-mapper.test.mjs).
// Inputs: full-scale square waves (±1), clipped noise (gain 2–10, clamped to ±1),
// DC offset (±0.5..1 plus a small signal, clamped), silence, normal gen.signal at
// amplitude 1, and very short clips (2048–4096 samples). Mono or stereo; stereo may
// be anti-phase (R = −L). levelMatch is random per run. Every emitted stem must be
// all-finite with peak ≤ 1. HQ stage 1 on clips under ~0.5 s may give exact-zero
// vocal/bass; that satisfies ≤ 1 and is not treated as a failure here.
const clamp1 = (v) => (v > 1 ? 1 : v < -1 ? -1 : v);

const fullScaleCaseGen = (() => {
  const kindGen = gen.oneOf('square', 'clippedNoise', 'dc', 'silence', 'signal');
  const lenGen = gen.oneOf(gen.int(2048, 4096), gen.int(4097, 8000));
  const chGen = gen.int(1, 2);
  const antiGen = gen.int(0, 1);
  const lmGen = gen.int(0, 1);
  const makeChannel = (rng, kind, n) => {
    const x = new Float32Array(n);
    if (kind === 'square') {
      const period = gen.int(2, 400)(rng);
      const off = gen.int(0, period - 1)(rng);
      for (let i = 0; i < n; i++) x[i] = ((i + off) % period) < period / 2 ? 1 : -1;
    } else if (kind === 'clippedNoise') {
      const g = gen.float(2, 10)(rng);
      for (let i = 0; i < n; i++) x[i] = clamp1(g * gaussian(rng) * 0.5);
    } else if (kind === 'dc') {
      const dc = (rng() < 0.5 ? -1 : 1) * gen.float(0.5, 1)(rng);
      const small = gen.signal({ minLength: n, maxLength: n, sampleRate: SR, amplitude: gen.float(0.01, 0.3)(rng) })(rng);
      for (let i = 0; i < n; i++) x[i] = clamp1(dc + small[i]);
    } else if (kind === 'signal') {
      x.set(gen.signal({ minLength: n, maxLength: n, sampleRate: SR, amplitude: 1 })(rng));
    }
    return x; // 'silence' stays all zeros
  };
  return (rng) => {
    const kind = kindGen(rng);
    const n = lenGen(rng);
    const channels = chGen(rng);
    const anti = channels === 2 && antiGen(rng) === 1;
    const L = makeChannel(rng, kind, n);
    const input = [L];
    if (channels === 2) input.push(anti ? L.map((v) => -v) : makeChannel(rng, kind, n));
    return { kind, n, channels, anti, levelMatch: lmGen(rng) === 1, input };
  };
})();

test('Feature: separation-accuracy, Property 17: 输出峰值不超过满幅（DSP 部分）', async (t) => {
  for (const mode of ['fast', 'high']) {
    await t.test(`mode ${mode}`, async () => {
      await forAll(fullScaleCaseGen, async ({ input, levelMatch }) => {
        const { stems, result } = await separate(input, mode, { levelMatch });
        assert.equal(result.mode, mode);
        const ids = Object.keys(stems);
        assert.ok(ids.length > 0, 'at least one stem emitted');
        for (const id of ids) {
          for (let c = 0; c < stems[id].length; c++) {
            const ch = stems[id][c];
            for (let i = 0; i < ch.length; i++) {
              if (!Number.isFinite(ch[i])) assert.fail(`stem ${id} ch ${c} sample ${i} not finite: ${ch[i]}`);
            }
          }
          const p = peakOf(stems[id]);
          assert.ok(p <= 1, `stem ${id} peak ${p} > 1`);
        }
      }, { runs: 100 });
    });
  }
});
