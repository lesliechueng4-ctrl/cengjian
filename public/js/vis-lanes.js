// Lane_Function：lanesAt(t, visData, opts) → Lane_Strip 的 Shape 列表（stem-lanes Requirements 2–5、7、8）。
// 同构纯函数模块：只导入 ./vis-data.js 和 ./vis-scene.js，不读任何全局状态，导入时没有副作用。
// 同一模块还提供 laneLayout、laneLabelSpecs、onsetsInWindow 和 stackedLayout（导出叠放尺寸）。
//
// Shape 在 vis-scene.js 的四种图元之外增加 band：
//   { kind: 'band', layer, x0, x1, y, hs, glow, color, alpha }   // 中线 y，[x0, x1] 上等距采样的半高 hs
// role（baseline / band / marker / flash / playhead）和 side（past / future）只供测试和调试使用。

import { envelopeAt, ONSET_STEM_IDS, VIS_FRAME_RATE } from './vis-data.js';
import { LAYER_COLORS, emphasisFor, MAX_SHAPES } from './vis-scene.js';

export const LANE_ORDER = Object.freeze(['drums', 'perc', 'bass', 'vocal', 'harmony', 'inst', 'fx', 'other']);
export const LANE_PAST_SEC = 1;
export const LANE_FUTURE_SEC = 3;
export const LANE_SELECTED_WEIGHT = 3;
export const LANE_BACKGROUND = Object.freeze([11, 13, 20]); // #0b0d14
export const LANE_ENV_SCALE = 0.45;        // Envelope_Lane 半高 / Lane 高度
export const LANE_ONSET_ENV_SCALE = 0.35;  // Onset_Lane 淡 Band
export const LANE_MAX_SAMPLES = 400;
export const LANE_MAX_MARKERS = 48;
export const LANE_FLASH_SEC = 0.15;
export const LANE_LABEL_MIN_PX = 14;
export const LANE_ALPHA = Object.freeze({
  band: 0.85, faintBand: 0.22, marker: 0.95, baseline: 0.12, playhead: 0.85, flash: 0.9,
});
export const LANE_PAST_DIM = Object.freeze({ band: 0.45, marker: 0.4 });
export const PLAYHEAD_COLOR = Object.freeze([255, 255, 255]);
export const STRIP_RATIO = 0.2;
export const STRIP_MIN = 96;

const DEFAULT_PICTURE_W = 1280;
const DEFAULT_PICTURE_H = 720;
const DEFAULT_BOX = 1920;
const FIT_EPS = 1e-7; // 抵消 w × (max / w) 略小于 max 的舍入误差

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const even = (v) => v - (v % 2);
const isOnsetStem = (id) => ONSET_STEM_IDS.includes(id);
const isPositive = (v) => Number.isFinite(v) && v > 0;

/**
 * Lane_Layout（2.1、2.2、5.1、5.2）。ids 中属于 LANE_ORDER 的按 LANE_ORDER 排序、去重；
 * selected 在其中且 Lane 数 > 1 时权重 3，其余 1。y_k = height × (前 k 条权重和) / 总权重，
 * 最后一条 h = height − y_last，使总和正好等于 height。ids 为空或 height 无效时返回 []。
 * @param {Iterable<string>} ids
 * @param {string} selected
 * @param {number} height
 * @returns {{ id: string, y: number, h: number }[]}
 */
export function laneLayout(ids, selected, height) {
  if (!isPositive(height) || ids == null) return [];
  const present = new Set(Array.from(ids));
  const lanes = LANE_ORDER.filter((id) => present.has(id));
  const n = lanes.length;
  if (n === 0) return [];
  const weighted = n > 1 && lanes.includes(selected);
  const weightOf = (id) => (weighted && id === selected ? LANE_SELECTED_WEIGHT : 1);
  let total = 0;
  for (const id of lanes) total += weightOf(id);
  const out = [];
  let cum = 0;
  for (let k = 0; k < n; k++) {
    const id = lanes[k];
    const w = weightOf(id);
    const y = (height * cum) / total;
    const h = k === n - 1 ? height - y : (height * w) / total;
    out.push({ id, y, h });
    cum += w;
  }
  return out;
}

/** Lane_Label 规格（2.4）：[{ id, top: y + h / 2, visible: h ≥ minPx }]，顺序同 layout。 */
export function laneLabelSpecs(layout, minPx = LANE_LABEL_MIN_PX) {
  if (!Array.isArray(layout)) return [];
  return layout.map((lane) => ({ id: lane.id, top: lane.y + lane.h / 2, visible: lane.h >= minPx }));
}

/**
 * [t0, t1] ∩ [0, duration] 内（两端都包含）Onset 的时间（秒，idx / frameRate），按时间递增。
 * onsets 是严格递增的 Int32Array，二分查找起点，只分配结果数组。
 * @returns {number[]}
 */
export function onsetsInWindow(visData, id, t0, t1) {
  const out = [];
  if (!visData || !Number.isFinite(t0) || !Number.isFinite(t1)) return out;
  const stem = visData.stems && hasOwn(visData.stems, id) ? visData.stems[id] : null;
  const onsets = stem && stem.onsets;
  if (!onsets || onsets.length === 0) return out;
  const rate = visData.frameRate || VIS_FRAME_RATE;
  const dur = Number.isFinite(visData.duration) ? visData.duration : 0;
  const lower = t0 > 0 ? t0 : 0;
  const upper = t1 < dur ? t1 : dur;
  if (!(upper >= lower)) return out;
  // 二分查找第一个 time ≥ lower 的位置
  let lo = 0;
  let hi = onsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (onsets[mid] / rate < lower) lo = mid + 1;
    else hi = mid;
  }
  for (let k = lo; k < onsets.length; k++) {
    const time = onsets[k] / rate;
    if (time > upper) break;
    out.push(time);
  }
  return out;
}

const stripHeightFor = (ow) => Math.max(STRIP_MIN, even(Math.round(STRIP_RATIO * ow)));

/**
 * 叠放尺寸（design 决策 8；12.2、12.3、13.1）。w、h 不是正有限数时按 1280×720。
 * 画面按原宽高比缩小（不放大），width ≤ maxW，pictureHeight + stripHeight ≤ maxH。
 * @returns {{ width: number, pictureHeight: number, stripHeight: number }}  全部为 ≥ 2 的偶数
 */
export function stackedLayout(w, h, maxW, maxH) {
  if (!isPositive(w) || !isPositive(h)) {
    w = DEFAULT_PICTURE_W;
    h = DEFAULT_PICTURE_H;
  }
  const bw = isPositive(maxW) ? maxW : DEFAULT_BOX;
  const bh = isPositive(maxH) ? maxH : DEFAULT_BOX;
  const k = Math.min(1, bw / w, bh / (h + STRIP_RATIO * w));
  let width = Math.max(2, even(Math.floor(w * k + FIT_EPS)));
  let pictureHeight = Math.max(2, even(Math.floor(h * k + FIT_EPS)));
  if (width > bw) width = Math.max(2, even(Math.floor(bw)));
  let stripHeight = stripHeightFor(width);
  if (pictureHeight + stripHeight > bh) {
    // 只会在 STRIP_MIN 下限起作用时发生
    pictureHeight = Math.max(2, even(Math.floor(bh - stripHeight)));
    width = Math.max(2, even(Math.min(width, Math.floor((w * pictureHeight) / h + FIT_EPS))));
    stripHeight = stripHeightFor(width);
  }
  return { width, pictureHeight, stripHeight };
}

function stemIdsOf(visData) {
  const stems = visData && visData.stems;
  if (!stems || typeof stems !== 'object') return [];
  return Object.keys(stems).filter((id) => !!stems[id]);
}

/** 离 t 最近的 limit 个（距离相同时取较早的），再按时间升序（4.4）。times 已按时间升序。 */
function nearestOnsets(times, t, limit) {
  if (times.length <= limit) return times;
  // times 有序，所以最近的 limit 个是一段连续区间：从两端向内收缩
  let lo = 0;
  let hi = times.length - 1;
  while (hi - lo + 1 > limit) {
    const dl = Math.abs(times[lo] - t);
    const dh = Math.abs(times[hi] - t);
    if (dh >= dl) hi--; // 并列时去掉较晚的
    else lo++;
  }
  return times.slice(lo, hi + 1);
}

/**
 * @param {number} t  秒（媒体时间）
 * @param {object} visData
 * @param {{ selected: string, width: number, height: number, reducedMotion?: boolean,
 *           pastSec?: number, futureSec?: number }} opts
 *   pastSec / futureSec 不是 ≥ 0 的有限数时用默认值 1 / 3；两者之和为 0 时都用默认值（3.2）。
 * @returns {object[]}  最多 MAX_SHAPES 个；尺寸无效、t 非有限数或没有 Stem 时为 []（8.5）
 */
export function lanesAt(t, visData, opts) {
  const out = [];
  const o = opts || {};
  const W = o.width;
  const H = o.height;
  if (!Number.isFinite(W) || !Number.isFinite(H) || !(W >= 1) || !(H >= 1)) return out;
  if (!Number.isFinite(t) || !visData) return out;
  const layout = laneLayout(stemIdsOf(visData), o.selected, H);
  if (layout.length === 0) return out;

  let past = Number.isFinite(o.pastSec) && o.pastSec >= 0 ? o.pastSec : LANE_PAST_SEC;
  let future = Number.isFinite(o.futureSec) && o.futureSec >= 0 ? o.futureSec : LANE_FUTURE_SEC;
  if (!(past + future > 0)) {
    past = LANE_PAST_SEC;
    future = LANE_FUTURE_SEC;
  }
  const selected = o.selected;
  const reduced = o.reducedMotion === true;
  const S = past + future;
  const px = W / S;
  const playheadX = (W * past) / S;
  const xAt = (tau) => playheadX + (tau - t) * px;

  // 采样网格（决策 7）：每条 Lane 对 m0 … m1 各取一次包络，最多 n + 2 个
  const n = clamp(Math.ceil(W / 2), 1, LANE_MAX_SAMPLES);
  const dt = S / n;
  const m0 = Math.floor((t - past) / dt);
  const m1 = Math.min(Math.ceil((t + future) / dt), m0 + n + 1);
  const mp = clamp(Math.ceil(t / dt), m0, m1);
  const count = m1 - m0 + 1;
  const xPast0 = xAt(m0 * dt);
  const xMid = xAt(mp * dt);
  const xFuture1 = xAt(m1 * dt);

  const markerW = clamp(0.006 * W, 2, 8);

  for (const lane of layout) {
    const id = lane.id;
    const ly = lane.y;
    const lh = lane.h;
    const cy = ly + lh / 2;
    const a = emphasisFor(id, selected).alpha;
    const color = LAYER_COLORS[id];
    const onsetLane = isOnsetStem(id);
    const scale = onsetLane ? LANE_ONSET_ENV_SCALE : LANE_ENV_SCALE;
    const bandBase = onsetLane ? LANE_ALPHA.faintBand : LANE_ALPHA.band;

    // baseline：Lane 中线上的细线（Lane 很矮时变细，保持在 Lane 内）
    const bh = lh < 2 ? lh / 2 : 1;
    out.push({
      kind: 'rect', layer: id, role: 'baseline', x: 0, y: cy - bh / 2, w: W, h: bh, glow: 0,
      color: color.slice(), alpha: clamp01(LANE_ALPHA.baseline * a),
    });

    // Band：每个网格点只调用一次 envelopeAt（10.4）
    const hs = new Array(count);
    for (let j = 0; j < count; j++) hs[j] = scale * lh * envelopeAt(visData, id, (m0 + j) * dt);
    const glow = 0.1 * lh;
    if (mp > m0) {
      out.push({
        kind: 'band', layer: id, role: 'band', side: 'past', x0: xPast0, x1: xMid, y: cy,
        hs: hs.slice(0, mp - m0 + 1), glow, color: color.slice(),
        alpha: clamp01(bandBase * LANE_PAST_DIM.band * a),
      });
    }
    if (m1 > mp) {
      out.push({
        kind: 'band', layer: id, role: 'band', side: 'future', x0: xMid, x1: xFuture1, y: cy,
        hs: hs.slice(mp - m0), glow, color: color.slice(), alpha: clamp01(bandBase * a),
      });
    }

    if (!onsetLane) continue;

    // Onset_Marker（3.3、3.6、4.3、4.4、4.5）
    const times = nearestOnsets(onsetsInWindow(visData, id, t - past, t + future), t, LANE_MAX_MARKERS);
    const mh = 0.7 * lh;
    const mGlow = clamp(0.15 * lh, 1, 6);
    for (const tau of times) {
      const isPast = tau <= t;
      out.push({
        kind: 'rect', layer: id, role: 'marker', side: isPast ? 'past' : 'future',
        x: xAt(tau) - markerW / 2, y: cy - 0.35 * lh, w: markerW, h: mh, glow: mGlow, color: color.slice(),
        alpha: clamp01(isPast ? LANE_ALPHA.marker * LANE_PAST_DIM.marker * a : LANE_ALPHA.marker * a),
      });
    }

    // Playhead_Flash（4.7）：(t − 0.15, t] 内最近的 Onset，每条 Lane 最多一个
    if (!reduced) {
      const recent = onsetsInWindow(visData, id, t - LANE_FLASH_SEC, t);
      const tau = recent.length ? recent[recent.length - 1] : NaN;
      if (tau > t - LANE_FLASH_SEC) {
        const q = 1 - (t - tau) / LANE_FLASH_SEC;
        out.push({
          kind: 'disc', layer: id, role: 'flash', x: playheadX, y: cy, r: 0.2 * lh, glow: 0.8 * lh,
          color: color.slice(), alpha: clamp01(LANE_ALPHA.flash * q * q * a),
        });
      }
    }
  }

  // Playhead（4.6）：贯穿全高的白线，不乘亮度系数
  const pw = Math.max(2, Math.round(0.003 * W));
  out.push({
    kind: 'rect', layer: 'playhead', role: 'playhead', x: playheadX - pw / 2, y: 0, w: pw, h: H, glow: pw,
    color: PLAYHEAD_COLOR.slice(), alpha: LANE_ALPHA.playhead,
  });

  if (out.length > MAX_SHAPES) out.length = MAX_SHAPES;
  return out;
}
