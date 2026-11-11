import test from 'node:test';
import assert from 'node:assert/strict';
import {
  laneLayout, laneLabelSpecs, stackedLayout, LANE_ORDER, LANE_LABEL_MIN_PX,
} from '../public/js/vis-lanes.js';
import { VIS_STEM_IDS, ALL_STEM_IDS } from '../public/js/vis-data.js';
import { forAll } from './helpers/prop.mjs';

const RUNS = 100;
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const UNKNOWN_IDS = ['original', 'nope', '', '__proto__', 'Drums', 'toString'];

/** VIS_STEM_IDS 的随机子集，随机顺序、可重复、混入未知 id。 */
function genIds(rng) {
  const out = VIS_STEM_IDS.filter(() => rng() < 0.6);
  const extra = Math.floor(rng() * 4);
  for (let i = 0; i < extra; i++) out.push(out.length && rng() < 0.5 ? pick(rng, out) : pick(rng, UNKNOWN_IDS));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const genSelected = (rng) => (rng() < 0.15 ? pick(rng, UNKNOWN_IDS) : pick(rng, ALL_STEM_IDS));

function genHeight(rng, max = 1000) {
  const r = rng();
  if (r < 0.3) return 1 + Math.floor(rng() * max);
  return 1 + rng() * (max - 1);
}

// ---------- Property 3 ----------

// Feature: stem-lanes, Property 3: Lane 布局
// **Validates: Requirements 2.1, 2.2, 5.1, 5.2**
test('Property 3: laneLayout follows LANE_ORDER, tiles the height and weights the selected lane 3×', async () => {
  await forAll((rng) => ({ ids: genIds(rng), selected: genSelected(rng), height: genHeight(rng) }),
    ({ ids, selected, height }) => {
      const layout = laneLayout(ids, selected, height);
      const want = LANE_ORDER.filter((id) => ids.includes(id));
      assert.deepStrictEqual(layout.map((l) => l.id), want);
      if (want.length === 0) return;
      assert.equal(layout[0].y, 0);
      for (let k = 0; k + 1 < layout.length; k++) {
        assert.ok(Math.abs(layout[k + 1].y - (layout[k].y + layout[k].h)) <= 1e-9, `gap after ${k}`);
      }
      const last = layout[layout.length - 1];
      assert.ok(Math.abs(last.y + last.h - height) <= 1e-9, 'sum equals height');
      const weighted = layout.length > 1 && want.includes(selected);
      const rel = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
      if (weighted) {
        const sel = layout.find((l) => l.id === selected);
        for (const l of layout) if (l !== sel) assert.ok(rel(sel.h, 3 * l.h), `${sel.h} vs 3 × ${l.h}`);
      } else {
        for (const l of layout) assert.ok(rel(l.h, layout[0].h), 'equal heights');
      }
    }, { runs: RUNS });
});

test('laneLayout: 8 stems, drums selected, 160 px → drums 48, others 16', () => {
  const layout = laneLayout(VIS_STEM_IDS, 'drums', 160);
  assert.deepStrictEqual(layout.map((l) => l.id), [...LANE_ORDER]);
  for (const l of layout) {
    assert.ok(Math.abs(l.h - (l.id === 'drums' ? 48 : 16)) <= 1e-9, `${l.id}: ${l.h}`);
  }
  assert.deepStrictEqual(laneLayout([], 'drums', 160), []);
  assert.deepStrictEqual(laneLayout(['drums'], 'drums', 0), []);
  assert.deepStrictEqual(laneLayout(['drums'], 'drums', NaN), []);
});

// ---------- Property 4 ----------

// Feature: stem-lanes, Property 4: Lane_Label 门限
// **Validates: Requirements 2.4**
test('Property 4: laneLabelSpecs centres each label and shows it iff h ≥ 14', async () => {
  await forAll((rng) => {
    const ids = genIds(rng);
    const lanes = LANE_ORDER.filter((id) => ids.includes(id)).length || 1;
    // 高度集中在每条 Lane 14 px 附近，正好落在门限上的情况也会出现
    const r = rng();
    const height = r < 0.3 ? 14 * lanes : r < 0.6 ? (10 + rng() * 8) * lanes : genHeight(rng, 300);
    return { ids, selected: genSelected(rng), height };
  }, ({ ids, selected, height }) => {
    const layout = laneLayout(ids, selected, height);
    const specs = laneLabelSpecs(layout);
    assert.equal(specs.length, layout.length);
    for (let i = 0; i < layout.length; i++) {
      const l = layout[i];
      const s = specs[i];
      assert.equal(s.id, l.id);
      assert.equal(s.top, l.y + l.h / 2);
      assert.equal(s.visible, l.h >= LANE_LABEL_MIN_PX, `h=${l.h}`);
    }
  }, { runs: RUNS });
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
