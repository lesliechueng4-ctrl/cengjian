// 同构模块：Vis_Data 的常量、组装、查询，以及 Vis_Payload 的编码 / 严格解码。
// 只用 ECMAScript 内置对象和全局 TextDecoder；没有 import，导入时没有副作用。

export const VIS_VERSION = 2;
export const VIS_FRAME_RATE = 100;
export const VIS_STEM_IDS = Object.freeze(['inst', 'vocal', 'drums', 'bass', 'harmony', 'perc', 'fx', 'other']);
export const ONSET_STEM_IDS = Object.freeze(['drums', 'perc', 'fx', 'other']);
export const ALL_STEM_IDS = Object.freeze(['original', ...VIS_STEM_IDS]);
export const VIS_MAX_DURATION = 3600;           // 秒
export const VIS_MAX_BYTES = 16 * 1024 * 1024;  // Vis_Payload 上限
export const ONSET_MIN_GAP_FRAMES = 5;          // 50 ms

const INVALID_MESSAGE = '可视化数据无效';

export class VisPayloadError extends Error {
  constructor(message = INVALID_MESSAGE) {
    super(message);
    this.name = 'VisPayloadError';
  }
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isOnsetStem = (id) => ONSET_STEM_IDS.includes(id);

/**
 * 把各 Stem 的分析结果组装成 Vis_Data：frames = 各 Stem 的最大帧数，duration = 最大时长；
 * 较短的 env 末尾补 0。results 中缺失的 Stem 不出现在 stems 里（1.10）。
 * @param {Record<string, { env: Uint8Array, onsets: Int32Array|null, duration: number }>} results
 */
export function createVisData(results) {
  const present = [];
  let frames = 0;
  let duration = 0;
  for (const id of VIS_STEM_IDS) {
    const r = results && hasOwn(results, id) ? results[id] : null;
    if (!r || !r.env) continue;
    present.push(id);
    frames = Math.max(frames, r.env.length);
    if (Number.isFinite(r.duration)) duration = Math.max(duration, r.duration);
  }
  const stems = {};
  for (const id of present) {
    const r = results[id];
    const env = new Uint8Array(frames);
    env.set(r.env);
    const onsets = isOnsetStem(id) && r.onsets != null ? Int32Array.from(r.onsets) : null;
    stems[id] = { env, onsets };
  }
  const visData = { version: VIS_VERSION, frameRate: VIS_FRAME_RATE, frames, duration, stems };
  const marks = {};
  for (const id of present) {
    const m = results[id].marks;
    if (!m) continue;
    for (const key of MARK_KEYS) {
      if (hasOwn(m, key) && m[key] != null) marks[key] = Int32Array.from(m[key]).filter((f) => f >= 0 && f < frames);
    }
  }
  if (marks.B && (!marks.BL || marks.BL.length !== marks.B.length)) { delete marks.B; delete marks.BL; }
  if (!marks.B) delete marks.BL;
  if (Object.keys(marks).length) visData.marks = marks;
  return finishVisData(visData);
}

// ---------- Marks, beat grid and entries ----------

export const MARK_KEYS = Object.freeze(['K', 'S', 'H', 'B', 'BL']);
export const BEAT_MIN_BPM = 70;
export const BEAT_MAX_BPM = 140;
export const BEAT_MIN_HITS = 16;
export const BEAT_MIN_COHERENCE = 0.45;
export const ENTRY_MIN_GAP_SEC = 3;
export const ENTRY_MAX_GAP_SEC = 8;
export const ENTRY_ROW_IDS = Object.freeze(['K', 'S', 'H', 'bass', 'vocal', 'harmony', 'fx', 'other']);

/** How well the times sit on a grid of period q: |Σ e^(2πi·t/q)| / N, with the grid offset in [0, q). */
function gridFit(times, q) {
  let re = 0;
  let im = 0;
  for (let i = 0; i < times.length; i++) {
    const a = (2 * Math.PI * times[i]) / q;
    re += Math.cos(a);
    im += Math.sin(a);
  }
  const n = times.length || 1;
  let offset = (Math.atan2(im, re) / (2 * Math.PI)) * q;
  if (offset < 0) offset += q;
  return { c: Math.hypot(re, im) / n, offset };
}

/**
 * Constant-tempo beat grid from the Kick and Snare hits (frame indices).
 * Tempo: the 8th-note period (BPM 70–140) the hits sit on best. Beat = the 8th
 * with more hits; snares mark beats 2 and 4; of the two candidates left, beat 1
 * is the one with more kicks (a bass note start counts as half a kick). Returns null with too few hits or an unsteady tempo.
 * @returns {{ period: number, phase: number } | null}  seconds; a bar starts at phase + 4·k·period
 */
export function fitBeat(kick, snare, frameRate = VIS_FRAME_RATE, bass = null) {
  const K = kick ? Array.from(kick, (f) => f / frameRate) : [];
  const S = snare ? Array.from(snare, (f) => f / frameRate) : [];
  const times = K.concat(S);
  if (times.length < BEAT_MIN_HITS) return null;
  let best = { c: -1, bpm: 0, offset: 0 };
  const scan = (from, to, step) => {
    for (let bpm = from; bpm <= to + 1e-9; bpm += step) {
      const r = gridFit(times, 30 / bpm);
      if (r.c > best.c) best = { c: r.c, bpm, offset: r.offset };
    }
  };
  scan(BEAT_MIN_BPM, BEAT_MAX_BPM, 0.1);
  scan(best.bpm - 0.15, best.bpm + 0.15, 0.005);
  if (!(best.c >= BEAT_MIN_COHERENCE)) return null;
  const q = 30 / best.bpm;
  const slot = (t) => {
    const k = Math.round((t - best.offset) / q);
    return Math.abs(t - best.offset - k * q) <= 0.25 * q ? k : null;
  };
  const mod = (v, m) => ((v % m) + m) % m;
  const parity = [0, 0];
  for (const t of times) { const k = slot(t); if (k !== null) parity[mod(k, 2)]++; }
  const par = parity[1] > parity[0] ? 1 : 0;
  const beatOf = (t) => { const k = slot(t); return k !== null && mod(k, 2) === par ? (k - par) / 2 : null; };
  const sBy2 = [0, 0];
  for (const t of S) { const b = beatOf(t); if (b !== null) sBy2[mod(b, 2)]++; }
  const kBy4 = [0, 0, 0, 0];
  for (const t of K) { const b = beatOf(t); if (b !== null) kBy4[mod(b, 4)]++; }
  const candidates = sBy2[0] === sBy2[1] ? [0, 1, 2, 3] : sBy2[1] > sBy2[0] ? [0, 2] : [1, 3];
  // Bass notes break ties (four-on-the-floor kicks cannot tell beat 1 from beat 3).
  const score = Array.from(kBy4);
  if (bass) for (const f of bass) { const b = beatOf(f / frameRate); if (b !== null) score[mod(b, 4)] += 0.5; }
  let one = candidates[0];
  for (const c of candidates) if (score[c] > score[one]) one = c;
  const period = 2 * q;
  const phase = mod(best.offset + par * q + one * period, 4 * period);
  return { period, phase };
}

/**
 * Frames where a row comes in after a silence of two bars (4 s without a beat
 * grid; always between 3 and 8 s). Rows: K, S, H (hits), bass (notes, or its
 * envelope without marks), vocal / harmony / fx / other (envelope: quiet below
 * 10% of the stem's peak, in again at 25%). The very start of the file does not count.
 * @returns {Record<string, Int32Array>}
 */
export function deriveEntries(visData) {
  const out = {};
  if (!visData || !visData.stems) return out;
  const rate = visData.frameRate || VIS_FRAME_RATE;
  const beat = visData.beat;
  const gapSec = beat ? Math.min(ENTRY_MAX_GAP_SEC, Math.max(ENTRY_MIN_GAP_SEC, 8 * beat.period)) : 4;
  const gap = Math.round(gapSec * rate);
  const marks = visData.marks || {};
  const fromMarks = (starts, lens) => {
    const res = [];
    let prevEnd = 0;
    for (let i = 0; i < starts.length; i++) {
      if (starts[i] - prevEnd >= gap) res.push(starts[i]);
      prevEnd = Math.max(prevEnd, starts[i] + (lens ? lens[i] : 0));
    }
    return Int32Array.from(res);
  };
  const fromEnv = (env) => {
    const res = [];
    let lastActive = 0;
    for (let i = 0; i < env.length; i++) {
      if (env[i] >= 64 && i - lastActive >= gap) res.push(i);
      if (env[i] >= 26) lastActive = i;
    }
    return Int32Array.from(res);
  };
  for (const key of ['K', 'S', 'H']) if (marks[key]) out[key] = fromMarks(marks[key], null);
  if (marks.B && marks.BL) out.bass = fromMarks(marks.B, marks.BL);
  for (const id of ['bass', 'vocal', 'harmony', 'fx', 'other']) {
    if (out[id]) continue;
    const stem = hasOwn(visData.stems, id) ? visData.stems[id] : null;
    if (stem && stem.env) out[id] = fromEnv(stem.env);
  }
  return out;
}

/**
 * A copy of visData whose bar starts `beats` beats later (the beat lines stay where they are, only
 * the numbering moves). Without a beat grid the same object is returned.
 */
export function shiftBeat(visData, beats = 1) {
  const beat = visData && visData.beat;
  if (!beat || !(beat.period > 0) || !Number.isInteger(beats)) return visData;
  const bar = 4 * beat.period;
  const phase = (((beat.phase + beats * beat.period) % bar) + bar) % bar;
  return { ...visData, beat: { period: beat.period, phase } };
}

/** Fills in the derived parts of a Vis_Data: `beat` (unless already set) and `entries`. */
export function finishVisData(visData) {
  const marks = visData.marks || {};
  if (visData.beat === undefined) visData.beat = fitBeat(marks.K, marks.S, visData.frameRate, marks.B);
  visData.entries = deriveEntries(visData);
  return visData;
}

/**
 * t 秒处的包络值（0..1），帧间线性插值（3.10）；t 在 [0, duration] 外或 stem 缺失时为 0（3.12）。
 * 帧 i 的采样点位于 t = i / frameRate；最后一帧之后到 duration 之间保持最后一帧的值。
 */
export function envelopeAt(visData, id, t) {
  if (!visData || !Number.isFinite(t) || t < 0 || t > visData.duration) return 0;
  const stem = visData.stems && hasOwn(visData.stems, id) ? visData.stems[id] : null;
  if (!stem || !stem.env) return 0;
  const env = stem.env;
  const n = env.length;
  if (n === 0) return 0;
  const rate = visData.frameRate || VIS_FRAME_RATE;
  let pos = t * rate;
  const nearest = Math.round(pos);
  if (Math.abs(pos - nearest) < 1e-9) pos = nearest; // 抵消 i / 100 × 100 的舍入误差
  const i = Math.floor(pos);
  if (i >= n - 1) return env[n - 1] / 255;
  const frac = pos - i;
  const v = (env[i] + (env[i + 1] - env[i]) * frac) / 255;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** [t − windowSec, t] 内 envelopeAt 的平均值（连续积分的梯形近似，步长 1 帧），用于 Reduced_Motion（7.2）。 */
export function envelopeMean(visData, id, t, windowSec = 0.3) {
  if (!visData || !Number.isFinite(t)) return 0;
  if (!(windowSec > 0)) return envelopeAt(visData, id, t);
  const rate = visData.frameRate || VIS_FRAME_RATE;
  const steps = Math.max(1, Math.round(windowSec * rate));
  const h = windowSec / steps;
  const start = t - windowSec;
  let sum = (envelopeAt(visData, id, start) + envelopeAt(visData, id, t)) / 2;
  for (let k = 1; k < steps; k++) sum += envelopeAt(visData, id, start + k * h);
  const v = sum / steps;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** t 之前 windowSec 秒内（含 t，且 ≥ 0）的 Onset，返回 [{ index, time }]，按时间从近到远，最多 limit 个。 */
export function recentOnsets(visData, id, t, windowSec, limit = Infinity) {
  const out = [];
  if (!visData || !Number.isFinite(t) || !(windowSec > 0) || !(limit > 0)) return out;
  const stem = visData.stems && hasOwn(visData.stems, id) ? visData.stems[id] : null;
  const onsets = stem && stem.onsets;
  if (!onsets || onsets.length === 0) return out;
  const rate = visData.frameRate || VIS_FRAME_RATE;
  const upper = Math.min(t, visData.duration);
  // 二分查找最后一个 time ≤ upper 的位置
  let lo = 0;
  let hi = onsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (onsets[mid] / rate <= upper) lo = mid + 1;
    else hi = mid;
  }
  const lower = t - windowSec;
  for (let k = lo - 1; k >= 0 && out.length < limit; k--) {
    const index = onsets[k];
    const time = index / rate;
    if (time <= lower) break;
    if (time < 0) break;
    out.push({ index, time });
  }
  return out;
}

// ---------- Base64 ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_CODES = (() => {
  const codes = new Uint8Array(64);
  for (let i = 0; i < 64; i++) codes[i] = B64.charCodeAt(i);
  return codes;
})();
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) table[B64.charCodeAt(i)] = i;
  return table;
})();

/** 模块内置的 Base64 编码（标准字母表、带填充），不依赖 Buffer / btoa。 */
export function bytesToBase64(bytes) {
  const n = bytes.length;
  const out = new Uint8Array(Math.ceil(n / 3) * 4);
  let o = 0;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = B64_CODES[v >> 18];
    out[o++] = B64_CODES[(v >> 12) & 63];
    out[o++] = B64_CODES[(v >> 6) & 63];
    out[o++] = B64_CODES[v & 63];
  }
  const rest = n - i;
  if (rest === 1) {
    const v = bytes[i] << 16;
    out[o++] = B64_CODES[v >> 18];
    out[o++] = B64_CODES[(v >> 12) & 63];
    out[o++] = 61;
    out[o++] = 61;
  } else if (rest === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out[o++] = B64_CODES[v >> 18];
    out[o++] = B64_CODES[(v >> 12) & 63];
    out[o++] = B64_CODES[(v >> 6) & 63];
    out[o++] = 61;
  }
  let text = '';
  const CHUNK = 0x8000;
  for (let k = 0; k < out.length; k += CHUNK) {
    text += String.fromCharCode.apply(null, out.subarray(k, k + CHUNK));
  }
  return text;
}

/** 严格的 Base64 解码：非法字符、长度不是 4 的倍数、填充错误（含非零的多余位）时抛错。 */
export function base64ToBytes(text) {
  if (typeof text !== 'string') throw new TypeError('Base64 必须是字符串');
  const len = text.length;
  if (len % 4 !== 0) throw new Error('Base64 长度无效');
  if (len === 0) return new Uint8Array(0);
  let pad = 0;
  if (text.charCodeAt(len - 1) === 61) pad = text.charCodeAt(len - 2) === 61 ? 2 : 1;
  const sextet = (k) => {
    const c = text.charCodeAt(k);
    const v = c < 128 ? B64_LOOKUP[c] : -1;
    if (v < 0) throw new Error('Base64 含非法字符');
    return v;
  };
  const out = new Uint8Array((len / 4) * 3 - pad);
  let o = 0;
  let k = 0;
  const full = pad ? len - 4 : len;
  for (; k < full; k += 4) {
    const v = (sextet(k) << 18) | (sextet(k + 1) << 12) | (sextet(k + 2) << 6) | sextet(k + 3);
    out[o++] = v >> 16;
    out[o++] = (v >> 8) & 255;
    out[o++] = v & 255;
  }
  if (pad === 2) {
    const a = sextet(k);
    const b = sextet(k + 1);
    if (b & 15) throw new Error('Base64 填充无效');
    out[o++] = (a << 2) | (b >> 4);
  } else if (pad === 1) {
    const a = sextet(k);
    const b = sextet(k + 1);
    const c = sextet(k + 2);
    if (c & 3) throw new Error('Base64 填充无效');
    const v = (a << 18) | (b << 12) | (c << 6);
    out[o++] = v >> 16;
    out[o++] = (v >> 8) & 255;
  }
  if (o !== out.length) throw new Error('Base64 填充无效');
  return out;
}

// ---------- Vis_Payload ----------

/** Vis_Payload JSON 文本：{ v, frameRate, frames, duration, selected, stems: { id: { env: base64, onsets?: number[] } } } */
export function encodeVisPayload(visData, selected) {
  const stems = {};
  for (const id of VIS_STEM_IDS) {
    const stem = visData.stems && hasOwn(visData.stems, id) ? visData.stems[id] : null;
    if (!stem || !stem.env) continue;
    const item = { env: bytesToBase64(stem.env) };
    if (isOnsetStem(id) && stem.onsets != null) item.onsets = Array.from(stem.onsets);
    stems[id] = item;
  }
  const payload = {
    v: VIS_VERSION,
    frameRate: VIS_FRAME_RATE,
    frames: visData.frames,
    duration: visData.duration,
    selected,
    stems,
  };
  if (visData.marks) {
    const marks = {};
    for (const key of MARK_KEYS) if (visData.marks[key]) marks[key] = Array.from(visData.marks[key]);
    if (Object.keys(marks).length) payload.marks = marks;
  }
  if (visData.beat) payload.beat = { period: visData.beat.period, phase: visData.beat.phase };
  return JSON.stringify(payload);
}

const TOP_KEYS = Object.freeze(['v', 'frameRate', 'frames', 'duration', 'selected', 'stems']);
const OPTIONAL_TOP_KEYS = Object.freeze(['marks', 'beat']);

/** marks: { K?, S?, H?: strictly increasing frame indices; B? + BL?: note starts and lengths (≥ 1) }. */
function decodeMarks(raw, frames) {
  if (!isPlainObject(raw)) fail();
  const keys = Object.keys(raw);
  if (keys.length === 0 || !keys.every((k) => MARK_KEYS.includes(k))) fail();
  if (hasOwn(raw, 'B') !== hasOwn(raw, 'BL')) fail();
  const marks = {};
  for (const key of keys) {
    const list = raw[key];
    if (!Array.isArray(list) || list.length > frames) fail();
    const arr = new Int32Array(list.length);
    let prev = -1;
    for (let k = 0; k < list.length; k++) {
      const v = list[k];
      if (!Number.isInteger(v)) fail();
      if (key === 'BL') {
        if (v < 1 || v > frames) fail();
      } else {
        if (v < 0 || v >= frames || v <= prev) fail();
        prev = v;
      }
      arr[k] = v;
    }
    marks[key] = arr;
  }
  if (marks.B && marks.B.length !== marks.BL.length) fail();
  return marks;
}

function decodeBeat(raw) {
  if (!isPlainObject(raw)) fail();
  const keys = Object.keys(raw);
  if (keys.length !== 2 || !hasOwn(raw, 'period') || !hasOwn(raw, 'phase')) fail();
  const { period, phase } = raw;
  if (typeof period !== 'number' || !Number.isFinite(period) || !(period >= 0.2 && period <= 2)) fail();
  if (typeof phase !== 'number' || !Number.isFinite(phase) || !(phase >= 0 && phase <= 4 * period)) fail();
  return { period, phase };
}

function fail() {
  throw new VisPayloadError(INVALID_MESSAGE);
}

/**
 * 严格解析与校验（10.5）。成功返回 { visData, selected }；任何不符都抛 VisPayloadError('可视化数据无效')。
 * @param {string | Uint8Array} input  Uint8Array 时按 UTF-8 严格解码（TextDecoder fatal）
 */
export function decodeVisPayload(input) {
  let text;
  if (typeof input === 'string') {
    if (input.length > VIS_MAX_BYTES) fail();
    text = input;
  } else if (input instanceof Uint8Array) {
    if (input.length > VIS_MAX_BYTES) fail();
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch {
      fail();
    }
  } else {
    fail();
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    fail();
  }
  if (!isPlainObject(obj)) fail();
  const keys = Object.keys(obj);
  if (!TOP_KEYS.every((k) => hasOwn(obj, k))) fail();
  if (!keys.every((k) => TOP_KEYS.includes(k) || OPTIONAL_TOP_KEYS.includes(k))) fail();

  if (obj.v !== VIS_VERSION || obj.frameRate !== VIS_FRAME_RATE) fail();
  const { duration, frames, selected } = obj;
  if (typeof duration !== 'number' || !Number.isFinite(duration)) fail();
  if (!(duration > 0 && duration <= VIS_MAX_DURATION)) fail();
  if (!Number.isInteger(frames) || frames !== Math.ceil(duration * VIS_FRAME_RATE)) fail();
  if (typeof selected !== 'string' || !ALL_STEM_IDS.includes(selected)) fail();

  const rawStems = obj.stems;
  if (!isPlainObject(rawStems)) fail();
  const stemIds = Object.keys(rawStems);
  if (stemIds.length === 0) fail();
  const maxOnsets = Math.ceil(frames / ONSET_MIN_GAP_FRAMES);
  const stems = {};
  for (const id of VIS_STEM_IDS) {
    if (!hasOwn(rawStems, id)) continue;
    const item = rawStems[id];
    if (!isPlainObject(item)) fail();
    const itemKeys = Object.keys(item);
    const allowed = isOnsetStem(id) ? ['env', 'onsets'] : ['env'];
    if (!hasOwn(item, 'env') || !itemKeys.every((k) => allowed.includes(k))) fail();
    if (typeof item.env !== 'string') fail();
    let env;
    try {
      env = base64ToBytes(item.env);
    } catch {
      fail();
    }
    if (env.length !== frames) fail();
    let onsets = null;
    if (hasOwn(item, 'onsets')) {
      const raw = item.onsets;
      if (!Array.isArray(raw) || raw.length > maxOnsets) fail();
      onsets = new Int32Array(raw.length);
      let prev = -Infinity;
      for (let k = 0; k < raw.length; k++) {
        const idx = raw[k];
        if (!Number.isInteger(idx) || idx < 0 || idx >= frames) fail();
        if (idx - prev < ONSET_MIN_GAP_FRAMES) fail();
        onsets[k] = idx;
        prev = idx;
      }
    }
    stems[id] = { env, onsets };
  }
  if (Object.keys(stems).length !== stemIds.length) fail(); // 有未知 Stem id

  const visData = { version: VIS_VERSION, frameRate: VIS_FRAME_RATE, frames, duration, stems };
  if (hasOwn(obj, 'marks')) visData.marks = decodeMarks(obj.marks, frames);
  visData.beat = hasOwn(obj, 'beat') ? decodeBeat(obj.beat) : null;
  return { visData: finishVisData(visData), selected };
}
