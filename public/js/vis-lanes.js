// Lane_Function：lanesAt(t, visData, opts) → 流动时间线的 Shape 列表。
// 同构纯函数模块：只导入 ./vis-data.js 和 ./vis-scene.js，不读任何全局状态，导入时没有副作用。
//
// 时间从右往左流过白色的播放线。每个声音占一行（Row）：
//   K / S / H   Kick、Snare、Hi-hat 的每一下（Vis_Data.marks；没有 marks 时退回一行 drums，用鼓的 Onset）
//   bass        每个音一条带长度的横条（没有 marks 时画响度波形）
//   vocal / harmony            响度波形
//   fx / other                 只在选中这条音轨时出现
// 还没到的音符小而暗；越过播放线的 0.25 秒内放大、变亮并在播放线上炸开一个圆环（Pop）；
// 之后变暗留在左边。一行沉默两小节以上后重新出现时，整行闪一下并显示「<名字> 进」（Entry）。
// 有拍子网格（Vis_Data.beat）时画拍线，每小节第 1 拍更粗，上方标 1 2 3 4。
//
// Shape 在 vis-scene.js 的四种图元之外增加：
//   { kind: 'band', layer, x0, x1, y, hs, glow, color, alpha }          // 中线 y，[x0, x1] 上等距采样的半高 hs
//   { kind: 'text', layer, x, y, text, size, weight, align, color, alpha } // 只有 Canvas 后端会画，软件光栅忽略
// role 和 side（past / future）只供测试和调试使用。

import { envelopeAt, VIS_FRAME_RATE, VIS_STEM_IDS } from './vis-data.js';
import { LAYER_COLORS, MAX_SHAPES, sceneAt } from './vis-scene.js';

export const LANE_PAST_SEC = 1;
export const LANE_FUTURE_SEC = 3;
export const LANE_BACKGROUND = Object.freeze([11, 13, 20]); // #0b0d14
export const LANE_ENV_SCALE = 0.42;        // 波形半高 / 行高
export const LANE_MAX_SAMPLES = 400;
export const LANE_MAX_MARKERS = 64;        // 每行最多画的音符数（离播放线最近的）
export const LANE_POP_SEC = 0.25;
export const LANE_POP_SCALE = 1.3;         // 弹出时最多放大到 1 + 1.3 倍
export const LANE_ENTRY_SEC = 1.2;
export const LANE_LABEL_MIN_PX = 14;
export const LANE_SELECTED_WEIGHT = 1.8;
export const LANE_ALPHA = Object.freeze({
  future: 0.6, past: 0.3, pop: 1, ring: 0.8, band: 0.8, baseline: 0.1, playhead: 0.9,
  beat: 0.1, bar: 0.3, entry: 0.22, note: 0.45,
});
export const LANE_PAST_DIM = 0.45;
export const LANE_EMPHASIS = Object.freeze({ selected: 1, other: 0.5, all: 0.85 });
export const PLAYHEAD_COLOR = Object.freeze([255, 255, 255]);
export const STRIP_RATIO = 0.2;
export const STRIP_MIN = 96;
export const STAGE_AMBIENT_ALPHA = 0.3;
export const STAGE_AMBIENT_LAYERS = Object.freeze(['inst', 'harmony', 'fx', 'other']);

export const ROW_ORDER = Object.freeze(['K', 'S', 'H', 'drums', 'bass', 'vocal', 'harmony', 'fx', 'other']);
export const ROW_NAMES = Object.freeze({
  K: 'Kick', S: 'Snare', H: 'Hi-hat', drums: '鼓', bass: '贝斯', vocal: '人声', harmony: '和声', fx: '效果音', other: '其他音效',
});
export const ROW_COLORS = Object.freeze({
  K: LAYER_COLORS.drums, S: Object.freeze([255, 168, 72]), H: LAYER_COLORS.perc, drums: LAYER_COLORS.drums,
  bass: LAYER_COLORS.bass, vocal: LAYER_COLORS.vocal, harmony: LAYER_COLORS.harmony,
  fx: LAYER_COLORS.fx, other: LAYER_COLORS.other,
});
const ROW_STEM = Object.freeze({ K: 'drums', S: 'drums', H: 'drums' });
const ROW_WEIGHT = Object.freeze({ K: 1.2, S: 1.2, H: 1, drums: 1.4, bass: 1.2, vocal: 0.8, harmony: 0.8, fx: 0.9, other: 0.9 });

const DEFAULT_PICTURE_W = 1280;
const DEFAULT_PICTURE_H = 720;
const DEFAULT_BOX = 1920;
const FIT_EPS = 1e-7; // 抵消 w × (max / w) 略小于 max 的舍入误差

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const even = (v) => v - (v % 2);
const isPositive = (v) => Number.isFinite(v) && v > 0;
const stemOf = (visData, id) => (visData && visData.stems && hasOwn(visData.stems, id) ? visData.stems[id] : null);
const marksOf = (visData, key) => (visData && visData.marks && visData.marks[key] ? visData.marks[key] : null);

/** 这一行属于哪条音轨（K / S / H 属于 drums，其余就是自己）。 */
export const rowStem = (rowId) => ROW_STEM[rowId] || rowId;

/** 选中 selected 时这一行是不是被强调的那一行：音轨相同；选「额外打击乐」时是 Hi-hat。 */
function rowMatches(rowId, selected) {
  return rowStem(rowId) === selected || (selected === 'perc' && rowId === 'H');
}

/**
 * 要画的行（按 ROW_ORDER）。有 marks.K / S / H 时各一行，否则有鼓音轨就画一行 drums；
 * bass、vocal、harmony 有数据就画；fx / other 只在被选中时画。
 * @returns {string[]}
 */
export function laneRows(visData, selected) {
  if (!visData || !visData.stems) return [];
  const rows = [];
  const hits = ['K', 'S', 'H'].filter((k) => marksOf(visData, k));
  if (hits.length) rows.push(...hits);
  else if (stemOf(visData, 'drums')) rows.push('drums');
  for (const id of ['bass', 'vocal', 'harmony']) if (stemOf(visData, id)) rows.push(id);
  if ((selected === 'fx' || selected === 'other') && stemOf(visData, selected)) rows.push(selected);
  return rows;
}

/** 每一行的亮度系数：有被选中的行时它为 1、其余 0.5；否则（原曲、纯伴奏、没有对应的行）全部 0.85。 */
export function rowEmphasis(rows, selected) {
  const any = VIS_STEM_IDS.includes(selected) && rows.some((id) => rowMatches(id, selected));
  const out = {};
  for (const id of rows) out[id] = !any ? LANE_EMPHASIS.all : rowMatches(id, selected) ? LANE_EMPHASIS.selected : LANE_EMPHASIS.other;
  return out;
}

/**
 * Lane_Layout：各行自上而下排在 [top, height) 内，高度按权重分配（Kick / Snare / Bass 略高，
 * 人声 / 和声略矮；被选中的行再 × 1.8）。最后一行补齐舍入误差。没有行或尺寸无效时返回 []。
 * @param {object} visData
 * @param {string} selected
 * @param {number} height
 * @param {number} [top=0]  顶部留给拍号的高度
 * @returns {{ id: string, y: number, h: number }[]}
 */
export function laneLayout(visData, selected, height, top = 0) {
  if (!isPositive(height)) return [];
  const y0 = Number.isFinite(top) && top > 0 && top < height ? top : 0;
  const rows = laneRows(visData, selected);
  const n = rows.length;
  if (n === 0) return [];
  const emph = rowEmphasis(rows, selected);
  const weightOf = (id) => ROW_WEIGHT[id] * (n > 1 && emph[id] === LANE_EMPHASIS.selected ? LANE_SELECTED_WEIGHT : 1);
  let total = 0;
  for (const id of rows) total += weightOf(id);
  const avail = height - y0;
  const out = [];
  let cum = 0;
  for (let k = 0; k < n; k++) {
    const w = weightOf(rows[k]);
    const y = y0 + (avail * cum) / total;
    const h = k === n - 1 ? height - y : (avail * w) / total;
    out.push({ id: rows[k], y, h });
    cum += w;
  }
  return out;
}

/** 顶部拍号区的高度：有拍子网格时 min(0.1 × 高, 0.03 × 宽)，否则 0。 */
export function laneHeaderHeight(visData, width, height) {
  if (!visData || !visData.beat || !isPositive(width) || !isPositive(height)) return 0;
  return Math.min(0.1 * height, 0.03 * width);
}

/** Lane_Label 规格：[{ id, top: y + h / 2, visible: h ≥ minPx }]，顺序同 layout。 */
export function laneLabelSpecs(layout, minPx = LANE_LABEL_MIN_PX) {
  if (!Array.isArray(layout)) return [];
  return layout.map((lane) => ({ id: lane.id, top: lane.y + lane.h / 2, visible: lane.h >= minPx }));
}

/** frames（严格递增的帧序号）中时间落在 [t0, t1] ∩ [0, duration] 内的下标区间 [from, to)。 */
function frameRange(frames, rate, duration, t0, t1) {
  if (!frames || frames.length === 0 || !Number.isFinite(t0) || !Number.isFinite(t1)) return [0, 0];
  const lower = t0 > 0 ? t0 : 0;
  const upper = t1 < duration ? t1 : duration;
  if (!(upper >= lower)) return [0, 0];
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (frames[mid] / rate < lower) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < frames.length && frames[end] / rate <= upper) end++;
  return [lo, end];
}

/**
 * [t0, t1] ∩ [0, duration] 内（两端都包含）某条音轨 Onset 的时间（秒），按时间递增。
 * @returns {number[]}
 */
export function onsetsInWindow(visData, id, t0, t1) {
  const stem = stemOf(visData, id);
  const onsets = stem && stem.onsets;
  if (!onsets) return [];
  const rate = visData.frameRate || VIS_FRAME_RATE;
  const dur = Number.isFinite(visData.duration) ? visData.duration : 0;
  const [from, to] = frameRange(onsets, rate, dur, t0, t1);
  const out = [];
  for (let k = from; k < to; k++) out.push(onsets[k] / rate);
  return out;
}

const stripHeightFor = (ow) => Math.max(STRIP_MIN, even(Math.round(STRIP_RATIO * ow)));

/**
 * 叠放尺寸（导出时画面在上、时间线在下）。w、h 不是正有限数时按 1280×720。
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

/** 下标区间 [from, to) 里离 t 最近的 limit 个（仍是一段连续区间）。 */
function nearestRange(frames, rate, from, to, t, limit) {
  while (to - from > limit) {
    const dl = Math.abs(frames[from] / rate - t);
    const dh = Math.abs(frames[to - 1] / rate - t);
    if (dh >= dl) to--;
    else from++;
  }
  return [from, to];
}

/**
 * @param {number} t  秒（媒体时间）
 * @param {object} visData
 * @param {{ selected: string, width: number, height: number, reducedMotion?: boolean,
 *           pastSec?: number, futureSec?: number, labels?: boolean }} opts
 *   pastSec / futureSec 不是 ≥ 0 的有限数时用默认值 1 / 3；两者之和为 0 时都用默认值。
 *   labels：在每行左侧画出行名（纯音频的全画面没有 DOM 标签时用）。
 *   reducedMotion：不放大、不炸圆环、不闪整行；时间线照常流动，正在响的音符仍然变亮。
 * @returns {object[]}  最多 MAX_SHAPES 个；尺寸无效、t 非有限数或没有行时为 []
 */
export function lanesAt(t, visData, opts) {
  const out = [];
  const o = opts || {};
  const W = o.width;
  const H = o.height;
  if (!Number.isFinite(W) || !Number.isFinite(H) || !(W >= 1) || !(H >= 1)) return out;
  if (!Number.isFinite(t) || !visData) return out;
  const selected = o.selected;
  const header = laneHeaderHeight(visData, W, H);
  const layout = laneLayout(visData, selected, H, header);
  if (layout.length === 0) return out;
  const emph = rowEmphasis(layout.map((l) => l.id), selected);

  let past = Number.isFinite(o.pastSec) && o.pastSec >= 0 ? o.pastSec : LANE_PAST_SEC;
  let future = Number.isFinite(o.futureSec) && o.futureSec >= 0 ? o.futureSec : LANE_FUTURE_SEC;
  if (!(past + future > 0)) {
    past = LANE_PAST_SEC;
    future = LANE_FUTURE_SEC;
  }
  const reduced = o.reducedMotion === true;
  const S = past + future;
  const px = W / S;
  const playheadX = (W * past) / S;
  const xAt = (tau) => playheadX + (tau - t) * px;
  const rate = visData.frameRate || VIS_FRAME_RATE;
  const dur = Number.isFinite(visData.duration) ? visData.duration : 0;
  const text = (layer, role, x, y, str, size, color, alpha, weight = 400) => {
    if (size >= 6) out.push({ kind: 'text', layer, role, x, y, text: str, size, weight, align: 'left', color: color.slice(), alpha: clamp01(alpha) });
  };

  // 拍线和拍号
  const beat = visData.beat;
  if (beat && beat.period > 0) {
    const n0 = Math.ceil((t - past - beat.phase) / beat.period);
    const n1 = Math.floor((t + future - beat.phase) / beat.period);
    for (let n = n0; n <= n1 && n - n0 < 64; n++) {
      const tau = beat.phase + n * beat.period;
      if (tau < 0 || tau > dur) continue;
      const num = ((n % 4) + 4) % 4;
      const one = num === 0;
      const lw = one ? Math.max(2, Math.round(0.002 * W)) : 1;
      const x = xAt(tau);
      out.push({
        kind: 'rect', layer: 'beat', role: one ? 'bar' : 'beat', x: x - lw / 2, y: header * 0.2, w: lw, h: H - header * 0.2, glow: 0,
        color: PLAYHEAD_COLOR.slice(), alpha: one ? LANE_ALPHA.bar : LANE_ALPHA.beat,
      });
      text('beat', 'beat-number', x + lw + 0.2 * header, header * 0.5, String(num + 1), header * 0.72, PLAYHEAD_COLOR, one ? 0.95 : 0.5, one ? 500 : 400);
    }
  }

  // 波形采样网格：每个网格点只取一次包络；网格固定在媒体时间上，滚动时波形不抖
  const n = clamp(Math.ceil(W / 2), 1, LANE_MAX_SAMPLES);
  const dt = S / n;
  const m0 = Math.floor((t - past) / dt);
  const m1 = Math.min(Math.ceil((t + future) / dt), m0 + n + 1);
  const mp = clamp(Math.ceil(t / dt), m0, m1);

  for (const lane of layout) {
    const id = lane.id;
    const lh = lane.h;
    const cy = lane.y + lh / 2;
    const a = emph[id];
    const color = ROW_COLORS[id];
    const push = (shape) => { shape.layer = id; shape.color = color.slice(); shape.alpha = clamp01(shape.alpha); out.push(shape); };

    // Entry：这一行在 (t − 1.2, t] 内最近一次「进」
    const entries = visData.entries && visData.entries[id];
    let entryAge = Infinity;
    if (entries && entries.length) {
      const [from, to] = frameRange(entries, rate, dur, t - LANE_ENTRY_SEC, t);
      if (to > from) entryAge = t - entries[to - 1] / rate;
    }
    if (entryAge < LANE_ENTRY_SEC) {
      const q = entryAge < 0.15 ? entryAge / 0.15 : 1 - (entryAge - 0.15) / (LANE_ENTRY_SEC - 0.15);
      if (!reduced) push({ kind: 'rect', role: 'entry', x: 0, y: lane.y, w: W, h: lh, glow: 0, alpha: LANE_ALPHA.entry * q });
      text(id, 'entry-text', playheadX + 0.012 * W, cy, `${ROW_NAMES[id]} 进`, Math.min(0.5 * lh, 0.03 * W), color, reduced ? 1 : Math.max(q, 0.35), 500);
    }

    if (o.labels === true) text(id, 'label', 0.008 * W, lane.y + Math.min(0.2 * lh, 0.02 * W) + 2, ROW_NAMES[id], Math.min(0.26 * lh, 0.018 * W), color, 0.75 * a);

    // 中线
    const bh = lh < 2 ? lh / 2 : 1;
    push({ kind: 'rect', role: 'baseline', x: 0, y: cy - bh / 2, w: W, h: bh, glow: 0, alpha: LANE_ALPHA.baseline * a });

    const hitFrames = id === 'drums' ? (stemOf(visData, 'drums') || {}).onsets : marksOf(visData, id);
    const noteStarts = id === 'bass' ? marksOf(visData, 'B') : null;
    const noteLens = id === 'bass' ? marksOf(visData, 'BL') : null;

    if (hitFrames) {
      // Hit：Kick 圆、Snare 宽竖条、Hi-hat 细竖条
      let [from, to] = frameRange(hitFrames, rate, dur, t - past, t + future);
      [from, to] = nearestRange(hitFrames, rate, from, to, t, LANE_MAX_MARKERS);
      for (let k = from; k < to; k++) {
        const tau = hitFrames[k] / rate;
        const age = t - tau;
        const isPast = age >= 0;
        const p = isPast && age < LANE_POP_SEC ? 1 - age / LANE_POP_SEC : 0;
        const s = reduced ? 1 : 1 + LANE_POP_SCALE * p;
        const alpha = (p > 0 ? LANE_ALPHA.pop : isPast ? LANE_ALPHA.past : LANE_ALPHA.future) * a;
        const side = isPast ? 'past' : 'future';
        const x = xAt(tau);
        if (id === 'K' || id === 'drums') {
          const r = Math.max(1.5, 0.2 * lh) * s;
          push({ kind: 'disc', role: 'hit', side, x, y: cy, r, glow: p > 0 ? 0.5 * r : 0.15 * r, alpha });
        } else {
          const w = (id === 'S' ? clamp(0.008 * W, 3, 12) : clamp(0.003 * W, 2, 5)) * s;
          const h = Math.min(0.95 * lh, (id === 'S' ? 0.6 : 0.36) * lh * s);
          push({ kind: 'rect', role: 'hit', side, x: x - w / 2, y: cy - h / 2, w, h, glow: p > 0 ? clamp(0.12 * lh, 1, 8) : 0, alpha });
        }
        if (p > 0 && !reduced) {
          push({
            kind: 'ring', role: 'pop', x: playheadX, y: cy, r: lh * (0.25 + 0.7 * (1 - p)), width: Math.max(1.5, 0.03 * lh),
            glow: 0.1 * lh, alpha: LANE_ALPHA.ring * p * a,
          });
        }
      }
    } else if (noteStarts && noteLens) {
      // Note：带长度的横条，正在响的那条变粗变亮，播放线上亮一小段
      let [from, to] = frameRange(noteStarts, rate, dur, t - past - 4, t + future);
      for (let k = from; k < to; k++) {
        const t0 = noteStarts[k] / rate;
        const t1 = Math.min(dur, (noteStarts[k] + noteLens[k]) / rate);
        if (t1 < t - past) continue;
        const on = t >= t0 && t < t1;
        const hh = (on ? 0.5 : 0.26) * lh;
        const x0 = xAt(t0);
        const w = Math.max(clamp(0.004 * W, 3, 8), xAt(t1) - x0);
        const alpha = (on ? LANE_ALPHA.pop : t >= t1 ? LANE_ALPHA.past : LANE_ALPHA.note) * a;
        push({ kind: 'rect', role: 'note', side: t >= t0 ? 'past' : 'future', x: x0, y: cy - hh / 2, w, h: hh, glow: on ? clamp(0.1 * lh, 1, 8) : 0, alpha });
        const age = t - t0;
        if (age >= 0 && age < LANE_POP_SEC && !reduced) {
          const p = 1 - age / LANE_POP_SEC;
          push({
            kind: 'ring', role: 'pop', x: playheadX, y: cy, r: lh * (0.25 + 0.7 * (1 - p)), width: Math.max(1.5, 0.03 * lh),
            glow: 0.1 * lh, alpha: LANE_ALPHA.ring * p * a,
          });
        }
      }
    } else {
      // Band：响度波形，已播放的部分变暗；播放线上按当前响度亮一个点
      const count = m1 - m0 + 1;
      const hs = new Array(count);
      for (let j = 0; j < count; j++) hs[j] = LANE_ENV_SCALE * lh * envelopeAt(visData, id, (m0 + j) * dt);
      const glow = 0.08 * lh;
      if (mp > m0) {
        push({
          kind: 'band', role: 'band', side: 'past', x0: xAt(m0 * dt), x1: xAt(mp * dt), y: cy,
          hs: hs.slice(0, mp - m0 + 1), glow, alpha: LANE_ALPHA.band * LANE_PAST_DIM * a,
        });
      }
      if (m1 > mp) {
        push({
          kind: 'band', role: 'band', side: 'future', x0: xAt(mp * dt), x1: xAt(m1 * dt), y: cy,
          hs: hs.slice(mp - m0), glow, alpha: LANE_ALPHA.band * a,
        });
      }
      const e = envelopeAt(visData, id, t);
      if (e > 0.02) {
        push({ kind: 'disc', role: 'level', x: playheadX, y: cy, r: 0.06 * lh, glow: (0.15 + 0.45 * e) * lh, alpha: (0.3 + 0.7 * e) * a });
      }
    }
  }

  // 播放线：贯穿全高的白线，不乘亮度系数；超过 MAX_SHAPES 时也保留它
  const pw = Math.max(2, Math.round(0.003 * W));
  if (out.length > MAX_SHAPES - 1) out.length = MAX_SHAPES - 1;
  out.push({
    kind: 'rect', layer: 'playhead', role: 'playhead', x: playheadX - pw / 2, y: 0, w: pw, h: H, glow: pw,
    color: PLAYHEAD_COLOR.slice(), alpha: LANE_ALPHA.playhead,
  });
  return out;
}

/**
 * 纯音频的全画面：调暗的氛围背景（sceneAt 里的纯伴奏辉光、和声色斑、效果音 / 其他音效粒子，亮度 × 0.3）
 * 加上同一条流动时间线（带行名）。参数同 lanesAt。
 * @returns {object[]}
 */
export function stageAt(t, visData, opts) {
  const o = opts || {};
  const lanes = lanesAt(t, visData, { ...o, labels: true });
  if (lanes.length === 0) return lanes;
  const ambient = sceneAt(t, visData, { selected: 'original', width: o.width, height: o.height, reducedMotion: o.reducedMotion })
    .filter((s) => STAGE_AMBIENT_LAYERS.includes(s.layer));
  for (const s of ambient) s.alpha *= STAGE_AMBIENT_ALPHA;
  return ambient.concat(lanes);
}
