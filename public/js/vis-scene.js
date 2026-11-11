// Scene_Function：sceneAt(t, visData, opts) → Shape 列表（Requirements 3、4、7）。
// 同构纯函数模块：只导入 ./vis-data.js，不读任何全局状态，导入时没有副作用。
// 所有「随机」元素都由 hash01(Stem 序号 / 用途, Shape 序号, Onset 帧序号) 决定（3.9）。
//
// Shape（与 vis-raster.js / vis-canvas.js 一致）：
//   { kind: 'disc', layer, x, y, r, glow, color, alpha }
//   { kind: 'ring', layer, x, y, r, width, glow, color, alpha }
//   { kind: 'wave', layer, x0, x1, ys, width, glow, color, alpha }
//   { kind: 'rect', layer, x, y, w, h, glow, color, alpha }      // x, y 为左上角
// color 为 [r, g, b] 整数，alpha ∈ [0, 1]。
//
// Emphasis_Weight（4.4）：alpha × w.alpha（再夹到 [0, 1]）；尺寸字段 × w.size：
// r、width、glow、贝斯光带的 h、人声波形的起伏（ys − cy）。位置字段（圆心、飞散距离、漂移）不乘。

import { VIS_STEM_IDS, envelopeAt, recentOnsets } from './vis-data.js';

export const MAX_SHAPES = 400;

const freezeColor = (c) => Object.freeze(c);
export const LAYER_COLORS = Object.freeze({
  inst: freezeColor([96, 72, 168]),
  vocal: freezeColor([255, 208, 120]),
  drums: freezeColor([255, 92, 92]),
  bass: freezeColor([72, 132, 255]),
  harmony: freezeColor([120, 220, 184]),
  perc: freezeColor([255, 240, 200]),
  fx: freezeColor([204, 120, 255]),
  other: freezeColor([120, 200, 255]),
});

export const EMPHASIS = Object.freeze({
  selected: Object.freeze({ alpha: 1, size: 1 }),
  other: Object.freeze({ alpha: 0.35, size: 0.8 }),
  all: Object.freeze({ alpha: 0.7, size: 0.9 }),
});

export const REDUCED_ALPHA_MAX = 0.4;

const REDUCED_WINDOW = 0.3; // 秒（7.2）
const TAU = Math.PI * 2;

const DRUM_WINDOW = 0.6;
const DRUM_MAX = 6;
const PERC_WINDOW = 0.4;
const PERC_MAX = 6;
const PERC_SPARKS = 10;
const PARTICLE_BOOST_WINDOW = 0.3;
const PARTICLES = 40;
const HARMONY_BLOBS = 5;
const WAVE_POINTS = 64;

/** 层 id 的 Emphasis_Weight（4.1、4.2）。selected 为 'original' 或不在 VIS_STEM_IDS 时全部用 all。 */
export function emphasisFor(layerId, selected) {
  if (!VIS_STEM_IDS.includes(selected)) return EMPHASIS.all;
  return layerId === selected ? EMPHASIS.selected : EMPHASIS.other;
}

/** 32 位整数哈希 → [0, 1)，参数为若干整数（Stem 序号、Shape 序号、Onset 帧序号）。没有全局状态（3.9）。 */
export function hash01(...ints) {
  let h = 0x811c9dc5 ^ ints.length;
  for (let i = 0; i < ints.length; i++) {
    let k = ints[i] | 0;
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const frac = (v) => v - Math.floor(v);

/**
 * [t − W, t] 内 envelopeAt 的精确平均（Reduced_Motion，7.2）。
 * envelopeAt 在相邻帧点之间、以及 0 / duration 两个边界之间是线性的，所以按这些断点分段、
 * 每段用中点值 × 段长积分是精确的。精确积分对 t 的导数不超过 1 / W，相隔 1/30 秒的两帧
 * 平均值最多相差 (1/30) / 0.3 ≈ 0.111；乘 REDUCED_ALPHA_MAX 后 ≤ 0.045 < 0.05。
 * （vis-data.js 的 envelopeMean 是步长 1 帧的梯形近似，在 t = 0 / duration 处的硬跳变上
 * 最多可差 4 个采样 × 1/30 ≈ 0.133，乘 0.4 后会超过 0.05，所以这里不用它。）
 */
function windowMean(visData, id, t, W) {
  const a = t - W;
  const rate = visData.frameRate > 0 ? visData.frameRate : 100;
  const dur = visData.duration;
  const lo = Math.max(a, 0);
  const hi = Math.min(t, Number.isFinite(dur) ? dur : 0);
  if (!(hi > lo)) return 0;
  let sum = 0;
  let p = lo;
  let k = Math.floor(lo * rate) + 1;
  while (p < hi) {
    let q = k / rate;
    if (q > hi) q = hi;
    if (q > p) sum += (q - p) * envelopeAt(visData, id, (p + q) / 2);
    p = q;
    k++;
  }
  return clamp01(sum / W);
}

function disc(layer, x, y, r, glow, alpha) {
  return { kind: 'disc', layer, x, y, r, glow, color: LAYER_COLORS[layer].slice(), alpha: clamp01(alpha) };
}

/**
 * @param {number} t  秒
 * @param {object} visData
 * @param {{ selected: string, width: number, height: number, reducedMotion?: boolean }} opts
 * @returns {object[]}  按 VIS_STEM_IDS 顺序分层，最多 MAX_SHAPES 个
 */
export function sceneAt(t, visData, opts) {
  const out = [];
  const o = opts || {};
  const width = o.width;
  const height = o.height;
  if (!visData || !visData.stems || !Number.isFinite(width) || !Number.isFinite(height)) return out;
  if (!(width > 0) || !(height > 0)) return out;
  const selected = o.selected;
  const reduced = o.reducedMotion === true;
  // 非有限 t：Envelope 视为 0、没有 Onset，运动相位按 0 计算，保证输出是有限数
  const tt = Number.isFinite(t) ? t : -1;
  const tm = Number.isFinite(t) ? t : 0;

  const u = Math.min(width, height);
  const cx = width / 2;
  const cy = height / 2;
  const stems = visData.stems;

  for (let si = 0; si < VIS_STEM_IDS.length; si++) {
    const id = VIS_STEM_IDS[si];
    if (!Object.prototype.hasOwnProperty.call(stems, id) || !stems[id]) continue;
    const w = emphasisFor(id, selected);
    const S = w.size;
    const A = w.alpha;
    const e = reduced ? 0 : envelopeAt(visData, id, tt);
    const m = reduced ? windowMean(visData, id, tt, REDUCED_WINDOW) : 0;
    const ra = REDUCED_ALPHA_MAX * m; // Reduced_Motion 的基础透明度

    switch (id) {
      case 'inst': {
        out.push(disc(id, cx, cy, 0, 0.6 * u * S, (reduced ? ra * 0.6 : 0.35 * e) * A));
        break;
      }
      case 'vocal': {
        const x0 = 0.05 * width;
        const x1 = 0.95 * width;
        const ys = new Array(WAVE_POINTS);
        if (reduced) {
          ys.fill(cy);
        } else {
          const amp = 0.18 * u * S;
          for (let j = 0; j < WAVE_POINTS; j++) {
            const ej = envelopeAt(visData, id, tt - 0.004 * Math.abs(j - 32));
            ys[j] = cy + amp * Math.sin(TAU * (j / 16 + tm * 0.5)) * ej;
          }
        }
        out.push({
          kind: 'wave', layer: id, x0, x1, ys, width: 0.006 * u * S, glow: 0.02 * u * S,
          color: LAYER_COLORS[id].slice(), alpha: clamp01((reduced ? ra : 0.3 + 0.7 * e) * A),
        });
        break;
      }
      case 'drums': {
        const ringW = 0.012 * u * S;
        const glow = 0.05 * u * S;
        if (reduced) {
          out.push({
            kind: 'ring', layer: id, x: cx, y: cy, r: 0.2 * u * S, width: ringW, glow,
            color: LAYER_COLORS[id].slice(), alpha: clamp01(ra * A),
          });
          break;
        }
        for (const on of recentOnsets(visData, id, tt, DRUM_WINDOW, DRUM_MAX)) {
          const p = clamp01((tt - on.time) / DRUM_WINDOW);
          const fade = 1 - p;
          out.push({
            kind: 'ring', layer: id, x: cx, y: cy, r: (0.08 + p * 0.42) * u * S, width: ringW, glow,
            color: LAYER_COLORS[id].slice(), alpha: clamp01(fade * fade * A),
          });
        }
        break;
      }
      case 'bass': {
        const h = (reduced ? 0.1 : 0.04 + 0.16 * e) * height * S;
        out.push({
          kind: 'rect', layer: id, x: 0, y: height - h, w: width, h, glow: 0.06 * u * S,
          color: LAYER_COLORS[id].slice(), alpha: clamp01((reduced ? ra : 0.25 + 0.6 * e) * A),
        });
        break;
      }
      case 'harmony': {
        for (let k = 0; k < HARMONY_BLOBS; k++) {
          let bx = 0.15 + 0.7 * hash01(4, k, 0);
          let by = 0.15 + 0.7 * hash01(4, k, 1);
          if (!reduced) {
            const px = 20 + 20 * hash01(8, k, 0); // 周期 20–40 秒
            const py = 20 + 20 * hash01(8, k, 1);
            bx += 0.12 * Math.sin(TAU * (tm / px + hash01(9, k, 0)));
            by += 0.12 * Math.cos(TAU * (tm / py + hash01(9, k, 1)));
          }
          const glow = (0.18 + 0.1 * hash01(7, k)) * u * S;
          out.push(disc(id, bx * width, by * height, 0, glow, (reduced ? ra * 0.75 : 0.3 * e) * A));
        }
        break;
      }
      case 'perc': {
        if (reduced) {
          out.push(disc(id, cx, cy, 0.02 * u * S, 0.04 * u * S, ra * A));
          break;
        }
        const r = 0.004 * u * S;
        const glow = 0.012 * u * S;
        for (const on of recentOnsets(visData, id, tt, PERC_WINDOW, PERC_MAX)) {
          const p = clamp01((tt - on.time) / PERC_WINDOW);
          for (let k = 0; k < PERC_SPARKS; k++) {
            const th = TAU * hash01(5, on.index, k);
            const dist = (0.05 + p * (0.25 + 0.15 * hash01(6, on.index, k))) * u;
            out.push(disc(id, cx + Math.cos(th) * dist, cy + Math.sin(th) * dist, r, glow, (1 - p) * A));
          }
        }
        break;
      }
      case 'fx':
      case 'other': {
        const r = 0.003 * u * S;
        const glow = 0.01 * u * S;
        let alpha;
        if (reduced) {
          alpha = ra;
        } else {
          const last = recentOnsets(visData, id, tt, PARTICLE_BOOST_WINDOW, 1);
          const boost = last.length ? Math.max(0, 1 - (tt - last[0].time) / PARTICLE_BOOST_WINDOW) : 0;
          alpha = 0.15 + 0.6 * e + 0.25 * boost;
        }
        alpha = clamp01(alpha * A);
        const drift = 0.01 * u * tm; // 像素，0.01u/s
        for (let k = 0; k < PARTICLES; k++) {
          let fx = hash01(si, k, 0);
          let fy = hash01(si, k, 1);
          if (!reduced) {
            const th = TAU * hash01(si, k, 2);
            fx = frac(fx + (Math.cos(th) * drift) / width);
            fy = frac(fy + (Math.sin(th) * drift) / height);
          }
          out.push({ kind: 'disc', layer: id, x: fx * width, y: fy * height, r, glow, color: LAYER_COLORS[id].slice(), alpha });
        }
        break;
      }
      default:
        break;
    }
  }

  if (out.length > MAX_SHAPES) out.length = MAX_SHAPES;
  return out;
}
