// 16-bit PCM WAV encoder. No DOM access.

/**
 * @param {Float32Array[]} channels equal-length channel arrays
 * @param {number} sampleRate
 * @returns {ArrayBuffer}
 */
export function encodeWav(channels, sampleRate) {
  const numChannels = channels.length;
  const frames = numChannels ? channels[0].length : 0;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const pcm = new Int16Array(buffer, 44, frames * numChannels);
  let o = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      let s = channels[c][i];
      if (!(s === s)) s = 0; // NaN guard
      s = s > 1 ? 1 : s < -1 ? -1 : s;
      pcm[o++] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
  }
  return buffer;
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

/**
 * 解析 RIFF/WAVE：PCM 16/24/32 位整数、IEEE float 32 位、WAVE_FORMAT_EXTENSIBLE（子格式取前 2 字节）。
 * 跳过未知块，奇数长度块按 RIFF 规则补齐。
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{ channels: Float32Array[], sampleRate: number }}
 * @throws Error('不支持的 WAV 格式') / Error('WAV 文件不完整')
 */
export function decodeWav(arrayBuffer) {
  const unsupported = () => new Error('不支持的 WAV 格式');
  const incomplete = () => new Error('WAV 文件不完整');
  if (!(arrayBuffer instanceof ArrayBuffer)) throw unsupported();
  const total = arrayBuffer.byteLength;
  const view = new DataView(arrayBuffer);
  const tag = (off) => String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));

  if (total < 12) {
    // Too short to tell; if what exists looks like RIFF, it's truncated.
    const head = 'RIFF'.slice(0, total);
    let prefix = '';
    for (let i = 0; i < Math.min(total, 4); i++) prefix += String.fromCharCode(view.getUint8(i));
    if (total > 0 && prefix === head) throw incomplete();
    throw unsupported();
  }
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw unsupported();

  let fmt = null;
  let off = 12;
  while (true) {
    if (off + 8 > total) throw incomplete(); // ran out before finding data
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;

    if (id === 'fmt ') {
      if (size < 16) throw unsupported();
      if (body + size > total) throw incomplete();
      let format = view.getUint16(body, true);
      const numChannels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const blockAlign = view.getUint16(body + 12, true);
      const bits = view.getUint16(body + 14, true);
      if (format === FORMAT_EXTENSIBLE) {
        // cbSize(2) validBits(2) channelMask(4) subFormat GUID(16)
        if (size < 40) throw unsupported();
        format = view.getUint16(body + 24, true);
      }
      const isInt = format === FORMAT_PCM && (bits === 16 || bits === 24 || bits === 32);
      const isFloat = format === FORMAT_FLOAT && bits === 32;
      if (!isInt && !isFloat) throw unsupported();
      if (!numChannels || !sampleRate) throw unsupported();
      const bytes = bits >> 3;
      if (blockAlign !== numChannels * bytes) throw unsupported();
      fmt = { isFloat, bytes, numChannels, sampleRate, blockAlign };
    } else if (id === 'data') {
      if (!fmt) throw unsupported();
      if (body + size > total) throw incomplete();
      return decodeSamples(view, body, size, fmt);
    }
    off = body + size + (size & 1);
  }
}

function decodeSamples(view, start, size, { isFloat, bytes, numChannels, sampleRate, blockAlign }) {
  const frames = Math.floor(size / blockAlign);
  const channels = Array.from({ length: numChannels }, () => new Float32Array(frames));
  let p = start;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      let s;
      if (isFloat) {
        s = view.getFloat32(p, true);
      } else if (bytes === 2) {
        s = view.getInt16(p, true) / 0x8000;
      } else if (bytes === 3) {
        let v = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16);
        if (v & 0x800000) v -= 0x1000000;
        s = v / 0x800000;
      } else {
        s = view.getInt32(p, true) / 0x80000000;
      }
      channels[c][i] = s;
      p += bytes;
    }
  }
  return { channels, sampleRate };
}
