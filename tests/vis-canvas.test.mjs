import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawSceneToCanvas } from '../public/js/vis-canvas.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------- 记录调用的假 Canvas2D ctx ----------
function fakeCtx({ width = 64, height = 48, throwOn = null } = {}) {
  const log = [];
  const state = { globalCompositeOperation: 'source-over', globalAlpha: 1 };
  const gradient = (type, args) => {
    const g = { type, args, stops: [], addColorStop: (o, c) => g.stops.push([o, c]) };
    return g;
  };
  const methods = {
    fillRect: () => {},
    clearRect: () => {},
    beginPath: () => {},
    arc: () => {},
    fill: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    stroke: () => {},
    createRadialGradient: (...a) => gradient('radial', a),
    createLinearGradient: (...a) => gradient('linear', a),
  };
  const ctx = new Proxy(
    { canvas: { width, height } },
    {
      get(target, key) {
        if (key in methods) {
          return (...args) => {
            log.push({
              call: key,
              args,
              op: state.globalCompositeOperation,
              alpha: state.globalAlpha,
              fillStyle: state.fillStyle,
            });
            if (throwOn === key) throw new Error(`boom:${key}`);
            return methods[key](...args);
          };
        }
        if (key === 'canvas') return target.canvas;
        return state[key];
      },
      set(_t, key, value) {
        state[key] = value;
        log.push({ set: key, value });
        return true;
      },
    },
  );
  return { ctx, log, state };
}
const calls = (log, name) => log.filter((e) => e.call === name);
const drawCalls = (log) => log.filter((e) => ['fill', 'stroke', 'fillRect'].includes(e.call));

const SHAPES = {
  disc: { kind: 'disc', x: 20, y: 20, r: 6, glow: 3, color: [255, 0, 0], alpha: 0.8 },
  ring: { kind: 'ring', x: 30, y: 24, r: 10, width: 2, glow: 2, color: [0, 255, 0], alpha: 0.5 },
  wave: { kind: 'wave', x0: 0, x1: 63, ys: [10, 20, 15, 30], width: 2, glow: 2, color: [0, 0, 255], alpha: 1 },
  rect: { kind: 'rect', x: 4, y: 30, w: 10, h: 6, glow: 2, color: [200, 200, 0], alpha: 0.7 },
};

// ---------- 背景 / 清空选项 ----------
test('默认：先以 source-over 用背景色 fillRect 整个画布', () => {
  const { ctx, log } = fakeCtx({ width: 64, height: 48 });
  drawSceneToCanvas(ctx, [], { background: [1, 2, 3] });
  const fr = calls(log, 'fillRect');
  assert.equal(fr.length, 1);
  assert.deepEqual(fr[0].args, [0, 0, 64, 48]);
  assert.equal(fr[0].op, 'source-over');
  assert.equal(fr[0].alpha, 1);
  assert.equal(fr[0].fillStyle, 'rgba(1, 2, 3, 1)');
  assert.equal(calls(log, 'clearRect').length, 0);
});

test('未给 background 时使用默认背景 #0b0d14', () => {
  const { ctx, log } = fakeCtx();
  drawSceneToCanvas(ctx, []);
  assert.equal(calls(log, 'fillRect')[0].fillStyle, 'rgba(11, 13, 20, 1)');
});

test('transparent: true 时 clearRect 而不 fillRect', () => {
  const { ctx, log } = fakeCtx({ width: 10, height: 7 });
  drawSceneToCanvas(ctx, [], { transparent: true });
  assert.deepEqual(calls(log, 'clearRect').map((e) => e.args), [[0, 0, 10, 7]]);
  assert.equal(calls(log, 'fillRect').length, 0);
});

test('clear: false 时不填充也不清空，Shape 仍以 lighter 叠加', () => {
  const { ctx, log } = fakeCtx();
  drawSceneToCanvas(ctx, [SHAPES.disc], { clear: false, background: [9, 9, 9] });
  assert.equal(calls(log, 'clearRect').length, 0);
  assert.equal(calls(log, 'fillRect').length, 0);
  const fills = calls(log, 'fill');
  assert.equal(fills.length, 1);
  assert.equal(fills[0].op, 'lighter');
});

// ---------- 四种 Shape 的绘制 ----------
test('disc / ring 用径向渐变 + arc + fill，在 lighter 下绘制', () => {
  for (const kind of ['disc', 'ring']) {
    const { ctx, log } = fakeCtx();
    const s = SHAPES[kind];
    drawSceneToCanvas(ctx, [s]);
    const rg = calls(log, 'createRadialGradient');
    assert.equal(rg.length, 1, kind);
    const outer = kind === 'disc' ? s.r : s.r + s.width / 2;
    assert.deepEqual(rg[0].args, [s.x, s.y, 0, s.x, s.y, outer + s.glow], kind);
    const arc = calls(log, 'arc');
    assert.equal(arc.length, 1, kind);
    assert.deepEqual(arc[0].args.slice(0, 3), [s.x, s.y, outer + s.glow], kind);
    const fills = calls(log, 'fill');
    assert.equal(fills.length, 1, kind);
    assert.equal(fills[0].op, 'lighter', kind);
    assert.equal(typeof fills[0].fillStyle, 'object', kind);
    // 渐变停靠点在 [0, 1] 内且单调不减
    const stops = fills[0].fillStyle.stops.map(([o]) => o);
    assert.ok(stops.length >= 2, kind);
    for (let i = 0; i < stops.length; i++) {
      assert.ok(stops[i] >= 0 && stops[i] <= 1, kind);
      if (i > 0) assert.ok(stops[i] >= stops[i - 1], kind);
    }
  }
});

test('wave 用 moveTo/lineTo 折线 stroke（发光一次 + 主线一次）', () => {
  const { ctx, log } = fakeCtx();
  const s = SHAPES.wave;
  drawSceneToCanvas(ctx, [s]);
  const strokes = calls(log, 'stroke');
  assert.equal(strokes.length, 2);
  for (const st of strokes) assert.equal(st.op, 'lighter');
  const moves = calls(log, 'moveTo');
  assert.deepEqual(moves[0].args, [s.x0, s.ys[0]]);
  const lines = calls(log, 'lineTo');
  assert.equal(lines.length, 2 * (s.ys.length - 1));
  assert.deepEqual(lines[s.ys.length - 2].args, [s.x1, s.ys[s.ys.length - 1]]);
  const widths = log.filter((e) => e.set === 'lineWidth').map((e) => e.value);
  assert.deepEqual(widths, [s.width + 2 * s.glow, s.width]);
});

test('rect：无发光时纯色 fillRect，有发光时线性渐变覆盖上下发光区', () => {
  {
    const { ctx, log } = fakeCtx();
    drawSceneToCanvas(ctx, [{ ...SHAPES.rect, glow: 0 }], { transparent: true });
    const fr = calls(log, 'fillRect');
    assert.equal(fr.length, 1);
    assert.deepEqual(fr[0].args, [4, 30, 10, 6]);
    assert.equal(fr[0].op, 'lighter');
    assert.equal(fr[0].fillStyle, 'rgba(200, 200, 0, 0.7)');
  }
  {
    const { ctx, log } = fakeCtx();
    const s = SHAPES.rect;
    drawSceneToCanvas(ctx, [s], { transparent: true });
    assert.equal(calls(log, 'createLinearGradient').length, 1);
    const fr = calls(log, 'fillRect');
    assert.equal(fr.length, 1);
    assert.deepEqual(fr[0].args, [s.x, s.y - s.glow, s.w, s.h + 2 * s.glow]);
    assert.equal(fr[0].op, 'lighter');
  }
});

test('四种 Shape 一起绘制：每个都只在 lighter 下产生绘制调用', () => {
  const { ctx, log } = fakeCtx();
  drawSceneToCanvas(ctx, Object.values(SHAPES), { transparent: true });
  const draws = drawCalls(log);
  // disc 1 fill + ring 1 fill + wave 2 stroke + rect 1 fillRect
  assert.equal(draws.length, 5);
  for (const d of draws) assert.equal(d.op, 'lighter');
});

test('退化 Shape 被跳过：null、未知 kind、alpha ≤ 0、空 ys、零尺寸', () => {
  const { ctx, log } = fakeCtx();
  drawSceneToCanvas(
    ctx,
    [
      null,
      { kind: 'triangle', x: 1, y: 1, r: 5, alpha: 1, color: [1, 1, 1] },
      { ...SHAPES.disc, alpha: 0 },
      { ...SHAPES.ring, alpha: -1 },
      { ...SHAPES.disc, alpha: NaN },
      { ...SHAPES.wave, ys: [] },
      { ...SHAPES.wave, width: 0, glow: 0 },
      { ...SHAPES.rect, w: 0 },
      { ...SHAPES.rect, h: 0, glow: 0 },
      { ...SHAPES.disc, r: 0, glow: 0 },
    ],
    { transparent: true },
  );
  assert.equal(drawCalls(log).length, 0);
});

// ---------- band（9.4、9.5） ----------
const BAND = { kind: 'band', x0: 4, x1: 60, y: 24, hs: [2, 5, 3, 6, 1], glow: 2, color: [0, 200, 255], alpha: 0.8 };

// 按 beginPath 切分出每条轮廓的 moveTo / lineTo / closePath / fill
function outlines(log) {
  const out = [];
  let cur = null;
  for (const e of log) {
    if (e.call === 'beginPath') out.push((cur = { moves: [], lines: [], closed: false, fills: [] }));
    else if (!cur) continue;
    else if (e.call === 'moveTo') cur.moves.push(e.args);
    else if (e.call === 'lineTo') cur.lines.push(e.args);
    else if (e.call === 'closePath') cur.closed = true;
    else if (e.call === 'fill') cur.fills.push(e);
  }
  return out;
}

test('band：glow > 0 时先以 alpha × 0.25 填充外扩轮廓，再以 alpha 填充核心轮廓', () => {
  const { ctx, log } = fakeCtx();
  const s = BAND;
  const n = s.hs.length;
  drawSceneToCanvas(ctx, [s], { transparent: true });
  const fills = calls(log, 'fill');
  assert.equal(fills.length, 2);
  assert.equal(fills[0].fillStyle, 'rgba(0, 200, 255, 0.2)');
  assert.equal(fills[1].fillStyle, 'rgba(0, 200, 255, 0.8)');
  for (const f of fills) assert.equal(f.op, 'lighter');
  const paths = outlines(log);
  assert.equal(paths.length, 2);
  const step = (s.x1 - s.x0) / (n - 1);
  paths.forEach((p, idx) => {
    const extra = idx === 0 ? s.glow : 0;
    assert.equal(p.moves.length, 1);
    assert.deepEqual(p.moves[0], [s.x0, s.y - s.hs[0] - extra]);
    assert.equal(p.lines.length, 2 * n - 1);
    assert.ok(p.closed);
    assert.equal(p.fills.length, 1);
    // 上边缘从左到右，下边缘从右到左
    for (let i = 1; i < n; i++) assert.deepEqual(p.lines[i - 1], [s.x0 + step * i, s.y - s.hs[i] - extra]);
    for (let k = 0; k < n; k++) {
      const j = n - 1 - k;
      assert.deepEqual(p.lines[n - 1 + k], [s.x0 + step * j, s.y + s.hs[j] + extra]);
    }
  });
});

test('band：glow = 0 时只填充一次核心轮廓', () => {
  const { ctx, log } = fakeCtx();
  drawSceneToCanvas(ctx, [{ ...BAND, glow: 0 }], { transparent: true });
  const fills = calls(log, 'fill');
  assert.equal(fills.length, 1);
  assert.equal(fills[0].fillStyle, 'rgba(0, 200, 255, 0.8)');
  assert.equal(calls(log, 'lineTo').length, 2 * BAND.hs.length - 1);
  assert.equal(calls(log, 'closePath').length, 1);
});

test('band：hs 为空、含 NaN / Infinity / 负数或缺失时没有绘制调用', () => {
  for (const hs of [[], [1, NaN, 2], [1, Infinity], [1, -1, 2], undefined, null, 'abc']) {
    const { ctx, log } = fakeCtx();
    drawSceneToCanvas(ctx, [{ ...BAND, hs }], { transparent: true });
    assert.equal(drawCalls(log).length, 0, String(hs));
    assert.equal(calls(log, 'beginPath').length, 0, String(hs));
  }
});

test('band：在 lighter 下绘制并恢复合成模式', () => {
  const { ctx, log, state } = fakeCtx();
  state.globalCompositeOperation = 'multiply';
  state.globalAlpha = 0.4;
  drawSceneToCanvas(ctx, [BAND, SHAPES.disc], { transparent: true });
  for (const d of drawCalls(log)) assert.equal(d.op, 'lighter');
  assert.equal(state.globalCompositeOperation, 'multiply');
  assert.equal(state.globalAlpha, 0.4);
});

test('shapes 不是数组时只画背景', () => {
  const { ctx, log } = fakeCtx();
  drawSceneToCanvas(ctx, null);
  assert.equal(calls(log, 'fillRect').length, 1);
  assert.equal(drawCalls(log).length, 1);
});

// ---------- 合成模式 / 透明度恢复 ----------
test('绘制结束后恢复原有 globalCompositeOperation 与 globalAlpha', () => {
  const { ctx, state } = fakeCtx();
  state.globalCompositeOperation = 'multiply';
  state.globalAlpha = 0.3;
  drawSceneToCanvas(ctx, Object.values(SHAPES));
  assert.equal(state.globalCompositeOperation, 'multiply');
  assert.equal(state.globalAlpha, 0.3);
});

test('绘制中抛错时仍恢复合成模式与 globalAlpha，并把错误抛出', () => {
  for (const throwOn of ['fill', 'stroke', 'createRadialGradient']) {
    const { ctx, state } = fakeCtx({ throwOn });
    state.globalCompositeOperation = 'screen';
    state.globalAlpha = 0.6;
    assert.throws(() => drawSceneToCanvas(ctx, Object.values(SHAPES)), new RegExp(`boom:${throwOn}`));
    assert.equal(state.globalCompositeOperation, 'screen', throwOn);
    assert.equal(state.globalAlpha, 0.6, throwOn);
  }
});

// ---------- 同构冒烟：源码扫描 ----------
// 去掉注释（保留字符串与模板字面量），避免注释里的词误判。
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      out += ' ';
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
function importSpecifiers(code) {
  const specs = [];
  // 静态 import / export…from 必须在行首；动态 import('...') 任意位置
  const re =
    /^[ \t]*(?:import\s*(?:[\w*{}\s,$]+?\s*from\s*)?|export\s*[\w*{}\s,$]+?\s*from\s*)(['"])([^'"]+)\1|\bimport\s*\(\s*(['"])([^'"]+)\3\s*\)/gm;
  let m;
  while ((m = re.exec(code))) specs.push(m[2] || m[4]);
  return specs;
}
const read = (rel) => stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

test('stripComments 去掉行/块注释但保留字符串', () => {
  const s = stripComments("const a = '// not comment'; // window\n/* document */ const b = 1;");
  assert.ok(s.includes("'// not comment'"));
  assert.ok(!/\bwindow\b/.test(s));
  assert.ok(!/\bdocument\b/.test(s));
});

test('vis-data / vis-scene / vis-raster / vis-canvas 只有 ./ 相对导入且不引用宿主全局', () => {
  const forbidden = ['window', 'document', 'self', 'process', 'require'];
  for (const rel of [
    'public/js/vis-data.js',
    'public/js/vis-scene.js',
    'public/js/vis-raster.js',
    'public/js/vis-canvas.js',
    'public/js/vis-lanes.js',
  ]) {
    const code = read(rel);
    for (const spec of importSpecifiers(code)) {
      assert.ok(spec.startsWith('./'), `${rel} 导入了非 ./ 相对模块：${spec}`);
    }
    for (const word of forbidden) {
      assert.ok(!new RegExp(`\\b${word}\\b`).test(code), `${rel} 引用了 ${word}`);
    }
  }
});

test('export-service.js 只导入 node: 内置模块和项目内相对模块（15.5）', () => {
  const code = read('export-service.js');
  const specs = importSpecifiers(code);
  assert.ok(specs.length > 0);
  for (const spec of specs) {
    assert.ok(/^node:/.test(spec) || /^\.\.?\//.test(spec), `export-service.js 导入了 ${spec}`);
  }
  assert.ok(!/\brequire\s*\(/.test(code), 'export-service.js 使用了 require');
});
