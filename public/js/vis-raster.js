// Software_Rasterizer：把 Scene_Function 输出的 Shape 列表加法混合到 RGB24 缓冲（Requirement 12）。
// 同构模块：只用 Math 和类型化数组，没有 import，导入时没有副作用（12.4）。
//
// 覆盖率 cov(d) = d ≤ 0 ? 1 : (glow > 0 ? max(0, 1 − d / glow)² : 0)，d 是像素中心到核心形状外的距离。
// 每个 Shape 只遍历外接框与画面的交集（12.3），cov = 0 的像素不写。

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function nonNeg(v) {
  return isNum(v) && v > 0 ? v : 0;
}

/**
 * @param {number} width  ≥ 1 的整数
 * @param {number} height ≥ 1 的整数
 */
export function createRasterizer(width, height) {
  const W = Math.floor(width);
  const H = Math.floor(height);
  if (!(W >= 1) || !(H >= 1)) throw new RangeError('width and height must be integers >= 1');
  const frameBytes = W * H * 3;
  const acc = new Float32Array(frameBytes);
  const own = new Uint8Array(frameBytes);
  const rowStride = W * 3;

  // 当前 Shape 的预乘颜色（color × alpha）
  let cr = 0;
  let cg = 0;
  let cb = 0;

  // 圆盘与圆环共用：以 (x, y) 为圆心，|dist − c| − hw 为距离；c = 0、hw = r 时就是 disc。
  // innerR = c − hw − glow > 0 时，圆内更小的范围覆盖率为 0，每行跳过这一段。
  function radial(x, y, c, hw, glow) {
    const outer = c + hw + glow;
    const outer2 = outer * outer;
    const core = c + hw;
    const core2 = core * core;
    const coreIn = c - hw; // 核心内边界（ring）
    const coreIn2 = coreIn > 0 ? coreIn * coreIn : -1;
    const inner = c - hw - glow;
    const inner2 = inner > 0 ? inner * inner : -1;
    const invG = glow > 0 ? 1 / glow : 0;
    const isRing = c > 0;
    const yA = Math.max(0, Math.ceil(y - outer - 0.5));
    const yB = Math.min(H - 1, Math.floor(y + outer - 0.5));
    for (let py = yA; py <= yB; py++) {
      const dy = py + 0.5 - y;
      const dy2 = dy * dy;
      const rem = outer2 - dy2;
      if (rem < 0) continue;
      const hx = Math.sqrt(rem);
      const xA = Math.max(0, Math.ceil(x - hx - 0.5));
      const xB = Math.min(W - 1, Math.floor(x + hx - 0.5));
      // 内部空洞中确定覆盖率为 0 的整数列区间（保守地各缩 1 列）
      let skipA = xB + 1;
      let skipB = xB;
      if (inner2 > dy2) {
        const hi = Math.sqrt(inner2 - dy2);
        skipA = Math.ceil(x - hi - 0.5) + 1;
        skipB = Math.floor(x + hi - 0.5) - 1;
      }
      let i = py * rowStride + xA * 3;
      for (let px = xA; px <= xB; px++, i += 3) {
        if (px >= skipA && px <= skipB) {
          i += (skipB - px + 1) * 3;
          px = skipB + 1;
          if (px > xB) break;
        }
        const dx = px + 0.5 - x;
        const d2 = dx * dx + dy2;
        if (d2 >= outer2 && glow > 0) continue;
        if (d2 <= inner2) continue;
        let cov;
        if (d2 <= core2 && d2 >= coreIn2) {
          cov = 1;
        } else {
          if (invG === 0) continue;
          const dist = Math.sqrt(d2);
          const d = isRing ? Math.abs(dist - c) - hw : dist - hw;
          if (d <= 0) {
            cov = 1;
          } else {
            const t = 1 - d * invG;
            if (t <= 0) continue;
            cov = t * t;
          }
        }
        acc[i] += cr * cov;
        acc[i + 1] += cg * cov;
        acc[i + 2] += cb * cov;
      }
    }
  }

  function drawRect(x, y, w, h, glow) {
    const hx = w / 2;
    const hy = h / 2;
    const cx = x + hx;
    const cy = y + hy;
    const invG = glow > 0 ? 1 / glow : 0;
    const g2 = glow * glow;
    const xA = Math.max(0, Math.ceil(x - glow - 0.5));
    const xB = Math.min(W - 1, Math.floor(x + w + glow - 0.5));
    const yA = Math.max(0, Math.ceil(y - glow - 0.5));
    const yB = Math.min(H - 1, Math.floor(y + h + glow - 0.5));
    if (xA > xB) return;
    for (let py = yA; py <= yB; py++) {
      const qy = Math.abs(py + 0.5 - cy) - hy;
      const oy = qy > 0 ? qy : 0;
      const oy2 = oy * oy;
      if (qy > 0 && (invG === 0 || oy2 >= g2)) continue;
      let i = py * rowStride + xA * 3;
      for (let px = xA; px <= xB; px++, i += 3) {
        const qx = Math.abs(px + 0.5 - cx) - hx;
        let cov;
        if (qx <= 0 && qy <= 0) {
          cov = 1;
        } else {
          if (invG === 0) continue;
          const ox = qx > 0 ? qx : 0;
          const s = ox * ox + oy2;
          if (s >= g2) continue;
          const t = 1 - Math.sqrt(s) * invG;
          cov = t * t;
        }
        acc[i] += cr * cov;
        acc[i + 1] += cg * cov;
        acc[i + 2] += cb * cov;
      }
    }
  }

  // 波形：ys 在 [x0, x1] 上等距采样，距离为竖直距离 |p.y − lerp| − width/2；每列插值一次。
  function drawWave(x0, x1, ys, hw, glow) {
    const n = ys.length;
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);
    const span = x1 - x0;
    const R = hw + glow;
    const invG = glow > 0 ? 1 / glow : 0;
    const xA = Math.max(0, Math.ceil(lo - 0.5));
    const xB = Math.min(W - 1, Math.floor(hi - 0.5));
    for (let px = xA; px <= xB; px++) {
      let yc;
      if (n === 1 || span === 0) {
        yc = ys[0];
      } else {
        let u = ((px + 0.5 - x0) / span) * (n - 1);
        if (u < 0) u = 0;
        else if (u > n - 1) u = n - 1;
        let k = Math.floor(u);
        if (k > n - 2) k = n - 2;
        const a = ys[k];
        yc = a + (ys[k + 1] - a) * (u - k);
      }
      const yA = Math.max(0, Math.ceil(yc - R - 0.5));
      const yB = Math.min(H - 1, Math.floor(yc + R - 0.5));
      let i = yA * rowStride + px * 3;
      for (let py = yA; py <= yB; py++, i += rowStride) {
        const d = Math.abs(py + 0.5 - yc) - hw;
        let cov;
        if (d <= 0) {
          cov = 1;
        } else {
          if (invG === 0) continue;
          const t = 1 - d * invG;
          if (t <= 0) continue;
          cov = t * t;
        }
        acc[i] += cr * cov;
        acc[i + 1] += cg * cov;
        acc[i + 2] += cb * cov;
      }
    }
  }

  // Band：中线 y 固定，半高 hs 在 [x0, x1] 上等距采样；距离为 |p.y − y| − h(p.x)。
  // 列范围与每列插值的算术与 drawWave 逐项一致（yc 换成常数 y、hw 换成插值的 h），
  // 因此 hs 全为 h 时与 ys 全为 y、width = 2h 的 wave 逐字节相同（Requirement 9.3）。
  function drawBand(x0, x1, y, hs, glow) {
    const n = hs.length;
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);
    const span = x1 - x0;
    const invG = glow > 0 ? 1 / glow : 0;
    const xA = Math.max(0, Math.ceil(lo - 0.5));
    const xB = Math.min(W - 1, Math.floor(hi - 0.5));
    for (let px = xA; px <= xB; px++) {
      let h;
      if (n === 1 || span === 0) {
        h = hs[0];
      } else {
        let u = ((px + 0.5 - x0) / span) * (n - 1);
        if (u < 0) u = 0;
        else if (u > n - 1) u = n - 1;
        let k = Math.floor(u);
        if (k > n - 2) k = n - 2;
        const a = hs[k];
        h = a + (hs[k + 1] - a) * (u - k);
      }
      const R = h + glow;
      const yA = Math.max(0, Math.ceil(y - R - 0.5));
      const yB = Math.min(H - 1, Math.floor(y + R - 0.5));
      let i = yA * rowStride + px * 3;
      for (let py = yA; py <= yB; py++, i += rowStride) {
        const d = Math.abs(py + 0.5 - y) - h;
        let cov;
        if (d <= 0) {
          cov = 1;
        } else {
          if (invG === 0) continue;
          const t = 1 - d * invG;
          if (t <= 0) continue;
          cov = t * t;
        }
        acc[i] += cr * cov;
        acc[i + 1] += cg * cov;
        acc[i + 2] += cb * cov;
      }
    }
  }

  function drawShape(s) {
    if (!s || typeof s !== 'object') return;
    const alpha = s.alpha;
    if (!isNum(alpha) || alpha <= 0) return;
    const col = s.color;
    if (!col || col.length < 3) return;
    const r0 = col[0] * alpha;
    const g0 = col[1] * alpha;
    const b0 = col[2] * alpha;
    if (!isNum(r0) || !isNum(g0) || !isNum(b0)) return;
    cr = r0 > 0 ? r0 : 0;
    cg = g0 > 0 ? g0 : 0;
    cb = b0 > 0 ? b0 : 0;
    if (cr === 0 && cg === 0 && cb === 0) return;
    const glow = nonNeg(s.glow);
    switch (s.kind) {
      case 'disc': {
        if (!isNum(s.x) || !isNum(s.y)) return;
        radial(s.x, s.y, 0, nonNeg(s.r), glow);
        return;
      }
      case 'ring': {
        if (!isNum(s.x) || !isNum(s.y)) return;
        const r = nonNeg(s.r);
        const hw = nonNeg(s.width) / 2;
        if (r === 0) radial(s.x, s.y, 0, hw, glow); // |dist − 0| − hw 即半径 hw 的圆盘
        else radial(s.x, s.y, r, hw, glow);
        return;
      }
      case 'rect': {
        if (!isNum(s.x) || !isNum(s.y)) return;
        drawRect(s.x, s.y, nonNeg(s.w), nonNeg(s.h), glow);
        return;
      }
      case 'wave': {
        const ys = s.ys;
        if (!isNum(s.x0) || !isNum(s.x1) || !ys || !(ys.length >= 1)) return;
        for (let k = 0; k < ys.length; k++) if (!isNum(ys[k])) return;
        drawWave(s.x0, s.x1, ys, nonNeg(s.width) / 2, glow);
        return;
      }
      case 'band': {
        const hs = s.hs;
        if (!isNum(s.x0) || !isNum(s.x1) || !isNum(s.y) || !hs || !(hs.length >= 1)) return;
        for (let k = 0; k < hs.length; k++) if (!isNum(hs[k]) || hs[k] < 0) return; // 9.5
        drawBand(s.x0, s.x1, s.y, hs, glow);
        return;
      }
      default:
        return;
    }
  }

  /**
   * @param {object[]} shapes
   * @param {number[]} background [r, g, b]
   * @param {Uint8Array} [out] 至少 frameBytes 字节；未给出时使用内部缓冲
   * @returns {Uint8Array}
   */
  function render(shapes, background, out) {
    const dst = out || own;
    if (dst.length < frameBytes) throw new RangeError('output buffer too small');
    const bg = background || [0, 0, 0];
    const br = isNum(bg[0]) ? bg[0] : 0;
    const bgG = isNum(bg[1]) ? bg[1] : 0;
    const bb = isNum(bg[2]) ? bg[2] : 0;
    for (let i = 0; i < frameBytes; i += 3) {
      acc[i] = br;
      acc[i + 1] = bgG;
      acc[i + 2] = bb;
    }
    if (shapes) {
      for (let k = 0; k < shapes.length; k++) drawShape(shapes[k]);
    }
    for (let i = 0; i < frameBytes; i++) {
      const v = acc[i];
      dst[i] = v >= 255 ? 255 : v <= 0 ? 0 : (v + 0.5) | 0;
    }
    return dst;
  }

  return { width: W, height: H, frameBytes, render };
}
