import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, decodeWav } from '../public/js/wav.js';
import { forAll, int, float, oneOf } from './helpers/prop.mjs';

const str = (view, off, len) => String.fromCharCode(...Array.from({ length: len }, (_, i) => view.getUint8(off + i)));

test('stereo WAV header fields are correct', () => {
  const L = new Float32Array([0, 0.5, -0.5, 1]);
  const R = new Float32Array([0.25, -0.25, 0, -1]);
  const buf = encodeWav([L, R], 44100);
  const v = new DataView(buf);
  assert.equal(buf.byteLength, 44 + 4 * 2 * 2);
  assert.equal(str(v, 0, 4), 'RIFF');
  assert.equal(v.getUint32(4, true), buf.byteLength - 8);
  assert.equal(str(v, 8, 4), 'WAVE');
  assert.equal(str(v, 12, 4), 'fmt ');
  assert.equal(v.getUint32(16, true), 16);
  assert.equal(v.getUint16(20, true), 1);
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), 44100);
  assert.equal(v.getUint32(28, true), 44100 * 4);
  assert.equal(v.getUint16(32, true), 4);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(str(v, 36, 4), 'data');
  assert.equal(v.getUint32(40, true), 16);
  // interleaved samples: L0 R0 L1 R1 ...
  assert.equal(v.getInt16(44, true), 0);
  assert.equal(v.getInt16(46, true), Math.round(0.25 * 0x7fff));
  assert.equal(v.getInt16(48, true), Math.round(0.5 * 0x7fff));
  assert.equal(v.getInt16(50, true), Math.round(-0.25 * 0x8000));
});

test('samples outside [-1, 1] and NaN are clamped safely', () => {
  const buf = encodeWav([new Float32Array([2, -3, NaN, 1, -1])], 8000);
  const v = new DataView(buf);
  assert.equal(buf.byteLength, 44 + 5 * 2);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(v.getInt16(44, true), 32767);
  assert.equal(v.getInt16(46, true), -32768);
  assert.equal(v.getInt16(48, true), 0);
  assert.equal(v.getInt16(50, true), 32767);
  assert.equal(v.getInt16(52, true), -32768);
});

test('empty input produces a valid header only file', () => {
  const buf = encodeWav([new Float32Array(0)], 48000);
  assert.equal(buf.byteLength, 44);
  assert.equal(new DataView(buf).getUint32(40, true), 0);
});

// --- Property 18 ---------------------------------------------------------

// encodeWav 正值乘 0x7fff、负值乘 0x8000 再取整；decodeWav 统一除以 0x8000。
// 负值误差 ≤ 0.5/32768；正值误差 ≤ 0.5/32767（取整）+ q/(32767·32768)（比例差，q ≤ 32767）
// < 1.5/32767。设计稿写的 1/32767 对接近 1 的正值不成立，这里按实际量化方式取上界。
const ROUNDTRIP_TOL = 1.5 / 32767 + 1e-7;

const roundTripGen = (rng) => {
  const numChannels = int(1, 2)(rng);
  const frames = int(0, 4096)(rng);
  const sampleRate = int(8000, 96000)(rng);
  const sample = oneOf(float(-1, 1), -1, 1, 0); // 偶尔注入端点
  const channels = Array.from({ length: numChannels }, () => {
    const ch = new Float32Array(frames);
    for (let i = 0; i < frames; i++) ch[i] = sample(rng);
    return ch;
  });
  return { channels, sampleRate };
};

const KS_GUID_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

/** 随机生成 PCM 16/24/32 位或 float32 WAV 的原始字节，同时给出期望样本。 */
const wavFileGen = (rng) => {
  const kind = oneOf('pcm16', 'pcm24', 'pcm32', 'float32')(rng);
  const extensible = rng() < 0.5;
  const numChannels = int(1, 2)(rng);
  const frames = int(0, 512)(rng);
  const sampleRate = int(8000, 96000)(rng);
  const bytes = kind === 'pcm16' ? 2 : kind === 'pcm24' ? 3 : 4;
  const formatCode = kind === 'float32' ? 3 : 1;
  // 未知块：奇数或偶数长度，放在 fmt 前 / fmt 与 data 之间 / data 之后
  const unknownChunks = Array.from({ length: int(1, 3)(rng) }, () => ({
    id: oneOf('LIST', 'junk', 'bext', 'id3 ')(rng),
    size: int(0, 33)(rng),
    where: oneOf('beforeFmt', 'beforeData', 'afterData')(rng),
  }));
  if (!unknownChunks.some((c) => c.where === 'beforeData' && c.size % 2 === 1)) {
    unknownChunks.push({ id: 'odd ', size: 2 * int(0, 8)(rng) + 1, where: 'beforeData' });
  }

  const expected = Array.from({ length: numChannels }, () => new Float32Array(frames));
  const raw = [];
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      let v;
      if (kind === 'pcm16') { v = int(-32768, 32767)(rng); expected[c][i] = v / 0x8000; }
      else if (kind === 'pcm24') { v = int(-8388608, 8388607)(rng); expected[c][i] = v / 0x800000; }
      else if (kind === 'pcm32') { v = int(-2147483648, 2147483647)(rng); expected[c][i] = v / 0x80000000; }
      else { v = Math.fround(float(-1.5, 1.5)(rng)); expected[c][i] = v; }
      raw.push(v);
    }
  }
  return { kind, extensible, numChannels, frames, sampleRate, bytes, formatCode, unknownChunks, raw, expected };
};

function buildWav({ extensible, numChannels, sampleRate, bytes, formatCode, unknownChunks, raw, kind }) {
  const parts = [];
  const chunk = (id, body) => {
    const pad = body.length & 1;
    const out = new Uint8Array(8 + body.length + pad);
    const v = new DataView(out.buffer);
    for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
    v.setUint32(4, body.length, true);
    out.set(body, 8);
    return out;
  };
  const unknown = (where) => unknownChunks.filter((c) => c.where === where).forEach((c) => {
    const body = new Uint8Array(c.size);
    for (let i = 0; i < c.size; i++) body[i] = (i * 37 + 11) & 0xff;
    parts.push(chunk(c.id, body));
  });

  const blockAlign = numChannels * bytes;
  const fmt = new Uint8Array(extensible ? 40 : 16);
  const fv = new DataView(fmt.buffer);
  fv.setUint16(0, extensible ? 0xfffe : formatCode, true);
  fv.setUint16(2, numChannels, true);
  fv.setUint32(4, sampleRate, true);
  fv.setUint32(8, sampleRate * blockAlign, true);
  fv.setUint16(12, blockAlign, true);
  fv.setUint16(14, bytes * 8, true);
  if (extensible) {
    fv.setUint16(16, 22, true); // cbSize
    fv.setUint16(18, bytes * 8, true); // validBits
    fv.setUint32(20, numChannels === 1 ? 0x4 : 0x3, true); // channelMask
    fv.setUint16(24, formatCode, true);
    fmt.set(KS_GUID_TAIL, 26);
  }

  const data = new Uint8Array(raw.length * bytes);
  const dv = new DataView(data.buffer);
  raw.forEach((v, k) => {
    const p = k * bytes;
    if (kind === 'float32') dv.setFloat32(p, v, true);
    else if (bytes === 2) dv.setInt16(p, v, true);
    else if (bytes === 4) dv.setInt32(p, v, true);
    else { const u = v & 0xffffff; data[p] = u & 0xff; data[p + 1] = (u >> 8) & 0xff; data[p + 2] = (u >> 16) & 0xff; }
  });

  unknown('beforeFmt');
  parts.push(chunk('fmt ', fmt));
  unknown('beforeData');
  parts.push(chunk('data', data));
  unknown('afterData');

  const bodyLen = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(12 + bodyLen);
  const ov = new DataView(out.buffer);
  'RIFF'.split('').forEach((ch, i) => { out[i] = ch.charCodeAt(0); });
  ov.setUint32(4, 4 + bodyLen, true);
  'WAVE'.split('').forEach((ch, i) => { out[8 + i] = ch.charCodeAt(0); });
  let o = 12;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out.buffer;
}

test('Feature: separation-accuracy, Property 18: WAV 编解码往返', async () => {
  // **Validates: Requirements 5.9**
  await forAll(roundTripGen, ({ channels, sampleRate }) => {
    const out = decodeWav(encodeWav(channels, sampleRate));
    assert.equal(out.sampleRate, sampleRate);
    assert.equal(out.channels.length, channels.length);
    for (let c = 0; c < channels.length; c++) {
      assert.equal(out.channels[c].length, channels[c].length);
      for (let i = 0; i < channels[c].length; i++) {
        const err = Math.abs(out.channels[c][i] - channels[c][i]);
        if (!(err <= ROUNDTRIP_TOL)) {
          assert.fail(`ch ${c} sample ${i}: in ${channels[c][i]}, out ${out.channels[c][i]}, err ${err}`);
        }
      }
    }
  }, { runs: 100 });

  await forAll(wavFileGen, (w) => {
    const out = decodeWav(buildWav(w));
    assert.equal(out.sampleRate, w.sampleRate);
    assert.equal(out.channels.length, w.numChannels);
    for (let c = 0; c < w.numChannels; c++) {
      assert.equal(out.channels[c].length, w.frames);
      for (let i = 0; i < w.frames; i++) {
        // 期望值已存为 Float32，解码结果也存为 Float32，应逐位一致
        if (out.channels[c][i] !== w.expected[c][i]) {
          assert.fail(`${w.kind}${w.extensible ? ' (extensible)' : ''} ch ${c} sample ${i}: expected ${w.expected[c][i]}, got ${out.channels[c][i]}`);
        }
      }
    }
  }, { runs: 100 });
});

// --- decodeWav 错误条件 (Requirements 5.9) ----------------------------------

const UNSUPPORTED = { message: '不支持的 WAV 格式' };
const INCOMPLETE = { message: 'WAV 文件不完整' };

/** 按给定块列表拼出 RIFF/WAVE 文件；块 size 默认为 body 长度，可用 size 覆盖。 */
function riffFile(chunks, { riff = 'RIFF', wave = 'WAVE' } = {}) {
  const encoded = chunks.map(({ id, body, size = body.length }) => {
    const out = new Uint8Array(8 + body.length + (body.length & 1));
    for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
    new DataView(out.buffer).setUint32(4, size, true);
    out.set(body, 8);
    return out;
  });
  const bodyLen = encoded.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(12 + bodyLen);
  for (let i = 0; i < 4; i++) { out[i] = riff.charCodeAt(i); out[8 + i] = wave.charCodeAt(i); }
  new DataView(out.buffer).setUint32(4, 4 + bodyLen, true);
  let o = 12;
  for (const p of encoded) { out.set(p, o); o += p.length; }
  return out.buffer;
}

function fmtBody({ format = 1, numChannels = 1, sampleRate = 44100, bits = 16, blockAlign, size = 16, subFormat = 1 } = {}) {
  const body = new Uint8Array(size);
  const v = new DataView(body.buffer);
  const ba = blockAlign ?? numChannels * (bits >> 3);
  if (size >= 2) v.setUint16(0, format, true);
  if (size >= 4) v.setUint16(2, numChannels, true);
  if (size >= 8) v.setUint32(4, sampleRate, true);
  if (size >= 12) v.setUint32(8, sampleRate * ba, true);
  if (size >= 14) v.setUint16(12, ba, true);
  if (size >= 16) v.setUint16(14, bits, true);
  if (size >= 26) v.setUint16(24, subFormat, true);
  return body;
}

const fmtChunk = (opts) => ({ id: 'fmt ', body: fmtBody(opts) });
const dataChunk = (n = 8) => ({ id: 'data', body: new Uint8Array(n) });

test('decodeWav: 非 RIFF/WAVE 输入抛出“不支持的 WAV 格式”', () => {
  assert.throws(() => decodeWav(riffFile([fmtChunk(), dataChunk()], { riff: 'RIFX' })), UNSUPPORTED);
  assert.throws(() => decodeWav(riffFile([fmtChunk(), dataChunk()], { wave: 'AVI ' })), UNSUPPORTED);
  assert.throws(() => decodeWav(new TextEncoder().encode('ID3\x03 this is an mp3 file').buffer), UNSUPPORTED);
  assert.throws(() => decodeWav(new ArrayBuffer(0)), UNSUPPORTED);
  assert.throws(() => decodeWav(new Uint8Array(encodeWav([new Float32Array(4)], 8000))), UNSUPPORTED);
});

test('decodeWav: 缺少 fmt 块（data 先于 fmt 出现）抛出“不支持的 WAV 格式”', () => {
  assert.throws(() => decodeWav(riffFile([dataChunk()])), UNSUPPORTED);
  assert.throws(() => decodeWav(riffFile([{ id: 'LIST', body: new Uint8Array(5) }, dataChunk(), fmtChunk()])), UNSUPPORTED);
});

test('decodeWav: 缺少 data 块抛出“WAV 文件不完整”', () => {
  assert.throws(() => decodeWav(riffFile([fmtChunk()])), INCOMPLETE);
  assert.throws(() => decodeWav(riffFile([fmtChunk(), { id: 'junk', body: new Uint8Array(3) }])), INCOMPLETE);
  assert.throws(() => decodeWav(riffFile([])), INCOMPLETE);
});

test('decodeWav: 截断的文件抛出“WAV 文件不完整”', () => {
  const full = encodeWav([new Float32Array([0.1, -0.2, 0.3, -0.4])], 8000); // 44 + 8 字节
  assert.equal(decodeWav(full).channels[0].length, 4); // 未截断时可正常解码
  assert.throws(() => decodeWav(full.slice(0, full.byteLength - 1)), INCOMPLETE); // data 体超出末尾
  assert.throws(() => decodeWav(full.slice(0, 44)), INCOMPLETE); // 只剩 data 头
  assert.throws(() => decodeWav(full.slice(0, 40)), INCOMPLETE); // data 块头被截断
  assert.throws(() => decodeWav(full.slice(0, 30)), INCOMPLETE); // fmt 体超出末尾
  assert.throws(() => decodeWav(full.slice(0, 6)), INCOMPLETE); // RIFF 头被截断
  // 块头声明的长度超过实际剩余字节
  assert.throws(() => decodeWav(riffFile([fmtChunk(), { id: 'data', body: new Uint8Array(4), size: 1000 }])), INCOMPLETE);
});

test('decodeWav: 不支持的格式码 / 位深 / 参数抛出“不支持的 WAV 格式”', () => {
  const cases = [
    { format: 2 }, // MS ADPCM
    { format: 0x55 }, // MP3
    { format: 1, bits: 8 }, // 8 位 PCM
    { format: 3, bits: 64 }, // float64
    { format: 3, bits: 16 },
    { format: 0xfffe, size: 40, subFormat: 2 }, // EXTENSIBLE 子格式非 PCM/float
    { format: 0xfffe, size: 18 }, // EXTENSIBLE 但 fmt 不足 40 字节
    { size: 14 }, // fmt 不足 16 字节
    { numChannels: 0 },
    { sampleRate: 0 },
    { numChannels: 2, blockAlign: 2 }, // blockAlign 与声道×字节数不符
  ];
  for (const c of cases) {
    assert.throws(() => decodeWav(riffFile([fmtChunk(c), dataChunk()])), UNSUPPORTED, JSON.stringify(c));
  }
  // 对照：同一构造器生成的合法文件能正常解码
  assert.equal(decodeWav(riffFile([fmtChunk(), dataChunk()])).channels[0].length, 4);
  assert.equal(decodeWav(riffFile([fmtChunk({ format: 0xfffe, size: 40, subFormat: 3, bits: 32 }), dataChunk()])).channels[0].length, 2);
});
