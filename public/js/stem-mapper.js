// Stem_Mapper: turns raw Demucs outputs (4 or 6 stems) into the app's 8
// Derived_Stems. Extra percussion, fx and other are derived with DSP from
// dsp.js so the server only has to serve Demucs' own WAV files.
//
// Outputs are loaded and emitted one at a time in a fixed order (design 3) so
// only the inst / harmony accumulators, the current output and a filter
// temporary are held at once.
//
// Every emitted stem has exactly 2 channels, the same shape as DSP_Separator's
// stereo output. Demucs always writes stereo; if `load` ever returns a single
// channel it is duplicated to [x, x]. For a mono source (isMonoPair) fx and
// other are still emitted as 2 identical channels.
//
// Browser-safe ES module: no DOM or Node APIs at import time.

import { highpass, estimateBpm, limitPeak } from './dsp.js';

const COMMON_SOURCES = {
  vocal: 'Demucs vocals',
  drums: 'Demucs drums',
  bass: 'Demucs bass',
  perc: 'Demucs drums 经 5 kHz 高通（DSP）',
  fx: 'Demucs other 中 1.5 kHz 以上的立体声两侧成分，左右同相（DSP；单声道取 6 kHz 以上）',
  other: 'Demucs other 减去效果音后的残余（DSP）',
};

/** Per model: which Demucs outputs or DSP step produced each Derived_Stem. */
export const STEM_SOURCES = {
  htdemucs: {
    vocal: COMMON_SOURCES.vocal,
    inst: 'Demucs drums + bass + other 相加',
    drums: COMMON_SOURCES.drums,
    bass: COMMON_SOURCES.bass,
    harmony: 'Demucs other',
    perc: COMMON_SOURCES.perc,
    fx: COMMON_SOURCES.fx,
    other: COMMON_SOURCES.other,
  },
  htdemucs_6s: {
    vocal: COMMON_SOURCES.vocal,
    inst: 'Demucs drums + bass + other + guitar + piano 相加',
    drums: COMMON_SOURCES.drums,
    bass: COMMON_SOURCES.bass,
    harmony: 'Demucs guitar + piano + other',
    perc: COMMON_SOURCES.perc,
    fx: COMMON_SOURCES.fx,
    other: COMMON_SOURCES.other,
  },
};

/** 4th-order zero-phase highpass, same as the existing DSP_Separator usage. */
function hp(x, f, sr) {
  return highpass(highpass(x, f, sr), f, sr);
}

/**
 * A pair counts as a mono source when the largest |L − R| is at most 1e-4 of
 * the larger channel peak (Demucs always writes stereo, even for mono input).
 * A single channel, or two silent channels, is mono.
 */
export function isMonoPair(channels) {
  const [L, R] = channels;
  if (!R || L === R) return true;
  let peak = 0, diff = 0;
  const n = Math.min(L.length, R.length);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(L[i]), b = Math.abs(R[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
    const d = Math.abs(L[i] - R[i]);
    if (d > diff) diff = d;
  }
  return diff <= peak * 1e-4;
}

function toPair(channels) {
  if (!channels || !channels.length) throw new Error('Demucs 输出没有声道');
  return channels.length === 1 ? [channels[0], channels[0]] : [channels[0], channels[1]];
}

function copy(x) {
  return new Float32Array(x);
}

function addInto(acc, x) {
  for (let i = 0; i < acc.length; i++) acc[i] += x[i];
}

/**
 * Load Demucs outputs in a fixed order and emit each Derived_Stem as soon as
 * it is known.
 *
 * @param {object} p
 * @param {'htdemucs'|'htdemucs_6s'} p.model
 * @param {(name:string) => Promise<{channels: Float32Array[], sampleRate: number}>} p.load
 * @param {(id:string, channels: Float32Array[]) => (Promise<any>|any)} p.emit
 * @returns {Promise<{bpm:number, sampleRate:number, mono:boolean, duration:number}>}
 */
export async function mapDemucsStems({ model, load, emit }) {
  if (!STEM_SOURCES[model]) throw new Error(`未知的 Demucs 模型：${model}`);
  const sixStem = model === 'htdemucs_6s';
  let sampleRate = 0;
  let length = 0;

  const get = async (name) => {
    const res = await load(name);
    const chs = toPair(res && res.channels);
    if (!sampleRate) {
      sampleRate = res.sampleRate;
      length = chs[0].length;
    } else if (res.sampleRate !== sampleRate) {
      throw new Error(`Demucs 输出 ${name} 的采样率与其他输出不一致`);
    }
    if (chs[0].length !== length || chs[1].length !== length) {
      throw new Error(`Demucs 输出 ${name} 的长度与其他输出不一致`);
    }
    return chs;
  };
  const send = (id, chs) => emit(id, limitPeak(chs));

  // 1. vocals
  let vocals = await get('vocals');
  await send('vocal', vocals);
  vocals = null;

  // 2. drums -> drums, perc, inst accumulator, BPM
  let drums = await get('drums');
  const mid = new Float32Array(length);
  for (let i = 0; i < length; i++) mid[i] = (drums[0][i] + drums[1][i]) / 2;
  const bpm = estimateBpm(mid, sampleRate);
  const inst = [copy(drums[0]), copy(drums[1])];
  await send('drums', drums);
  await send('perc', [hp(drums[0], 5000, sampleRate), hp(drums[1], 5000, sampleRate)]);
  drums = null;

  // 3. bass
  let bass = await get('bass');
  addInto(inst[0], bass[0]);
  addInto(inst[1], bass[1]);
  await send('bass', bass);
  bass = null;

  // 4. (6s) guitar, piano -> inst and harmony accumulators
  let harmony = null;
  if (sixStem) {
    for (const name of ['guitar', 'piano']) {
      const chs = await get(name);
      addInto(inst[0], chs[0]);
      addInto(inst[1], chs[1]);
      if (!harmony) harmony = [copy(chs[0]), copy(chs[1])];
      else { addInto(harmony[0], chs[0]); addInto(harmony[1], chs[1]); }
    }
  }

  // 5. other -> inst, harmony
  const other = await get('other');
  addInto(inst[0], other[0]);
  addInto(inst[1], other[1]);
  await send('inst', inst);
  if (harmony) {
    addInto(harmony[0], other[0]);
    addInto(harmony[1], other[1]);
    await send('harmony', harmony);
  } else {
    await send('harmony', other);
  }
  harmony = null;

  // 6. fx and other' from other, keeping other' + original-phase fx = other.
  const [oL, oR] = other;
  const mono = isMonoPair(other);
  let s;
  const restL = new Float32Array(length);
  const restR = new Float32Array(length);
  if (mono) {
    s = hp(oL, 6000, sampleRate);
    for (let i = 0; i < length; i++) { restL[i] = oL[i] - s[i]; restR[i] = oR[i] - s[i]; }
  } else {
    const side = new Float32Array(length);
    for (let i = 0; i < length; i++) side[i] = (oL[i] - oR[i]) / 2;
    s = hp(side, 1500, sampleRate);
    // The side part is +s on the left and −s on the right.
    for (let i = 0; i < length; i++) { restL[i] = oL[i] - s[i]; restR[i] = oR[i] + s[i]; }
  }

  // 7. emit fx (in phase on both channels) and other'
  await send('fx', [s, s]);
  await send('other', [restL, restR]);

  return { bpm, sampleRate, mono, duration: sampleRate ? length / sampleRate : 0 };
}
