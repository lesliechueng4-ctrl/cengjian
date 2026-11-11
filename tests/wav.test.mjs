import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav } from '../public/js/wav.js';

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
