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
