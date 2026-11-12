// Canvas_Backend：在 Canvas2D 上绘制 Scene_Function 输出的 Shape 列表（Requirement 12.6）。
// 加法合成（'lighter'），覆盖率近似 Software_Rasterizer 的 cov(d) = d ≤ 0 ? 1 : max(0, 1 − d/glow)²。
// 零依赖，只通过传入的 ctx 工作，不访问任何全局对象。

const DEFAULT_BACKGROUND = [11, 13, 20]; // #0b0d14，与 VIS_BACKGROUND 相同
const GLOW_STEPS = 4; // 发光区按 cov(d) 取的渐变停靠点数

function num(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function nonNeg(v) {
  return Math.max(0, num(v));
}

function channel(v) {
  return Math.min(255, Math.max(0, Math.round(num(v))));
}

function rgba(color, a) {
  const c = Array.isArray(color) ? color : DEFAULT_BACKGROUND;
  const alpha = Math.min(1, Math.max(0, num(a)));
  return `rgba(${channel(c[0])}, ${channel(c[1])}, ${channel(c[2])}, ${alpha})`;
}

function cov(d, glow) {
  if (d <= 0) return 1;
  if (glow <= 0) return 0;
  const k = 1 - d / glow;
  return k > 0 ? k * k : 0;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function canvasSize(ctx) {
  const c = ctx && ctx.canvas;
  return [nonNeg(c && c.width), nonNeg(c && c.height)];
}

/**
 * 以中心为原点（r0 = 0）的径向渐变：核心为 [inner, outer] 的环带，
 * 环带外侧和内侧各在 glow 内按 cov(d) 衰减。inner = 0 时就是实心圆斑。
 */
function fillRadialProfile(ctx, x, y, inner, outer, glow, color, alpha) {
  const R = outer + glow;
  if (!(R > 0)) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, R);
  const stop = (dist, a) => g.addColorStop(clamp01(dist / R), rgba(color, alpha * a));
  if (inner > 0) {
    // 内侧发光：距离中心 inner − d 处取 cov(d)
    const innerGlowStart = inner - glow;
    if (glow > 0 && innerGlowStart > 0) stop(0, 0);
    else if (glow > 0) stop(0, cov(inner, glow));
    else stop(0, 0);
    for (let k = GLOW_STEPS; k >= 1; k--) {
      const d = (glow * k) / GLOW_STEPS;
      if (glow > 0 && inner - d >= 0) stop(inner - d, cov(d, glow));
    }
    if (!(glow > 0)) stop(inner, 0);
    stop(inner, 1);
  } else {
    stop(0, 1);
  }
  stop(outer, 1);
  if (glow > 0) {
    for (let k = 1; k <= GLOW_STEPS; k++) {
      const d = (glow * k) / GLOW_STEPS;
      stop(outer + d, cov(d, glow));
    }
  } else {
    stop(outer, 0);
    stop(R, 0);
  }
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.fill();
}

function drawDisc(ctx, s, alpha) {
  const r = nonNeg(s.r);
  const glow = nonNeg(s.glow);
  fillRadialProfile(ctx, num(s.x), num(s.y), 0, r, glow, s.color, alpha);
}

function drawRing(ctx, s, alpha) {
  const r = nonNeg(s.r);
  const half = nonNeg(s.width) / 2;
  const glow = nonNeg(s.glow);
  const inner = Math.max(0, r - half);
  const outer = r + half;
  fillRadialProfile(ctx, num(s.x), num(s.y), inner, outer, glow, s.color, alpha);
}

function drawWave(ctx, s, alpha) {
  const ys = Array.isArray(s.ys) || ArrayBuffer.isView(s.ys) ? s.ys : [];
  const n = ys.length;
  if (n === 0) return;
  const x0 = num(s.x0);
  const x1 = num(s.x1, x0);
  const width = nonNeg(s.width);
  const glow = nonNeg(s.glow);
  const path = () => {
    ctx.beginPath();
    if (n === 1) {
      ctx.moveTo(x0, num(ys[0]));
      ctx.lineTo(x1, num(ys[0]));
    } else {
      const step = (x1 - x0) / (n - 1);
      ctx.moveTo(x0, num(ys[0]));
      for (let i = 1; i < n; i++) ctx.lineTo(x0 + step * i, num(ys[i]));
    }
  };
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  if (glow > 0) {
    ctx.lineWidth = width + 2 * glow;
    ctx.strokeStyle = rgba(s.color, alpha * 0.25);
    path();
    ctx.stroke();
  }
  if (width > 0) {
    ctx.lineWidth = width;
    ctx.strokeStyle = rgba(s.color, alpha);
    path();
    ctx.stroke();
  }
}

function drawRect(ctx, s, alpha) {
  const x = num(s.x);
  const y = num(s.y);
  const w = nonNeg(s.w);
  const h = nonNeg(s.h);
  const glow = nonNeg(s.glow);
  if (!(w > 0)) return;
  const top = y - glow;
  const total = h + 2 * glow;
  if (!(total > 0)) return;
  if (!(glow > 0)) {
    ctx.fillStyle = rgba(s.color, alpha);
    ctx.fillRect(x, y, w, h);
    return;
  }
  const g = ctx.createLinearGradient(0, top, 0, top + total);
  const stop = (yy, a) => g.addColorStop(clamp01((yy - top) / total), rgba(s.color, alpha * a));
  for (let k = GLOW_STEPS; k >= 1; k--) {
    const d = (glow * k) / GLOW_STEPS;
    stop(y - d, cov(d, glow));
  }
  stop(y, 1);
  stop(y + h, 1);
  for (let k = 1; k <= GLOW_STEPS; k++) {
    const d = (glow * k) / GLOW_STEPS;
    stop(y + h + d, cov(d, glow));
  }
  ctx.fillStyle = g;
  ctx.fillRect(x, top, w, total);
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Band（9.4、9.5）：中线 y、等距半高 hs。轮廓为上边缘从左到右、下边缘从右到左并 closePath；
 * glow > 0 时先以 alpha × 0.25 填充外扩 glow 的轮廓，再以 alpha 填充核心轮廓。
 * hs 为空或含非有限数 / 负数，或 x0、x1、y 非有限数时跳过。
 */
function drawBand(ctx, s, alpha) {
  const hs = Array.isArray(s.hs) || ArrayBuffer.isView(s.hs) ? s.hs : null;
  if (!hs || hs.length === 0) return;
  if (!isNum(s.x0) || !isNum(s.x1) || !isNum(s.y)) return;
  for (let k = 0; k < hs.length; k++) if (!isNum(hs[k]) || hs[k] < 0) return;
  const { x0, x1, y } = s;
  const n = hs.length;
  const glow = nonNeg(s.glow);
  const outline = (extra) => {
    ctx.beginPath();
    if (n === 1) {
      // 单个采样：整个 [x0, x1] 半高相同（与 Software_Rasterizer 的插值一致）
      const h = hs[0] + extra;
      ctx.moveTo(x0, y - h);
      ctx.lineTo(x1, y - h);
      ctx.lineTo(x1, y + h);
      ctx.lineTo(x0, y + h);
    } else {
      const step = (x1 - x0) / (n - 1);
      ctx.moveTo(x0, y - hs[0] - extra);
      for (let i = 1; i < n; i++) ctx.lineTo(x0 + step * i, y - hs[i] - extra);
      for (let j = n - 1; j >= 0; j--) ctx.lineTo(x0 + step * j, y + hs[j] + extra);
    }
    ctx.closePath();
  };
  if (glow > 0) {
    ctx.fillStyle = rgba(s.color, alpha * 0.25);
    outline(glow);
    ctx.fill();
  }
  ctx.fillStyle = rgba(s.color, alpha);
  outline(0);
  ctx.fill();
}

/** Text（拍号、行名、「人声 进」）：x 为左边缘（align 可改），y 为竖直中点。ctx 不支持文字或参数无效时跳过。 */
function drawText(ctx, s, alpha) {
  if (typeof ctx.fillText !== 'function' || typeof s.text !== 'string' || !s.text) return;
  if (!isNum(s.x) || !isNum(s.y) || !isNum(s.size) || !(s.size > 0)) return;
  ctx.font = `${s.weight === 500 ? 500 : 400} ${Math.round(s.size)}px system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.textAlign = s.align === 'center' || s.align === 'right' ? s.align : 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = rgba(s.color, alpha);
  ctx.fillText(s.text, s.x, s.y);
}

const DRAWERS = { disc: drawDisc, ring: drawRing, wave: drawWave, rect: drawRect, band: drawBand, text: drawText };

/**
 * 在 Canvas2D 上绘制 Shape 列表（12.6）：先 fillRect 背景（transparent=true 时 clearRect），
 * 再以 globalCompositeOperation = 'lighter' 加法绘制各 Shape，结束时恢复合成模式。
 * @param {CanvasRenderingContext2D} ctx
 * @param {object[]} shapes
 * clear=false 时跳过背景/清空，直接叠加到画布已有内容上（录制画布先画视频帧再叠加，14.3）。
 * @param {{ background?: number[], transparent?: boolean, clear?: boolean }} [opts]
 */
export function drawSceneToCanvas(ctx, shapes, opts = {}) {
  const { background = DEFAULT_BACKGROUND, transparent = false, clear = true } = opts || {};
  const [W, H] = canvasSize(ctx);
  const prevOp = ctx.globalCompositeOperation;
  const prevAlpha = ctx.globalAlpha;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  if (clear === false) {
    // 不清空：保留已绘制的视频帧 / 背景
  } else if (transparent) {
    ctx.clearRect(0, 0, W, H);
  } else {
    ctx.fillStyle = rgba(background, 1);
    ctx.fillRect(0, 0, W, H);
  }
  ctx.globalCompositeOperation = 'lighter';
  try {
    for (const s of Array.isArray(shapes) ? shapes : []) {
      if (!s) continue;
      const draw = DRAWERS[s.kind];
      const alpha = Math.min(1, num(s.alpha));
      if (!draw || !(alpha > 0)) continue;
      draw(ctx, s, alpha);
    }
  } finally {
    ctx.globalCompositeOperation = prevOp === undefined ? 'source-over' : prevOp;
    ctx.globalAlpha = prevAlpha === undefined ? 1 : prevAlpha;
  }
}
