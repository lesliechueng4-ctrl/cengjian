// Stem separation built from classic DSP (no AI model).
//
// Pipeline
// 1. One segmented STFT pass over the stereo pair computes, per time-frequency bin:
//    - HPSS masks (harmonic / percussive / residual) from the average magnitude
//    - an inter-channel similarity mask that is 1 for center-panned content
//    and outputs: center-harmonic vocal band (V), harmonic L/R, percussive L/R,
//    residual L/R.
// 2. Time-domain zero-phase filters turn those parts into the 9 practice stems:
//    原曲     original file audio (played by the media element itself)
//    人声     V band limited to 120 Hz to 8 kHz (center + harmonic + vocal band)
//    纯伴奏   original minus 人声 (center cancellation; bass and kick stay since
//            the vocal estimate is band limited above 120 Hz)
//    鼓       percussive part (HPSS)
//    贝斯     harmonic part lowpassed at 250 Hz (4th order)
//    和声伴奏 harmonic part minus 贝斯 minus 人声 (pads, chords, backing harmonies)
//    额外打击乐 percussive part highpassed above 5 kHz (hats, shakers, claps)
//    效果音   stereo side content of residual + percussive above 1.5 kHz, played
//            in phase on both channels so it stays audible when summed to mono
//            (mono input: residual above 6 kHz, i.e. risers and noise sweeps)
//    其他音效 HPSS residual: what is neither clearly tonal nor clearly transient
// Mono input skips the center mask (everything counts as center).
//
// This module has no DOM access at import time so Node tests can import it.

import {
  processSegments, hpssMasks, centerMask, lowpass, highpass, bandpass,
  subtract, estimateBpm, rms,
} from './dsp.js';

export const STEMS = [
  { id: 'original', label: '原曲' },
  { id: 'inst', label: '纯伴奏' },
  { id: 'vocal', label: '人声' },
  { id: 'drums', label: '鼓' },
  { id: 'bass', label: '贝斯' },
  { id: 'harmony', label: '和声伴奏' },
  { id: 'perc', label: '额外打击乐' },
  { id: 'fx', label: '效果音' },
  { id: 'other', label: '其他音效' },
];

export const STEM_NOTES = {
  original: '上传文件自带的原始音频，不做任何处理。',
  inst: '原曲减去人声估计（中置声道消除），低频鼓和贝斯保留。',
  vocal: '左右声道相同且偏旋律性的 120 Hz 到 8 kHz 成分。',
  drums: '谐波/打击分离（HPSS）中的打击部分。',
  bass: '谐波部分里 250 Hz 以下的低频。',
  harmony: '谐波部分去掉贝斯和人声后剩下的和弦、铺底、和声。',
  perc: '打击部分里 5 kHz 以上的高频：镲、沙锤、拍手等。',
  fx: '立体声两侧的高频残余和瞬态，例如转场音效、扫频。左右同相输出，单喇叭也听得到。',
  other: '既不明显是旋律也不明显是打击的残余部分。',
};

// Separation keeps several full-length float copies plus 8 WAV blobs in memory
// (about 800 MB peak for a 3 minute stereo song), so long files are refused
// before they can crash a phone tab. Phones (coarse pointer) get tighter limits.
export const SEPARATION_LIMITS = {
  mobile: { seconds: 6 * 60, bytes: 500 * 1024 * 1024 },
  desktop: { seconds: 15 * 60, bytes: 2 * 1024 * 1024 * 1024 },
};

/**
 * @param {{bytes?: number, duration?: number, mobile: boolean}} info
 * @returns {string} empty when separation may run, otherwise a message for the user
 */
export function separationLimitMessage({ bytes, duration, mobile }) {
  const limit = mobile ? SEPARATION_LIMITS.mobile : SEPARATION_LIMITS.desktop;
  const device = mobile ? '手机' : '电脑';
  if (bytes != null && bytes > limit.bytes) {
    return `文件超过 ${Math.round(limit.bytes / 1024 / 1024)} MB，在${device}上分离音轨容易内存不足，已跳过分离，原曲可以正常播放。建议先剪成需要的片段再上传。`;
  }
  if (duration != null && duration > limit.seconds) {
    return `文件超过 ${limit.seconds / 60} 分钟，在${device}上分离音轨容易内存不足，已跳过分离，原曲可以正常播放。建议先剪成 ${limit.seconds / 60} 分钟以内的片段再上传。`;
  }
  return '';
}

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
 * Separate decoded audio into practice stems.
 * @param {Float32Array[]} channels 1 or 2 channels (extra channels ignored)
 * @param {number} sampleRate
 * @param {{onProgress?: (p:number)=>any, onStem?: (id:string, ch:Float32Array[])=>any}} hooks
 * @returns {Promise<{bpm:number}>}
 */
export async function separateChannels(channels, sampleRate, hooks = {}) {
  const { onProgress, onStem } = hooks;
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
    if (onStem) await onStem(id, scaleToReference(chs, refRms));
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

// ---------------------------------------------------------------------------
// Browser entry: run in a module Web Worker, fall back to the main thread.
// ---------------------------------------------------------------------------

/**
 * @param {AudioBuffer} audioBuffer
 * @param {{onProgress?: (p:number)=>void, encode: (ch:Float32Array[], sr:number)=>ArrayBuffer, signal?: AbortSignal}} opts
 * @returns {Promise<{urls: Record<string,string>, bpm:number}>}
 */
export function runSeparation(audioBuffer, opts) {
  const sampleRate = audioBuffer.sampleRate;
  const count = Math.min(2, audioBuffer.numberOfChannels);
  const getChannels = () => Array.from({ length: count }, (_, c) => audioBuffer.getChannelData(c).slice());
  const toUrl = (wav) => URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));

  const { signal } = opts;
  const aborted = () => new DOMException('已取消', 'AbortError');

  const mainThread = async () => {
    const urls = {};
    const yieldUi = () => new Promise((r) => setTimeout(r, 0));
    const { bpm } = await separateChannels(getChannels(), sampleRate, {
      onProgress: async (p) => {
        if (signal?.aborted) {
          for (const u of Object.values(urls)) URL.revokeObjectURL(u);
          throw aborted();
        }
        opts.onProgress?.(p);
        await yieldUi();
      },
      onStem: (id, chs) => { urls[id] = toUrl(opts.encode(chs, sampleRate)); },
    });
    return { urls, bpm };
  };

  if (typeof Worker === 'undefined') return mainThread();

  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./separator.worker.js', import.meta.url), { type: 'module' });
    } catch {
      mainThread().then(resolve, reject);
      return;
    }
    const urls = {};
    let settled = false;
    // The worker posts 'ready' as soon as its module graph loaded. Only a failure
    // before that (no module worker support, script load error) falls back to the
    // main thread; failures during separation are reported, not rerun.
    let started = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      worker.terminate();
      return true;
    };
    const fail = (err) => {
      if (!finish()) return;
      for (const u of Object.values(urls)) URL.revokeObjectURL(u);
      reject(err);
    };
    signal?.addEventListener('abort', () => fail(aborted()), { once: true });
    const fallback = () => {
      if (!finish()) return;
      for (const u of Object.values(urls)) URL.revokeObjectURL(u);
      mainThread().then(resolve, reject);
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      if (!started) fallback();
      else fail(new Error(`音轨分离失败：${e.message || '后台线程意外停止，可能是内存不足'}`));
    };
    worker.onmessage = ({ data }) => {
      if (settled) return;
      if (data.type === 'ready') started = true;
      else if (data.type === 'progress') opts.onProgress?.(data.value);
      else if (data.type === 'stem') urls[data.id] = toUrl(data.wav);
      else if (data.type === 'done') { finish(); resolve({ urls, bpm: data.bpm }); }
      else if (data.type === 'error') fail(new Error(`音轨分离失败：${data.message || '未知错误'}`));
    };
    const channels = getChannels();
    worker.postMessage({ channels, sampleRate }, channels.map((c) => c.buffer));
  });
}
