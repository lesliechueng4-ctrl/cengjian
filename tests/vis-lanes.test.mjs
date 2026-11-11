import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  lanesAt, laneLayout, onsetsInWindow,
  LANE_PAST_SEC, LANE_FUTURE_SEC, LANE_MAX_SAMPLES, LANE_MAX_MARKERS, LANE_FLASH_SEC,
  LANE_ENV_SCALE, LANE_ONSET_ENV_SCALE, LANE_ALPHA, LANE_PAST_DIM, PLAYHEAD_COLOR,
} from '../public/js/vis-lanes.js';
import { createVisData, envelopeAt, VIS_STEM_IDS, ONSET_STEM_IDS, ALL_STEM_IDS } from '../public/js/vis-data.js';
import { LAYER_COLORS, emphasisFor, MAX_SHAPES } from '../public/js/vis-scene.js';
import { forAll } from './helpers/prop.mjs';

const RUNS = 100;
const KINDS = ['disc', 'ring', 'wave', 'rect', 'band'];
const SIZE_FIELDS = ['r', 'w', 'h', 'glow', 'width'];
const EPS = 1e-6;

// ---------- generators ----------

const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const isOnset = (id) => ONSET_STEM_IDS.includes(id);

/** Envelope：全 0、逐帧随机、0/255 硬跳变块、平滑起伏、常数。 */
function genEnv(rng, frames) {
  const env = new Uint8Array(frames);
  const mode = Math.floor(rng() * 5);
  if (mode === 1) {
    for (let i = 0; i < frames; i++) env[i] = Math.floor(rng() * 256);
  } else if (mode === 2) {
    let i = 0;
    let v = rng() < 0.5 ? 0 : 255;
    while (i < frames) {
      const len = 1 + Math.floor(rng() * 50);
      env.fill(v, i, Math.min(frames, i + len));
      i += len;
      v = 255 - v;
    }
  } else if (mode === 3) {
    const f = 0.01 + rng() * 0.2;
    const ph = rng() * 6.28;
    for (let i = 0; i < frames; i++) env[i] = Math.round(127.5 + 127.5 * Math.sin(f * i + ph));
  } else if (mode === 4) {
    env.fill(Math.floor(rng() * 256));
  }
  return env;
}

/** 严格递增、间隔 ≥ 5 帧的 Onset 帧序号；极密集时每 5 帧一个（4 秒窗口内 80 个，超过 48 个上限）。 */
function genOnsets(rng, frames) {
  const r = rng();
  const out = [];
  if (r < 0.1) return out;
  const dense = r < 0.4;
  let i = Math.floor(rng() * 20);
  while (i < frames) {
    out.push(i);
    i += dense ? 5 : 5 + Math.floor(rng() * 76);
  }
  return out;
}

/** Vis_Data：随机 Stem 子集（可能只有一条、可能全静音），时长 [minDur, maxDur]。 */
function genVisData(rng, { minDur = 0.3, maxDur = 8, ids } = {}) {
  const duration = minDur + rng() * (maxDur - minDur);
  const frames = Math.ceil(duration * 100);
  let subset = ids;
  if (!subset) {
    subset = VIS_STEM_IDS.filter(() => rng() < 0.6);
    if (subset.length === 0) subset = [pick(rng, VIS_STEM_IDS)];
  }
  const silent = rng() < 0.1;
  const results = {};
  for (const id of subset) {
    results[id] = {
      env: silent ? new Uint8Array(frames) : genEnv(rng, frames),
      onsets: isOnset(id) ? Int32Array.from(genOnsets(rng, frames)) : null,
      duration,
    };
  }
  return createVisData(results);
}

const genSelected = (rng) => (rng() < 0.1 ? 'nope' : pick(rng, ALL_STEM_IDS));

function genWidth(rng) {
  const r = rng();
  if (r < 0.15) return 1 + Math.floor(rng() * 8);
  if (r < 0.3) return 1 + rng() * 4095;
  return 1 + Math.floor(rng() * 4096);
}

function genHeight(rng) {
  const r = rng();
  if (r < 0.2) return 1 + Math.floor(rng() * 20);
  if (r < 0.4) return 1 + rng() * 511;
  return 1 + Math.floor(rng() * 512);
}

/** pastSec / futureSec：缺省、合法值、0、无效值。 */
function genWindowSec(rng) {
  const r = rng();
  if (r < 0.35) return undefined;
  if (r < 0.75) return rng() * 4;
  return pick(rng, [0, -1, NaN, Infinity, -Infinity, '2', null]);
}

/** 与模块文档一致的有效窗口：无效值各自回退，和为 0 时都回退。 */
function effectiveWindow(opts) {
  let past = Number.isFinite(opts.pastSec) && opts.pastSec >= 0 ? opts.pastSec : LANE_PAST_SEC;
  let future = Number.isFinite(opts.futureSec) && opts.futureSec >= 0 ? opts.futureSec : LANE_FUTURE_SEC;
  if (!(past + future > 0)) {
    past = LANE_PAST_SEC;
    future = LANE_FUTURE_SEC;
  }
  return { past, future };
}

function genOpts(rng, { reduced, withWindow = true } = {}) {
  const opts = { selected: genSelected(rng), width: genWidth(rng), height: genHeight(rng) };
  opts.reducedMotion = reduced ?? rng() < 0.5;
  if (withWindow) {
    const p = genWindowSec(rng);
    const f = genWindowSec(rng);
    if (p !== undefined) opts.pastSec = p;
    if (f !== undefined) opts.futureSec = f;
  }
  return opts;
}

function onsetTimes(vd, id) {
  const stem = vd.stems[id];
  return stem && stem.onsets ? Array.from(stem.onsets, (i) => i / vd.frameRate) : [];
}

/** t：任意范围（窗口跨过 0 或时长）、网格上、让某个 Onset 落在窗口边界或闪光窗口内。 */
function genTime(rng, vd, opts) {
  const { past, future } = effectiveWindow(opts);
  const dur = vd.duration;
  const r = rng();
  const all = [];
  for (const id of Object.keys(vd.stems)) all.push(...onsetTimes(vd, id));
  if (r < 0.4 || all.length === 0) return -3 + rng() * (dur + 6);
  const tau = pick(rng, all);
  if (r < 0.55) return tau + past;     // τ 恰在左边界
  if (r < 0.7) return tau - future;    // τ 恰在右边界
  if (r < 0.75) return tau;            // τ 恰在 Playhead
  return tau + rng() * 0.2;            // 闪光窗口附近
}

// ---------- helpers ----------

function gridOf(opts) {
  const { past, future } = effectiveWindow(opts);
  const W = opts.width;
  const S = past + future;
  const n = Math.min(LANE_MAX_SAMPLES, Math.max(1, Math.ceil(W / 2)));
  return { past, future, S, n, dt: S / n, px: W / S, playheadX: (W * past) / S };
}

function laneMap(vd, opts) {
  const map = new Map();
  for (const lane of laneLayout(Object.keys(vd.stems), opts.selected, opts.height)) map.set(lane.id, lane);
  return map;
}

function snapshot(vd) {
  const stems = {};
  for (const [id, s] of Object.entries(vd.stems)) {
    stems[id] = { env: Array.from(s.env), onsets: s.onsets ? Array.from(s.onsets) : null };
  }
  return { version: vd.version, frameRate: vd.frameRate, frames: vd.frames, duration: vd.duration, stems };
}

/** [t − past, t + future] ∩ [0, duration] 内的 Onset；超过 48 个时按 |τ − t|（并列取较早）保留 48 个，升序。 */
function refMarkerTimes(vd, id, t, past, future) {
  const lo = Math.max(t - past, 0);
  const hi = Math.min(t + future, vd.duration);
  const times = onsetTimes(vd, id).filter((tau) => tau >= lo && tau <= hi);
  if (times.length <= LANE_MAX_MARKERS) return times;
  const sorted = times.slice().sort((a, b) => (Math.abs(a - t) - Math.abs(b - t)) || (a - b));
  return sorted.slice(0, LANE_MAX_MARKERS).sort((a, b) => a - b);
}

const close = (a, b, eps = EPS) => Math.abs(a - b) <= eps;

// ---------- Property 1 ----------

// Feature: stem-lanes, Property 1: Lane 场景确定性
// **Validates: Requirements 8.1, 3.4, 3.5**
test('Property 1: lanesAt is deterministic and does not mutate its inputs', async () => {
  await forAll((rng) => {
    const vd = genVisData(rng);
    const opts = genOpts(rng);
    const base = Array.from({ length: 2 + Math.floor(rng() * 4) }, () => genTime(rng, vd, opts));
    const times = base.concat(base.filter(() => rng() < 0.5));
    for (let i = times.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [times[i], times[j]] = [times[j], times[i]];
    }
    return { vd, opts, times };
  }, ({ vd, opts, times }) => {
    const before = snapshot(vd);
    const optsBefore = { ...opts };
    const seq = times.map((t) => lanesAt(t, vd, opts));
    for (let i = 0; i < times.length; i++) {
      const fresh = lanesAt(times[i], createVisData(Object.fromEntries(
        Object.entries(before.stems).map(([id, s]) => [id, {
          env: Uint8Array.from(s.env), onsets: s.onsets ? Int32Array.from(s.onsets) : null, duration: vd.duration,
        }]),
      )), { ...optsBefore });
      assert.deepStrictEqual(seq[i], fresh, `t=${times[i]}`);
    }
    assert.deepStrictEqual(snapshot(vd), before);
    assert.deepStrictEqual(opts, optsBefore);
  }, { runs: RUNS });
});

test('isomorphism smoke: vis-lanes.js only has ./ imports and no host globals', async () => {
  const src = await readFile(new URL('../public/js/vis-lanes.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const specs = [...code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(specs.length > 0);
  for (const s of specs) assert.ok(s.startsWith('./'), `import ${s}`);
  assert.deepStrictEqual([...new Set(specs)].sort(), ['./vis-data.js', './vis-scene.js']);
  assert.doesNotMatch(code, /\bimport\s*\(/);
  for (const word of ['window', 'document', 'self', 'process', 'require']) {
    assert.doesNotMatch(code, new RegExp(`\\b${word}\\b`), word);
  }
});

// ---------- Property 2 ----------

// Feature: stem-lanes, Property 2: Lane 输出界限
// **Validates: Requirements 8.2, 8.3, 8.4, 8.5, 4.4**
test('Property 2: lanesAt output stays within shape, value, and lane bounds', async () => {
  await forAll((rng) => {
    const vd = genVisData(rng);
    const opts = genOpts(rng, { withWindow: false });
    return { vd, opts, t: genTime(rng, vd, opts) };
  }, ({ vd, opts, t }) => {
    const shapes = lanesAt(t, vd, opts);
    assert.ok(shapes.length > 0 && shapes.length <= MAX_SHAPES, `count ${shapes.length}`);
    const lanes = laneMap(vd, opts);
    const { dt, px } = gridOf(opts);
    const markers = new Map();
    for (const s of shapes) {
      assert.ok(KINDS.includes(s.kind), `kind ${s.kind}`);
      for (const [k, v] of Object.entries(s)) {
        if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k}=${v}`);
      }
      assert.ok(s.alpha >= 0 && s.alpha <= 1, `alpha ${s.alpha}`);
      assert.equal(s.color.length, 3);
      for (const c of s.color) assert.ok(Number.isInteger(c) && c >= 0 && c <= 255, `color ${c}`);
      for (const f of SIZE_FIELDS) if (f in s) assert.ok(s[f] >= 0, `${f}=${s[f]}`);
      const lane = lanes.get(s.layer);
      if (s.kind === 'band') {
        assert.ok(Array.isArray(s.hs) && s.hs.length >= 2);
        for (const v of s.hs) assert.ok(Number.isFinite(v) && v >= 0, `hs ${v}`);
        const m = Math.max(...s.hs);
        assert.ok(s.y - m >= lane.y - EPS && s.y + m <= lane.y + lane.h + EPS, 'band inside lane');
        assert.ok(s.x0 >= -dt * px - EPS, `x0 ${s.x0}`);
        assert.ok(s.x1 <= opts.width + dt * px + EPS, `x1 ${s.x1}`);
      }
      if (s.role === 'marker') {
        assert.ok(s.y >= lane.y - EPS && s.y + s.h <= lane.y + lane.h + EPS, 'marker inside lane');
        markers.set(s.layer, (markers.get(s.layer) || 0) + 1);
      }
    }
    for (const [id, c] of markers) assert.ok(c <= LANE_MAX_MARKERS, `${id}: ${c} markers`);
  }, { runs: RUNS });
});

test('Property 2: invalid sizes or empty stems give []', async () => {
  const bad = [0, -1, -0.5, 0.5, NaN, Infinity, -Infinity, undefined, '100'];
  await forAll((rng) => {
    const vd = genVisData(rng);
    const opts = genOpts(rng);
    const which = Math.floor(rng() * 3);
    if (which === 0) opts.width = pick(rng, bad);
    else if (which === 1) opts.height = pick(rng, bad);
    return { vd: which === 2 ? createVisData({}) : vd, opts, t: -2 + rng() * 10 };
  }, ({ vd, opts, t }) => {
    assert.deepStrictEqual(lanesAt(t, vd, opts), []);
  }, { runs: RUNS });
});

// ---------- Property 5 ----------

// Feature: stem-lanes, Property 5: 时间窗口映射与 Onset_Marker
// **Validates: Requirements 3.1, 3.2, 3.3, 3.6, 4.3, 4.4**
test('Property 5: Onset_Marker positions match the window reference model', async () => {
  await forAll((rng) => {
    const vd = genVisData(rng);
    const opts = genOpts(rng);
    return { vd, opts, t: genTime(rng, vd, opts) };
  }, ({ vd, opts, t }) => {
    const shapes = lanesAt(t, vd, opts);
    const { past, future, px, playheadX } = gridOf(opts);
    for (const lane of laneMap(vd, opts).values()) {
      const got = shapes.filter((s) => s.layer === lane.id && s.role === 'marker');
      if (!isOnset(lane.id)) {
        assert.equal(got.length, 0);
        continue;
      }
      const want = refMarkerTimes(vd, lane.id, t, past, future).map((tau) => playheadX + (tau - t) * px);
      assert.equal(got.length, want.length, `${lane.id} marker count`);
      for (let i = 0; i < want.length; i++) {
        const s = got[i];
        assert.ok(close(s.x + s.w / 2, want[i]), `${lane.id}[${i}] x ${s.x + s.w / 2} vs ${want[i]}`);
        assert.ok(close(s.h, 0.7 * lane.h), 'marker height');
        assert.ok(close(s.y + s.h / 2, lane.y + lane.h / 2), 'marker centre');
      }
    }
    // 不传 pastSec / futureSec 等于传 1 / 3
    const { pastSec, futureSec, ...rest } = opts;
    assert.deepStrictEqual(lanesAt(t, vd, rest), lanesAt(t, vd, { ...rest, pastSec: 1, futureSec: 3 }));
  }, { runs: RUNS });
});

test('onsetsInWindow includes both ends and clips to [0, duration]', () => {
  const vd = createVisData({
    drums: { env: new Uint8Array(200), onsets: Int32Array.from([0, 50, 100, 200, 250]), duration: 2 },
    bass: { env: new Uint8Array(200), onsets: null, duration: 2 },
  });
  assert.deepStrictEqual(onsetsInWindow(vd, 'drums', 0.5, 1), [0.5, 1]);      // t0、t1 上的都包含
  assert.deepStrictEqual(onsetsInWindow(vd, 'drums', 0.51, 0.99), []);
  assert.deepStrictEqual(onsetsInWindow(vd, 'drums', -1, 0), [0]);            // 0 上的包含
  assert.deepStrictEqual(onsetsInWindow(vd, 'drums', 1.5, 5), [2]);           // 时长上的包含，之后的排除
  assert.deepStrictEqual(onsetsInWindow(vd, 'drums', 2, 2), [2]);
  assert.deepStrictEqual(onsetsInWindow(vd, 'drums', -5, -0.1), []);
  assert.deepStrictEqual(onsetsInWindow(vd, 'drums', 1, 0.5), []);            // t0 > t1
  assert.deepStrictEqual(onsetsInWindow(vd, 'drums', NaN, 1), []);
  assert.deepStrictEqual(onsetsInWindow(vd, 'drums', 0, Infinity), []);
  assert.deepStrictEqual(onsetsInWindow(vd, 'bass', 0, 2), []);
  assert.deepStrictEqual(onsetsInWindow(vd, 'perc', 0, 2), []);
  assert.deepStrictEqual(onsetsInWindow(null, 'drums', 0, 2), []);
});

// ---------- Property 6 ----------

/** 每个 band 的采样 → [{ m, tau, h }]，m 为网格序号。 */
function bandSamples(s, t, grid) {
  const L = s.hs.length;
  const out = [];
  for (let j = 0; j < L; j++) {
    const x = s.x0 + (j * (s.x1 - s.x0)) / (L - 1);
    const tau = t + (x - grid.playheadX) / grid.px;
    const m = Math.round(tau / grid.dt);
    out.push({ m, tau, h: s.hs[j] });
  }
  return out;
}

/** stems 的 Proxy：每条 Stem 的 env 读取次数计数，不改变数据。 */
function countingVisData(vd) {
  const counts = Object.fromEntries(Object.keys(vd.stems).map((id) => [id, 0]));
  const wrappers = {};
  for (const [id, s] of Object.entries(vd.stems)) {
    wrappers[id] = { get env() { counts[id]++; return s.env; }, onsets: s.onsets };
  }
  const stems = new Proxy(vd.stems, {
    get: (target, key) => (Object.prototype.hasOwnProperty.call(wrappers, key) ? wrappers[key] : target[key]),
  });
  return { data: { ...vd, stems }, counts };
}

// Feature: stem-lanes, Property 6: 波形采样
// **Validates: Requirements 4.1, 4.2, 4.8, 3.6, 10.4**
test('Property 6: band samples sit on the grid and equal the scaled envelope', async () => {
  await forAll((rng) => {
    const vd = genVisData(rng);
    const opts = genOpts(rng);
    const grid = gridOf(opts);
    return { vd, opts, t: genTime(rng, vd, opts), k: Math.floor(rng() * 101) - 50, grid };
  }, ({ vd, opts, t, k, grid }) => {
    const lanes = laneMap(vd, opts);
    const perLane = (time) => {
      const shapes = lanesAt(time, vd, opts);
      const byLane = new Map();
      for (const lane of lanes.values()) {
        const bands = shapes.filter((s) => s.layer === lane.id && s.kind === 'band');
        const pastB = bands.find((s) => s.side === 'past');
        const futB = bands.find((s) => s.side === 'future');
        if (pastB && futB) assert.equal(pastB.x1, futB.x0, 'past.x1 === future.x0');
        const scale = isOnset(lane.id) ? LANE_ONSET_ENV_SCALE : LANE_ENV_SCALE;
        const hs = new Map();
        for (const b of bands) {
          assert.ok(close(b.y, lane.y + lane.h / 2), 'band centre line');
          for (const { m, tau, h } of bandSamples(b, time, grid)) {
            assert.ok(Math.abs(tau / grid.dt - m) <= 1e-6, `off grid ${tau / grid.dt}`);
            const want = scale * lane.h * envelopeAt(vd, lane.id, m * grid.dt);
            assert.ok(close(h, want), `${lane.id} m=${m}: ${h} vs ${want}`);
            if (m * grid.dt < 0 || m * grid.dt > vd.duration) assert.equal(h, 0, 'outside [0, duration] is 0');
            hs.set(m, h);
          }
        }
        byLane.set(lane.id, hs);
      }
      return byLane;
    };
    const a = perLane(t);
    const b = perLane(t + k * grid.dt);
    for (const [id, hsA] of a) {
      for (const [m, h] of b.get(id)) if (hsA.has(m)) assert.equal(h, hsA.get(m), `${id} m=${m} shift ${k}`);
    }
  }, { runs: RUNS });
});

// Feature: stem-lanes, Property 6: 波形采样
// **Validates: Requirements 10.4**
test('Property 6: each grid point is sampled once per lane, at most 402 per frame', async () => {
  await forAll((rng) => {
    const vd = genVisData(rng, { minDur: 6, maxDur: 10 });
    const opts = { selected: genSelected(rng), width: 40 + Math.floor(rng() * 4057), height: genHeight(rng) };
    // 整个窗口（含一个采样间隔的余量）都在 [0, duration] 内，使每次 envelopeAt 都读 env
    const t = 1.3 + rng() * (vd.duration - 4.6);
    return { vd, opts, t };
  }, ({ vd, opts, t }) => {
    const { data, counts } = countingVisData(vd);
    const someId = Object.keys(vd.stems)[0];
    envelopeAt(data, someId, 0.5);
    const perCall = counts[someId];
    assert.ok(perCall > 0);
    counts[someId] = 0;
    const shapes = lanesAt(t, data, opts);
    assert.deepStrictEqual(shapes, lanesAt(t, vd, opts), 'proxy does not change the output');
    const grid = gridOf(opts);
    for (const id of Object.keys(vd.stems)) {
      assert.equal(counts[id] % perCall, 0);
      const calls = counts[id] / perCall;
      assert.ok(calls <= LANE_MAX_SAMPLES + 2, `${id}: ${calls} calls`);
      const ms = new Set();
      for (const b of shapes.filter((s) => s.layer === id && s.kind === 'band')) {
        for (const { m } of bandSamples(b, t, grid)) ms.add(m);
      }
      assert.equal(calls, ms.size, `${id}: ${calls} calls for ${ms.size} grid points`);
    }
  }, { runs: RUNS });
});

// ---------- Property 7 ----------

function expectedBase(s) {
  const onset = isOnset(s.layer);
  const past = s.side === 'past';
  if (s.role === 'baseline') return LANE_ALPHA.baseline;
  if (s.role === 'band') return (onset ? LANE_ALPHA.faintBand : LANE_ALPHA.band) * (past ? LANE_PAST_DIM.band : 1);
  if (s.role === 'marker') return LANE_ALPHA.marker * (past ? LANE_PAST_DIM.marker : 1);
  throw new Error(`unexpected role ${s.role}`);
}

// Feature: stem-lanes, Property 7: 颜色与透明度模型
// **Validates: Requirements 2.3, 4.2, 4.5, 5.3, 7.2**
test('Property 7: colours come from LAYER_COLORS and alpha depends only on stem, selection, role and side', async () => {
  await forAll((rng) => {
    const vd = genVisData(rng);
    const opts = genOpts(rng);
    return { vd, opts, t: genTime(rng, vd, opts), t2: genTime(rng, vd, opts) };
  }, ({ vd, opts, t, t2 }) => {
    const alphaKeys = (shapes) => {
      const map = new Map();
      for (const s of shapes) {
        if (!VIS_STEM_IDS.includes(s.layer)) continue;
        assert.deepStrictEqual(s.color, [...LAYER_COLORS[s.layer]], `${s.layer} colour`);
        if (s.role === 'flash') continue;
        const a = emphasisFor(s.layer, opts.selected).alpha;
        const want = Math.min(1, expectedBase(s) * a);
        assert.ok(Math.abs(s.alpha - want) <= 1e-12, `${s.layer} ${s.role} ${s.side}: ${s.alpha} vs ${want}`);
        map.set(`${s.layer}|${s.role}|${s.side}`, s.alpha);
      }
      return map;
    };
    const first = alphaKeys(lanesAt(t, vd, opts));
    const second = alphaKeys(lanesAt(t2, vd, opts));
    for (const [key, alpha] of first) if (second.has(key)) assert.equal(second.get(key), alpha, key);
    // 淡 Band ≤ 0.3 × 同侧标记
    for (const id of ONSET_STEM_IDS) {
      if (!vd.stems[id]) continue;
      const a = emphasisFor(id, opts.selected).alpha;
      for (const side of ['past', 'future']) {
        const band = first.get(`${id}|band|${side}`);
        const marker = first.get(`${id}|marker|${side}`)
          ?? Math.min(1, LANE_ALPHA.marker * (side === 'past' ? LANE_PAST_DIM.marker : 1) * a);
        if (band !== undefined) assert.ok(band <= 0.3 * marker + 1e-12, `${id} ${side}: ${band} vs ${marker}`);
      }
    }
  }, { runs: RUNS });
});

// ---------- Property 8 ----------

// Feature: stem-lanes, Property 8: Playhead 与闪光
// **Validates: Requirements 4.6, 4.7**
test('Property 8: one white full-height Playhead and one flash per recently crossed Onset_Lane', async () => {
  await forAll((rng) => {
    const vd = genVisData(rng);
    const opts = genOpts(rng, { reduced: false });
    return { vd, opts, t: genTime(rng, vd, opts) };
  }, ({ vd, opts, t }) => {
    const shapes = lanesAt(t, vd, opts);
    const { playheadX } = gridOf(opts);
    const heads = shapes.filter((s) => s.role === 'playhead');
    assert.equal(heads.length, 1);
    const p = heads[0];
    assert.ok(close(p.x + p.w / 2, playheadX), 'playhead x');
    assert.equal(p.y, 0);
    assert.equal(p.h, opts.height);
    assert.deepStrictEqual(p.color, [...PLAYHEAD_COLOR]);
    assert.deepStrictEqual(p.color, [255, 255, 255]);
    for (const lane of laneMap(vd, opts).values()) {
      const flashes = shapes.filter((s) => s.layer === lane.id && s.role === 'flash');
      if (!isOnset(lane.id)) {
        assert.equal(flashes.length, 0, `${lane.id} has no flash`);
        continue;
      }
      const recent = onsetTimes(vd, lane.id)
        .filter((tau) => tau > t - LANE_FLASH_SEC && tau <= t && tau >= 0 && tau <= vd.duration);
      if (recent.length === 0) {
        assert.equal(flashes.length, 0, `${lane.id}: no recent onset`);
        continue;
      }
      assert.equal(flashes.length, 1, `${lane.id}: one flash`);
      const f = flashes[0];
      const tau = Math.max(...recent);
      const q = 1 - (t - tau) / LANE_FLASH_SEC;
      const want = Math.min(1, 0.9 * q * q * emphasisFor(lane.id, opts.selected).alpha);
      assert.ok(close(f.x, playheadX) && close(f.y, lane.y + lane.h / 2), 'flash position');
      assert.ok(Math.abs(f.alpha - want) <= 1e-9, `flash alpha ${f.alpha} vs ${want}`);
    }
  }, { runs: RUNS });
});

// ---------- Property 9 ----------

// Feature: stem-lanes, Property 9: 减少动态效果
// **Validates: Requirements 7.1**
test('Property 9: reduced motion only removes Playhead_Flash', async () => {
  await forAll((rng) => {
    const vd = genVisData(rng);
    const opts = genOpts(rng);
    return { vd, opts, t: genTime(rng, vd, opts) };
  }, ({ vd, opts, t }) => {
    const full = lanesAt(t, vd, { ...opts, reducedMotion: false });
    const reduced = lanesAt(t, vd, { ...opts, reducedMotion: true });
    assert.deepStrictEqual(reduced, full.filter((s) => s.role !== 'flash'));
  }, { runs: RUNS });
});
