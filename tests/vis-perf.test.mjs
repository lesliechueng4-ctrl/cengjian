// Render performance of Scene_Function + Software_Rasterizer (Requirements 13.1, 13.2).
// Opt-in: runs only when BENCH_PERF=1 (timing depends on the machine).
//   PowerShell: $env:BENCH_PERF='1'; node --test tests/vis-perf.test.mjs; Remove-Item Env:BENCH_PERF
// Synthetic Vis_Data: 3 minutes, all 8 stems have envelopes, drums and perc have
// 4 onsets per second. 900 frames sampled evenly at 640x360 after a short warm-up;
// sceneAt + render must average < 33 ms per frame. Reports mean and P95.
// A second case times lanesAt + render at 960x192 (stem-lanes 14.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createVisData, VIS_STEM_IDS, VIS_FRAME_RATE } from '../public/js/vis-data.js';
import { sceneAt } from '../public/js/vis-scene.js';
import { createRasterizer } from '../public/js/vis-raster.js';
import { lanesAt, LANE_BACKGROUND } from '../public/js/vis-lanes.js';

const DURATION = 180;
const WIDTH = 640;
const HEIGHT = 360;
const FRAMES = 900;
const WARMUP = 60;
const BUDGET_MS = 33;
const ONSETS_PER_SEC = 4;
const BACKGROUND = [8, 8, 16];

function synthVisData() {
  const frames = DURATION * VIS_FRAME_RATE;
  const gap = Math.round(VIS_FRAME_RATE / ONSETS_PER_SEC);
  const results = {};
  VIS_STEM_IDS.forEach((id, si) => {
    const env = new Uint8Array(frames);
    const hasOnsets = id === 'drums' || id === 'perc';
    const offset = id === 'perc' ? Math.floor(gap / 2) : 0;
    for (let i = 0; i < frames; i++) {
      // Slow swell plus per-stem wobble; onset stems decay after each hit.
      const slow = 0.5 + 0.4 * Math.sin((2 * Math.PI * i) / (VIS_FRAME_RATE * (3 + si)));
      const hit = hasOnsets ? Math.exp(-(((i - offset) % gap + gap) % gap) / 8) : 0;
      env[i] = Math.min(255, Math.round(255 * Math.max(0, hasOnsets ? 0.3 * slow + 0.7 * hit : slow)));
    }
    let onsets = null;
    if (hasOnsets) {
      const list = [];
      for (let f = offset; f < frames; f += gap) list.push(f);
      onsets = Int32Array.from(list);
    } else if (id === 'fx' || id === 'other') {
      onsets = new Int32Array(0);
    }
    results[id] = { env, onsets, duration: DURATION };
  });
  return createVisData(results);
}

test('sceneAt + render average < 33 ms per frame at 640x360 (BENCH_PERF=1)',
  { skip: !process.env.BENCH_PERF, timeout: 10 * 60 * 1000 }, (t) => {
    const visData = synthVisData();
    assert.equal(Object.keys(visData.stems).length, 8);
    const raster = createRasterizer(WIDTH, HEIGHT);
    const out = new Uint8Array(raster.frameBytes);
    const opts = { selected: 'drums', width: WIDTH, height: HEIGHT };

    for (let k = 0; k < WARMUP; k++) {
      raster.render(sceneAt((k * DURATION) / WARMUP, visData, opts), BACKGROUND, out);
    }

    const times = new Float64Array(FRAMES);
    let shapeTotal = 0;
    for (let k = 0; k < FRAMES; k++) {
      const tSec = (k * DURATION) / FRAMES;
      const t0 = performance.now();
      const shapes = sceneAt(tSec, visData, opts);
      raster.render(shapes, BACKGROUND, out);
      times[k] = performance.now() - t0;
      shapeTotal += shapes.length;
    }

    const sorted = Float64Array.from(times).sort();
    const mean = times.reduce((a, b) => a + b, 0) / FRAMES;
    const p95 = sorted[Math.min(FRAMES - 1, Math.ceil(0.95 * FRAMES) - 1)];
    t.diagnostic(`frames=${FRAMES} ${WIDTH}x${HEIGHT} avgShapes=${(shapeTotal / FRAMES).toFixed(1)} `
      + `mean=${mean.toFixed(2)} ms p95=${p95.toFixed(2)} ms max=${sorted[FRAMES - 1].toFixed(2)} ms`);
    assert.ok(shapeTotal > 0, 'scene produced no shapes');
    assert.ok(mean < BUDGET_MS, `mean ${mean.toFixed(2)} ms >= ${BUDGET_MS} ms`);
  });

// stem-lanes Requirements 14.1, 14.2: the Stacked_Layout export renders only the Lane_Strip,
// at 960x192 for a 1920-wide output. Same synthetic Vis_Data; lanesAt + render < 33 ms per frame.
const LANE_WIDTH = 960;
const LANE_HEIGHT = 192;

test('lanesAt + render average < 33 ms per frame at 960x192 (BENCH_PERF=1)',
  { skip: !process.env.BENCH_PERF, timeout: 10 * 60 * 1000 }, (t) => {
    const visData = synthVisData();
    assert.equal(Object.keys(visData.stems).length, 8);
    const raster = createRasterizer(LANE_WIDTH, LANE_HEIGHT);
    const out = new Uint8Array(raster.frameBytes);
    const opts = { selected: 'drums', width: LANE_WIDTH, height: LANE_HEIGHT, reducedMotion: false };

    for (let k = 0; k < WARMUP; k++) {
      raster.render(lanesAt((k * DURATION) / WARMUP, visData, opts), LANE_BACKGROUND, out);
    }

    const times = new Float64Array(FRAMES);
    let shapeTotal = 0;
    for (let k = 0; k < FRAMES; k++) {
      const tSec = (k * DURATION) / FRAMES;
      const t0 = performance.now();
      const shapes = lanesAt(tSec, visData, opts);
      raster.render(shapes, LANE_BACKGROUND, out);
      times[k] = performance.now() - t0;
      shapeTotal += shapes.length;
    }

    const sorted = Float64Array.from(times).sort();
    const mean = times.reduce((a, b) => a + b, 0) / FRAMES;
    const p95 = sorted[Math.min(FRAMES - 1, Math.ceil(0.95 * FRAMES) - 1)];
    t.diagnostic(`frames=${FRAMES} ${LANE_WIDTH}x${LANE_HEIGHT} avgShapes=${(shapeTotal / FRAMES).toFixed(1)} `
      + `mean=${mean.toFixed(2)} ms p95=${p95.toFixed(2)} ms max=${sorted[FRAMES - 1].toFixed(2)} ms`);
    assert.ok(shapeTotal > 0, 'lanesAt produced no shapes');
    assert.ok(mean < BUDGET_MS, `mean ${mean.toFixed(2)} ms >= ${BUDGET_MS} ms`);
  });
