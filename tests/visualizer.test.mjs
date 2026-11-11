import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canvasPixelSize, readVisSettings, visFrameAction, visFrameKey, createLiveVisualizer,
} from '../public/js/visualizer.js';
import { forAll } from './helpers/prop.mjs';

const RUNS = 100;
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const bool = (rng) => rng() < 0.5;

// ---------- Property 14 ----------

/** 规格中的调度模型（design 第 8 节）。 */
function modelAction({ enabled, visible, hasData, playing, key, lastKey }) {
  if (!enabled || !visible || !hasData) return { draw: false, schedule: false };
  if (playing) return { draw: true, schedule: true };
  return key !== lastKey ? { draw: true, schedule: false } : { draw: false, schedule: false };
}

// Feature: stem-visualizer, Property 14: 实时绘制调度模型
test('Property 14: visFrameAction 与调度模型一致', async () => {
  const keys = [null, 'a', 'b', 'c'];
  await forAll((rng) => ({
    enabled: bool(rng), visible: bool(rng), hasData: bool(rng), playing: bool(rng),
    key: pick(rng, keys), lastKey: pick(rng, keys),
  }), (input) => {
    assert.deepEqual(visFrameAction(input), modelAction(input));
  }, { runs: RUNS });
});

// Feature: stem-visualizer, Property 14: 实时绘制调度模型
test('Property 14: visFrameKey 只随 t（毫秒精度）、selected、尺寸、减少动态效果和数据变化', async () => {
  const gen = (rng) => ({
    t: pick(rng, [0, 0.5, 1.2345, 1.2341, 3, 3.0004]),
    selected: pick(rng, ['original', 'vocal', 'drums']),
    width: pick(rng, [1, 320, 640]), height: pick(rng, [1, 180, 360]),
    reducedMotion: bool(rng), dataId: pick(rng, [1, 2]),
  });
  await forAll((rng) => [gen(rng), gen(rng)], ([a, b]) => {
    const same = a.t.toFixed(3) === b.t.toFixed(3) && a.selected === b.selected
      && a.width === b.width && a.height === b.height
      && a.reducedMotion === b.reducedMotion && a.dataId === b.dataId;
    assert.equal(visFrameKey(a) === visFrameKey(b), same);
  }, { runs: RUNS });
});

/** 假环境：raf 队列、document、matchMedia、canvas、Player 状态。 */
function makeEnv(init) {
  const s = { ...init };
  const queue = []; // [{ handle, cb }]
  let nextHandle = 1;
  let inRaf = false;
  let maxPending = 0;
  const draws = [];
  const outsideRaf = [];
  const docListeners = new Set();
  const mqlListeners = new Set();
  const doc = {
    get visibilityState() { return s.visible ? 'visible' : 'hidden'; },
    addEventListener(type, fn) { if (type === 'visibilitychange') docListeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'visibilitychange') docListeners.delete(fn); },
  };
  const mql = {
    get matches() { return s.reducedMotion; },
    addEventListener(type, fn) { if (type === 'change') mqlListeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'change') mqlListeners.delete(fn); },
  };
  const ctx = { tag: 'ctx' };
  const canvas = {
    width: 300, height: 150,
    get clientWidth() { return s.cssW; },
    get clientHeight() { return s.cssH; },
    getContext: () => ctx,
  };
  const raf = (cb) => {
    const handle = nextHandle++;
    queue.push({ handle, cb });
    maxPending = Math.max(maxPending, queue.length);
    return handle;
  };
  const caf = (h) => {
    const i = queue.findIndex((q) => q.handle === h);
    if (i >= 0) queue.splice(i, 1);
  };
  const sceneAt = (t, data, o) => {
    if (!inRaf) outsideRaf.push('sceneAt');
    return [{ t, data, ...o }];
  };
  const drawSceneToCanvas = (c, shapes, o) => {
    if (!inRaf) outsideRaf.push('draw');
    draws.push({ c, scene: shapes[0], opts: o, canvasW: canvas.width, canvasH: canvas.height });
  };
  const vis = createLiveVisualizer({
    canvas,
    getTime: () => s.time,
    isPlaying: () => s.playing,
    getSelected: () => s.selected,
    getVisData: () => s.data,
    isEnabled: () => s.enabled,
    raf, caf, document: doc,
    matchMedia: () => mql,
    devicePixelRatio: () => s.dpr,
    sceneAt, drawSceneToCanvas,
  });
  function runFrame() {
    const q = queue.shift();
    if (!q) return false;
    inRaf = true;
    try { q.cb(performance.now()); } finally { inRaf = false; }
    return true;
  }
  return {
    s, vis, queue, draws, outsideRaf, ctx, canvas, docListeners, mqlListeners, runFrame,
    get maxPending() { return maxPending; },
  };
}

const DATA = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
const TIMES = [0, 0.5, 1, 1.0002, 2.25, 7];

function genInit(rng) {
  return {
    playing: bool(rng), time: pick(rng, TIMES), selected: pick(rng, ['original', 'vocal', 'drums']),
    enabled: rng() < 0.8, visible: rng() < 0.85, reducedMotion: bool(rng),
    data: rng() < 0.8 ? pick(rng, DATA) : null,
    cssW: pick(rng, [0, 100, 320.4, 640]), cssH: pick(rng, [0, 90, 180.6, 360]),
    dpr: pick(rng, [1, 1.5, 2, 3]),
  };
}

const EVENT_KINDS = ['play', 'pause', 'seek', 'tick', 'select', 'toggle', 'visibility',
  'reducedMotion', 'resize', 'data', 'invalidate', 'frame', 'frame', 'frame'];

function genEvent(rng) {
  const kind = pick(rng, EVENT_KINDS);
  const ev = { kind, invalidate: rng() < 0.7 };
  if (kind === 'seek') ev.time = pick(rng, TIMES);
  if (kind === 'tick') ev.dt = pick(rng, [0, 0.0001, 0.016, 0.033]);
  if (kind === 'select') ev.selected = pick(rng, ['original', 'vocal', 'drums', 'bass']);
  if (kind === 'resize') { ev.cssW = pick(rng, [0, 100, 320.4, 640]); ev.cssH = pick(rng, [0, 90, 360]); ev.dpr = pick(rng, [1, 1.5, 2, 3]); }
  if (kind === 'data') ev.data = rng() < 0.3 ? null : pick(rng, DATA);
  if (kind === 'visibility') ev.visible = bool(rng);
  if (kind === 'reducedMotion') ev.reducedMotion = bool(rng);
  return ev;
}

const clampDpr = (d) => Math.min(2, Math.max(1, d));

// Feature: stem-visualizer, Property 14: 实时绘制调度模型
test('Property 14: createLiveVisualizer 在随机事件序列下符合调度模型', async () => {
  await forAll((rng) => {
    const init = genInit(rng);
    const n = 1 + Math.floor(rng() * 60);
    const events = [];
    for (let i = 0; i < n; i++) events.push(genEvent(rng));
    return { init, events };
  }, ({ init, events }) => {
    const env = makeEnv(init);
    const { s } = env;
    // 模型状态
    let pending = false;
    let lastKey = null;
    const dataIds = new Map();
    const dataId = (d) => { if (!dataIds.has(d)) dataIds.set(d, dataIds.size + 1); return dataIds.get(d); };

    const invalidate = () => { env.vis.invalidate(); pending = true; };

    for (const [i, ev] of events.entries()) {
      const where = `event ${i} (${ev.kind})`;
      switch (ev.kind) {
        case 'play': s.playing = true; break;
        case 'pause': s.playing = false; break;
        case 'seek': s.time = ev.time; break;
        case 'tick': if (s.playing) s.time += ev.dt; break;
        case 'select': s.selected = ev.selected; break;
        case 'toggle': s.enabled = !s.enabled; break;
        case 'resize': s.cssW = ev.cssW; s.cssH = ev.cssH; s.dpr = ev.dpr; break;
        case 'data': s.data = ev.data; break;
        case 'visibility':
          s.visible = ev.visible;
          for (const fn of env.docListeners) fn({ type: 'visibilitychange' });
          if (s.visible) pending = true; // 重新可见时 invalidate()
          break;
        case 'reducedMotion':
          s.reducedMotion = ev.reducedMotion;
          for (const fn of env.mqlListeners) fn({ type: 'change', matches: s.reducedMotion });
          pending = true; // change → invalidate()
          break;
        case 'invalidate': invalidate(); break;
        case 'frame': {
          const before = env.draws.length;
          const ran = env.runFrame();
          assert.equal(ran, pending, `${where}: 挂起帧与模型不一致`);
          if (!ran) break;
          pending = false;
          const hasData = !!s.data;
          if (!s.enabled || !hasData) lastKey = null;
          const r = clampDpr(s.dpr);
          const width = Math.max(1, Math.round(s.cssW * r));
          const height = Math.max(1, Math.round(s.cssH * r));
          const key = hasData
            ? [s.time.toFixed(3), s.selected, width, height, s.reducedMotion, dataId(s.data)].join('|')
            : null;
          const action = modelAction({
            enabled: s.enabled, visible: s.visible, hasData, playing: s.playing, key, lastKey,
          });
          assert.equal(env.draws.length - before, action.draw ? 1 : 0, `${where}: 绘制次数`);
          if (action.draw) {
            const d = env.draws.at(-1);
            assert.equal(d.c, env.ctx);
            assert.equal(d.scene.t, s.time, `${where}: t 应为当时的 currentTime`);
            assert.equal(d.scene.data, s.data);
            assert.equal(d.scene.selected, s.selected);
            assert.equal(d.scene.reducedMotion, s.reducedMotion);
            assert.equal(d.scene.width, width);
            assert.equal(d.scene.height, height);
            assert.equal(d.canvasW, width, `${where}: canvas.width`);
            assert.equal(d.canvasH, height, `${where}: canvas.height`);
            lastKey = key;
          }
          if (action.schedule) pending = true;
          assert.equal(env.queue.length, pending ? 1 : 0, `${where}: 续订与模型不一致`);
          break;
        }
        default: break;
      }
      if (ev.kind !== 'invalidate' && ev.kind !== 'frame' && ev.invalidate) invalidate();
      assert.ok(env.queue.length <= 1, `${where}: 挂起帧 ${env.queue.length} 个`);
      assert.equal(env.queue.length, pending ? 1 : 0, `${where}: 挂起帧与模型不一致`);
    }
    assert.ok(env.maxPending <= 1, `最多挂起 ${env.maxPending} 个动画帧`);
    assert.deepEqual(env.outsideRaf, [], 'raf 回调之外发生了绘制');

    // 收尾：把挂起帧跑完后，若暂停或不可绘制，则不再有挂起帧
    if (!s.playing || !s.enabled || !s.visible || !s.data) {
      env.runFrame();
      assert.equal(env.queue.length, 0, '暂停 / 隐藏 / 关闭 / 无数据时不应续订');
    }
    // destroy：取消挂起帧并移除监听
    env.vis.destroy();
    assert.equal(env.queue.length, 0);
    assert.equal(env.docListeners.size, 0);
    assert.equal(env.mqlListeners.size, 0);
    const drawsBefore = env.draws.length;
    env.vis.invalidate();
    env.runFrame();
    assert.equal(env.draws.length, drawsBefore);
  }, { runs: RUNS });
});

test('示例：暂停后只画一帧，播放时每帧绘制并续订，隐藏时停止', () => {
  const env = makeEnv({
    playing: false, time: 1, selected: 'vocal', enabled: true, visible: true, reducedMotion: false,
    data: DATA[0], cssW: 100, cssH: 50, dpr: 2,
  });
  env.vis.invalidate();
  env.vis.invalidate();
  assert.equal(env.queue.length, 1);
  env.runFrame();
  assert.equal(env.draws.length, 1);
  assert.equal(env.queue.length, 0);
  assert.equal(env.canvas.width, 200);
  env.vis.invalidate();
  env.runFrame();
  assert.equal(env.draws.length, 1, '暂停且 key 不变时不重绘');

  env.s.playing = true;
  env.vis.invalidate();
  for (let i = 0; i < 5; i++) { env.s.time += 0.016; env.runFrame(); }
  assert.equal(env.draws.length, 6);
  assert.equal(env.queue.length, 1);

  env.s.visible = false;
  for (const fn of env.docListeners) fn();
  env.runFrame();
  assert.equal(env.draws.length, 6);
  assert.equal(env.queue.length, 0, '隐藏时不续订');
});

// ---------- Property 15 ----------

// Feature: stem-visualizer, Property 15: 画布像素尺寸
test('Property 15: canvasPixelSize = max(1, round(css × clamp(dpr, 1, 2)))', async () => {
  const css = (rng) => pick(rng, [0, 0.2, 0.5, 1, 1.5])
    || (rng() < 0.5 ? Math.floor(rng() * 4000) : rng() * 4000);
  await forAll((rng) => ({
    w: rng() < 0.2 ? pick(rng, [0, 0.2, 0.5, 1.5]) : css(rng),
    h: rng() < 0.2 ? pick(rng, [0, 0.2, 0.5, 1.5]) : css(rng),
    dpr: rng() < 0.5 ? pick(rng, [0, -1, -0.5, NaN, Infinity, -Infinity, 3, 4, 1, 2]) : rng() * 4,
  }), ({ w, h, dpr }) => {
    const r = Number.isFinite(dpr) ? Math.min(2, Math.max(1, dpr)) : 1;
    const out = canvasPixelSize(w, h, dpr);
    assert.ok(out.width >= 1 && out.height >= 1);
    assert.equal(out.width, Math.max(1, Math.round(w * r)));
    assert.equal(out.height, Math.max(1, Math.round(h * r)));
  }, { runs: RUNS });
});

// ---------- Property 16 ----------

// Feature: stem-lanes, Property 17: 开关设置默认值
// **Validates: Requirements 6.1, 6.2**
test('Property 17: readVisSettings 非布尔值使用默认值 true', async () => {
  const MISSING = Symbol('missing');
  const value = (rng) => pick(rng, [MISSING, undefined, null, true, false, 'true', 'false', '', 0, 1, NaN, {}, []]);
  await forAll((rng) => {
    const shape = pick(rng, ['undefined', 'null', 'array', 'object', 'object', 'object', 'string', 'number']);
    if (shape === 'undefined') return undefined;
    if (shape === 'null') return null;
    if (shape === 'string') return 'visVideo';
    if (shape === 'number') return 42;
    const o = shape === 'array' ? [] : {};
    const v = value(rng);
    const a = value(rng);
    if (v !== MISSING) o.visVideo = v;
    if (a !== MISSING) o.visAudio = a;
    if (rng() < 0.3) o.speed = 1;
    return o;
  }, (s) => {
    const out = readVisSettings(s);
    const vv = s?.visVideo;
    const va = s?.visAudio;
    assert.equal(out.visVideo, typeof vv === 'boolean' ? vv : true);
    assert.equal(out.visAudio, typeof va === 'boolean' ? va : true);
  }, { runs: RUNS });
});
