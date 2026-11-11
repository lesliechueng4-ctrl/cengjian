// Baseline_Separator: a line-by-line copy of `separateChannels` from
// public/js/separator.js as it was before the separation-accuracy work
// (STFT 2048/512 Hann, contextFrames 16, HPSS 13/13/1.5, Avendano center mask,
// practice gain capped at 4x, mono input skips the center mask).
//
// It only depends on pre-existing dsp.js exports whose behavior stays unchanged,
// so benchmarks can compare the improved separator against this fixed reference.
// Extra option: `levelMatch` (default true). When false, `scaleToReference` is
// skipped so SDR is measured on the raw stem levels.

import {
  processSegments, hpssMasks, centerMask, lowpass, highpass, bandpass,
  subtract, estimateBpm, rms,
} from '../../public/js/dsp.js';

function vocalBandWeight(freq) {
  if (freq < 120) return 0;
  if (freq < 200) return (freq - 120) / 80;
  if (freq <= 5000) return 1;
  if (freq < 8000) return (8000 - freq) / 3000;
  return 0;
}

function emptySpec(like) {
  const size = like.re.length;
  return { ...like, re: new Float32Array(size), im: new Float32Array(size) };
}

function scaleToReference(channels, refRms) {
  // Bring quiet stems up to a practice-friendly level without clipping.
  const level = Math.max(...channels.map(rms));
  if (level < 1e-7) return channels;
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  let gain = Math.min(4, Math.max(1, (refRms * 0.8) / level));
  if (peak * gain > 0.98) gain = Math.max(1, 0.98 / peak);
  if (gain === 1) return channels;
  return channels.map((ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) out[i] = ch[i] * gain;
    return out;
  });
}

/**
 * Baseline separation into practice stems.
 * @param {Float32Array[]} channels 1 or 2 channels (extra channels ignored)
 * @param {number} sampleRate
 * @param {{onProgress?: (p:number)=>any, onStem?: (id:string, ch:Float32Array[])=>any}} hooks
 * @param {{levelMatch?: boolean}} options levelMatch=false skips scaleToReference
 * @returns {Promise<{bpm:number}>}
 */
export async function separateChannelsBaseline(channels, sampleRate, hooks = {}, options = {}) {
  const { onProgress, onStem } = hooks;
  const { levelMatch = true } = options;
  const stereo = channels.length > 1;
  const L = channels[0];
  const R = stereo ? channels[1] : channels[0];
  const len = L.length;

  const mid = new Float32Array(len);
  for (let i = 0; i < len; i++) mid[i] = (L[i] + R[i]) / 2;
  const bpm = estimateBpm(mid, sampleRate);
  const refRms = Math.max(rms(L), rms(R));

  const n = 2048;
  const hop = 512;
  const binHz = sampleRate / n;
  const inputs = stereo ? [L, R] : [L];

  const kernel = (specs) => {
    const sl = specs[0];
    const sr = stereo ? specs[1] : specs[0];
    const { frames, bins } = sl;
    const size = sl.re.length;
    const mag = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      mag[i] = (Math.hypot(sl.re[i], sl.im[i]) + Math.hypot(sr.re[i], sr.im[i])) / 2;
    }
    const { H, P, R: Res } = hpssMasks(mag, frames, bins, { kTime: 13, kFreq: 13, beta: 1.5 });
    const C = stereo ? centerMask(sl, sr, 4) : null;
    const band = new Float32Array(bins);
    for (let k = 0; k < bins; k++) band[k] = vocalBandWeight(k * binHz);

    const outs = Array.from({ length: stereo ? 7 : 4 }, () => emptySpec(sl));
    const [V] = outs;
    for (let t = 0; t < frames; t++) {
      for (let k = 0; k < bins; k++) {
        const i = t * bins + k;
        const mr = (sl.re[i] + sr.re[i]) / 2;
        const mi = (sl.im[i] + sr.im[i]) / 2;
        const vm = H[i] * band[k] * (C ? C[i] : 1);
        V.re[i] = mr * vm; V.im[i] = mi * vm;
        if (stereo) {
          outs[1].re[i] = sl.re[i] * H[i]; outs[1].im[i] = sl.im[i] * H[i];
          outs[2].re[i] = sr.re[i] * H[i]; outs[2].im[i] = sr.im[i] * H[i];
          outs[3].re[i] = sl.re[i] * P[i]; outs[3].im[i] = sl.im[i] * P[i];
          outs[4].re[i] = sr.re[i] * P[i]; outs[4].im[i] = sr.im[i] * P[i];
          outs[5].re[i] = sl.re[i] * Res[i]; outs[5].im[i] = sl.im[i] * Res[i];
          outs[6].re[i] = sr.re[i] * Res[i]; outs[6].im[i] = sr.im[i] * Res[i];
        } else {
          outs[1].re[i] = sl.re[i] * H[i]; outs[1].im[i] = sl.im[i] * H[i];
          outs[2].re[i] = sl.re[i] * P[i]; outs[2].im[i] = sl.im[i] * P[i];
          outs[3].re[i] = sl.re[i] * Res[i]; outs[3].im[i] = sl.im[i] * Res[i];
        }
      }
    }
    return outs;
  };

  const spectralShare = 0.85;
  const parts = await processSegments(inputs, stereo ? 7 : 4, { n, hop, contextFrames: 16 }, kernel,
    (p) => onProgress && onProgress(p * spectralShare));

  let V, HL, HR, PL, PR, RL, RR;
  if (stereo) [V, HL, HR, PL, PR, RL, RR] = parts;
  else { [V, HL, PL, RL] = parts; HR = HL; PR = PL; RR = RL; }

  const total = 8;
  let done = 0;
  const emit = async (id, chs) => {
    if (onStem) await onStem(id, levelMatch ? scaleToReference(chs, refRms) : chs);
    done++;
    if (onProgress) await onProgress(spectralShare + ((1 - spectralShare) * done) / total);
  };
  const pair = (fn) => (stereo ? [fn(0), fn(1)] : [fn(0)]);

  const vocal = bandpass(V, 120, 8000, sampleRate);
  await emit('vocal', pair(() => vocal));
  await emit('inst', pair((c) => subtract(c ? R : L, vocal)));
  await emit('drums', pair((c) => (c ? PR : PL)));

  const bassOf = (x) => lowpass(lowpass(x, 250, sampleRate), 250, sampleRate);
  const bassL = bassOf(HL);
  const bassR = stereo ? bassOf(HR) : bassL;
  await emit('bass', pair((c) => (c ? bassR : bassL)));
  await emit('harmony', pair((c) => subtract(subtract(c ? HR : HL, c ? bassR : bassL), vocal)));
  await emit('perc', pair((c) => highpass(highpass(c ? PR : PL, 5000, sampleRate), 5000, sampleRate)));

  if (stereo) {
    const side = new Float32Array(len);
    for (let i = 0; i < len; i++) side[i] = (RL[i] - RR[i] + PL[i] - PR[i]) / 2;
    const s = highpass(highpass(side, 1500, sampleRate), 1500, sampleRate);
    // Same phase on both channels: the textbook [s, -s] side reconstruction
    // sums to silence on mono phone speakers, single earbuds and mono mode.
    await emit('fx', [s, s]);
  } else {
    await emit('fx', [highpass(highpass(RL, 6000, sampleRate), 6000, sampleRate)]);
  }
  await emit('other', pair((c) => (c ? RR : RL)));

  return { bpm };
}

export { separateChannelsBaseline as separateChannels };
