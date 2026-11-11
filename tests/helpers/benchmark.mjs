// Benchmark_Set synthesis, SDR and evaluation helpers for the DSP separator
// benchmark (design.md, Testing Strategy). Self-contained, zero dependencies.
//
// makeBenchmarkSet() -> [{ name, stereo, sampleRate, bpm, seed, channels, refs }]
//   channels: Float32Array[] (the mix, peak 0.9)
//   refs:     { inst, vocal, drums, bass, harmony, perc, fx, other } -> Float32Array[]
// sdr(ref, est)                 -> dB over all channels concatenated (<= 100)
// evaluate(separate, sample, o) -> { name, stereo, sdr: { id: dB }, stems? }
// averageSdr(results)           -> { id: mean dB, ..., mean }
// formatSdrTable(columns)       -> plain-text table for t.diagnostic

export const SAMPLE_RATE = 44100;
export const DURATION_SEC = 8;
export const TRIM_SEC = 0.1;
export const DERIVED_STEMS = ['inst', 'vocal', 'drums', 'bass', 'harmony', 'perc', 'fx', 'other'];

// RMS levels in dBFS before the common peak normalisation.
const LEVELS_DB = { vocal: -14, drums: -16, bass: -17, pad: -20, hat: -26, fx: -26, noise: -30 };

const SPECS = [
  { name: 'stereo-100bpm', stereo: true, seed: 0x1001, bpm: 100, key: 0, chordNotes: 3, spread: 0 },
  { name: 'stereo-118bpm', stereo: true, seed: 0x2002, bpm: 118, key: 5, chordNotes: 4, spread: 1 },
  { name: 'stereo-128bpm', stereo: true, seed: 0x3003, bpm: 128, key: 9, chordNotes: 4, spread: 2 },
  { name: 'mono-110bpm', stereo: false, seed: 0x4004, bpm: 110, key: 2, chordNotes: 3, spread: 1 },
  { name: 'mono-124bpm', stereo: false, seed: 0x5005, bpm: 124, key: 7, chordNotes: 4, spread: 0 },
];

// ---------------------------------------------------------------- utilities

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = 2 * Math.PI;
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// RBJ cookbook biquad coefficients.
function biquadCoeffs(type, f, q, sr) {
  const w = (TAU * f) / sr;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'lowpass') { b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0; }
  else if (type === 'highpass') { b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0; }
  else { b0 = alpha; b1 = 0; b2 = -alpha; } // bandpass, 0 dB peak
  const a0 = 1 + alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

function filterInPlace(x, type, f, sr, q = Math.SQRT1_2) {
  const { b0, b1, b2, a1, a2 } = biquadCoeffs(type, f, q, sr);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    x[i] = y0;
  }
  return x;
}

function whiteNoise(n, rand) {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = rand() * 2 - 1;
  return x;
}

function rmsOf(arrays) {
  let s = 0, n = 0;
  for (const a of arrays) { for (let i = 0; i < a.length; i++) s += a[i] * a[i]; n += a.length; }
  return n ? Math.sqrt(s / n) : 0;
}

function scaleToDb(arrays, db) {
  const r = rmsOf(arrays);
  const g = r > 0 ? Math.pow(10, db / 20) / r : 0;
  for (const a of arrays) for (let i = 0; i < a.length; i++) a[i] *= g;
}

// Major-key chord progression I - vi - IV - V (semitones from the key root).
const PROGRESSION = [
  { root: 0, minor: false },
  { root: 9, minor: true },
  { root: 5, minor: false },
  { root: 7, minor: false },
];
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];

function chordIntervals(chord, size) {
  const third = chord.minor ? 3 : 4;
  const base = [0, third, 7];
  if (size > 3) base.push(chord.minor ? 10 : 11);
  return base;
}

// ---------------------------------------------------------------- components

function synthVocal(n, sr, rand, key) {
  const out = new Float64Array(n);
  // Melody MIDI notes within 200-600 Hz (MIDI 56..74) on the key's scale.
  const pool = [];
  for (let m = 56; m <= 74; m++) if (MAJOR_SCALE.includes((((m - 60 - key) % 12) + 12) % 12)) pool.push(m);
  const vowels = [
    [730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240], [530, 1840, 2480], [570, 840, 2410],
  ];
  // Build the note list: { start, end, midi, vowel, amp, glide }.
  const notes = [];
  let t = 0.05 + rand() * 0.1;
  let idx = Math.floor(rand() * pool.length);
  let prevEndedLegato = false;
  while (t < n / sr) {
    const dur = 0.4 + rand() * 0.4;
    idx = Math.max(0, Math.min(pool.length - 1, idx + Math.floor(rand() * 5) - 2));
    notes.push({ start: t, end: t + dur, midi: pool[idx], vowel: vowels[Math.floor(rand() * vowels.length)], amp: 0.8 + rand() * 0.2, glide: prevEndedLegato });
    t += dur;
    if (rand() < 0.2) { t += 0.2 + rand() * 0.2; prevEndedLegato = false; } else prevEndedLegato = true;
  }
  const glide = 0.02;
  const vibDepth = 30 / 1200; // octaves
  const ampSmooth = 1 - Math.exp(-1 / (0.008 * sr));
  const fmtSmooth = 1 - Math.exp(-1 / (0.02 * sr));
  const bw = [90, 120, 160];
  const gains = [1, 0.6, 0.35];
  const phases = new Float64Array(12);
  for (let h = 0; h < 12; h++) phases[h] = rand() * TAU;
  let amp = 0;
  const fm = notes.length ? notes[0].vowel.slice() : [500, 1500, 2500];
  let ni = 0;
  let prevMidi = notes.length ? notes[0].midi : 60;
  let lastMidi = prevMidi;
  for (let i = 0; i < n; i++) {
    const time = i / sr;
    while (ni < notes.length && time >= notes[ni].end) { lastMidi = notes[ni].midi; ni++; }
    const note = ni < notes.length && time >= notes[ni].start ? notes[ni] : null;
    let target = 0, midi = lastMidi;
    if (note) {
      target = note.amp;
      midi = note.midi;
      const into = time - note.start;
      prevMidi = ni > 0 ? notes[ni - 1].midi : note.midi;
      if (note.glide && into < glide) midi = prevMidi + (note.midi - prevMidi) * (into / glide);
      for (let k = 0; k < 3; k++) fm[k] += (note.vowel[k] - fm[k]) * fmtSmooth;
    }
    amp += (target - amp) * ampSmooth;
    if (amp < 1e-6 && target === 0) continue;
    const f0 = midiHz(midi) * Math.pow(2, vibDepth * Math.sin(TAU * 5.5 * time));
    let s = 0;
    for (let h = 1; h <= 12; h++) {
      const f = f0 * h;
      phases[h - 1] += (TAU * f) / sr;
      if (f >= sr / 2) continue;
      let w = 0.02;
      for (let k = 0; k < 3; k++) { const d = (f - fm[k]) / bw[k]; w += gains[k] / (1 + d * d); }
      s += (w / h) * Math.sin(phases[h - 1]);
    }
    out[i] = amp * s;
  }
  return out;
}

function synthKickSnare(n, sr, rand, bpm) {
  const out = new Float64Array(n);
  const beat = 60 / bpm;
  const addKick = (t0, vel) => {
    const s0 = Math.round(t0 * sr);
    const len = Math.round(0.2 * sr);
    let ph = 0;
    for (let j = 0; j < len && s0 + j < n; j++) {
      const t = j / sr;
      ph += (TAU * (45 + 75 * Math.exp(-t / 0.03))) / sr;
      const env = Math.exp((-6.9 * t) / 0.15) * Math.min(1, j / (0.001 * sr));
      out[s0 + j] += vel * env * Math.sin(ph);
    }
  };
  const addSnare = (t0, vel) => {
    const s0 = Math.round(t0 * sr);
    const len = Math.round(0.16 * sr);
    const noise = whiteNoise(len, rand);
    filterInPlace(noise, 'highpass', 200, sr);
    filterInPlace(noise, 'lowpass', 4000, sr);
    for (let j = 0; j < len && s0 + j < n; j++) {
      const t = j / sr;
      const env = Math.exp((-6.9 * t) / 0.12) * Math.min(1, j / (0.001 * sr));
      out[s0 + j] += vel * env * (0.45 * Math.sin(TAU * 180 * t) + 1.6 * noise[j]);
    }
  };
  const beats = Math.ceil((n / sr) / beat);
  for (let b = 0; b < beats; b++) {
    const t = b * beat;
    const pos = b % 4;
    if (pos === 0 || pos === 2) addKick(t, 0.9 + rand() * 0.1);
    else addSnare(t, 0.85 + rand() * 0.15);
    if (pos === 2 && rand() < 0.5) addKick(t + beat / 2, 0.7);
  }
  return out;
}

function synthHats(n, sr, rand, bpm) {
  const out = new Float64Array(n);
  const step = 60 / bpm / 2;
  for (let k = 0; k * step < n / sr; k++) {
    const s0 = Math.round(k * step * sr);
    const decay = 0.03 + rand() * 0.03;
    const len = Math.round(decay * 1.5 * sr);
    const noise = whiteNoise(len, rand);
    filterInPlace(noise, 'highpass', 7000, sr);
    filterInPlace(noise, 'highpass', 7000, sr);
    const vel = k % 2 === 0 ? 1 : 0.6 + rand() * 0.2;
    for (let j = 0; j < len && s0 + j < n; j++) {
      out[s0 + j] += vel * Math.exp((-6.9 * j) / sr / decay) * noise[j];
    }
  }
  return out;
}

function synthBass(n, sr, rand, bpm, key) {
  const out = new Float64Array(n);
  const beat = 60 / bpm;
  const harm = [1, 0.5, 0.33, 0.25];
  let b = 0;
  while (b * beat < n / sr) {
    const beats = rand() < 0.5 ? 1 : 2;
    const chord = PROGRESSION[Math.floor(b / 4) % PROGRESSION.length];
    let midi = 28 + ((((key + chord.root + (rand() < 0.3 ? 7 : 0)) % 12) + 12) % 12); // 28..39
    if (rand() < 0.3 && midi + 12 <= 45) midi += 12;
    const f = midiHz(midi);
    const s0 = Math.round(b * beat * sr);
    const len = Math.round(beats * beat * sr);
    const att = 0.005 * sr, rel = 0.03 * sr;
    for (let j = 0; j < len && s0 + j < n; j++) {
      const env = Math.min(1, j / att, (len - j) / rel);
      let s = 0;
      for (let h = 0; h < 4; h++) s += harm[h] * Math.sin((TAU * f * (h + 1) * j) / sr);
      out[s0 + j] += env * s;
    }
    b += beats;
  }
  return out;
}

// Returns [L, R]: left detuned -3 cents, right +3 cents, different start phases.
function synthPad(n, sr, rand, bpm, key, size, spread) {
  const L = new Float64Array(n);
  const R = new Float64Array(n);
  const bar = (4 * 60) / bpm;
  const detune = Math.pow(2, 3 / 1200);
  for (let k = 0; k * bar < n / sr; k++) {
    const chord = PROGRESSION[k % PROGRESSION.length];
    const ints = chordIntervals(chord, size);
    const base = 55 + ((((key + chord.root) % 12) + 12) % 12) - (spread > 1 ? 3 : 0);
    const mids = ints.map((iv, i) => {
      let m = base + iv + (spread > 0 && i % 2 === 1 ? 12 * Math.min(spread, 1) : 0) + (spread > 1 && i === ints.length - 1 ? 12 : 0);
      while (midiHz(m) < 150) m += 12;
      while (midiHz(m) > 1000) m -= 12;
      return m;
    });
    const s0 = Math.round(k * bar * sr);
    const len = Math.round(bar * sr);
    const att = 0.2 * sr, rel = 0.05 * sr;
    for (const m of mids) {
      const f = midiHz(m);
      const fl = f / detune, fr = f * detune;
      const pl = [], pr = [];
      for (let h = 0; h < 6; h++) { pl.push(rand() * TAU); pr.push(rand() * TAU); }
      for (let h = 1; h <= 6; h++) {
        const a = 1 / h;
        const wl = (TAU * fl * h) / sr, wr = (TAU * fr * h) / sr;
        for (let j = 0; j < len && s0 + j < n; j++) {
          const env = a * Math.min(1, j / att, (len - j) / rel);
          L[s0 + j] += env * Math.sin(wl * j + pl[h - 1]);
          R[s0 + j] += env * Math.sin(wr * j + pr[h - 1]);
        }
      }
    }
  }
  return [L, R];
}

// Rising band-pass noise sweep from f0 to f1, one every 2 seconds.
function synthRisers(n, sr, rand, f0, f1) {
  const out = new Float64Array(n);
  const dur = 1.2;
  for (let start = 0.4; start < n / sr; start += 2) {
    const s0 = Math.round(start * sr);
    const len = Math.round(dur * sr);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, c = null;
    for (let j = 0; j < len && s0 + j < n; j++) {
      const u = j / len;
      if (j % 16 === 0) c = biquadCoeffs('bandpass', f0 * Math.pow(f1 / f0, u), 3, sr);
      const x0 = rand() * 2 - 1;
      const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      const env = Math.pow(u, 1.5) * Math.min(1, (len - j) / (0.02 * sr));
      out[s0 + j] += env * y0;
    }
  }
  return out;
}

function synthNoise(n, sr, rand) {
  const x = whiteNoise(n, rand);
  filterInPlace(x, 'highpass', 200, sr);
  filterInPlace(x, 'highpass', 200, sr);
  filterInPlace(x, 'lowpass', 1200, sr);
  filterInPlace(x, 'lowpass', 1200, sr);
  return x;
}

// ---------------------------------------------------------------- Benchmark_Set

function makeSample(spec, sr, seconds) {
  const n = Math.round(seconds * sr);
  const rand = mulberry32(spec.seed);
  const vocal = synthVocal(n, sr, rand, spec.key);
  const ks = synthKickSnare(n, sr, rand, spec.bpm);
  const hat = synthHats(n, sr, rand, spec.bpm);
  const bass = synthBass(n, sr, rand, spec.bpm, spec.key);
  const pad = synthPad(n, sr, rand, spec.bpm, spec.key, spec.chordNotes, spec.spread);
  const fx = spec.stereo ? synthRisers(n, sr, rand, 2000, 10000) : synthRisers(n, sr, rand, 7000, 14000);
  const noise = synthNoise(n, sr, rand);

  const padChs = spec.stereo ? pad : [pad[0]];
  scaleToDb([vocal], LEVELS_DB.vocal);
  scaleToDb([ks], LEVELS_DB.drums);
  scaleToDb([hat], LEVELS_DB.hat);
  scaleToDb([bass], LEVELS_DB.bass);
  scaleToDb(padChs, LEVELS_DB.pad);
  scaleToDb([fx], LEVELS_DB.fx);
  scaleToDb([noise], LEVELS_DB.noise);

  const nch = spec.stereo ? 2 : 1;
  const hatGain = (c) => (c === 1 ? 0.8 : 1);
  const fxSign = (c) => (c === 1 ? -1 : 1);
  const mix = [];
  for (let c = 0; c < nch; c++) {
    const m = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      m[i] = vocal[i] + ks[i] + hatGain(c) * hat[i] + bass[i] + padChs[c][i] + fxSign(c) * fx[i] + noise[i];
    }
    mix.push(m);
  }
  let peak = 0;
  for (const m of mix) for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(m[i]));
  const g = peak > 0 ? 0.9 / peak : 1;

  const build = (fn) => {
    const chs = [];
    for (let c = 0; c < nch; c++) {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = g * fn(c, i);
      chs.push(a);
    }
    return chs;
  };
  const channels = build((c, i) => mix[c][i]);
  const refs = {
    vocal: build((c, i) => vocal[i]),
    drums: build((c, i) => ks[i] + hatGain(c) * hat[i]),
    bass: build((c, i) => bass[i]),
    harmony: build((c, i) => padChs[c][i]),
    perc: build((c, i) => hatGain(c) * hat[i]),
    fx: build((c, i) => fx[i]), // in phase on both channels: [e, e] / [e]
    other: build((c, i) => noise[i]),
  };
  refs.inst = channels.map((ch, c) => {
    const a = new Float32Array(n);
    const v = refs.vocal[c];
    for (let i = 0; i < n; i++) a[i] = ch[i] - v[i];
    return a;
  });
  return {
    name: spec.name,
    stereo: spec.stereo,
    seed: spec.seed,
    bpm: spec.bpm,
    sampleRate: sr,
    channels,
    refs,
  };
}

/**
 * Builds the fixed Benchmark_Set: 3 stereo (100/118/128 BPM) and 2 mono
 * samples, 44.1 kHz, 8 s each. Deterministic for given options.
 * @param {{ sampleRate?: number, seconds?: number }} [opts]
 */
export function makeBenchmarkSet({ sampleRate = SAMPLE_RATE, seconds = DURATION_SEC } = {}) {
  return SPECS.map((spec) => makeSample(spec, sampleRate, seconds));
}

// ---------------------------------------------------------------- SDR

/**
 * SDR over all channels concatenated. Missing estimate channels count as
 * silence. Denominator floor 1e-12, result capped at 100 dB.
 * @param {ArrayLike<number>[]} refChannels
 * @param {ArrayLike<number>[]} estChannels
 * @param {number} [start] first sample index included
 * @param {number} [end] one past the last sample index included
 */
export function sdr(refChannels, estChannels, start = 0, end = Infinity) {
  let num = 0, den = 0;
  for (let c = 0; c < refChannels.length; c++) {
    const r = refChannels[c];
    const e = estChannels[c];
    const stop = Math.min(end, r.length);
    for (let i = Math.max(0, start); i < stop; i++) {
      const ev = e && i < e.length ? e[i] : 0;
      num += r[i] * r[i];
      const d = r[i] - ev;
      den += d * d;
    }
  }
  return Math.min(100, 10 * Math.log10(num / Math.max(den, 1e-12)));
}

/**
 * Runs a separator on one Benchmark_Set sample and scores the 8 Derived_Stems.
 * @param {(channels: Float32Array[], sampleRate: number, hooks: object, opts: object) => Promise<any>} separate
 * @param {ReturnType<typeof makeSample>} sample
 * @param {{ mode?: string, levelMatch?: boolean, keepStems?: boolean, [k: string]: any }} [opts]
 *   Extra keys (e.g. `mode`) are passed through to the separator.
 */
export async function evaluate(separate, sample, { levelMatch = false, keepStems = false, ...extra } = {}) {
  const stems = {};
  const input = sample.channels.map((ch) => Float32Array.from(ch));
  const hooks = {
    onStem: (id, chs) => { stems[id] = chs.map((ch) => Float32Array.from(ch)); },
  };
  const opts = { consumeInput: false, ...extra, levelMatch };
  for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
  await separate(input, sample.sampleRate, hooks, opts);
  const n = sample.channels[0].length;
  const trim = Math.round(TRIM_SEC * sample.sampleRate);
  const scores = {};
  for (const id of DERIVED_STEMS) {
    if (!stems[id]) throw new Error(`separator did not emit stem "${id}" for ${sample.name}`);
    scores[id] = sdr(sample.refs[id], stems[id], trim, n - trim);
  }
  const result = { name: sample.name, stereo: sample.stereo, sdr: scores };
  if (keepStems) result.stems = stems;
  return result;
}

/** Per-stem mean SDR over evaluate() results, plus `mean` of the 8 means. */
export function averageSdr(results) {
  const out = {};
  let total = 0;
  for (const id of DERIVED_STEMS) {
    let s = 0;
    for (const r of results) s += r.sdr[id];
    out[id] = results.length ? s / results.length : NaN;
    total += out[id];
  }
  out.mean = total / DERIVED_STEMS.length;
  return out;
}

/**
 * Formats per-stem SDR columns as a text table.
 * @param {Record<string, Record<string, number>>} columns e.g. { baseline: averageSdr(...), fast: ... }
 */
export function formatSdrTable(columns) {
  const names = Object.keys(columns);
  const rows = [...DERIVED_STEMS, 'mean'];
  const w0 = Math.max(5, ...rows.map((r) => r.length));
  const widths = names.map((nm) => Math.max(8, nm.length));
  const pad = (s, w) => String(s).padStart(w);
  const lines = [['stem'.padEnd(w0), ...names.map((nm, i) => pad(nm, widths[i]))].join('  ')];
  for (const r of rows) {
    const cells = names.map((nm, i) => {
      const col = columns[nm];
      const v = r === 'mean' && col.mean === undefined
        ? DERIVED_STEMS.reduce((s, id) => s + col[id], 0) / DERIVED_STEMS.length
        : col[r];
      return pad(Number.isFinite(v) ? v.toFixed(2) : String(v), widths[i]);
    });
    lines.push([r.padEnd(w0), ...cells].join('  '));
  }
  return lines.join('\n');
}
