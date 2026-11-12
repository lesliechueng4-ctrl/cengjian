import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  lanesAt, stageAt, laneLayout, laneHeaderHeight, rowEmphasis, onsetsInWindow,
  LANE_PAST_SEC, LANE_FUTURE_SEC, LANE_MAX_SAMPLES, LANE_MAX_MARKERS, LANE_POP_SEC, LANE_POP_SCALE,
  LANE_ENTRY_SEC, LANE_ENV_SCALE, LANE_ALPHA, LANE_PAST_DIM, PLAYHEAD_COLOR, ROW_COLORS, ROW_NAMES,
  STAGE_AMBIENT_LAYERS, STAGE_AMBIENT_ALPHA,
} from '../public/js/vis-lanes.js';
import { finishVisData, envelopeAt, VIS_STEM_IDS, ALL_STEM_IDS } from '../public/js/vis-data.js';
import { MAX_SHAPES, sceneAt } from '../public/js/vis-scene.js';
import { createRasterizer } from '../public/js/vis-raster.js';
import { forAll } from './helpers/prop.mjs';

const RUNS = 100;
const KINDS = ['disc', 'ring', 'rect', 'band', 'text'];
const EPS = 1e-6;
const close = (a, b, eps = EPS) => Math.abs(a - b) <= eps;

// ---------- generators ----------

const pick = (rng, list) => list[Math.floor(rng() * list.length)];

function genEnv(rng, frames) {
  const env = new Uint8Array(frames);
  const mode = rng();
  if (mode < 0.1) return env;
  let v = rng() * 255;
  for (let i = 0; i < frames; i++) {
    v = Math.min(255, Math.max(0, v + (rng() - 0.5) * 60));
    env[i] = rng() < 0.05 ? 0 : Math.round(v);
  }
  return env;
}

/** 严格递增的帧序号，平均间隔 gap 帧。 */
function genFrames(rng, frames, gap) {
  const out = [];
  let i = Math.floor(rng() * gap);
  while (i < frames) {
    out.push(i);
    i += 1 + Math.floor(rng() * 2 * gap);
  }
  return Int32Array.from(out);
}

function genVisData(rng, { minDur = 0.5, maxDur = 12, marks = true, beat = true } = {}) {
  const duration = minDur + rng() * (maxDur - minDur);
  const frames = Math.ceil(duration * 100);
  const stems = {};
  for (const id of VIS_STEM_IDS) {
    if (rng() < 0.8) stems[id] = { env: genEnv(rng, frames), onsets: ['drums', 'perc', 'fx', 'other'].includes(id) ? genFrames(rng, frames, 20) : null };
  }
  const vd = { version: 2, frameRate: 100, frames, duration, stems };
  if (marks) {
    const m = {};
    if (stems.drums) { m.K = genFrames(rng, frames, 30); m.S = genFrames(rng, frames, 60); m.H = genFrames(rng, frames, 8); }
    if (stems.bass && rng() < 0.7) {
      m.B = genFrames(rng, frames, 25);
      m.BL = Int32Array.from(m.B, () => 1 + Math.floor(rng() * 40));
    }
    if (Object.keys(m).length) vd.marks = m;
  }
  vd.beat = beat && rng() < 0.7 ? { period: 0.3 + rng() * 0.5, phase: rng() } : null;
  return finishVisData(vd);
}

const genSelected = (rng) => (rng() < 0.1 ? 'nope' : pick(rng, ALL_STEM_IDS));

function genOpts(rng, { reduced } = {}) {
  const o = {
    selected: genSelected(rng),
    width: rng() < 0.2 ? 1 + Math.floor(rng() * 40) : 100 + rng() * 1800,
    height: rng() < 0.2 ? 1 + Math.floor(rng() * 20) : 40 + rng() * 700,
    reducedMotion: reduced === undefined ? rng() < 0.3 : reduced,
  };
  if (rng() < 0.3) { o.pastSec = rng() * 2; o.futureSec = 0.2 + rng() * 5; }
  if (rng() < 0.3) o.labels = true;
  return o;
}

const genTime = (rng, vd) => (rng() < 0.1 ? -1 + rng() * (vd.duration + 2) : rng() * vd.duration);

function windowOf(o) {
  const past = Number.isFinite(o.pastSec) && o.pastSec >= 0 ? o.pastSec : LANE_PAST_SEC;
  const future = Number.isFinite(o.futureSec) && o.futureSec >= 0 ? o.futureSec : LANE_FUTURE_SEC;
  const S = past + future;
  return { past, future, px: o.width / S, playheadX: (o.width * past) / S };
}

const snapshot = (vd) => JSON.stringify(vd, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v));

// ---------- determinism, purity, bounds ----------

test('lanesAt is deterministic and does not mutate its inputs', async () => {
  await forAll((rng) => {
    const vd = genVisData(rng);
    return { vd, opts: genOpts(rng), t: genTime(rng, vd) };
  }, ({ vd, opts, t }) => {
    const before = snapshot(vd);
    const optsBefore = JSON.stringify(opts);
    const a = lanesAt(t, vd, opts);
    const b = lanesAt(t, vd, opts);
    assert.deepStrictEqual(a, b);
    assert.equal(snapshot(vd), before);
    assert.equal(JSON.stringify(opts), optsBefore);
    for (const s of a) if (s.color) s.color[0] = -1; // 返回的颜色是副本
    assert.deepStrictEqual(lanesAt(t, vd, opts), b);
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

test('lanesAt output: known kinds, finite numbers, alpha in [0, 1], at most MAX_SHAPES, Playhead last', async () => {
  await forAll((rng) => {
    const vd = genVisData(rng);
    return { vd, opts: genOpts(rng), t: genTime(rng, vd) };
  }, ({ vd, opts, t }) => {
    const shapes = lanesAt(t, vd, opts);
    if (laneLayout(vd, opts.selected, opts.height).length === 0) {
      assert.deepStrictEqual(shapes, []);
      return;
    }
    assert.ok(shapes.length >= 1 && shapes.length <= MAX_SHAPES, `count ${shapes.length}`);
    for (const s of shapes) {
      assert.ok(KINDS.includes(s.kind), s.kind);
      assert.ok(s.alpha >= 0 && s.alpha <= 1, `alpha ${s.alpha}`);
      assert.equal(s.color.length, 3);
      for (const f of ['x', 'y', 'x0', 'x1', 'r', 'w', 'h', 'glow', 'width', 'size']) {
        if (f in s) assert.ok(Number.isFinite(s[f]), `${s.kind}.${f} = ${s[f]}`);
      }
      for (const f of ['r', 'w', 'h', 'glow', 'width', 'size']) if (f in s) assert.ok(s[f] >= 0, `${s.kind}.${f}`);
      if (s.kind === 'band') for (const h of s.hs) assert.ok(Number.isFinite(h) && h >= 0);
      if (s.kind === 'text') assert.ok(typeof s.text === 'string' && s.text.length > 0);
    }
    // Playhead：最后一个，白色，贯穿全高
    const { playheadX } = windowOf(opts);
    const p = shapes[shapes.length - 1];
    assert.equal(p.role, 'playhead');
    assert.deepStrictEqual(p.color, [...PLAYHEAD_COLOR]);
    assert.equal(p.alpha, LANE_ALPHA.playhead);
    assert.equal(p.y, 0);
    assert.equal(p.h, opts.height);
    assert.ok(close(p.x + p.w / 2, playheadX));
    assert.equal(shapes.filter((s) => s.role === 'playhead').length, 1);
  }, { runs: RUNS });
});

test('invalid sizes, a non-finite time or no rows give []', () => {
  const vd = finishVisData({ frameRate: 100, frames: 100, duration: 1, stems: { vocal: { env: new Uint8Array(100).fill(200), onsets: null } }, beat: null });
  const ok = { selected: 'vocal', width: 300, height: 100 };
  assert.ok(lanesAt(0.5, vd, ok).length > 0);
  for (const bad of [{ width: 0 }, { width: NaN }, { height: 0.5 }, { height: Infinity }]) {
    assert.deepStrictEqual(lanesAt(0.5, vd, { ...ok, ...bad }), []);
  }
  assert.deepStrictEqual(lanesAt(NaN, vd, ok), []);
  assert.deepStrictEqual(lanesAt(0.5, null, ok), []);
  assert.deepStrictEqual(lanesAt(0.5, { ...vd, stems: {} }, ok), []);
  assert.deepStrictEqual(lanesAt(0.5, vd, undefined), []);
});

// ---------- hits ----------

function rowBox(vd, opts, id) {
  const header = laneHeaderHeight(vd, opts.width, opts.height);
  return laneLayout(vd, opts.selected, opts.height, header).find((l) => l.id === id);
}

test('hits: one shape per Kick / Snare / Hi-hat in the window, at playheadX + (τ − t) × px, coloured by row', async () => {
  await forAll((rng) => {
    const vd = genVisData(rng, { minDur: 2 });
    vd.stems.drums = vd.stems.drums || { env: genEnv(rng, vd.frames), onsets: genFrames(rng, vd.frames, 20) };
    vd.marks = { ...(vd.marks || {}), K: genFrames(rng, vd.frames, 30), S: genFrames(rng, vd.frames, 60), H: genFrames(rng, vd.frames, 8) };
    finishVisData(vd);
    const opts = genOpts(rng, { reduced: false });
    opts.width = 400 + rng() * 1200;
    opts.height = 120 + rng() * 400;
    return { vd, opts, t: genTime(rng, vd) };
  }, ({ vd, opts, t }) => {
    const { past, future, px, playheadX } = windowOf(opts);
    const shapes = lanesAt(t, vd, opts);
    const emph = rowEmphasis(laneLayout(vd, opts.selected, opts.height).map((l) => l.id), opts.selected);
    for (const id of ['K', 'S', 'H']) {
      const box = rowBox(vd, opts, id);
      const cy = box.y + box.h / 2;
      const lower = Math.max(0, t - past);
      const upper = Math.min(vd.duration, t + future);
      let want = Array.from(vd.marks[id], (f) => f / 100).filter((tau) => tau >= lower && tau <= upper);
      while (want.length > LANE_MAX_MARKERS) {
        if (Math.abs(want[want.length - 1] - t) >= Math.abs(want[0] - t)) want.pop();
        else want.shift();
      }
      const hits = shapes.filter((s) => s.layer === id && s.role === 'hit');
      assert.equal(hits.length, want.length, `${id} count`);
      hits.forEach((s, k) => {
        const tau = want[k];
        const age = t - tau;
        const p = age >= 0 && age < LANE_POP_SEC ? 1 - age / LANE_POP_SEC : 0;
        const cx = s.kind === 'disc' ? s.x : s.x + s.w / 2;
        assert.ok(close(cx, playheadX + (tau - t) * px, 1e-5), `${id} x`);
        assert.ok(close(s.kind === 'disc' ? s.y : s.y + s.h / 2, cy, 1e-5), `${id} y`);
        assert.equal(s.kind, id === 'K' ? 'disc' : 'rect');
        assert.deepStrictEqual(s.color, [...ROW_COLORS[id]]);
        assert.equal(s.side, age >= 0 ? 'past' : 'future');
        const base = p > 0 ? LANE_ALPHA.pop : age >= 0 ? LANE_ALPHA.past : LANE_ALPHA.future;
        assert.ok(close(s.alpha, Math.min(1, base * emph[id])), `${id} alpha`);
        if (id === 'K') assert.ok(close(s.r, Math.max(1.5, 0.2 * box.h) * (1 + LANE_POP_SCALE * p), 1e-5), 'Kick grows while popping');
      });
      // Pop：每个 0.25 秒内越过播放线的音符在播放线上炸一个圆环
      const popping = want.filter((tau) => t - tau >= 0 && t - tau < LANE_POP_SEC && 1 - (t - tau) / LANE_POP_SEC > 0);
      const rings = shapes.filter((s) => s.layer === id && s.role === 'pop');
      assert.equal(rings.length, popping.length, `${id} pops`);
      for (const r of rings) {
        assert.equal(r.kind, 'ring');
        assert.ok(close(r.x, playheadX) && close(r.y, cy, 1e-5));
      }
    }
  }, { runs: RUNS });
});

test('a hit is small and dim before the Playhead, largest and brightest right on it, dim again after 0.25 s', () => {
  const vd = finishVisData({
    frameRate: 100, frames: 400, duration: 4, beat: null,
    stems: { drums: { env: new Uint8Array(400), onsets: null } }, marks: { K: Int32Array.of(200) },
  });
  const at = (t) => lanesAt(t, vd, { selected: 'drums', width: 800, height: 100 }).find((s) => s.role === 'hit');
  const before = at(1.5);
  const on = at(2.0);
  const mid = at(2.1);
  const after = at(2.3);
  assert.equal(before.alpha, LANE_ALPHA.future);
  assert.equal(on.alpha, LANE_ALPHA.pop);
  assert.equal(after.alpha, LANE_ALPHA.past);
  assert.ok(close(on.r, before.r * (1 + LANE_POP_SCALE)));
  assert.ok(mid.r < on.r && mid.r > after.r);
  assert.ok(close(after.r, before.r));
  assert.ok(close(on.x, 200) && before.x > 200 && after.x < 200, 'flows from right to left through the Playhead at 25%');
});

test('without marks the drum stem is one 鼓 row drawn from its Onsets', () => {
  const vd = finishVisData({
    frameRate: 100, frames: 300, duration: 3, beat: null,
    stems: { drums: { env: new Uint8Array(300), onsets: Int32Array.of(50, 150, 250) } },
  });
  const shapes = lanesAt(1.0, vd, { selected: 'original', width: 800, height: 100 });
  const hits = shapes.filter((s) => s.role === 'hit');
  assert.deepStrictEqual(hits.map((s) => s.layer), ['drums', 'drums', 'drums']);
  assert.ok(hits.every((s) => s.kind === 'disc'));
  assert.deepStrictEqual(onsetsInWindow(vd, 'drums', 0.5, 2.5), [0.5, 1.5, 2.5]);
  assert.deepStrictEqual(onsetsInWindow(vd, 'drums', -1, 9), [0.5, 1.5, 2.5]);
  assert.deepStrictEqual(onsetsInWindow(vd, 'vocal', 0, 3), []);
});

// ---------- bass notes ----------

test('bass notes: a bar from start to end; the sounding one is taller and brightest', () => {
  const vd = finishVisData({
    frameRate: 100, frames: 600, duration: 6, beat: null,
    stems: { bass: { env: new Uint8Array(600).fill(100), onsets: null } },
    marks: { B: Int32Array.of(100, 300, 500), BL: Int32Array.of(50, 100, 20) },
  });
  const opts = { selected: 'bass', width: 800, height: 100 };
  const { px, playheadX } = windowOf(opts);
  const t = 3.5;
  const notes = lanesAt(t, vd, opts).filter((s) => s.role === 'note');
  assert.equal(notes.length, 2, 'the note that ended before the window is skipped');
  const [sounding, next] = notes;
  assert.ok(close(sounding.x, playheadX + (3 - t) * px) && close(sounding.w, 1 * px));
  assert.ok(close(next.x, playheadX + (5 - t) * px) && close(next.w, 0.2 * px));
  assert.equal(sounding.alpha, LANE_ALPHA.pop);
  assert.equal(next.alpha, LANE_ALPHA.note);
  assert.ok(sounding.h > next.h);
  assert.equal(lanesAt(t, vd, opts).filter((s) => s.kind === 'band').length, 0, 'no waveform when the notes are known');
  assert.equal(lanesAt(3.1, vd, opts).filter((s) => s.role === 'pop').length, 1, 'a note start pops too');
  const past = lanesAt(4.5, vd, opts).filter((s) => s.role === 'note')[0];
  assert.equal(past.alpha, LANE_ALPHA.past);
});

// ---------- waveform rows ----------

test('waveform rows: band samples sit on a fixed time grid and equal the scaled envelope; the past part is dimmer', async () => {
  await forAll((rng) => {
    const vd = genVisData(rng, { marks: false, minDur: 2 });
    vd.stems.vocal = { env: genEnv(rng, vd.frames), onsets: null };
    finishVisData(vd);
    const opts = { selected: genSelected(rng), width: 100 + rng() * 1500, height: 60 + rng() * 400, reducedMotion: rng() < 0.5 };
    return { vd, opts, t: rng() * vd.duration };
  }, ({ vd, opts, t }) => {
    const { past, future, px, playheadX } = windowOf(opts);
    const S = past + future;
    const n = Math.min(LANE_MAX_SAMPLES, Math.max(1, Math.ceil(opts.width / 2)));
    const dt = S / n;
    const box = rowBox(vd, opts, 'vocal');
    const a = rowEmphasis(laneLayout(vd, opts.selected, opts.height).map((l) => l.id), opts.selected).vocal;
    const bands = lanesAt(t, vd, opts).filter((s) => s.layer === 'vocal' && s.kind === 'band');
    assert.ok(bands.length >= 1 && bands.length <= 2);
    let samples = 0;
    for (const b of bands) {
      samples += b.hs.length;
      const step = b.hs.length > 1 ? (b.x1 - b.x0) / (b.hs.length - 1) : 0;
      b.hs.forEach((h, j) => {
        const tau = t + (b.x0 + step * j - playheadX) / px;
        const m = Math.round(tau / dt);
        assert.ok(close(tau, m * dt, 1e-6), 'on the grid');
        assert.ok(close(h, LANE_ENV_SCALE * box.h * envelopeAt(vd, 'vocal', m * dt), 1e-6), 'scaled envelope');
      });
      assert.ok(close(b.alpha, LANE_ALPHA.band * (b.side === 'past' ? LANE_PAST_DIM : 1) * a));
      assert.ok(close(b.y, box.y + box.h / 2, 1e-6));
    }
    assert.ok(samples <= LANE_MAX_SAMPLES + 3);
  }, { runs: RUNS });
});

// ---------- beat grid ----------

test('beat lines: one per beat in the window, every 4th is a bar line with number 1; none without a beat grid', async () => {
  await forAll((rng) => {
    const vd = genVisData(rng, { minDur: 3 });
    vd.beat = { period: 0.3 + rng() * 0.6, phase: rng() * 2 };
    const opts = { selected: genSelected(rng), width: 300 + rng() * 1500, height: 80 + rng() * 500 };
    return { vd, opts, t: rng() * vd.duration };
  }, ({ vd, opts, t }) => {
    const { past, future, px, playheadX } = windowOf(opts);
    const { period, phase } = vd.beat;
    const shapes = lanesAt(t, vd, opts);
    const lines = shapes.filter((s) => s.layer === 'beat' && s.kind === 'rect');
    const want = [];
    for (let n = Math.ceil((t - past - phase) / period); n <= Math.floor((t + future - phase) / period); n++) {
      const tau = phase + n * period;
      if (tau >= 0 && tau <= vd.duration) want.push({ tau, num: ((n % 4) + 4) % 4 });
    }
    assert.equal(lines.length, want.length);
    lines.forEach((s, k) => {
      assert.ok(close(s.x + s.w / 2, playheadX + (want[k].tau - t) * px, 1e-5));
      assert.equal(s.role, want[k].num === 0 ? 'bar' : 'beat');
      assert.equal(s.alpha, want[k].num === 0 ? LANE_ALPHA.bar : LANE_ALPHA.beat);
    });
    const numbers = shapes.filter((s) => s.role === 'beat-number');
    if (laneHeaderHeight(vd, opts.width, opts.height) * 0.72 >= 6) {
      assert.deepStrictEqual(numbers.map((s) => s.text), want.map((w) => String(w.num + 1)));
    } else {
      assert.equal(numbers.length, 0, 'numbers too small to read are left out');
    }
    // 没有拍子网格：没有拍线，行从顶部开始
    const plain = lanesAt(t, { ...vd, beat: null }, opts);
    assert.equal(plain.filter((s) => s.layer === 'beat').length, 0);
  }, { runs: RUNS });
});

// ---------- entries ----------

test('entry: for 1.2 s after a row comes in, the row flashes and shows 「<name> 进」', () => {
  const env = new Uint8Array(1000);
  env.fill(200, 600, 1000); // 人声在 6 秒处进
  const vd = finishVisData({ frameRate: 100, frames: 1000, duration: 10, beat: null, stems: { vocal: { env, onsets: null } } });
  assert.deepStrictEqual(Array.from(vd.entries.vocal), [600]);
  const opts = { selected: 'original', width: 800, height: 100 };
  const pickEntry = (t, o = opts) => {
    const shapes = lanesAt(t, vd, o);
    return { flash: shapes.find((s) => s.role === 'entry'), text: shapes.find((s) => s.role === 'entry-text') };
  };
  assert.deepStrictEqual(pickEntry(5.9), { flash: undefined, text: undefined });
  const on = pickEntry(6.15);
  assert.equal(on.text.text, `${ROW_NAMES.vocal} 进`);
  assert.deepStrictEqual(on.text.color, [...ROW_COLORS.vocal]);
  assert.ok(close(on.flash.alpha, LANE_ALPHA.entry), 'full strength 0.15 s in');
  assert.ok(on.flash.x === 0 && on.flash.w === 800 && on.flash.y === 0 && on.flash.h === 100, 'the whole row');
  const later = pickEntry(6.9);
  assert.ok(later.flash.alpha < on.flash.alpha && later.flash.alpha > 0, 'fades');
  assert.deepStrictEqual(pickEntry(6 + LANE_ENTRY_SEC + 0.01), { flash: undefined, text: undefined });
  const reduced = pickEntry(6.15, { ...opts, reducedMotion: true });
  assert.equal(reduced.flash, undefined, 'no flash with reduced motion');
  assert.equal(reduced.text.text, `${ROW_NAMES.vocal} 进`, 'the name still shows');
});

// ---------- reduced motion ----------

test('reduced motion: no Pop rings, no growing, no row flash; everything else is unchanged', async () => {
  await forAll((rng) => {
    const vd = genVisData(rng, { minDur: 2 });
    return { vd, opts: genOpts(rng, { reduced: false }), t: rng() * vd.duration };
  }, ({ vd, opts, t }) => {
    const normal = lanesAt(t, vd, opts);
    const reduced = lanesAt(t, vd, { ...opts, reducedMotion: true });
    assert.equal(reduced.filter((s) => s.role === 'pop' || s.role === 'entry').length, 0);
    const strip = (list) => list.filter((s) => s.role !== 'pop' && s.role !== 'entry')
      .map((s) => (s.role === 'hit' ? { layer: s.layer, side: s.side, alpha: s.alpha, kind: s.kind } : s.role === 'entry-text' ? { ...s, alpha: 0 } : s));
    if (normal.length < MAX_SHAPES) assert.deepStrictEqual(strip(reduced), strip(normal));
    const { playheadX, px } = windowOf(opts);
    for (const s of reduced.filter((x) => x.role === 'hit' && x.kind === 'disc')) {
      const same = reduced.filter((x) => x.role === 'hit' && x.kind === 'disc' && x.layer === s.layer);
      assert.ok(same.every((x) => close(x.r, same[0].r)), 'all hits of a row have the same size');
    }
    assert.ok(Number.isFinite(playheadX) && Number.isFinite(px));
  }, { runs: RUNS });
});

// ---------- stage (audio-only) ----------

test('stageAt: the timeline with row names over the dimmed ambient layers of the scene', async () => {
  await forAll((rng) => {
    const vd = genVisData(rng, { minDur: 2 });
    const opts = { selected: genSelected(rng), width: 640 + rng() * 640, height: 360 + rng() * 360, reducedMotion: rng() < 0.3 };
    return { vd, opts, t: rng() * vd.duration };
  }, ({ vd, opts, t }) => {
    const stage = stageAt(t, vd, opts);
    const lanes = lanesAt(t, vd, { ...opts, labels: true });
    if (lanes.length === 0) {
      assert.deepStrictEqual(stage, []);
      return;
    }
    assert.deepStrictEqual(stage.slice(stage.length - lanes.length), lanes, 'timeline on top');
    const ambient = stage.slice(0, stage.length - lanes.length);
    const scene = sceneAt(t, vd, { selected: 'original', width: opts.width, height: opts.height, reducedMotion: opts.reducedMotion })
      .filter((s) => STAGE_AMBIENT_LAYERS.includes(s.layer));
    assert.equal(ambient.length, scene.length);
    ambient.forEach((s, k) => {
      assert.ok(close(s.alpha, scene[k].alpha * STAGE_AMBIENT_ALPHA));
      assert.deepStrictEqual({ ...s, alpha: 0 }, { ...scene[k], alpha: 0 });
    });
    const names = lanes.filter((s) => s.role === 'label').map((s) => s.text);
    const rows = laneLayout(vd, opts.selected, opts.height).map((l) => ROW_NAMES[l.id]);
    assert.deepStrictEqual(names, rows, 'one name per row');
  }, { runs: RUNS });
});

test('the software rasterizer draws the timeline and ignores text shapes', () => {
  const vd = finishVisData({
    frameRate: 100, frames: 400, duration: 4, beat: { period: 0.5, phase: 0 },
    stems: { drums: { env: new Uint8Array(400), onsets: null } }, marks: { K: Int32Array.of(100, 150, 200) },
  });
  const shapes = lanesAt(1.5, vd, { selected: 'original', width: 320, height: 96, labels: true });
  assert.ok(shapes.some((s) => s.kind === 'text'));
  const raster = createRasterizer(320, 96);
  const withText = Uint8Array.from(raster.render(shapes, [11, 13, 20]));
  const withoutText = Uint8Array.from(raster.render(shapes.filter((s) => s.kind !== 'text'), [11, 13, 20]));
  assert.deepStrictEqual(withText, withoutText);
  let lit = 0;
  for (let i = 0; i < withText.length; i += 3) if (withText[i] > 100) lit++;
  assert.ok(lit > 20, 'the popping Kick is drawn');
});
