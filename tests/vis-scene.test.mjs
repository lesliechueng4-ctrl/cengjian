import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneAt, MAX_SHAPES } from '../public/js/vis-scene.js';
import { createVisData, VIS_STEM_IDS, ONSET_STEM_IDS, ALL_STEM_IDS } from '../public/js/vis-data.js';
import { forAll } from './helpers/prop.mjs';

const RUNS = 100;
const KINDS = ['disc', 'ring', 'wave', 'rect'];
const SIZE_FIELDS = ['r', 'width', 'glow', 'w', 'h'];

// ---------- generators ----------

const pick = (rng, list) => list[Math.floor(rng() * list.length)];

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

/** 严格递增、间隔 ≥ 5 帧的 Onset 帧序号；dense 时间隔为 5–6 帧。 */
function genOnsets(rng, frames, { dense = rng() < 0.25, min = 0 } = {}) {
  const out = [];
  const maxGap = dense ? 6 : 80;
  let i = Math.floor(rng() * 20);
  while (i < frames) {
    out.push(i);
    i += 5 + Math.floor(rng() * (maxGap - 4));
  }
  if (out.length < min && frames > 0) out.splice(0, out.length, 0);
  return out;
}

/**
 * Stem 分析结果（createVisData 的输入）。
 * ids：固定的 Stem 子集；否则随机子集（可能为空）。require：必须包含的 Stem。
 */
function genResults(rng, { ids, require = [], minOnsets = 0, maxDuration = 6 } = {}) {
  const duration = 0.3 + rng() * (maxDuration - 0.3);
  const frames = Math.ceil(duration * 100);
  const subset = ids ?? VIS_STEM_IDS.filter((id) => require.includes(id) || rng() < 0.7);
  const results = {};
  for (const id of subset) {
    const len = rng() < 0.2 ? Math.max(1, frames - Math.floor(rng() * 4)) : frames;
    results[id] = {
      env: genEnv(rng, len),
      onsets: ONSET_STEM_IDS.includes(id) ? Int32Array.from(genOnsets(rng, frames, { min: minOnsets })) : null,
      duration,
    };
  }
  return { results, duration, subset };
}

function genSize(rng) {
  const r = rng();
  if (r < 0.15) return [16 + Math.floor(rng() * 4081), 16];
  if (r < 0.3) return [16, 16 + Math.floor(rng() * 4081)];
  return [16 + Math.floor(rng() * 4081), 16 + Math.floor(rng() * 4081)];
}

function genTime(rng, duration) {
  const r = rng();
  if (r < 0.1) return -rng() * 5;
  if (r < 0.2) return duration + rng() * 5;
  if (r < 0.25) return pick(rng, [0, duration, 1e6, -1e6]);
  return rng() * duration;
}

function genOpts(rng, reduced) {
  const [width, height] = genSize(rng);
  return {
    selected: pick(rng, [...ALL_STEM_IDS, 'nope']),
    width,
    height,
    reducedMotion: reduced ?? rng() < 0.5,
  };
}

// ---------- helpers ----------

const byLayer = (shapes, id) => shapes.filter((s) => s.layer === id);
const sumAlpha = (shapes) => shapes.reduce((a, s) => a + s.alpha, 0);
const withoutAlpha = ({ alpha, ...rest }) => rest; // eslint-disable-line no-unused-vars

function approx(actual, expected, what) {
  const tol = 1e-9 * Math.max(1, Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} ≠ ${expected}`);
}

function checkShape(s, W, H) {
  assert.ok(KINDS.includes(s.kind), `kind ${s.kind}`);
  assert.ok(VIS_STEM_IDS.includes(s.layer), `layer ${s.layer}`);
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${s.kind}.${k} = ${v}`);
  }
  assert.ok(s.alpha >= 0 && s.alpha <= 1, `alpha ${s.alpha}`);
  assert.ok(Array.isArray(s.color) && s.color.length === 3, 'color shape');
  for (const c of s.color) assert.ok(Number.isInteger(c) && c >= 0 && c <= 255, `color ${c}`);
  for (const k of SIZE_FIELDS) if (k in s) assert.ok(s[k] >= 0, `${s.kind}.${k} = ${s[k]}`);
  const inX = (x) => x >= -0.25 * W && x <= 1.25 * W;
  const inY = (y) => y >= -0.25 * H && y <= 1.25 * H;
  if (s.kind === 'wave') {
    assert.ok(Array.isArray(s.ys) && s.ys.length > 0, 'ys');
    for (const y of s.ys) assert.ok(Number.isFinite(y), `ys ${y}`);
    assert.ok(Number.isFinite(s.x0) && Number.isFinite(s.x1), 'x0/x1');
    assert.ok(inX(s.x0) && inY(s.ys[0]), `wave start (${s.x0}, ${s.ys[0]})`);
  } else {
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y), 'x/y');
    assert.ok(inX(s.x) && inY(s.y), `${s.kind} at (${s.x}, ${s.y}) in ${W}x${H}`);
  }
}

// ---------- properties ----------

// Feature: stem-visualizer, Property 7: 场景确定性
// **Validates: Requirements 3.9, 5.1, 5.4, 5.5**
test('Property 7: 场景确定性', async () => {
  await forAll((rng) => {
    const { results, duration } = genResults(rng);
    const ts = Array.from({ length: 2 + Math.floor(rng() * 5) }, () => genTime(rng, duration));
    if (ts.length > 2) ts.push(ts[0]); // 重复的时刻
    return { results, ts, opts: genOpts(rng) };
  }, ({ results, ts, opts }) => {
    const vd = createVisData(results);
    const vdBefore = structuredClone(vd);
    const optsBefore = { ...opts };
    const seq = ts.map((t) => sceneAt(t, vd, opts));
    ts.forEach((t, i) => {
      const fresh = sceneAt(t, createVisData(results), { ...optsBefore });
      assert.deepStrictEqual(seq[i], fresh, `t = ${t}`);
    });
    assert.deepStrictEqual(vd, vdBefore, 'visData mutated');
    assert.deepStrictEqual(opts, optsBefore, 'opts mutated');
  }, { runs: RUNS });
});

// Feature: stem-visualizer, Property 8: 场景输出界限
// **Validates: Requirements 3.11, 3.12**
test('Property 8: 场景输出界限', async () => {
  await forAll((rng) => {
    const { results, duration } = genResults(rng);
    return { results, t: genTime(rng, duration), opts: genOpts(rng) };
  }, ({ results, t, opts }) => {
    const shapes = sceneAt(t, createVisData(results), opts);
    assert.ok(Array.isArray(shapes) && shapes.length <= MAX_SHAPES && MAX_SHAPES === 400);
    for (const s of shapes) checkShape(s, opts.width, opts.height);
  }, { runs: RUNS });
});

// Feature: stem-visualizer, Property 9: 每条 Stem 一层
// **Validates: Requirements 3.1**
test('Property 9: 每条 Stem 一层', async () => {
  await forAll((rng) => {
    const { results, duration, subset } = genResults(rng);
    return { results, subset, t: rng() * duration, opts: genOpts(rng) };
  }, ({ results, subset, t, opts }) => {
    const vd = createVisData(results);
    const normal = sceneAt(t, vd, { ...opts, reducedMotion: false });
    for (const s of normal) assert.ok(subset.includes(s.layer), `unexpected layer ${s.layer}`);
    const reduced = sceneAt(t, vd, { ...opts, reducedMotion: true });
    const layers = new Set(reduced.map((s) => s.layer));
    assert.deepStrictEqual([...layers].sort(), [...subset].sort());
    const colorOf = new Map();
    for (const s of [...normal, ...reduced]) {
      const c = s.color.join(',');
      if (colorOf.has(s.layer)) assert.equal(colorOf.get(s.layer), c, `layer ${s.layer} color varies`);
      else colorOf.set(s.layer, c);
    }
    const colors = [...colorOf.values()];
    assert.equal(new Set(colors).size, colors.length, `shared colors ${colors}`);
  }, { runs: RUNS });
});

// Feature: stem-visualizer, Property 10: Onset 窗口图形
// **Validates: Requirements 3.2, 3.3, 3.7**
test('Property 10: Onset 窗口图形', async () => {
  await forAll((rng) => {
    const { results, duration } = genResults(rng, { require: ONSET_STEM_IDS, minOnsets: 1 });
    const t = rng() < 0.85 ? rng() * duration : genTime(rng, duration);
    const pid = pick(rng, ['fx', 'other']);
    const ons = results[pid].onsets;
    const k = Math.floor(rng() * ons.length);
    const tBoost = ons[k] / 100 + rng() * 0.29;
    return { results, t, pid, k, tBoost, opts: genOpts(rng, false) };
  }, ({ results, t, pid, k, tBoost, opts }) => {
    const vd = createVisData(results);
    const shapes = sceneAt(t, vd, opts);
    const inWindow = (id, W) => Array.from(results[id].onsets).filter((i) => i / 100 > t - W && i / 100 <= t).length;

    const rings = byLayer(shapes, 'drums');
    assert.ok(rings.every((s) => s.kind === 'ring'), 'drums kinds');
    assert.equal(rings.length, Math.min(6, inWindow('drums', 0.6)), 'ring count');
    for (let i = 1; i < rings.length; i++) {
      assert.ok(rings[i].r > rings[i - 1].r, `ring radius not increasing at ${i}`);
      assert.ok(rings[i].alpha <= rings[i - 1].alpha, `ring alpha increasing at ${i}`);
    }

    const sparks = byLayer(shapes, 'perc');
    assert.ok(sparks.every((s) => s.kind === 'disc'), 'perc kinds');
    assert.equal(sparks.length, 10 * Math.min(6, inWindow('perc', 0.4)), 'spark count');

    const withIt = sumAlpha(byLayer(sceneAt(tBoost, vd, opts), pid));
    const removed = { ...results, [pid]: { ...results[pid], onsets: results[pid].onsets.filter((_, j) => j !== k) } };
    const without = sumAlpha(byLayer(sceneAt(tBoost, createVisData(removed), opts), pid));
    assert.ok(withIt >= without - 1e-9, `${pid} boost: ${withIt} < ${without}`);
  }, { runs: RUNS });
});

// Feature: stem-visualizer, Property 11: 随包络单调
// **Validates: Requirements 3.4, 3.5, 3.6, 3.8**
test('Property 11: 随包络单调', async () => {
  const MONO = ['bass', 'vocal', 'inst', 'harmony'];
  await forAll((rng) => {
    const { results, duration } = genResults(rng, { require: MONO });
    const t = rng() * duration;
    const hi = {};
    for (const id of MONO) {
      const e1 = results[id].env;
      const e2 = e1.slice();
      const c = Math.floor(t * 100);
      for (let i = Math.max(0, c - 25); i <= Math.min(e2.length - 1, c + 2); i++) {
        e2[i] = e1[i] + Math.floor(rng() * (256 - e1[i]));
      }
      hi[id] = { ...results[id], env: e2 };
    }
    return { results, hi, t, opts: genOpts(rng, false) };
  }, ({ results, hi, t, opts }) => {
    const s1 = sceneAt(t, createVisData(results), opts);
    const s2 = sceneAt(t, createVisData({ ...results, ...hi }), opts);
    const eps = 1e-9;

    const [b1] = byLayer(s1, 'bass');
    const [b2] = byLayer(s2, 'bass');
    assert.equal(b1.kind, 'rect');
    assert.ok(b2.h >= b1.h - eps, `bass h ${b2.h} < ${b1.h}`);
    assert.ok(b2.alpha >= b1.alpha - eps, `bass alpha ${b2.alpha} < ${b1.alpha}`);
    approx(b1.y + b1.h, opts.height, 'bass bottom edge');

    const cy = opts.height / 2;
    const dev = (s) => Math.max(...s.ys.map((y) => Math.abs(y - cy)));
    const [v1] = byLayer(s1, 'vocal');
    const [v2] = byLayer(s2, 'vocal');
    assert.equal(v1.kind, 'wave');
    assert.ok(dev(v2) >= dev(v1) - eps, `vocal deviation ${dev(v2)} < ${dev(v1)}`);

    for (const id of ['inst', 'harmony']) {
      const a = byLayer(s1, id);
      const b = byLayer(s2, id);
      assert.equal(a.length, b.length);
      a.forEach((s, i) => assert.ok(b[i].alpha >= s.alpha - eps, `${id}[${i}] alpha ${b[i].alpha} < ${s.alpha}`));
    }

    const silent = { ...results, vocal: { ...results.vocal, env: new Uint8Array(results.vocal.env.length) } };
    const [flat] = byLayer(sceneAt(t, createVisData(silent), opts), 'vocal');
    assert.ok(flat.ys.every((y) => y === cy), 'silent vocal is not a flat line');
  }, { runs: RUNS });
});

// Feature: stem-visualizer, Property 12: 选中音轨强调
// **Validates: Requirements 4.1, 4.2, 4.4**
test('Property 12: 选中音轨强调', async () => {
  await forAll((rng) => {
    const { results, duration } = genResults(rng);
    return { results, t: genTime(rng, duration), opts: genOpts(rng) };
  }, ({ results, t, opts }) => {
    const vd = createVisData(results);
    const actual = sceneAt(t, vd, opts);
    const derived = VIS_STEM_IDS.includes(opts.selected);
    for (const id of Object.keys(vd.stems)) {
      // 参考输出：该层被选中时权重为 1
      const ref = byLayer(sceneAt(t, vd, { ...opts, selected: id }), id);
      const got = byLayer(actual, id);
      const [A, S] = !derived ? [0.7, 0.9] : id === opts.selected ? [1, 1] : [0.35, 0.8];
      assert.equal(got.length, ref.length, `${id} count`);
      got.forEach((g, i) => {
        const r = ref[i];
        const tag = `${id}[${i}] ${g.kind}`;
        assert.equal(g.kind, r.kind, tag);
        assert.deepStrictEqual(g.color, r.color, `${tag} color`);
        approx(g.alpha, Math.min(1, r.alpha * A), `${tag} alpha`);
        for (const k of ['r', 'width', 'glow', 'h']) if (k in r) approx(g[k], r[k] * S, `${tag} ${k}`);
        if (g.kind === 'disc' || g.kind === 'ring') {
          approx(g.x, r.x, `${tag} x`);
          approx(g.y, r.y, `${tag} y`);
        } else if (g.kind === 'rect') {
          approx(g.x, r.x, `${tag} x`);
          approx(g.w, r.w, `${tag} w`);
          approx(g.y, opts.height - g.h, `${tag} y`);
        } else {
          approx(g.x0, r.x0, `${tag} x0`);
          approx(g.x1, r.x1, `${tag} x1`);
          const cy = opts.height / 2;
          g.ys.forEach((y, j) => approx(y - cy, (r.ys[j] - cy) * S, `${tag} ys[${j}]`));
        }
      });
    }
  }, { runs: RUNS });
});

// Feature: stem-visualizer, Property 13: 减少动态效果
// **Validates: Requirements 7.1, 7.2**
test('Property 13: 减少动态效果', async () => {
  await forAll((rng) => {
    const { results, duration } = genResults(rng);
    return {
      results,
      t1: genTime(rng, duration),
      t2: genTime(rng, duration),
      t: rng() < 0.8 ? rng() * (duration + 0.6) - 0.3 : genTime(rng, duration),
      opts: genOpts(rng, true),
    };
  }, ({ results, t1, t2, t, opts }) => {
    const vd = createVisData(results);
    const a = sceneAt(t1, vd, opts);
    const b = sceneAt(t2, vd, opts);
    assert.equal(a.length, b.length, 'shape count');
    a.forEach((s, i) => assert.deepStrictEqual(withoutAlpha(s), withoutAlpha(b[i]), `shape ${i} geometry`));

    const p = sceneAt(t, vd, opts);
    const q = sceneAt(t + 1 / 30, vd, opts);
    assert.equal(p.length, q.length);
    p.forEach((s, i) => {
      const d = Math.abs(s.alpha - q[i].alpha);
      assert.ok(d <= 0.05 + 1e-12, `${s.layer}[${i}] alpha jump ${d} at t = ${t}`);
    });
  }, { runs: RUNS });
});

// ---------- examples ----------

function typicalVisData() {
  const duration = 3;
  const frames = 300;
  const results = {};
  for (const id of VIS_STEM_IDS) {
    results[id] = { env: new Uint8Array(frames).fill(128), onsets: null, duration };
  }
  results.drums.onsets = Int32Array.from([50, 100, 120]); // (0.65, 1.25] 内：1.0、1.2
  results.perc.onsets = Int32Array.from([50, 100]);       // (0.85, 1.25] 内：1.0
  results.fx.onsets = Int32Array.from([110]);
  results.other.onsets = Int32Array.from([20]);
  return createVisData(results);
}

const summary = (shapes) => {
  const out = [];
  for (const s of shapes) {
    const last = out[out.length - 1];
    if (last && last.layer === s.layer && last.kind === s.kind) last.count++;
    else out.push({ layer: s.layer, kind: s.kind, count: 1 });
  }
  return out;
};

test('示例：典型时刻每种 Layer_Style 的 Shape（正常模式）', () => {
  const shapes = sceneAt(1.25, typicalVisData(), { selected: 'original', width: 640, height: 360 });
  assert.deepStrictEqual(summary(shapes), [
    { layer: 'inst', kind: 'disc', count: 1 },
    { layer: 'vocal', kind: 'wave', count: 1 },
    { layer: 'drums', kind: 'ring', count: 2 },
    { layer: 'bass', kind: 'rect', count: 1 },
    { layer: 'harmony', kind: 'disc', count: 5 },
    { layer: 'perc', kind: 'disc', count: 10 },
    { layer: 'fx', kind: 'disc', count: 40 },
    { layer: 'other', kind: 'disc', count: 40 },
  ]);
  const wave = shapes.find((s) => s.layer === 'vocal');
  assert.equal(wave.ys.length, 64);
  const rect = shapes.find((s) => s.layer === 'bass');
  assert.equal(rect.x, 0);
  assert.equal(rect.w, 640);
  const rings = shapes.filter((s) => s.layer === 'drums');
  for (const r of rings) {
    assert.equal(r.x, 320);
    assert.equal(r.y, 180);
  }
});

test('示例：典型时刻每种 Layer_Style 的 Shape（减少动态效果）', () => {
  const shapes = sceneAt(1.25, typicalVisData(), { selected: 'drums', width: 640, height: 360, reducedMotion: true });
  assert.deepStrictEqual(summary(shapes), [
    { layer: 'inst', kind: 'disc', count: 1 },
    { layer: 'vocal', kind: 'wave', count: 1 },
    { layer: 'drums', kind: 'ring', count: 1 },
    { layer: 'bass', kind: 'rect', count: 1 },
    { layer: 'harmony', kind: 'disc', count: 5 },
    { layer: 'perc', kind: 'disc', count: 1 },
    { layer: 'fx', kind: 'disc', count: 40 },
    { layer: 'other', kind: 'disc', count: 40 },
  ]);
  const wave = shapes.find((s) => s.layer === 'vocal');
  assert.ok(wave.ys.every((y) => y === 180));
  for (const s of shapes) assert.ok(s.alpha <= 0.4 + 1e-12, `${s.layer} alpha ${s.alpha}`);
});

test('示例：没有 Vis_Data 或尺寸无效时返回空列表', () => {
  const vd = typicalVisData();
  assert.deepStrictEqual(sceneAt(1, null, { selected: 'inst', width: 640, height: 360 }), []);
  assert.deepStrictEqual(sceneAt(1, vd, { selected: 'inst', width: 0, height: 360 }), []);
  assert.deepStrictEqual(sceneAt(1, createVisData({}), { selected: 'inst', width: 640, height: 360 }), []);
});
