import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRasterizer } from '../public/js/vis-raster.js';
import { forAll, int, float, oneOf, array } from './helpers/prop.mjs';

// ---------- 生成器 ----------

const byte = int(0, 255);
const color = (rng) => [byte(rng), byte(rng), byte(rng)];
const bgGen = (rng) => [int(0, 80)(rng), int(0, 80)(rng), int(0, 80)(rng)];

function shapeGen(W, H) {
  const cx = float(-8, W + 8);
  const cy = float(-8, H + 8);
  const glow = oneOf(0, float(0, 6));
  const alpha = oneOf(1, float(0, 1));
  const disc = (rng) => ({ kind: 'disc', layer: 'perc', x: cx(rng), y: cy(rng), r: float(0, 10)(rng), glow: glow(rng), color: color(rng), alpha: alpha(rng) });
  const ring = (rng) => ({ kind: 'ring', layer: 'drums', x: cx(rng), y: cy(rng), r: oneOf(0, float(0, 14))(rng), width: float(0, 4)(rng), glow: glow(rng), color: color(rng), alpha: alpha(rng) });
  const rect = (rng) => ({ kind: 'rect', layer: 'bass', x: cx(rng), y: cy(rng), w: float(0, 12)(rng), h: float(0, 12)(rng), glow: glow(rng), color: color(rng), alpha: alpha(rng) });
  const wave = (rng) => {
    const n = int(1, 12)(rng);
    const ys = [];
    for (let i = 0; i < n; i++) ys.push(cy(rng));
    return { kind: 'wave', layer: 'vocal', x0: cx(rng), x1: cx(rng), ys, width: float(0, 4)(rng), glow: glow(rng), color: color(rng), alpha: alpha(rng) };
  };
  const band = (rng) => {
    const n = int(1, 12)(rng);
    const hs = [];
    for (let i = 0; i < n; i++) hs.push(oneOf(0, float(0, 8))(rng));
    return { kind: 'band', layer: 'bass', x0: cx(rng), x1: cx(rng), y: cy(rng), hs, glow: glow(rng), color: color(rng), alpha: alpha(rng) };
  };
  return oneOf(disc, ring, rect, wave, band);
}

function sceneGen({ maxShapes = 8 } = {}) {
  return (rng) => {
    const W = int(1, 64)(rng);
    const H = int(1, 64)(rng);
    return { W, H, bg: bgGen(rng), shapes: array(shapeGen(W, H), { minLength: 0, maxLength: maxShapes })(rng) };
  };
}

// 外接框（设计第 6 节：位置 ± 半径 + 宽度/2 + 发光），闭区间，按像素中心判断
function bbox(s) {
  const g = s.glow > 0 ? s.glow : 0;
  switch (s.kind) {
    case 'disc': { const R = s.r + g; return [s.x - R, s.x + R, s.y - R, s.y + R]; }
    case 'ring': { const R = s.r + s.width / 2 + g; return [s.x - R, s.x + R, s.y - R, s.y + R]; }
    case 'rect': return [s.x - g, s.x + s.w + g, s.y - g, s.y + s.h + g];
    case 'wave': {
      const R = s.width / 2 + g;
      return [Math.min(s.x0, s.x1), Math.max(s.x0, s.x1), Math.min(...s.ys) - R, Math.max(...s.ys) + R];
    }
    case 'band': {
      const R = Math.max(...s.hs) + g;
      return [Math.min(s.x0, s.x1), Math.max(s.x0, s.x1), s.y - R, s.y + R];
    }
    default: throw new Error('unknown kind');
  }
}

function inBox(b, px, py) {
  const x = px + 0.5;
  const y = py + 0.5;
  return x >= b[0] && x <= b[1] && y >= b[2] && y <= b[3];
}

function shuffle(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Property 25 ----------

// Feature: stem-visualizer, Property 25: 光栅化背景、单调与范围
// Feature: stem-lanes, Property 12: 含 Band 的光栅化顺序无关与单调（shapeGen 含 band）
// **Validates: Requirements 12.1, 12.3**（stem-visualizer）；**Validates: Requirements 9.1, 9.2**（stem-lanes）
test('Property 25: 空列表等于背景；末尾追加 Shape 不减少任何通道；外接框外等于背景', async () => {
  await forAll(
    (rng) => {
      const sc = sceneGen()(rng);
      return { ...sc, extra: shapeGen(sc.W, sc.H)(rng) };
    },
    ({ W, H, bg, shapes, extra }) => {
      const r = createRasterizer(W, H);
      assert.equal(r.frameBytes, W * H * 3);

      const empty = r.render([], bg).slice();
      for (let i = 0; i < empty.length; i++) {
        assert.equal(empty[i], bg[i % 3], `empty render pixel byte ${i}`);
      }

      const base = r.render(shapes, bg).slice();
      const more = r.render([...shapes, extra], bg).slice();
      for (let i = 0; i < base.length; i++) {
        assert.ok(more[i] >= base[i], `byte ${i} decreased: ${base[i]} -> ${more[i]}`);
      }

      const boxes = [...shapes, extra].map(bbox);
      for (let py = 0; py < H; py++) {
        for (let px = 0; px < W; px++) {
          if (boxes.some((b) => inBox(b, px, py))) continue;
          const i = (py * W + px) * 3;
          for (let c = 0; c < 3; c++) {
            assert.equal(more[i + c], bg[c], `pixel (${px},${py}) ch ${c} outside all boxes changed`);
          }
        }
      }
    },
    { runs: 150 },
  );
});

// ---------- Property 26 ----------

// Feature: stem-visualizer, Property 26: 光栅化确定性与顺序无关
// Feature: stem-lanes, Property 12: 含 Band 的光栅化顺序无关与单调（shapeGen 含 band）
// **Validates: Requirements 12.2, 12.5**（stem-visualizer）；**Validates: Requirements 9.1, 9.2**（stem-lanes）
test('Property 26: 连续两次 render 逐字节相同且返回同一缓冲；重排后每通道相差 ≤ 1', async () => {
  await forAll(
    (rng) => ({ ...sceneGen({ maxShapes: 10 })(rng), seed: Math.floor(rng() * 2 ** 32) }),
    ({ W, H, bg, shapes, seed }) => {
      const r = createRasterizer(W, H);
      const a = r.render(shapes, bg);
      const first = a.slice();
      const b = r.render(shapes, bg);
      assert.equal(b, a, 'internal buffer object reused');
      assert.deepEqual(b, first, 'byte-identical across renders');

      // 传入 out 时写到 out 并返回 out，结果相同
      const out = new Uint8Array(r.frameBytes);
      const c = r.render(shapes, bg, out);
      assert.equal(c, out);
      assert.deepEqual(out, first);

      // 另一个同尺寸光栅化器结果相同
      assert.deepEqual(createRasterizer(W, H).render(shapes, bg), first);

      let s = seed >>> 0;
      const rng = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
      const shuffled = r.render(shuffle(shapes, rng), bg);
      for (let i = 0; i < first.length; i++) {
        assert.ok(Math.abs(shuffled[i] - first[i]) <= 1, `byte ${i}: ${first[i]} vs ${shuffled[i]} after shuffle`);
      }
    },
    { runs: 150 },
  );
});

test('render：out 过小时抛 RangeError', () => {
  const r = createRasterizer(4, 4);
  assert.throws(() => r.render([], [0, 0, 0], new Uint8Array(r.frameBytes - 1)), RangeError);
});

// ---------- 示例 ----------

test('示例：单个 disc 中心像素 = 背景 + color × alpha，外接框之外不变', () => {
  const W = 32;
  const H = 32;
  const bg = [10, 20, 30];
  const disc = { kind: 'disc', layer: 'perc', x: 16.5, y: 16.5, r: 3, glow: 2, color: [100, 50, 200], alpha: 0.5 };
  const r = createRasterizer(W, H);
  const buf = r.render([disc], bg);

  const ci = (16 * W + 16) * 3;
  assert.deepEqual([buf[ci], buf[ci + 1], buf[ci + 2]], [60, 45, 130]);

  const b = bbox(disc);
  let outside = 0;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      if (inBox(b, px, py)) continue;
      outside++;
      const i = (py * W + px) * 3;
      assert.deepEqual([buf[i], buf[i + 1], buf[i + 2]], bg, `pixel (${px},${py})`);
    }
  }
  assert.ok(outside > 0);
});

// ---------- stem-lanes：Band ----------

function lerpHs(hs, x0, x1, x) {
  const n = hs.length;
  if (n === 1 || x1 === x0) return hs[0];
  let u = ((x - x0) / (x1 - x0)) * (n - 1);
  u = Math.min(n - 1, Math.max(0, u));
  const k = Math.min(n - 2, Math.floor(u));
  return hs[k] + (hs[k + 1] - hs[k]) * (u - k);
}

function covRef(d, glow) {
  if (d <= 0) return 1;
  if (!(glow > 0)) return 0;
  const t = Math.max(0, 1 - d / glow);
  return t * t;
}

function bandGen(rng) {
  const W = int(1, 64)(rng);
  const H = int(1, 64)(rng);
  const n = int(1, 50)(rng);
  const hs = [];
  for (let i = 0; i < n; i++) hs.push(oneOf(0, float(0, 20))(rng));
  const x0 = float(-16, W + 16)(rng);
  const x1 = oneOf(x0, float(-16, W + 16))(rng);
  return {
    W, H, bg: bgGen(rng),
    band: {
      kind: 'band', layer: 'bass', x0, x1, y: float(-10, H + 10)(rng), hs,
      glow: oneOf(0, float(0, 8))(rng), color: color(rng), alpha: oneOf(1, float(0, 1))(rng),
    },
  };
}

const BAD_HS = [[], [NaN], [1, Infinity, 2], [3, -0.5, 1], [-Infinity], [2, NaN]];

// Feature: stem-lanes, Property 10: Band 光栅化
// **Validates: Requirements 9.1, 9.2, 9.5**
test('Property 10: Band 与参考模型相差 ≤ 1，外接范围外等于背景；无效 hs 时等于背景', async () => {
  await forAll(
    (rng) => ({ ...bandGen(rng), bad: BAD_HS[int(0, BAD_HS.length - 1)(rng)], badField: int(0, 3)(rng) }),
    ({ W, H, bg, band, bad, badField }) => {
      const r = createRasterizer(W, H);
      const buf = r.render([band], bg).slice();
      const lo = Math.min(band.x0, band.x1);
      const hi = Math.max(band.x0, band.x1);
      const b = bbox(band);
      for (let py = 0; py < H; py++) {
        for (let px = 0; px < W; px++) {
          const i = (py * W + px) * 3;
          const x = px + 0.5;
          if (!inBox(b, px, py)) {
            for (let c = 0; c < 3; c++) assert.equal(buf[i + c], bg[c], `pixel (${px},${py}) ch ${c} outside box`);
            continue;
          }
          let cov = 0;
          if (x >= lo && x <= hi) {
            const h = lerpHs(band.hs, band.x0, band.x1, x);
            cov = covRef(Math.abs(py + 0.5 - band.y) - h, band.glow);
          }
          for (let c = 0; c < 3; c++) {
            const v = bg[c] + band.color[c] * band.alpha * cov;
            const want = Math.min(255, Math.max(0, Math.round(v)));
            assert.ok(Math.abs(buf[i + c] - want) <= 1, `pixel (${px},${py}) ch ${c}: ${buf[i + c]} vs ${want}`);
          }
        }
      }

      // 无效 Band：hs 为空 / 含 NaN、Infinity、负数，或 x0 / x1 / y 非有限 → 只有背景
      const empty = r.render([], bg).slice();
      const broken = { ...band, hs: bad };
      if (badField === 1) Object.assign(broken, { hs: band.hs, x0: NaN });
      if (badField === 2) Object.assign(broken, { hs: band.hs, x1: Infinity });
      if (badField === 3) Object.assign(broken, { hs: band.hs, y: -Infinity });
      assert.deepEqual(r.render([broken], bg), empty);
    },
    { runs: 150 },
  );
});

// Feature: stem-lanes, Property 11: Band 与 wave 等价
// **Validates: Requirements 9.3**
test('Property 11: 常数 hs 的 Band 与 width = 2h 的平直 wave 逐字节相同', async () => {
  await forAll(
    (rng) => {
      const { W, H, bg, band } = bandGen(rng);
      const h = oneOf(0, float(0, 20))(rng);
      return { W, H, bg, band: { ...band, hs: band.hs.map(() => h) }, h };
    },
    ({ W, H, bg, band, h }) => {
      const n = band.hs.length;
      const wave = { ...band, kind: 'wave', ys: new Array(n).fill(band.y), width: 2 * h };
      delete wave.hs;
      const r = createRasterizer(W, H);
      const a = r.render([band], bg).slice();
      const b = r.render([wave], bg).slice();
      assert.deepEqual(a, b);
    },
    { runs: 150 },
  );
});

test('示例：常数 hs 的 Band 中心像素 = 背景 + color × alpha，外接框之外不变', () => {
  const W = 32;
  const H = 32;
  const bg = [10, 20, 30];
  const band = { kind: 'band', layer: 'bass', x0: 8, x1: 24, y: 16.5, hs: [3, 3, 3, 3], glow: 2, color: [100, 50, 200], alpha: 0.5 };
  const r = createRasterizer(W, H);
  const buf = r.render([band], bg);

  const ci = (16 * W + 16) * 3;
  assert.deepEqual([buf[ci], buf[ci + 1], buf[ci + 2]], [60, 45, 130]);

  const b = bbox(band);
  let outside = 0;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      if (inBox(b, px, py)) continue;
      outside++;
      const i = (py * W + px) * 3;
      assert.deepEqual([buf[i], buf[i + 1], buf[i + 2]], bg, `pixel (${px},${py})`);
    }
  }
  assert.ok(outside > 0);
});
