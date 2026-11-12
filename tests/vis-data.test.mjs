import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VIS_STEM_IDS, ONSET_STEM_IDS, ALL_STEM_IDS,
  VisPayloadError, bytesToBase64, base64ToBytes,
  createVisData, envelopeAt, encodeVisPayload, decodeVisPayload,
} from '../public/js/vis-data.js';
import { forAll, mulberry32 } from './helpers/prop.mjs';

// ---------- 生成器 ----------

const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

/** 与 frames 一致的 duration：ceil(duration × 100) === frames。 */
function durationFor(rng, frames) {
  const d = (frames - (0.01 + rng() * 0.98)) / 100;
  return Math.ceil(d * 100) === frames ? d : (frames - 0.5) / 100;
}

function randomOnsets(rng, frames) {
  const out = [];
  for (let idx = randInt(rng, 0, 10); idx < frames; idx += randInt(rng, 5, 40)) out.push(idx);
  return out;
}

/** 合法 Vis_Data：随机非空 Stem 子集、frames 1–5000、随机 env、合法 Onset。 */
function genVisData(rng, { maxFrames = 5000 } = {}) {
  const frames = rng() < 0.2 ? randInt(rng, 1, 10) : randInt(rng, 1, maxFrames);
  const duration = durationFor(rng, frames);
  let ids = VIS_STEM_IDS.filter(() => rng() < 0.5);
  if (ids.length === 0) ids = [pick(rng, VIS_STEM_IDS)];
  const stems = {};
  for (const id of ids) {
    const env = new Uint8Array(frames);
    for (let i = 0; i < frames; i++) env[i] = Math.floor(rng() * 256);
    const onsets = ONSET_STEM_IDS.includes(id) && rng() < 0.8
      ? Int32Array.from(randomOnsets(rng, frames)) : null;
    stems[id] = { env, onsets };
  }
  return { version: 1, frameRate: 100, frames, duration, stems };
}

const genValid = (rng) => ({ visData: genVisData(rng), selected: pick(rng, ALL_STEM_IDS) });

// ---------- Property 5 ----------

// Feature: stem-visualizer, Property 5: Vis_Payload 往返与校验
test('Property 5: 合法 Vis_Payload 往返一致（字符串和 UTF-8 字节两种输入），编码只含 ASCII', async () => {
  // **Validates: Requirements 10.5, 10.9**
  await forAll(genValid, ({ visData, selected }) => {
    const text = encodeVisPayload(visData, selected);
    assert.ok(/^[\x00-\x7f]*$/.test(text), '编码文本含非 ASCII 字符');
    for (const input of [text, new TextEncoder().encode(text)]) {
      const out = decodeVisPayload(input);
      assert.equal(out.selected, selected);
      assert.equal(out.visData.frames, visData.frames);
      assert.equal(out.visData.duration, visData.duration);
      assert.deepEqual(Object.keys(out.visData.stems).sort(), Object.keys(visData.stems).sort());
      for (const [id, s] of Object.entries(visData.stems)) {
        const d = out.visData.stems[id];
        assert.deepEqual(Array.from(d.env), Array.from(s.env));
        assert.deepEqual(d.onsets && Array.from(d.onsets), s.onsets && Array.from(s.onsets));
      }
    }
  }, { runs: 100 });
});

/** 对解析后的 Payload 对象做一次破坏，返回新的 JSON 文本或字节；不适用时返回 null。 */
const CORRUPTIONS = {
  extraTopKey: (o) => { o.extra = 1; return o; },
  missingTopKey: (o, rng) => { delete o[pick(rng, Object.keys(o))]; return o; },
  wrongVersion: (o, rng) => { o.v = pick(rng, [0, 1, 3, '2', null]); return o; },
  wrongFrameRate: (o, rng) => { o.frameRate = pick(rng, [30, 60, 99, '100', 100.5]); return o; },
  durationNonPositive: (o, rng) => { o.duration = pick(rng, [0, -0.01, -5]); return o; },
  durationTooLong: (o) => { o.duration = 3600.01; o.frames = Math.ceil(o.duration * 100); return o; },
  durationNaN: (o, rng) => { o.duration = pick(rng, ['NaN', null, '1.5', 'Infinity']); return o; },
  framesMismatch: (o, rng) => { o.frames += pick(rng, [1, -1, 0.5]); return o; },
  unknownStem: (o, rng) => { o.stems[pick(rng, ['original', 'piano', '__proto__x', 'Vocal'])] = o.stems[Object.keys(o.stems)[0]]; return o; },
  emptyStems: (o) => { o.stems = {}; return o; },
  onsetsOnNonOnsetStem: (o, rng) => {
    const id = pick(rng, VIS_STEM_IDS.filter((x) => !ONSET_STEM_IDS.includes(x)));
    o.stems[id] = { env: o.stems[Object.keys(o.stems)[0]].env, onsets: [] };
    return o;
  },
  extraStemKey: (o) => { o.stems[Object.keys(o.stems)[0]].extra = true; return o; },
  missingEnv: (o) => { delete o.stems[Object.keys(o.stems)[0]].env; return o; },
  envShort: (o) => {
    const s = o.stems[Object.keys(o.stems)[0]];
    s.env = bytesToBase64(base64ToBytes(s.env).subarray(1));
    return o;
  },
  envLong: (o) => {
    const s = o.stems[Object.keys(o.stems)[0]];
    const b = base64ToBytes(s.env);
    const nb = new Uint8Array(b.length + 1); nb.set(b);
    s.env = bytesToBase64(nb);
    return o;
  },
  envBadBase64: (o, rng) => {
    const s = o.stems[Object.keys(o.stems)[0]];
    const k = Math.floor(rng() * s.env.length);
    s.env = pick(rng, [
      s.env.slice(0, k) + pick(rng, ['!', '-', '_', '*', ' ', 'é']) + s.env.slice(k + 1),
      s.env + 'A',
      s.env.slice(0, -1),
    ]);
    return o;
  },
  envNotString: (o) => { const s = o.stems[Object.keys(o.stems)[0]]; s.env = Array.from(base64ToBytes(s.env)); return o; },
  onsetsUnsorted: (o) => withOnsets(o, (on) => (on.length >= 2 ? [on[1], on[0], ...on.slice(2)] : null)),
  onsetsSmallGap: (o, rng) => withOnsets(o, (on, frames) => {
    const a = on[0];
    const b = a + randInt(rng, 0, 4);
    return b < frames ? [a, b] : null;
  }),
  onsetsOutOfRange: (o, rng, frames) => withOnsets(o, () => [pick(rng, [-1, frames, frames + 10])]),
  onsetsNonInteger: (o, rng) => withOnsets(o, (on) => [on[0] + 0.5, ...on.slice(1)]),
  onsetsNotArray: (o) => withOnsets(o, () => 'x'),
  badSelected: (o, rng) => { o.selected = pick(rng, ['', 'Original', 'piano', 0, null]); return o; },
};

/** 在某条 Onset_Stem 上换成 fn(原 onsets, frames) 的结果；没有可用的 Onset_Stem 则新加一条。 */
function withOnsets(o, fn) {
  const frames = o.frames;
  let id = Object.keys(o.stems).find((x) => ONSET_STEM_IDS.includes(x));
  if (!id) {
    id = ONSET_STEM_IDS[0];
    o.stems[id] = { env: o.stems[Object.keys(o.stems)[0]].env };
  }
  const on = Array.isArray(o.stems[id].onsets) && o.stems[id].onsets.length ? o.stems[id].onsets : [0];
  const next = fn(on, frames);
  if (next == null) return null;
  o.stems[id].onsets = next;
  return o;
}

const BYTE_CORRUPTIONS = {
  invalidUtf8: (bytes, rng) => {
    const k = Math.floor(rng() * bytes.length);
    const bad = pick(rng, [[0xff], [0xc3], [0xed, 0xa0, 0x80], [0x80]]);
    const out = new Uint8Array(bytes.length + bad.length);
    out.set(bytes.subarray(0, k)); out.set(bad, k); out.set(bytes.subarray(k), k + bad.length);
    return out;
  },
  truncated: (bytes, rng) => bytes.subarray(0, Math.floor(rng() * bytes.length)),
};

const CORRUPTION_NAMES = [...Object.keys(CORRUPTIONS), ...Object.keys(BYTE_CORRUPTIONS)];

// Feature: stem-visualizer, Property 5: Vis_Payload 往返与校验
test('Property 5: 对合法 Payload 的任何一次破坏都抛 VisPayloadError', async () => {
  // **Validates: Requirements 10.5, 10.9**
  const genCase = (rng) => {
    const visData = genVisData(rng, { maxFrames: 400 });
    return { visData, selected: pick(rng, ALL_STEM_IDS), kind: pick(rng, CORRUPTION_NAMES), seed: (rng() * 2 ** 32) >>> 0 };
  };
  const seen = new Set();
  await forAll(genCase, ({ visData, selected, kind, seed }) => {
    const rng = mulberry32(seed);
    const text = encodeVisPayload(visData, selected);
    let input;
    if (BYTE_CORRUPTIONS[kind]) {
      input = BYTE_CORRUPTIONS[kind](new TextEncoder().encode(text), rng);
    } else {
      const o = CORRUPTIONS[kind](JSON.parse(text), rng, visData.frames);
      if (o == null) return true; // 不适用于这个样本
      input = rng() < 0.5 ? JSON.stringify(o) : new TextEncoder().encode(JSON.stringify(o));
    }
    seen.add(kind);
    assert.throws(() => decodeVisPayload(input), (e) => e instanceof VisPayloadError && e.message === '可视化数据无效', `破坏 ${kind} 未被拒绝`);
  }, { runs: 300 });
  assert.ok(seen.size >= CORRUPTION_NAMES.length - 2, `覆盖的破坏种类过少：${[...seen].join(',')}`);
});

test('decodeVisPayload 拒绝非字符串 / 非字节输入和非对象 JSON', () => {
  for (const input of [null, undefined, 42, {}, [], new ArrayBuffer(4), '[]', 'null', '"x"', '']) {
    assert.throws(() => decodeVisPayload(input), VisPayloadError);
  }
});

test('bytesToBase64 与 Node Buffer.toString("base64") 一致，base64ToBytes 可逆', () => {
  const rng = mulberry32(12345);
  for (let n = 0; n < 70; n++) {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = Math.floor(rng() * 256);
    const b64 = bytesToBase64(bytes);
    assert.equal(b64, Buffer.from(bytes).toString('base64'));
    assert.deepEqual(Array.from(base64ToBytes(b64)), Array.from(bytes));
  }
  const big = new Uint8Array(100003).map((_, i) => (i * 31) & 255);
  assert.equal(bytesToBase64(big), Buffer.from(big).toString('base64'));
});

test('createVisData 把较短的 env 末尾补 0，frames / duration 取最大值，非 Onset_Stem 的 onsets 为 null', () => {
  const v = createVisData({
    vocal: { env: Uint8Array.from([10, 20]), onsets: null, duration: 0.02 },
    drums: { env: Uint8Array.from([1, 2, 3, 4, 5]), onsets: Int32Array.from([0]), duration: 0.045 },
    bass: { env: Uint8Array.from([7]), onsets: Int32Array.from([0]), duration: 0.01 },
  });
  assert.equal(v.frames, 5);
  assert.equal(v.duration, 0.045);
  assert.deepEqual(Object.keys(v.stems).sort(), ['bass', 'drums', 'vocal']);
  assert.deepEqual(Array.from(v.stems.vocal.env), [10, 20, 0, 0, 0]);
  assert.deepEqual(Array.from(v.stems.bass.env), [7, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(v.stems.drums.env), [1, 2, 3, 4, 5]);
  assert.deepEqual(Array.from(v.stems.drums.onsets), [0]);
  assert.equal(v.stems.bass.onsets, null);
});

// ---------- Property 6 ----------

// Feature: stem-visualizer, Property 6: Envelope 插值
test('Property 6: envelopeAt 在帧点取 env[i]/255、帧间线性插值、越界或缺失为 0、总在 [0, 1]', async () => {
  // **Validates: Requirements 3.10, 3.12**
  const genCase = (rng) => {
    const visData = genVisData(rng, { maxFrames: 300 });
    const present = Object.keys(visData.stems);
    return { visData, id: pick(rng, present), seed: (rng() * 2 ** 32) >>> 0 };
  };
  await forAll(genCase, ({ visData, id, seed }) => {
    const rng = mulberry32(seed);
    const { frames, duration } = visData;
    const env = visData.stems[id].env;
    const eps = 1e-9;
    for (let k = 0; k < 20; k++) {
      // 帧点
      const i = randInt(rng, 0, frames - 1);
      const vi = envelopeAt(visData, id, i / 100);
      assert.ok(Math.abs(vi - env[i] / 255) < eps, `帧点 i=${i}: ${vi} ≠ ${env[i] / 255}`);
      // 帧间
      if (frames >= 2) {
        const j = randInt(rng, 0, frames - 2);
        const f = rng();
        const t = (j + f) / 100;
        if (t <= duration) {
          const v = envelopeAt(visData, id, t);
          const a = env[j] / 255, b = env[j + 1] / 255;
          assert.ok(Math.abs(v - (a + (b - a) * f)) < 1e-6, `t=${t}: ${v} 不是 ${a}→${b} 的插值（f=${f}）`);
          assert.ok(v >= Math.min(a, b) - eps && v <= Math.max(a, b) + eps);
        }
      }
      // 任意 t 都在 [0, 1]
      const tAny = -1 + rng() * (duration + 2);
      const va = envelopeAt(visData, id, tAny);
      assert.ok(va >= 0 && va <= 1, `t=${tAny}: ${va} 不在 [0, 1]`);
      if (tAny < 0 || tAny > duration) assert.equal(va, 0);
    }
    // 越界与缺失
    assert.equal(envelopeAt(visData, id, -1e-6), 0);
    assert.equal(envelopeAt(visData, id, duration + 1e-6), 0);
    assert.equal(envelopeAt(visData, id, NaN), 0);
    const missing = ALL_STEM_IDS.find((x) => !visData.stems[x]);
    assert.equal(envelopeAt(visData, missing, rng() * duration), 0);
  }, { runs: 100 });
});
