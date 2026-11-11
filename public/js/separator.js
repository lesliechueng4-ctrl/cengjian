// Stem separation built from classic DSP (no AI model).
//
// Atom partition (design 6.2): per time-frequency bin the mix is split into 7
// atoms whose masks are non-negative and sum to 1, so the atoms add back to
// the mix exactly (up to STFT reconstruction):
//    V  center, harmonic, vocal band (one mid channel shared by L/R)
//    B  harmonic below the adaptive bass crossover (≈150–320 Hz)
//    H  remaining harmonic
//    D  percussive below 5 kHz, not side high-frequency
//    T  percussive above 5 kHz, not side high-frequency
//    F  side percussive + residual above 1.5 kHz (mono: residual above 6 kHz)
//    O  remaining residual
// Stems: 人声 = V, 纯伴奏 = X − V, 鼓 = D + T, 额外打击乐 = T, 贝斯 = B,
// 和声伴奏 = H, 效果音 = [s, s] with s = (F_L − F_R)/2 (mono: F), 其他音效 = O.
// 原曲 is the original file audio, played by the media element itself.
// All frequency splits happen in the spectrum; there is no time-domain
// filtering or subtraction of separated parts.
//
// This module has no DOM access at import time so Node tests can import it.

import {
  processSegments, hpssMasks, centerMaskPhase, partitionMasks, bassCrossover,
  decimatedTimeMedian, wienerRefine, estimateBpm, rms, limitPeak,
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

// Quality_Mode: 'high' on desktops (non-touch), 'fast' on phones (touch).
export const QUALITY_MODES = ['high', 'fast'];
export const QUALITY_LABELS = { high: '高质量模式', fast: '快速模式' };
export const QUALITY_PRESETS = {
  fast: {
    stages: [{ n: 2048, hop: 512, context: 16, kTime: 13, kFreq: 13, beta: 1.5 }],
    wiener: false, longMedian: false, phaseSmooth: 0,
  },
  high: {
    stages: [
      // stage-1 kFreq tuned 17 → 25 on the Benchmark_Set (see HQ_KERNEL)
      { n: 4096, hop: 1024, context: 40, kTime: 17, kFreq: 25, beta: 2 },
      // stage-2 kTime / kFreq / beta tuned 17 / 17 / 1.5 → 45 / 9 / 2 (see HQ2_KERNEL)
      { n: 1024, hop: 256, context: 24, kTime: 45, kFreq: 9, beta: 2 },
    ],
    wiener: true, longMedian: { k: 33, step: 2 }, phaseSmooth: 1,
  },
};

const ORIGINAL_NOTE = '上传文件自带的原始音频，不做任何处理。';

export const STEM_NOTES_BY_MODE = {
  fast: {
    original: ORIGINAL_NOTE,
    inst: '原曲减去人声估计；各音轨按频谱比例划分，相加等于原曲。',
    vocal: '2048 点谐波中左右同相、偏中置的 160 Hz–8 kHz 成分（160–260 Hz 渐入，5 kHz 以上渐出；单声道无立体声线索，取频带内全部谐波）。',
    drums: '2048 点打击部分，去掉两侧高频效果。',
    bass: '2048 点谐波中自适应交叉点（约 150–320 Hz，随低音音高变化）以下的部分。',
    harmony: '2048 点谐波去掉人声和贝斯后的和弦、铺底、和声。',
    perc: '打击部分里约 6 kHz 以上（6.8 kHz 处各占一半）：镲、沙锤、拍手。',
    fx: '1.7 kHz 以上的立体声两侧打击与残余，左右同相输出（单声道取 6 kHz 以上残余）。',
    other: '既非旋律也非打击、且不属于效果音的残余。',
  },
  high: {
    original: ORIGINAL_NOTE,
    inst: '原曲减去人声估计；各音轨按频谱比例划分，相加等于原曲。',
    vocal: '长窗（4096 点）谐波中左右同相、偏中置、音高有波动的 160 Hz–8 kHz 成分（160–260 Hz 渐入，5 kHz 以上渐出；单声道只看音高波动）。',
    drums: '长窗谐波以外的部分再用短窗（1024 点）分出的打击部分，去掉两侧高频效果。',
    bass: '长窗谐波中自适应交叉点（约 150–320 Hz，随低音音高变化）以下的部分。',
    harmony: '长窗谐波去掉人声和贝斯后的和弦、铺底、和声。',
    perc: '短窗打击部分里约 6 kHz 以上（6.8 kHz 处各占一半）：镲、沙锤、拍手。',
    fx: '1.5 kHz 以上的立体声两侧打击与残余（短窗），左右同相输出（单声道取 6 kHz 以上残余）。',
    other: '既非旋律也非打击、且不属于效果音的残余（含长窗漏下的弱谐波）。',
  },
};

function normalizeMode(mode) {
  return QUALITY_MODES.includes(mode) ? mode : 'fast';
}

/** Stem notes for a Quality_Mode; unknown modes fall back to 'fast'. */
export function stemNotes(mode) {
  return STEM_NOTES_BY_MODE[normalizeMode(mode)];
}

// Kept for existing imports.
export const STEM_NOTES = STEM_NOTES_BY_MODE.fast;

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

// Vocal band weight: 0 below lo0, linear up to 1 at lo1, 1 up to hi0, linear
// down to 0 at hi1 (defaults 120 / 200 / 5000 / 8000 Hz).
function vocalBandWeight(freq, b = VOCAL_BAND) {
  if (freq < b.lo0) return 0;
  if (freq < b.lo1) return (freq - b.lo0) / (b.lo1 - b.lo0);
  if (freq <= b.hi0) return 1;
  if (freq < b.hi1) return (b.hi1 - freq) / (b.hi1 - b.hi0);
  return 0;
}
const VOCAL_BAND = { lo0: 120, lo1: 200, hi0: 5000, hi1: 8000 };

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

// Fast_Mode kernel parameters (design 6.2–6.4), tuned on the Benchmark_Set:
// - centerSharpness 3 (design start 4): keeps more of the centered vocal.
// - vocal band starts at 160–260 Hz (was 120–200): less bass / pad low end in 人声.
// - percHz 6800: the hi() ramp is 0.5 at percHz; the baseline's 4× 5 kHz
//   Butterworth high-pass (zero phase) only reaches 0.5 amplitude near 6.2 kHz,
//   so 5000 here cut much lower than the baseline did.
// - fxHz 1700, crossover factor 2.8 (design start 1500 / 2.2).
const FAST_KERNEL = {
  centerSharpness: 3,
  band: { lo0: 160, lo1: 260, hi0: 5000, hi1: 8000 },
  fxHz: 1700,
  percHz: 6800,
  monoFxHz: 6000,
  crossover: { factor: 2.8 },
};

/**
 * One single-resolution atom partition pass (Fast_Mode, design 6.4).
 * Returns the time-domain atoms:
 *   stereo { V, B:[L,R], H:[L,R], D:[L,R], T:[L,R], s, O:[L,R], F?:[L,R] }
 *   mono   { V, B:[x], H:[x], D:[x], T:[x], s, O:[x] }      (s = F)
 * F_L/F_R (raw-phase fx atom) are only produced when wantF is set.
 */
async function atomPartitionPass(inputs, sampleRate, stage, wantF, onProgress, segment) {
  const stereo = inputs.length > 1;
  const { n, hop, context, kTime, kFreq, beta } = stage;
  const binHz = sampleRate / n;
  const p = FAST_KERNEL;
  const band = new Float32Array(n / 2 + 1);
  for (let k = 0; k < band.length; k++) band[k] = vocalBandWeight(k * binHz, p.band);

  // Output layout. Stereo: V, B_L, B_R, H_L, H_R, D_L, D_R, T_L, T_R, s, O_L, O_R
  // (+ F_L, F_R). Mono: V, B, H, D, T, F, O.
  const nOut = stereo ? (wantF ? 14 : 12) : 7;

  const kernel = (specs) => {
    const sl = specs[0];
    const sr = stereo ? specs[1] : sl;
    const { frames, bins } = sl;
    const size = sl.re.length;
    const mag = new Float32Array(size);
    {
      // sqrt instead of Math.hypot: same value for these magnitudes, much faster
      const a = sl.re, b = sl.im, c = sr.re, d = sr.im;
      if (stereo) {
        for (let i = 0; i < size; i++) {
          mag[i] = (Math.sqrt(a[i] * a[i] + b[i] * b[i]) + Math.sqrt(c[i] * c[i] + d[i] * d[i])) / 2;
        }
      } else {
        for (let i = 0; i < size; i++) mag[i] = Math.sqrt(a[i] * a[i] + b[i] * b[i]);
      }
    }
    // Every per-frame quantity below depends on at most ±8 frames (HPSS median
    // half-width 6, crossover radius 8), inside contextFrames, so segmented
    // processing equals whole-signal processing.
    const { H: Mh, P: Mp, R: Mr } = hpssMasks(mag, frames, bins, { kTime, kFreq, beta });
    const fc = bassCrossover(Mh, mag, frames, bins, binHz, p.crossover);
    let Cv = 1;
    let S = null;
    if (stereo) ({ C: Cv, S } = centerMaskPhase(sl, sr, p.centerSharpness, 0));
    const m = partitionMasks({
      frames, bins, binHz, Mh, Mp, Mr, band, Cv, fc, S,
      fxHz: p.fxHz, percHz: p.percHz, monoFxHz: p.monoFxHz, renormalize: true,
    });

    const outs = Array.from({ length: nOut }, () => emptySpec(sl));
    const lre = sl.re, lim = sl.im, rre = sr.re, rim = sr.im;
    const MV = m.V;
    const vRe = outs[0].re, vIm = outs[0].im;
    if (stereo) {
      // Y_c = X_c − V; the non-V atoms are renormalised for Y_c.
      const yl = new Float32Array(size), yli = new Float32Array(size);
      const yr = new Float32Array(size), yri = new Float32Array(size);
      for (let i = 0; i < size; i++) {
        const mv = MV[i] * 0.5;
        const vr = mv * (lre[i] + rre[i]);
        const vi = mv * (lim[i] + rim[i]);
        vRe[i] = vr; vIm[i] = vi;
        yl[i] = lre[i] - vr; yli[i] = lim[i] - vi;
        yr[i] = rre[i] - vr; yri[i] = rim[i] - vi;
      }
      const put = (o, mask) => {
        const aRe = outs[o].re, aIm = outs[o].im, bRe = outs[o + 1].re, bIm = outs[o + 1].im;
        for (let i = 0; i < size; i++) {
          const g = mask[i];
          aRe[i] = g * yl[i]; aIm[i] = g * yli[i];
          bRe[i] = g * yr[i]; bIm[i] = g * yri[i];
        }
      };
      put(1, m.B);
      put(3, m.H);
      put(5, m.D);
      put(7, m.T);
      put(10, m.O);
      if (wantF) put(12, m.F);
      // s = (F_L − F_R)/2 directly in the spectrum (V cancels in Y_L − Y_R)
      const MF = m.F, sRe = outs[9].re, sIm = outs[9].im;
      for (let i = 0; i < size; i++) {
        const g = MF[i] * 0.5;
        sRe[i] = g * (yl[i] - yr[i]); sIm[i] = g * (yli[i] - yri[i]);
      }
    } else {
      const yr = new Float32Array(size), yi = new Float32Array(size);
      for (let i = 0; i < size; i++) {
        const vr = MV[i] * lre[i], vi = MV[i] * lim[i];
        vRe[i] = vr; vIm[i] = vi;
        yr[i] = lre[i] - vr; yi[i] = lim[i] - vi;
      }
      [m.B, m.H, m.D, m.T, m.F, m.O].forEach((mask, j) => {
        const oRe = outs[j + 1].re, oIm = outs[j + 1].im;
        for (let i = 0; i < size; i++) { oRe[i] = mask[i] * yr[i]; oIm[i] = mask[i] * yi[i]; }
      });
    }
    return outs;
  };

  const parts = await processSegments(inputs, nOut, segmentOpts(stage, segment), kernel, onProgress);
  if (stereo) {
    const two = (k) => [parts[k], parts[k + 1]];
    return {
      V: parts[0], B: two(1), H: two(3), D: two(5), T: two(7), s: parts[9], O: two(10),
      F: wantF ? two(12) : null,
    };
  }
  const [V, B, H, D, T, F, O] = parts;
  return { V, B: [B], H: [H], D: [D], T: [T], s: F, O: [O], F: null };
}

/**
 * processSegments options for one stage. `segment` (samples, optional) is
 * rounded down to a multiple of 2·hop (at least 2·hop) so segment origins stay
 * on the even frame grid decimatedTimeMedian needs; undefined keeps the
 * processSegments default (hop·256).
 */
function segmentOpts(stage, segment) {
  const { n, hop, context } = stage;
  const opts = { n, hop, contextFrames: context };
  if (segment != null) opts.segment = Math.max(2 * hop, Math.floor(segment / (2 * hop)) * 2 * hop);
  return opts;
}

// High_Quality_Mode stage-1 kernel parameters (design 6.5), tuned on the
// Benchmark_Set (stereo vocal / 纯伴奏 SDR):
// - vocal cue Cv = C·(cueFloor + (1 − cueFloor)·φ) (stereo) or Cv = φ (mono);
//   cueFloor 0.6 (design start 0.4, +0.7 dB vocal).
// - centerSharpness 2 (design start 4, Fast_Mode uses 3).
// - band / crossover as FAST_KERNEL (160–260 Hz start; lower starts let bass
//   into 人声, 180 Hz loses vocal low harmonics).
// - stage-1 kFreq is 25 in QUALITY_PRESETS.high (design start 17): with
//   10.8 Hz bins a 17-bin frequency median let vibrato-smeared vocal harmonics
//   look percussive and fall into Rem (+0.9 dB vocal).
const HQ_KERNEL = {
  centerSharpness: 2,
  band: { lo0: 160, lo1: 260, hi0: 5000, hi1: 8000 },
  crossover: { factor: 2.8 },
  cueFloor: 0.6,
  phiEps: 1e-9,
};

/**
 * High_Quality_Mode stage 1: long window harmonic split (design 6.5).
 * HPSS gives Mh; the non-harmonic part is a single atom Rem = 1 − Mh.
 * Vocal fluctuation cue φ = clamp(1 − Hlong/(Hshort + ε), 0, 1) with
 * Hshort = Mh·|X̄| and Hlong the decimated long time median of |X̄|. The long
 * median is taken on |X̄| rather than on Hshort: over ~1.5 s the median ignores
 * short transients anyway, and this keeps the dependency radius at
 * (33 >> 1 + 1)·2 = 34 frames (+1 Wiener) instead of 34 + 8 (HPSS time
 * median) + 1 = 43, which would exceed contextFrames 40 (design 6.7).
 *
 * Wiener refinement runs once on all four atoms V/B/H/Rem with their
 * un-renormalised masks (sum 1) against the channel spectra X_c, so the vocal
 * mask is refined too. V is then applied to the mid spectrum,
 * V = M_V·(X_L + X_R)/2, and B/H/Rem are renormalised by 1/(1 − M_V) and
 * applied to Y_c = X_c − V, so V + B_c + H_c + Rem_c = X_c exactly.
 *
 * Returns stereo { V, B:[L,R], H:[L,R], Rem:[L,R] }, mono { V, B:[x], H:[x], Rem:[x] }.
 */
async function hqStage1Pass(inputs, sampleRate, onProgress, segment) {
  const stereo = inputs.length > 1;
  const preset = QUALITY_PRESETS.high;
  const stage = preset.stages[0];
  const { n, kTime, kFreq, beta } = stage;
  const binHz = sampleRate / n;
  const p = HQ_KERNEL;
  const band = new Float32Array(n / 2 + 1);
  for (let k = 0; k < band.length; k++) band[k] = vocalBandWeight(k * binHz, p.band);
  const nOut = stereo ? 7 : 4; // V, B_L, B_R, H_L, H_R, Rem_L, Rem_R | V, B, H, Rem

  const kernel = (specs) => {
    const sl = specs[0];
    const sr = stereo ? specs[1] : sl;
    const { frames, bins } = sl;
    const size = sl.re.length;
    const mag = new Float32Array(size);
    {
      const a = sl.re, b = sl.im, c = sr.re, d = sr.im;
      if (stereo) {
        for (let i = 0; i < size; i++) {
          mag[i] = (Math.sqrt(a[i] * a[i] + b[i] * b[i]) + Math.sqrt(c[i] * c[i] + d[i] * d[i])) / 2;
        }
      } else {
        for (let i = 0; i < size; i++) mag[i] = Math.sqrt(a[i] * a[i] + b[i] * b[i]);
      }
    }
    const { H: Mh } = hpssMasks(mag, frames, bins, { kTime, kFreq, beta });
    const fc = bassCrossover(Mh, mag, frames, bins, binHz, p.crossover);

    // fluctuation cue φ, then the vocal cue Cv (written in place over φ)
    const Cv = preset.longMedian
      ? decimatedTimeMedian(mag, frames, bins, preset.longMedian.k, preset.longMedian.step)
      : new Float32Array(size);
    for (let i = 0; i < size; i++) {
      let phi = 1 - Cv[i] / (Mh[i] * mag[i] + p.phiEps);
      Cv[i] = phi < 0 ? 0 : phi > 1 ? 1 : phi;
    }
    if (stereo) {
      const { C } = centerMaskPhase(sl, sr, p.centerSharpness, preset.phaseSmooth);
      const floor = p.cueFloor, w = 1 - floor;
      for (let i = 0; i < size; i++) Cv[i] = C[i] * (floor + w * Cv[i]);
    }

    const m = partitionMasks({ frames, bins, binHz, Mh, band, Cv, fc, renormalize: false });
    if (preset.wiener) wienerRefine([m.V, m.B, m.H, m.Rem], stereo ? [sl, sr] : [sl], frames, bins);

    const outs = Array.from({ length: nOut }, () => emptySpec(sl));
    const MV = m.V, MB = m.B, MH = m.H, MR = m.Rem;
    const vRe = outs[0].re, vIm = outs[0].im;
    const lre = sl.re, lim = sl.im, rre = sr.re, rim = sr.im;
    // non-V masks renormalised for Y_c (denominator ~0 → all to Rem)
    const norm = (i) => {
      const d = MB[i] + MH[i] + MR[i];
      if (d < 1e-9) { MB[i] = 0; MH[i] = 0; MR[i] = 1; return; }
      const g = 1 / d;
      MB[i] *= g; MH[i] *= g; MR[i] *= g;
    };
    if (stereo) {
      const bL = outs[1], bR = outs[2], hL = outs[3], hR = outs[4], rL = outs[5], rR = outs[6];
      for (let i = 0; i < size; i++) {
        const mv = MV[i] * 0.5;
        const vr = mv * (lre[i] + rre[i]);
        const vi = mv * (lim[i] + rim[i]);
        vRe[i] = vr; vIm[i] = vi;
        const ylr = lre[i] - vr, yli = lim[i] - vi;
        const yrr = rre[i] - vr, yri = rim[i] - vi;
        norm(i);
        const gb = MB[i], gh = MH[i], gr = MR[i];
        bL.re[i] = gb * ylr; bL.im[i] = gb * yli; bR.re[i] = gb * yrr; bR.im[i] = gb * yri;
        hL.re[i] = gh * ylr; hL.im[i] = gh * yli; hR.re[i] = gh * yrr; hR.im[i] = gh * yri;
        rL.re[i] = gr * ylr; rL.im[i] = gr * yli; rR.re[i] = gr * yrr; rR.im[i] = gr * yri;
      }
    } else {
      const b = outs[1], h = outs[2], r = outs[3];
      for (let i = 0; i < size; i++) {
        const vr = MV[i] * lre[i], vi = MV[i] * lim[i];
        vRe[i] = vr; vIm[i] = vi;
        const yr = lre[i] - vr, yi = lim[i] - vi;
        norm(i);
        b.re[i] = MB[i] * yr; b.im[i] = MB[i] * yi;
        h.re[i] = MH[i] * yr; h.im[i] = MH[i] * yi;
        r.re[i] = MR[i] * yr; r.im[i] = MR[i] * yi;
      }
    }
    return outs;
  };

  const parts = await processSegments(inputs, nOut, segmentOpts(stage, segment), kernel, onProgress);
  if (stereo) {
    return { V: parts[0], B: [parts[1], parts[2]], H: [parts[3], parts[4]], Rem: [parts[5], parts[6]] };
  }
  return { V: parts[0], B: [parts[1]], H: [parts[2]], Rem: [parts[3]] };
}

// High_Quality_Mode stage-2 kernel parameters (design 6.5), tuned on the
// Benchmark_Set (stereo and mono):
// - HPSS kTime 45 (±22 frames ≈ ±128 ms), kFreq 9 (≈ 390 Hz), β 2 in
//   QUALITY_PRESETS.high.stages[1] (design start 17 / 17 / 1.5). At hop 256 a
//   17-frame time median (±50 ms) is shorter than the kick / snare decay, so
//   drums looked harmonic and went to 其他音效 (drums −3.4 dB, other −6.2 dB vs
//   baseline). β 2 keeps stationary noise and the mono riser out of Mp
//   (β 1 gave mono 额外打击乐 −3.6 dB). Dependency radius 22 + 1 (Wiener) = 23
//   frames ≤ contextFrames 24.
// - percHz 6800 as FAST_KERNEL (the baseline's 5 kHz high-pass is 0.5 near
//   6.2 kHz); 5000 gave stereo 额外打击乐 −0.2 dB vs baseline, 6800 +3.3 dB.
// - sideExp: exponent on the side-ness S in the fx weight (design: S²).
const HQ2_KERNEL = {
  sideExp: 2,
  fxHz: 1500,
  percHz: 6800,
  monoFxHz: 6000,
};

/**
 * HPSS time-median length for a clip of `len` samples (STFT n / hop).
 * medianFilter zero-pads, and a clip only has about (len + n)/hop non-silent
 * frames; when that is ≤ kTime >> 1 the harmonic time median is exactly 0
 * everywhere, so hpssMasks degenerates to a hard Mp = 1, Mr = 0 mask and the
 * residual atoms F/O (mono 效果音 / 其他音效) become exactly silent. The kernel is
 * capped at the clip's frame count (odd, ≥ 1). It depends only on the input
 * length, so it is the same for every segment (segment independence, design
 * 6.7), and only shortens the dependency radius. Clips with ≥ kTime frames
 * keep kTime unchanged.
 */
function clipTimeKernel(kTime, len, n, hop) {
  const clipFrames = Math.max(1, Math.ceil((len + n) / hop) - 1);
  const odd = clipFrames % 2 === 1 ? clipFrames : clipFrames - 1;
  return Math.max(1, Math.min(kTime, odd));
}

/**
 * High_Quality_Mode stage 2: short window percussive split of Rem_L/R
 * (design 6.5). HPSS on the Rem magnitudes gives Mp (percussive group D/T/F)
 * and Mr = 1 − Mp (residual group F/O, including weak harmonics stage 1 left
 * in Rem). Rem holds no V, so the four atoms are used without renormalisation
 * and sum to 1 per point: D + T + F + O = Rem_c. Side-ness S comes from the
 * phase-aware center mask on the Rem spectra (cross/auto spectra smoothed over
 * ±phaseSmooth frames). One Wiener refinement on D/T/F/O against Rem_c.
 * Dependency radius: HPSS time median (kTime >> 1) + Wiener 1 + phase
 * smoothing, inside contextFrames 24 (design 6.7).
 *
 * Returns stereo { D:[L,R], T:[L,R], s, O:[L,R], F?:[L,R] } with
 * s = (F_L − F_R)/2 computed in the spectrum; mono { D:[x], T:[x], s, O:[x] }
 * with s = F. F_L/F_R (raw-phase fx atom) only when wantF is set.
 */
async function hqStage2Pass(inputs, sampleRate, wantF, onProgress, segment) {
  const stereo = inputs.length > 1;
  const preset = QUALITY_PRESETS.high;
  const stage = preset.stages[1];
  const { n, kTime, kFreq, beta } = stage;
  const binHz = sampleRate / n;
  const p = HQ2_KERNEL;
  // stereo: D_L, D_R, T_L, T_R, s, O_L, O_R (+ F_L, F_R); mono: D, T, F, O
  const nOut = stereo ? (wantF ? 9 : 7) : 4;
  const kT = clipTimeKernel(kTime, inputs[0].length, n, stage.hop);

  const kernel = (specs) => {
    const sl = specs[0];
    const sr = stereo ? specs[1] : sl;
    const { frames, bins } = sl;
    const size = sl.re.length;
    const mag = new Float32Array(size);
    {
      const a = sl.re, b = sl.im, c = sr.re, d = sr.im;
      if (stereo) {
        for (let i = 0; i < size; i++) {
          mag[i] = (Math.sqrt(a[i] * a[i] + b[i] * b[i]) + Math.sqrt(c[i] * c[i] + d[i] * d[i])) / 2;
        }
      } else {
        for (let i = 0; i < size; i++) mag[i] = Math.sqrt(a[i] * a[i] + b[i] * b[i]);
      }
    }
    const { P: Mp } = hpssMasks(mag, frames, bins, { kTime: kT, kFreq, beta });
    const Mr = new Float32Array(size);
    for (let i = 0; i < size; i++) Mr[i] = Math.max(0, 1 - Mp[i]);
    let S = null;
    if (stereo) {
      // S does not depend on the sharpness exponent (only C does)
      ({ S } = centerMaskPhase(sl, sr, 1, preset.phaseSmooth));
      // partitionMasks weights by S²; S^(sideExp/2) gives S^sideExp
      if (p.sideExp !== 2) {
        const e = p.sideExp / 2;
        for (let i = 0; i < size; i++) S[i] = Math.pow(S[i], e);
      }
    }
    const m = partitionMasks({
      frames, bins, binHz, Mp, Mr, S,
      fxHz: p.fxHz, percHz: p.percHz, monoFxHz: p.monoFxHz, renormalize: false,
    });
    if (preset.wiener) wienerRefine([m.D, m.T, m.F, m.O], stereo ? [sl, sr] : [sl], frames, bins);

    const outs = Array.from({ length: nOut }, () => emptySpec(sl));
    const lre = sl.re, lim = sl.im, rre = sr.re, rim = sr.im;
    if (stereo) {
      const put = (o, mask) => {
        const aRe = outs[o].re, aIm = outs[o].im, bRe = outs[o + 1].re, bIm = outs[o + 1].im;
        for (let i = 0; i < size; i++) {
          const g = mask[i];
          aRe[i] = g * lre[i]; aIm[i] = g * lim[i];
          bRe[i] = g * rre[i]; bIm[i] = g * rim[i];
        }
      };
      put(0, m.D);
      put(2, m.T);
      put(5, m.O);
      if (wantF) put(7, m.F);
      const MF = m.F, sRe = outs[4].re, sIm = outs[4].im;
      for (let i = 0; i < size; i++) {
        const g = MF[i] * 0.5;
        sRe[i] = g * (lre[i] - rre[i]); sIm[i] = g * (lim[i] - rim[i]);
      }
    } else {
      [m.D, m.T, m.F, m.O].forEach((mask, j) => {
        const oRe = outs[j].re, oIm = outs[j].im;
        for (let i = 0; i < size; i++) { oRe[i] = mask[i] * lre[i]; oIm[i] = mask[i] * lim[i]; }
      });
    }
    return outs;
  };

  const parts = await processSegments(inputs, nOut, segmentOpts(stage, segment), kernel, onProgress);
  if (stereo) {
    return {
      D: [parts[0], parts[1]], T: [parts[2], parts[3]], s: parts[4], O: [parts[5], parts[6]],
      F: wantF ? [parts[7], parts[8]] : null,
    };
  }
  return { D: [parts[0]], T: [parts[1]], s: parts[2], O: [parts[3]], F: null };
}

/**
 * Separate decoded audio into practice stems.
 * @param {Float32Array[]} channels 1 or 2 channels (extra channels ignored)
 * @param {number} sampleRate
 * @param {{onProgress?: (p:number)=>any, onStem?: (id:string, ch:Float32Array[])=>any,
 *   onAtom?: (name:string, ch:Float32Array[])=>any}} hooks
 *   onAtom is a test hook: when given, the raw-phase fx atom is also produced
 *   and reported as onAtom('F', [F_L, F_R]) (mono: onAtom('F', [F])).
 * @param {{mode?: 'high'|'fast', levelMatch?: boolean, consumeInput?: boolean, segment?: number}} [options]
 *   mode: Quality_Mode (unknown values run as 'fast');
 *   levelMatch: raise quiet stems toward the mix level (scaleToReference);
 *   consumeInput: allow reusing the input arrays as scratch space (纯伴奏 is
 *   computed in place as X −= V). Off by default so the caller's arrays are
 *   never modified.
 *   segment (samples, optional, test hook): processing segment length per
 *   pass, rounded down to a multiple of 2·hop; the output does not depend on it
 *   (segment independence, design 6.7). Default: hop·256 per pass.
 * Every stem passes limitPeak before onStem, so its peak never exceeds 1.
 * @returns {Promise<{bpm:number, mode:'high'|'fast'}>}
 */
export async function separateChannels(channels, sampleRate, hooks = {}, options = {}) {
  const { onProgress, onStem, onAtom } = hooks;
  const { levelMatch = true, consumeInput = false, segment } = options;
  const mode = normalizeMode(options.mode ?? 'fast');
  const stereo = channels.length > 1;
  const inputs = stereo ? [channels[0], channels[1]] : [channels[0]];
  const len = inputs[0].length;

  // BPM before the outputs are allocated; the mid copy is dropped right after.
  let bpm;
  {
    const L = inputs[0];
    const R = stereo ? inputs[1] : L;
    const mid = new Float32Array(len);
    for (let i = 0; i < len; i++) mid[i] = (L[i] + R[i]) / 2;
    bpm = estimateBpm(mid, sampleRate);
  }
  const refRms = Math.max(...inputs.map(rms));

  const spectralShare = 0.85;
  const total = 8;
  let done = 0;
  const emit = async (id, chs) => {
    if (onStem) await onStem(id, limitPeak(levelMatch ? scaleToReference(chs, refRms) : chs));
    done++;
    if (onProgress) await onProgress(spectralShare + ((1 - spectralShare) * done) / total);
  };

  if (mode === 'high') {
    // Stage 1 (long window): V/B/H/Rem; emit the four harmonic-side stems,
    // then keep only Rem_L/R.
    const s1Share = 0.6;
    let s1 = await hqStage1Pass(inputs, sampleRate,
      (p) => onProgress && onProgress(p * spectralShare * s1Share), segment);
    let V = s1.V;
    s1.V = null;
    await emit('vocal', stereo ? [V, V] : [V]);
    let inst = inputs.map((x) => {
      const out = consumeInput ? x : new Float32Array(len);
      for (let i = 0; i < len; i++) out[i] = x[i] - V[i];
      return out;
    });
    V = null;
    inputs.length = 0; // drop our input references (inst may reuse them)
    await emit('inst', inst);
    inst = null;
    await emit('bass', s1.B);
    s1.B = null;
    await emit('harmony', s1.H);
    s1.H = null;
    const Rem = s1.Rem;
    s1 = null;

    // Stage 2 (short window) on Rem_L/R: D/T/F/O.
    let a = await hqStage2Pass(Rem, sampleRate, !!onAtom,
      (p) => onProgress && onProgress(spectralShare * (s1Share + (1 - s1Share) * p)), segment);
    Rem.length = 0;
    if (onAtom) await onAtom('F', stereo ? a.F : [a.s]);
    a.F = null;
    await emit('perc', a.T);
    // 鼓 = D + T, in place on D
    const D = a.D, T = a.T;
    a.D = null;
    a.T = null;
    for (let c = 0; c < D.length; c++) {
      const d = D[c], t = T[c];
      for (let i = 0; i < len; i++) d[i] += t[i];
    }
    await emit('drums', D);
    const s = a.s;
    a.s = null;
    await emit('fx', stereo ? [s, s] : [s]);
    const O = a.O;
    a = null;
    await emit('other', O);
    return { bpm, mode };
  }

  const stage = QUALITY_PRESETS.fast.stages[0];
  let atoms = await atomPartitionPass(inputs, sampleRate, stage, !!onAtom,
    (p) => onProgress && onProgress(p * spectralShare), segment);

  if (onAtom) await onAtom('F', stereo ? atoms.F : [atoms.s]);
  atoms.F = null;

  let V = atoms.V;
  atoms.V = null;
  await emit('vocal', stereo ? [V, V] : [V]);

  // 纯伴奏 = X_c − V (equals the sum of the other atoms)
  let inst = inputs.map((x) => {
    const out = consumeInput ? x : new Float32Array(len);
    for (let i = 0; i < len; i++) out[i] = x[i] - V[i];
    return out;
  });
  V = null;
  await emit('inst', inst);
  inst = null;

  await emit('bass', atoms.B);
  atoms.B = null;
  await emit('harmony', atoms.H);
  atoms.H = null;
  await emit('perc', atoms.T);

  // 鼓 = D + T, in place on D
  const D = atoms.D;
  const T = atoms.T;
  atoms.D = null;
  atoms.T = null;
  for (let c = 0; c < D.length; c++) {
    const d = D[c], t = T[c];
    for (let i = 0; i < len; i++) d[i] += t[i];
  }
  await emit('drums', D);

  // Same phase on both channels: the textbook [s, -s] side reconstruction
  // sums to silence on mono phone speakers, single earbuds and mono mode.
  const s = atoms.s;
  atoms.s = null;
  await emit('fx', stereo ? [s, s] : [s]);
  const O = atoms.O;
  atoms = null;
  await emit('other', O);

  return { bpm, mode };
}

// ---------------------------------------------------------------------------
// Browser entry: run in a module Web Worker, fall back to the main thread.
// ---------------------------------------------------------------------------

/**
 * @param {AudioBuffer} audioBuffer
 * @param {{mode?: 'high'|'fast', onProgress?: (p:number)=>void, encode: (ch:Float32Array[], sr:number)=>ArrayBuffer, signal?: AbortSignal}} opts
 * @returns {Promise<{urls: Record<string,string>, bpm:number, mode:'high'|'fast'}>}
 */
export function runSeparation(audioBuffer, opts) {
  const mode = normalizeMode(opts.mode ?? 'fast');
  const sampleRate = audioBuffer.sampleRate;
  const count = Math.min(2, audioBuffer.numberOfChannels);
  const getChannels = () => Array.from({ length: count }, (_, c) => audioBuffer.getChannelData(c).slice());
  const toUrl = (wav) => URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));

  const { signal } = opts;
  const aborted = () => new DOMException('已取消', 'AbortError');

  const mainThread = async () => {
    const urls = {};
    const yieldUi = () => new Promise((r) => setTimeout(r, 0));
    const res = await separateChannels(getChannels(), sampleRate, {
      onProgress: async (p) => {
        if (signal?.aborted) {
          for (const u of Object.values(urls)) URL.revokeObjectURL(u);
          throw aborted();
        }
        opts.onProgress?.(p);
        await yieldUi();
      },
      onStem: (id, chs) => { urls[id] = toUrl(opts.encode(chs, sampleRate)); },
    }, { mode, consumeInput: true });
    return { urls, bpm: res.bpm, mode: normalizeMode(res.mode) };
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
      else if (data.type === 'done') { finish(); resolve({ urls, bpm: data.bpm, mode: normalizeMode(data.mode ?? mode) }); }
      else if (data.type === 'error') fail(new Error(`音轨分离失败：${data.message || '未知错误'}`));
    };
    const channels = getChannels();
    worker.postMessage({ channels, sampleRate, mode }, channels.map((c) => c.buffer));
  });
}
