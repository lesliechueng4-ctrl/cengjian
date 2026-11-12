import test from 'node:test';
import assert from 'node:assert/strict';
import {
  laneLayout, laneLabelSpecs, laneRows, laneHeaderHeight, rowEmphasis, stackedLayout,
  ROW_ORDER, LANE_LABEL_MIN_PX, LANE_SELECTED_WEIGHT, LANE_EMPHASIS,
} from '../public/js/vis-lanes.js';
import { VIS_STEM_IDS, ALL_STEM_IDS } from '../public/js/vis-data.js';
import { forAll } from './helpers/prop.mjs';

const RUNS = 100;
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const UNKNOWN_IDS = ['nope', '', '__proto__', 'Drums', 'toString'];
const env = new Uint8Array(10);

/** Vis_Data 的骨架：VIS_STEM_IDS 的随机子集；有鼓时随机带 K / S / H，有贝斯时随机带 B / BL，随机带拍子网格。 */
function genVisData(rng) {
  const stems = {};
  for (const id of VIS_STEM_IDS) if (rng() < 0.6) stems[id] = { env, onsets: null };
  const vd = { frameRate: 100, frames: 10, duration: 0.1, stems, beat: rng() < 0.5 ? { period: 0.5, phase: 0 } : null };
  const marks = {};
  if (stems.drums && rng() < 0.7) for (const k of ['K', 'S', 'H']) if (rng() < 0.8) marks[k] = new Int32Array(0);
  if (stems.bass && rng() < 0.5) { marks.B = new Int32Array(0); marks.BL = new Int32Array(0); }
  if (Object.keys(marks).length) vd.marks = marks;
  return vd;
}

const genSelected = (rng) => (rng() < 0.15 ? pick(rng, UNKNOWN_IDS) : pick(rng, ALL_STEM_IDS));

function genHeight(rng, max = 1000) {
  const r = rng();
  if (r < 0.3) return 1 + Math.floor(rng() * max);
  return 1 + rng() * (max - 1);
}

function expectedRows(vd, selected) {
  const rows = [];
  const hits = ['K', 'S', 'H'].filter((k) => vd.marks && vd.marks[k]);
  if (hits.length) rows.push(...hits);
  else if (vd.stems.drums) rows.push('drums');
  for (const id of ['bass', 'vocal', 'harmony']) if (vd.stems[id]) rows.push(id);
  if ((selected === 'fx' || selected === 'other') && vd.stems[selected]) rows.push(selected);
  return rows;
}

test('laneRows: Kick / Snare / Hi-hat rows with marks, one 鼓 row without; fx / other only when selected; in ROW_ORDER', async () => {
  await forAll((rng) => ({ vd: genVisData(rng), selected: genSelected(rng) }), ({ vd, selected }) => {
    const rows = laneRows(vd, selected);
    assert.deepStrictEqual(rows, expectedRows(vd, selected));
    assert.deepStrictEqual(rows, ROW_ORDER.filter((id) => rows.includes(id)), 'ROW_ORDER');
    assert.ok(!rows.includes('inst') && !rows.includes('perc'), 'no row for 纯伴奏 / 额外打击乐');
  }, { runs: RUNS });
  assert.deepStrictEqual(laneRows(null, 'drums'), []);
  assert.deepStrictEqual(laneRows({}, 'drums'), []);
});

test('rowEmphasis: the rows of the selected stem are 1 and the rest 0.5; otherwise all 0.85', () => {
  const rows = ['K', 'S', 'H', 'bass', 'vocal', 'harmony'];
  const all = Object.fromEntries(rows.map((id) => [id, LANE_EMPHASIS.all]));
  const only = (...on) => Object.fromEntries(rows.map((id) => [id, on.includes(id) ? LANE_EMPHASIS.selected : LANE_EMPHASIS.other]));
  assert.deepStrictEqual(rowEmphasis(rows, 'original'), all);
  assert.deepStrictEqual(rowEmphasis(rows, 'inst'), all, '纯伴奏 has no row of its own');
  assert.deepStrictEqual(rowEmphasis(rows, 'nope'), all);
  assert.deepStrictEqual(rowEmphasis(rows, 'drums'), only('K', 'S', 'H'));
  assert.deepStrictEqual(rowEmphasis(rows, 'perc'), only('H'), '额外打击乐 is the Hi-hat row');
  assert.deepStrictEqual(rowEmphasis(rows, 'bass'), only('bass'));
  assert.deepStrictEqual(rowEmphasis(['drums', 'bass'], 'perc'), { drums: LANE_EMPHASIS.all, bass: LANE_EMPHASIS.all }, 'no Hi-hat row');
});

test('laneLayout tiles [top, height) in row order; a selected row is 1.8× its normal share', async () => {
  await forAll((rng) => {
    const height = genHeight(rng);
    return { vd: genVisData(rng), selected: genSelected(rng), height, top: rng() < 0.5 ? 0 : rng() * height * 0.3 };
  }, ({ vd, selected, height, top }) => {
    const layout = laneLayout(vd, selected, height, top);
    const rows = laneRows(vd, selected);
    assert.deepStrictEqual(layout.map((l) => l.id), rows);
    if (rows.length === 0) return;
    assert.ok(Math.abs(layout[0].y - top) <= 1e-9);
    for (let k = 0; k + 1 < layout.length; k++) {
      assert.ok(layout[k].h > 0);
      assert.ok(Math.abs(layout[k + 1].y - (layout[k].y + layout[k].h)) <= 1e-9, `gap after ${k}`);
    }
    const last = layout[layout.length - 1];
    assert.ok(Math.abs(last.y + last.h - height) <= 1e-9, 'ends at height');
    // 选中与否只改变相对高度：同一行在选中时的占比是不选中时的 1.8 倍（按其余行归一化）
    const plain = laneLayout(vd, 'original', height, top);
    const emph = rowEmphasis(rows, selected);
    const on = rows.filter((id) => emph[id] === LANE_EMPHASIS.selected);
    const off = rows.filter((id) => emph[id] !== LANE_EMPHASIS.selected);
    if (on.length && off.length && plain.length === layout.length) {
      const h = (list, id) => list.find((l) => l.id === id).h;
      const ratio = (h(layout, on[0]) / h(layout, off[0])) / (h(plain, on[0]) / h(plain, off[0]));
      assert.ok(Math.abs(ratio - LANE_SELECTED_WEIGHT) <= 1e-6, `ratio ${ratio}`);
    }
  }, { runs: RUNS });
  const vd = { stems: { drums: { env } } };
  assert.deepStrictEqual(laneLayout(vd, 'drums', 0), []);
  assert.deepStrictEqual(laneLayout(vd, 'drums', NaN), []);
  assert.deepStrictEqual(laneLayout({ stems: {} }, 'drums', 160), []);
  assert.deepStrictEqual(laneLayout(vd, 'drums', 160), [{ id: 'drums', y: 0, h: 160 }], 'a single row fills the strip');
});

test('laneHeaderHeight: min(0.1 × height, 0.03 × width) with a beat grid, 0 without', () => {
  const beat = { period: 0.5, phase: 0 };
  assert.equal(laneHeaderHeight({ beat }, 1600, 320), 32);
  assert.equal(laneHeaderHeight({ beat }, 320, 160), 320 * 0.03);
  assert.equal(laneHeaderHeight({ beat: null }, 1600, 320), 0);
  assert.equal(laneHeaderHeight(null, 1600, 320), 0);
  assert.equal(laneHeaderHeight({ beat }, 0, 320), 0);
});

test('laneLabelSpecs centres each label and shows it iff h ≥ 14', async () => {
  await forAll((rng) => {
    const vd = genVisData(rng);
    const lanes = laneRows(vd, 'original').length || 1;
    // 高度集中在每行 14 px 附近，正好落在门限上的情况也会出现
    const r = rng();
    const height = r < 0.3 ? 14 * lanes : r < 0.6 ? (10 + rng() * 8) * lanes : genHeight(rng, 300);
    return { vd, selected: genSelected(rng), height };
  }, ({ vd, selected, height }) => {
    const layout = laneLayout(vd, selected, height);
    const specs = laneLabelSpecs(layout);
    assert.equal(specs.length, layout.length);
    for (let i = 0; i < layout.length; i++) {
      const l = layout[i];
      const sp = specs[i];
      assert.equal(sp.id, l.id);
      assert.equal(sp.top, l.y + l.h / 2);
      assert.equal(sp.visible, l.h >= LANE_LABEL_MIN_PX, `h=${l.h}`);
    }
  }, { runs: RUNS });
  assert.deepStrictEqual(laneLabelSpecs(null), []);
});

// ---------- Property 13 ----------

const even = (v) => v - (v % 2);

function checkStacked(w, h, max) {
  const r = stackedLayout(w, h, max, max);
  const { width, pictureHeight: ph, stripHeight: sh } = r;
  for (const v of [width, ph, sh]) assert.ok(Number.isInteger(v) && v >= 2 && v % 2 === 0, `even ≥ 2: ${v}`);
  assert.ok(width <= max, `width ${width} > ${max}`);
  assert.ok(ph + sh <= max, `total ${ph + sh} > ${max}`);
  assert.equal(sh, Math.max(96, even(Math.round(0.2 * width))));
  assert.ok(width <= Math.max(2, w), `upscaled width ${width} > ${w}`);
  assert.ok(ph <= Math.max(2, h), `upscaled height ${ph} > ${h}`);
  const k = Math.min(1, max / w, max / (h + 0.2 * w));
  if (Math.min(w * k, h * k) >= 2) {
    const err = Math.abs(width / ph - w / h) / (w / h);
    assert.ok(err <= 2 / Math.min(width, ph), `aspect ${width}/${ph} vs ${w}/${h}: ${err}`);
  }
  return r;
}

// Feature: stem-lanes, Property 13: 叠放尺寸
// **Validates: Requirements 12.2, 12.3, 13.1**
test('Property 13: stackedLayout fits the box with even sizes and keeps the aspect ratio', async () => {
  const dim = (rng) => {
    const r = rng();
    if (r < 0.15) return 1 + Math.floor(rng() * 8);           // 极小 → 极端宽高比
    if (r < 0.25) return 8192 - Math.floor(rng() * 8);        // 极大
    return 1 + Math.floor(rng() * 8192);
  };
  await forAll((rng) => ({ w: dim(rng), h: dim(rng), max: pick(rng, [1280, 1920]) }),
    ({ w, h, max }) => { checkStacked(w, h, max); }, { runs: 300 });
});

test('Property 13: invalid sizes fall back to 1280×720', async () => {
  const bad = [0, -1, -720, NaN, Infinity, -Infinity, undefined, null, '1280'];
  await forAll((rng) => {
    const valid = 1 + Math.floor(rng() * 8192);
    const r = rng();
    const w = r < 0.67 ? pick(rng, bad) : valid;
    const h = r >= 0.33 ? pick(rng, bad) : valid;
    return { w, h, max: pick(rng, [1280, 1920]) };
  }, ({ w, h, max }) => {
    assert.deepStrictEqual(stackedLayout(w, h, max, max), stackedLayout(1280, 720, max, max));
  }, { runs: RUNS });
});

test('stackedLayout: decision 8 table for the 1920 and 1280 boxes', () => {
  const S = (width, pictureHeight, stripHeight) => ({ width, pictureHeight, stripHeight });
  const cases = [
    [1920, 1080, 1920, S(1920, 1080, 384)],
    [1080, 1920, 1920, S(970, 1724, 194)],
    [3840, 2160, 1920, S(1920, 1080, 384)],
    [640, 360, 1920, S(640, 360, 128)],
    [NaN, NaN, 1920, S(1280, 720, 256)],
    [1920, 1080, 1280, S(1280, 720, 256)],
    [1080, 1920, 1280, S(646, 1150, 128)],
    [3840, 2160, 1280, S(1280, 720, 256)],
    [640, 360, 1280, S(640, 360, 128)],
    [NaN, NaN, 1280, S(1280, 720, 256)],
    [0, 720, 1280, S(1280, 720, 256)],
  ];
  for (const [w, h, max, want] of cases) {
    assert.deepStrictEqual(stackedLayout(w, h, max, max), want, `${w}×${h} in ${max}`);
  }
});
