import { SyncPlayer, SPEEDS } from './player.js';
import { runSeparation, separationLimitMessage, STEMS, STEM_NOTES, QUALITY_LABELS, stemNotes } from './separator.js';
import { encodeWav } from './wav.js';
import { evictStemCaches, waitForDuration } from './library.js';
import {
  sanitizeDemucsModel, fetchDemucsStatus, DEFAULT_DEMUCS_MODEL,
  runDemucsSeparation, remoteProgressText, separateWithFallback,
} from './remote-separator.js';
import {
  fileNameFor, exportButtonState, fetchExportStatus, exportProgressText, UNSUPPORTED_TEXT,
  ExportError, readStemBlob, triggerDownload, runServerMux, canBrowserRecord,
  runBrowserRecording, exportVideoWithFallback, visFileLabel,
} from './export-client.js';
import { canBrowserVisRecord, createVisCompositor } from './vis-record.js';
import { encodeVisPayload, shiftBeat } from './vis-data.js';
import { createLiveVisualizer, readVisSettings } from './visualizer.js';
import { computeVisData } from './vis-compute.js';
import {
  lanesAt, stageAt, laneLayout, laneLabelSpecs, laneHeaderHeight, LANE_BACKGROUND, ROW_NAMES, ROW_COLORS,
} from './vis-lanes.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const els = {
  views: $$('.view'),
  tabs: $$('.tab'),
  fileInput: $('#fileInput'),
  dropzone: $('#dropzone'),
  mediaCard: $('#mediaCard'),
  video: $('#video'),
  masterAudio: $('#masterAudio'),
  audioArt: $('#audioArt'),
  audioName: $('#audioName'),
  stageTap: $('#stageTap'),
  progress: $('#progress'),
  progressFill: $('#progressFill'),
  progressThumb: $('#progressThumb'),
  timeTop: $('#timeTop'),
  timeBottom: $('#timeBottom'),
  ctlPlay: $('#ctlPlay'),
  speedBtn: $('#speedBtn'),
  loopBtn: $('#loopBtn'),
  stemStatus: $('#stemStatus'),
  cancelSeparation: $('#cancelSeparation'),
  stemButtons: $$('.stem-btn'),
  playBtn: $('#playBtn'),
  uploadBtn: $('#uploadBtn'),
  analysisLink: $('#analysisLink'),
  sheet: $('#analysisSheet'),
  sheetBackdrop: $('#sheetBackdrop'),
  sheetBody: $('#sheetBody'),
  sheetClose: $('#sheetClose'),
  libraryList: $('#libraryList'),
  libraryEmpty: $('#libraryEmpty'),
  defaultSpeed: $('#defaultSpeed'),
  defaultLoop: $('#defaultLoop'),
  demucsModel: $('#demucsModel'),
  demucsHint: $('#demucsHint'),
  exportBtn: $('#exportBtn'),
  exportHint: $('#exportHint'),
  exportStatus: $('#exportStatus'),
  cancelExport: $('#cancelExport'),
  exportWavFallback: $('#exportWavFallback'),
  exportSheet: $('#exportSheet'),
  exportBackdrop: $('#exportBackdrop'),
  exportOptions: $$('[data-export]'),
  visCanvas: $('#visCanvas'),
  visToggle: $('#visToggle'),
  visHint: $('#visHint'),
  beatShift: $('#beatShift'),
  laneStrip: $('#laneStrip'),
  laneCanvas: $('#laneCanvas'),
  laneLabels: $('#laneLabels'),
};

const state = {
  entries: [], // { id, file, name, kind, duration }
  current: null,
  selected: 'original',
  stemsReady: false,
  separating: false,
  progress: 0,
  error: '',
  analysis: null, // { duration, sampleRate, channels, bpm, engine, model?, sources?, qualityMode? }
  progressText: '', // when set, shown in the progress area instead of the percentage
  notice: '', // non-error message (fallback reason, cancelled)
  abort: null,
  nextId: 1,
  demucs: null, // latest fetchDemucsStatus result (null = unknown / unreachable)
  // Running export: { mode: 'wav' | 'server' | 'browser', abort, text, target, settled }.
  // `target` is the Export_Stem recorded when 导出 was clicked (2.6).
  exporting: null,
  exportNotice: '', // failure reason, fallback notice, 已取消导出
  exportUnsupported: false, // show UNSUPPORTED_TEXT and the WAV button (5.5)
  // Vis_Data of the current file: 'idle' | 'computing' | 'ready' | 'failed'.
  // `abort` stops a running computeVisData (2.3).
  vis: { status: 'idle', abort: null },
};

/** True while Browser_Recording drives the Player: controls are locked (12.6). */
const exportLocked = () => !!(state.exporting && state.exporting.mode === 'browser');

// ---------------------------------------------------------------------------
// Settings (stored locally)
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'cengjian.settings';
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      speed: SPEEDS.includes(s && s.speed) ? s.speed : 1,
      loop: !!(s && s.loop),
      demucsModel: sanitizeDemucsModel(s && s.demucsModel),
      ...readVisSettings(s), // visVideo / visAudio (6.6, 6.8)
    };
  } catch {
    return { speed: 1, loop: false, demucsModel: DEFAULT_DEMUCS_MODEL, ...readVisSettings(null) };
  }
}
const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}
els.defaultSpeed.value = String(settings.speed);
els.defaultLoop.checked = settings.loop;
els.defaultSpeed.addEventListener('change', () => {
  settings.speed = Number(els.defaultSpeed.value);
  saveSettings();
});
els.defaultLoop.addEventListener('change', () => {
  settings.loop = els.defaultLoop.checked;
  saveSettings();
});
if (els.demucsModel) {
  els.demucsModel.value = settings.demucsModel;
  els.demucsModel.addEventListener('change', () => {
    // A running separation keeps its model; the next openEntry reads this value.
    settings.demucsModel = sanitizeDemucsModel(els.demucsModel.value);
    els.demucsModel.value = settings.demucsModel;
    saveSettings();
  });
}

/** Shows the "no Demucs" hint unless the last status check said it is available. */
function renderDemucsHint() {
  if (!els.demucsHint) return;
  els.demucsHint.hidden = !!(state.demucs && state.demucs.available);
}
// The hint starts hidden in the HTML and is revealed once the check answers.
fetchDemucsStatus().then((status) => {
  state.demucs = status;
  renderDemucsHint();
});

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

let scrubbing = null; // ratio while dragging the progress bar
// Live_Visualizers, created right after the Player (whose setRate / setLoop already call render):
// `visualizer` draws the audio-only cover replacement, `laneVisualizer` the video Lane_Strip.
let visualizer = null;
let laneVisualizer = null;
const invalidateVis = () => {
  if (visualizer) visualizer.invalidate();
  if (laneVisualizer) laneVisualizer.invalidate();
};

const player = new SyncPlayer({ video: els.video, audio: els.masterAudio, onUpdate: render });
player.setRate(settings.speed);
player.setLoop(settings.loop);

// ---------------------------------------------------------------------------
// Visualizer (stem-visualizer)
// ---------------------------------------------------------------------------

/** Saved switch for the file type: on by default for both (stem-lanes 6.1, 6.2). */
const visEnabledFor = (kind) => (kind === 'video' ? settings.visVideo : settings.visAudio);

/** The current file's Vis_Data when it is ready, else null. */
function currentVisData() {
  const entry = state.current;
  if (!entry || state.vis.status !== 'ready' || !entry.cache || !entry.cache.vis) return null;
  return entry.cache.vis;
}

/** Cover_Canvas shown: audio-only file, switch on, Vis_Data ready (stem-lanes 1.1, 1.4). */
const coverOn = () => !!currentVisData() && state.current.kind === 'audio' && !!settings.visAudio;

/**
 * Lane_Strip shown: video file, switch on, Vis_Data computing or ready. While
 * computing it only holds its place (empty #0b0d14 strip) so the controls do
 * not jump when the data arrives (6.3–6.5).
 */
const laneOn = () => !!state.current && state.current.kind === 'video' && !!settings.visVideo
  && (state.vis.status === 'computing' || state.vis.status === 'ready');

const reducedMotionQuery = typeof window.matchMedia === 'function' ? (q) => window.matchMedia(q) : undefined;

visualizer = createLiveVisualizer({
  canvas: els.visCanvas,
  sceneAt: stageAt, // the same flowing timeline as the Lane_Strip, full size, over a dim ambient scene
  getTime: () => player.currentTime,
  isPlaying: () => !!state.current && !player.paused,
  getSelected: () => state.selected,
  getVisData: currentVisData,
  isEnabled: coverOn,
  isTransparent: () => false, // only the opaque audio-only cover replacement remains (10.3)
  matchMedia: reducedMotionQuery,
});

laneVisualizer = createLiveVisualizer({
  canvas: els.laneCanvas,
  sceneAt: lanesAt,
  getTime: () => player.currentTime,
  isPlaying: () => !!state.current && !player.paused,
  getSelected: () => state.selected,
  getVisData: currentVisData, // null while computing: nothing drawn, CSS background shows (6.4)
  isEnabled: laneOn,
  isTransparent: () => false,
  background: LANE_BACKGROUND,
  matchMedia: reducedMotionQuery,
});

/** Lane_Label spans of #laneLabels, reused per Stem id (2.4, 2.5). */
const laneLabelEls = new Map();

/**
 * Moves / hides the Lane_Labels to match the current Lane_Layout. Called when
 * the layout can change: renderVis (Vis_Data, switch), selectStem, resize.
 */
function renderLaneLabels() {
  const box = els.laneLabels;
  if (!box) return;
  const data = currentVisData();
  if (!els.laneStrip || els.laneStrip.hidden || !data) {
    if (laneLabelEls.size) {
      box.textContent = '';
      laneLabelEls.clear();
    }
    return;
  }
  const height = Number(els.laneStrip.clientHeight) || 0;
  const header = laneHeaderHeight(data, Number(els.laneStrip.clientWidth) || 0, height);
  const specs = laneLabelSpecs(laneLayout(data, state.selected, height, header));
  const ids = new Set(specs.map((s) => s.id));
  for (const [id, span] of laneLabelEls) {
    if (!ids.has(id)) {
      span.remove();
      laneLabelEls.delete(id);
    }
  }
  for (const spec of specs) {
    let span = laneLabelEls.get(spec.id);
    if (!span) {
      span = document.createElement('span');
      span.className = 'lane-label';
      span.textContent = ROW_NAMES[spec.id] || spec.id;
      const c = ROW_COLORS[spec.id];
      if (c) span.style.color = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
      box.appendChild(span);
      laneLabelEls.set(spec.id, span);
    }
    span.style.top = `${spec.top}px`;
    span.hidden = !spec.visible;
  }
}

/**
 * Worker for computeVisData. A module worker that never says 'ready' (load
 * failure the browser does not report, or no module-worker support) counts as
 * a failed start after VIS_READY_TIMEOUT_MS, so the analysis falls back to the
 * main thread instead of waiting forever (1.9).
 */
const VIS_READY_TIMEOUT_MS = 4000;
function createVisWorker() {
  if (typeof Worker === 'undefined') throw new Error('Worker unsupported');
  const worker = new Worker(new URL('./vis-analysis.worker.js', import.meta.url), { type: 'module' });
  const proxy = {
    onmessage: null,
    onerror: null,
    postMessage: (...args) => worker.postMessage(...args),
    terminate: () => { clearTimeout(timer); try { worker.terminate(); } catch { /* ignore */ } },
  };
  let started = false;
  const timer = setTimeout(() => {
    if (!started && proxy.onerror) proxy.onerror({ preventDefault() {} });
  }, VIS_READY_TIMEOUT_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  worker.onmessage = (e) => {
    if (e && e.data && e.data.type === 'ready') { started = true; clearTimeout(timer); }
    if (proxy.onmessage) proxy.onmessage(e);
  };
  worker.onerror = (e) => {
    clearTimeout(timer);
    if (proxy.onerror) proxy.onerror(e);
  };
  return proxy;
}

/** Stops a running Vis_Data computation and drops its partial result (2.3). */
function stopVisCompute() {
  if (state.vis.abort) state.vis.abort.abort();
  state.vis = { status: 'idle', abort: null };
}

/**
 * Computes Vis_Data from the cached stem WAVs in the background (1.1, 1.2).
 * The result is only kept while `entry` is still the current file and still
 * has its cache (2.1); a failure only affects the visualizer (2.6).
 */
function startVisCompute(entry) {
  stopVisCompute();
  if (!entry.cache || !entry.cache.urls) return;
  const abort = new AbortController();
  state.vis = { status: 'computing', abort };
  renderVis();
  const cache = entry.cache;
  computeVisData(cache.urls, { signal: abort.signal, createWorker: createVisWorker }).then((data) => {
    if (state.vis.abort !== abort || abort.signal.aborted) return;
    if (state.current === entry && entry.cache && entry.cache === cache) {
      entry.cache.vis = data;
      state.vis = { status: 'ready', abort: null };
    } else {
      state.vis = { status: 'idle', abort: null };
    }
    renderVis();
  }, (err) => {
    if (state.vis.abort !== abort) return;
    if ((err && err.name === 'AbortError') || abort.signal.aborted) return;
    console.error(err);
    state.vis = { status: 'failed', abort: null };
    renderVis();
  });
}

/** Cover_Canvas, Lane_Strip, vis-on class, switch state and the 准备中 / 失败 hint (stem-lanes 1, 6). */
function renderVis() {
  const entry = state.current;
  const { status } = state.vis;
  const cover = coverOn();
  if (els.visCanvas) els.visCanvas.hidden = !cover;
  if (els.laneStrip) els.laneStrip.hidden = !laneOn();
  els.mediaCard.classList.toggle('vis-on', cover); // the audio-only CSS depends on it
  if (els.visToggle) {
    els.visToggle.disabled = !entry || status !== 'ready' || !currentVisData();
    els.visToggle.setAttribute('aria-pressed', String(!!entry && !!visEnabledFor(entry.kind)));
  }
  if (els.beatShift) {
    // Only with a beat grid on screen: the numbering can be one or two beats off (e.g. a kick on every beat).
    const data = currentVisData();
    els.beatShift.hidden = !(entry && data && data.beat && visEnabledFor(entry.kind));
  }
  if (els.visHint) {
    const hint = !entry ? '' : status === 'computing' ? '可视化准备中…' : status === 'failed' ? '可视化数据生成失败' : '';
    els.visHint.textContent = hint;
    els.visHint.hidden = !hint;
  }
  invalidateVis();
  renderLaneLabels();
}

/** Vis_Toggle: flips the switch of the current file type and saves it (6.7). */
function toggleVis() {
  const entry = state.current;
  if (!entry || !currentVisData()) return;
  if (entry.kind === 'video') settings.visVideo = !settings.visVideo;
  else settings.visAudio = !settings.visAudio;
  saveSettings();
  renderVis();
}
if (els.visToggle) els.visToggle.addEventListener('click', toggleVis);

/** 第 1 拍 →: moves the bar start one beat later for this file (kept with its Vis_Data, also used by exports). */
function shiftBeatOne() {
  const entry = state.current;
  const data = currentVisData();
  if (!entry || !entry.cache || !data || !data.beat) return;
  entry.cache.vis = shiftBeat(data, 1);
  invalidateVis();
}
if (els.beatShift) els.beatShift.addEventListener('click', shiftBeatOne);
window.addEventListener('resize', () => {
  invalidateVis();
  renderLaneLabels(); // the strip height follows the card width (2.5)
});

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function render() {
  const loaded = !!state.current;
  const d = player.duration;
  // Files that skip decoding (too large, undecodable) still get a duration in 音乐台.
  if (loaded && !state.current.duration && d) {
    state.current.duration = d;
    renderLibrary();
  }
  const t = scrubbing != null ? scrubbing * d : player.currentTime;
  const ratio = d ? Math.min(1, t / d) : 0;
  const pct = `${(ratio * 100).toFixed(2)}%`;
  els.progressFill.style.width = pct;
  els.progressThumb.style.left = pct;
  els.progress.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  const time = `${formatTime(t)} / ${formatTime(d)}`;
  if (els.timeTop.textContent !== time) {
    els.timeTop.textContent = time;
    els.timeBottom.textContent = time;
  }
  const playing = loaded && !player.paused;
  els.playBtn.classList.toggle('is-playing', playing);
  els.ctlPlay.classList.toggle('is-playing', playing);
  els.ctlPlay.setAttribute('aria-label', playing ? '暂停' : '播放');
  els.mediaCard.classList.toggle('is-playing', playing);
  const locked = exportLocked();
  els.playBtn.disabled = !loaded || locked;
  els.ctlPlay.disabled = locked;
  els.speedBtn.disabled = locked;
  els.loopBtn.disabled = locked;
  if (locked) els.progress.setAttribute('aria-disabled', 'true');
  else els.progress.removeAttribute('aria-disabled');
  els.speedBtn.textContent = `${player.rate}×`;
  els.loopBtn.classList.toggle('on', player.loop);
  els.loopBtn.setAttribute('aria-pressed', String(player.loop));
  invalidateVis(); // Player ticks, seeks, rate and loop changes (5.1–5.5)
}

function renderStems() {
  const locked = exportLocked();
  // While recording, the Player plays the Export_Stem, so highlight that one.
  const shown = locked ? state.exporting.target.stemId : state.selected;
  for (const btn of els.stemButtons) {
    const id = btn.dataset.stem;
    btn.classList.toggle('selected', id === shown);
    btn.setAttribute('aria-pressed', String(id === shown));
    btn.disabled = (id === 'original' ? !state.current : !state.stemsReady) || locked;
  }
  let text;
  const notice = state.notice ? ` ${state.notice}` : '';
  if (!state.current) text = '上传后会自动分离音轨';
  else if (state.error) text = state.error;
  else if (state.separating) {
    const busy = state.progressText || `正在分离音轨… ${Math.floor(state.progress * 100)}%`;
    text = `${busy}（可以先播放原曲）${notice}`;
  } else if (state.stemsReady) text = `音轨已就绪，点一下切换${notice}`;
  else text = state.notice;
  els.stemStatus.textContent = text;
  els.stemStatus.classList.toggle('busy', state.separating);
  els.stemStatus.style.setProperty('--p', `${Math.floor(state.progress * 100)}%`);
  if (els.cancelSeparation) els.cancelSeparation.hidden = !state.separating;
  renderExport();
}

/** Export row: button state, 原曲 hint, progress / notice, cancel and WAV fallback (1.x, 5.5, 11.1). */
function renderExport() {
  if (!els.exportBtn) return;
  const entry = state.current;
  const urls = entry && entry.cache && entry.cache.urls;
  const ex = state.exporting;
  const { disabled, hint } = exportButtonState({
    hasFile: !!entry,
    separating: state.separating,
    stemsReady: state.stemsReady,
    selected: state.selected,
    hasStemUrl: !!(urls && urls[state.selected]),
    exporting: !!ex,
  });
  els.exportBtn.disabled = disabled;
  if (els.exportHint) {
    els.exportHint.textContent = hint;
    els.exportHint.hidden = !hint;
  }
  const parts = ex
    ? [state.exportNotice, ex.text]
    : [state.exportNotice, state.exportUnsupported ? UNSUPPORTED_TEXT : ''];
  const text = parts.filter(Boolean).join(' ');
  if (els.exportStatus) {
    els.exportStatus.textContent = text;
    els.exportStatus.hidden = !text;
  }
  if (els.cancelExport) els.cancelExport.hidden = !ex || ex.mode === 'wav';
  if (els.exportWavFallback) els.exportWavFallback.hidden = !!ex || !state.exportUnsupported || !entry;
}

// ---------------------------------------------------------------------------
// Loading and separation
// ---------------------------------------------------------------------------

function kindOf(file) {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return /\.(mp4|m4v|mov|webm|mkv|3gp)$/i.test(file.name) ? 'video' : 'audio';
}

function decodeAudio(arrayBuffer) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Offline(2, 44100, 44100);
  return new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

// Phones get tighter memory limits for separation (see separationLimitMessage).
const isMobile = () => !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

// Separated stems stay cached on their 音乐台 entry so re-opening a file is
// instant. Only the most recently used few are kept (see STEM_CACHE_LIMITS),
// and older ones are dropped before a new separation starts.
let useCounter = 0;

function revokeUrls(urls) {
  for (const u of Object.values(urls || {})) URL.revokeObjectURL(u);
}

const DECODE_FAILED = '这个文件的音轨没法在浏览器里解码，原曲可以正常播放；想分离音轨请换成 MP4 / MP3 / WAV / M4A。';

/**
 * Separates `entry` with Demucs when the local server has it, otherwise (or
 * after a Demucs failure) with the in-browser DSP. The file is only uploaded
 * when the status check said Demucs is available (Requirement 2.8).
 * Resolves to `{ urls, analysis }`, or null when the entry stopped being
 * current. A cancel (AbortError) is rethrown and never falls back to DSP.
 */
async function separateEntry(entry, { signal, stillCurrent, mobile, metaDuration }) {
  const onProgress = (p) => {
    if (!stillCurrent()) return;
    state.progress = p;
    renderStems();
  };

  const runDsp = async () => {
    const buf = await entry.file.arrayBuffer();
    if (!stillCurrent()) return null;
    let audioBuffer;
    try {
      audioBuffer = await decodeAudio(buf);
    } catch {
      throw new Error(DECODE_FAILED);
    }
    if (!stillCurrent()) return null;
    entry.duration = audioBuffer.duration;
    state.analysis = {
      duration: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      channels: audioBuffer.numberOfChannels,
      bpm: null,
    };
    renderLibrary();
    renderSheet();
    const lengthMessage = separationLimitMessage({ duration: audioBuffer.duration, mobile });
    if (lengthMessage) throw new Error(lengthMessage);
    const mode = mobile ? 'fast' : 'high';
    const { urls, bpm } = await runSeparation(audioBuffer, { mode, encode: encodeWav, signal, onProgress });
    return { urls, analysis: { ...state.analysis, bpm, engine: 'dsp', qualityMode: mode } };
  };

  const out = await separateWithFallback({
    stillCurrent,
    fetchStatus: async () => {
      const status = await fetchDemucsStatus({ signal });
      state.demucs = status;
      renderDemucsHint();
      return status;
    },
    runDemucs: () => runDemucsSeparation(entry.file, {
      model: settings.demucsModel,
      signal,
      encode: encodeWav,
      onPhase: (ph) => {
        if (!stillCurrent()) return;
        state.progressText = remoteProgressText(ph);
        renderStems();
      },
      onProgress,
    }),
    onNotice: (text) => {
      state.notice = text;
      state.progressText = '';
      state.progress = 0;
      renderStems();
    },
    runDsp,
  });
  if (!out || !out.result) return null;
  if (out.engine === 'dsp') return out.result;

  const r = out.result;
  // The metadata check could not run without a duration, so check the
  // downloaded length now. DSP would hit the same limit, so no fallback.
  if (!metaDuration) {
    const lengthMessage = separationLimitMessage({ duration: r.duration, mobile });
    if (lengthMessage) {
      revokeUrls(r.urls);
      throw new Error(lengthMessage);
    }
  }
  return {
    urls: r.urls,
    analysis: {
      duration: r.duration || metaDuration,
      sampleRate: r.sampleRate,
      channels: r.mono ? 1 : 2,
      bpm: r.bpm,
      engine: 'demucs',
      model: r.model,
      sources: r.sources,
    },
  };
}

async function openEntry(entry) {
  // Opening another file cancels a running export like 取消导出 does (1.7).
  // A recording restores the Playback_State when it stops, so wait for that
  // before the Player loads the new file.
  const ex = state.exporting;
  if (ex) {
    ex.abort.abort();
    if (ex.mode === 'browser' && ex.settled) await ex.settled;
    if (state.exporting === ex) state.exporting = null;
  }
  state.exportNotice = ex ? '已取消导出' : '';
  state.exportUnsupported = false;
  if (state.abort) state.abort.abort();
  stopVisCompute(); // the previous file's Vis_Data computation (2.3)
  state.current = entry;
  entry.lastUsed = ++useCounter;
  state.stemsReady = false;
  state.separating = !entry.cache;
  state.progress = entry.cache ? 1 : 0;
  state.error = '';
  state.progressText = '';
  state.notice = '';
  state.analysis = entry.cache ? entry.cache.analysis : null;
  state.selected = 'original';

  player.load(entry.file, entry.kind);
  player.setRate(settings.speed);
  player.setLoop(settings.loop);
  els.dropzone.hidden = true;
  els.mediaCard.hidden = false;
  els.mediaCard.classList.toggle('audio-only', entry.kind === 'audio');
  els.video.hidden = entry.kind !== 'video';
  els.audioArt.hidden = entry.kind === 'video';
  els.audioName.textContent = entry.name;
  if (entry.cache && entry.cache.vis) state.vis = { status: 'ready', abort: null }; // 2.2
  renderVis();
  renderStems();
  render();
  renderLibrary();

  if (entry.cache) {
    player.setStems(entry.cache.urls);
    state.stemsReady = true;
    renderStems();
    renderSheet();
    if (!entry.cache.vis) startVisCompute(entry); // cached stems without Vis_Data (1.2)
    return;
  }

  const abort = new AbortController();
  state.abort = abort;
  const stillCurrent = () => state.current === entry && !abort.signal.aborted;
  const mobile = isMobile();
  try {
    const sizeMessage = separationLimitMessage({ bytes: entry.file.size, mobile });
    if (sizeMessage) throw new Error(sizeMessage);
    // The media element usually knows the duration within milliseconds, so a
    // long file is refused before it is read and decoded. Containers that
    // report no duration fall through to the check after decoding.
    const metaDuration = await waitForDuration(player.master, { signal: abort.signal });
    if (!stillCurrent()) return;
    const metaMessage = separationLimitMessage({ duration: metaDuration || null, mobile });
    if (metaMessage) throw new Error(metaMessage);
    evictStemCaches(state.entries, entry, { mobile, revoke: (u) => URL.revokeObjectURL(u) });
    const out = await separateEntry(entry, { signal: abort.signal, stillCurrent, mobile, metaDuration });
    if (!out) return;
    if (!stillCurrent()) {
      revokeUrls(out.urls);
      return;
    }
    player.setStems(out.urls);
    state.analysis = out.analysis;
    entry.cache = { urls: out.urls, analysis: out.analysis };
    if (!entry.duration && out.analysis.duration) {
      entry.duration = out.analysis.duration;
      renderLibrary();
    }
    state.stemsReady = true;
    state.separating = false;
    state.progressText = '';
    state.progress = 1;
    startVisCompute(entry); // separation finished (1.1)
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (!stillCurrent()) return;
    state.separating = false;
    state.progressText = '';
    state.error = err && err.message ? err.message : '音轨分离失败';
    console.error(err);
  }
  renderStems();
  renderSheet();
}

function addFile(file) {
  if (!file) return;
  const entry = { id: state.nextId++, file, name: file.name, kind: kindOf(file), duration: 0 };
  state.entries.unshift(entry);
  showView('practice');
  openEntry(entry);
}

function pickFile() {
  els.fileInput.value = '';
  els.fileInput.click();
}

els.fileInput.addEventListener('change', () => addFile(els.fileInput.files[0]));
els.uploadBtn.addEventListener('click', pickFile);

// drag and drop on desktop: anywhere in the window
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const file = Array.from(e.dataTransfer?.files || []).find((f) => /^(video|audio)\//.test(f.type) || /\.(mp4|m4v|mov|webm|mkv|mp3|m4a|aac|wav|ogg|flac)$/i.test(f.name));
  if (file) addFile(file);
});

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function togglePlay() {
  if (exportLocked()) return;
  if (!state.current) { pickFile(); return; }
  player.toggle();
}

els.playBtn.addEventListener('click', togglePlay);
els.ctlPlay.addEventListener('click', togglePlay);
els.stageTap.addEventListener('click', togglePlay);

function cycleSpeed() {
  if (exportLocked()) return;
  const i = SPEEDS.indexOf(player.rate);
  player.setRate(SPEEDS[(i + 1) % SPEEDS.length]);
}
function toggleLoop() {
  if (exportLocked()) return;
  player.setLoop(!player.loop);
}
els.speedBtn.addEventListener('click', cycleSpeed);
els.loopBtn.addEventListener('click', toggleLoop);

function selectStem(id) {
  if (exportLocked()) return;
  if (id !== 'original' && !state.stemsReady) return;
  if (!state.current) return;
  state.selected = id;
  player.select(id);
  renderStems();
  invalidateVis(); // new Emphasis_Weight / Lane_Layout on the next frame (4.3, 5.4)
  renderLaneLabels(); // 2.5
}
for (const btn of els.stemButtons) btn.addEventListener('click', () => selectStem(btn.dataset.stem));

/**
 * Stops the running separation. Aborting makes runDemucsSeparation send the
 * DELETE and stop polling, and stops the DSP worker or main-thread fallback.
 * The entry keeps no cache, so opening it again separates from scratch.
 */
function cancelSeparation() {
  if (!state.separating) return;
  if (state.abort) state.abort.abort();
  stopVisCompute(); // 2.3
  renderVis();
  state.separating = false;
  state.progressText = '';
  state.progress = 0;
  state.error = '';
  state.notice = '已取消分离，原曲可以正常播放。';
  renderStems();
  renderSheet();
}
if (els.cancelSeparation) els.cancelSeparation.addEventListener('click', cancelSeparation);

// ---------------------------------------------------------------------------
// Export (stem-video-export)
// ---------------------------------------------------------------------------

const exportAbortError = () => new DOMException('已取消', 'AbortError');
let pendingExportTarget = null; // Export_Stem recorded when the chooser opened
let unsupportedTarget = null; // Export_Stem of the last video export that could not run

/**
 * The Export_Stem: the Selected_Stem at the moment 导出 is clicked (2.6).
 * Every later step (WAV read, upload, recording, file name) uses this record
 * and never reads state.selected again. Null when nothing can be exported.
 */
function exportTarget() {
  const entry = state.current;
  const stemId = state.selected;
  const url = entry && entry.cache && entry.cache.urls ? entry.cache.urls[stemId] : undefined;
  if (!entry || stemId === 'original' || !url) return null;
  const stem = STEMS.find((s) => s.id === stemId);
  return { entry, stemId, label: stem ? stem.label : stemId, url };
}

function beginExport(target, mode) {
  const abort = new AbortController();
  const ex = { mode, abort, text: '', target, settled: null };
  ex.stillCurrent = () => state.exporting === ex && state.current === target.entry && !abort.signal.aborted;
  state.exporting = ex;
  state.exportNotice = '';
  state.exportUnsupported = false;
  renderExport();
  return ex;
}

/** Ends `ex` unless it was superseded (another file opened); re-enables the controls. */
function finishExport(ex, { notice = '', unsupported = false } = {}) {
  if (state.exporting !== ex) return;
  state.exporting = null;
  state.exportNotice = notice;
  state.exportUnsupported = unsupported;
  renderStems();
  render();
}

/** Failure text shown in the export row; the button stays usable for a retry (13.4). */
function exportErrorText(err) {
  if (err instanceof ExportError) return err.message;
  return '导出失败';
}

/** WAV_Export: the cached stem WAV, byte-identical, no server request (3.1, 3.2). */
function startWavExport(target = exportTarget()) {
  closeExportSheet();
  if (!target || state.exporting) return null;
  const ex = beginExport(target, 'wav');
  ex.text = '正在导出 WAV…';
  renderExport();
  ex.settled = (async () => {
    let outcome = {};
    try {
      const blob = await readStemBlob(target.url);
      if (!ex.stillCurrent()) return;
      const name = fileNameFor(target.entry.name, target.label, 'wav');
      triggerDownload(blob, name);
      outcome = { notice: `已导出：${name}` };
    } catch (err) {
      console.error(err);
      outcome = { notice: exportErrorText(err) };
    } finally {
      finishExport(ex, outcome);
    }
  })();
  return ex.settled;
}

/**
 * Video_Export: Server_Mux first, Browser_Recording as the fallback (5.x).
 * The Player stays usable during Server_Mux (13.2); recording locks it (12.6)
 * and runBrowserRecording restores the Playback_State afterwards (12.9).
 */
function startVideoExport(target = exportTarget()) {
  return startServerOrBrowserExport(target, {
    fileLabel: target ? target.label : '',
    serverMux: (wav, opts) => runServerMux(target.entry.file, wav, opts),
    canRecord: () => canBrowserRecord(window, els.video),
    recording: () => ({ video: els.video }),
  });
}

/**
 * Vis_Export (stem-visualizer 9.4–9.7, 14.x): same flow as startVideoExport
 * with the Vis_Payload in the upload, the canvas-capability check, and a
 * recording canvas (video picture or #0b0d14 + visualization) as the picture.
 * `target.visData` is the Vis_Data reference taken when 导出 was clicked, so
 * a later cache eviction does not affect this export.
 */
function startVisExport(target) {
  const visData = target && target.visData;
  if (!target || !visData) return null;
  const isVideo = target.entry.kind === 'video';
  return startServerOrBrowserExport(target, {
    fileLabel: visFileLabel(target.label),
    serverMux: (wav, opts) => runServerMux(target.entry.file, wav, {
      ...opts,
      vis: {
        payload: new Blob([encodeVisPayload(visData, target.stemId)], { type: 'application/json' }),
        layout: isVideo ? 'stacked' : 'standalone', // 11.1
      },
    }),
    canRecord: () => canBrowserVisRecord(window),
    recording: () => ({
      video: player.master,
      frameSource: createVisCompositor({
        document,
        video: isVideo ? els.video : null,
        visData,
        stemId: target.stemId,
        getTime: () => player.currentTime,
      }),
    }),
  });
}

/**
 * Shared Server_Mux → Browser_Recording flow of 导出视频 and Vis_Export.
 * `serverMux(wav, { signal, onPhase })` uploads; `recording()` returns the
 * `video` / `frameSource` options of runBrowserRecording.
 */
function startServerOrBrowserExport(target, { fileLabel, serverMux, canRecord, recording }) {
  closeExportSheet();
  if (!target || state.exporting) return null;
  const ex = beginExport(target, 'server');
  const { signal } = ex.abort;
  const checkAbort = () => { if (signal.aborted) throw exportAbortError(); };
  const setText = (text) => {
    if (!ex.stillCurrent()) return;
    ex.text = text;
    renderExport();
  };
  setText('正在检查本地服务器…');

  ex.settled = (async () => {
    let outcome = {};
    try {
      const { path, blob } = await exportVideoWithFallback({
        fetchStatus: async () => {
          const status = await fetchExportStatus({ signal });
          checkAbort();
          return status;
        },
        runServer: async () => {
          const wav = await readStemBlob(target.url);
          checkAbort();
          return serverMux(wav, {
            signal,
            onPhase: (ph) => setText(exportProgressText(ph)),
          });
        },
        canRecord,
        onNotice: (text) => {
          if (!ex.stillCurrent()) return;
          state.exportNotice = text; // reason + 改用浏览器录制 (5.4)
          renderExport();
        },
        runBrowser: async () => {
          checkAbort();
          if (!ex.stillCurrent()) throw exportAbortError();
          ex.mode = 'browser';
          ex.text = exportProgressText({ stage: 'recording', progress: 0 });
          if (scrubbing != null) {
            scrubbing = null;
            els.progress.classList.remove('scrubbing');
          }
          renderStems();
          render();
          const media = recording();
          try {
            return await runBrowserRecording({
              player,
              ...media,
              stemId: target.stemId,
              stemUrl: target.url,
              // The user's selection right now (may have changed during Server_Mux); restored afterwards.
              selected: state.selected,
              signal,
              onProgress: (pct) => setText(exportProgressText({ stage: 'recording', progress: pct })),
            });
          } finally {
            // runBrowserRecording stops it too; this covers an early throw (stop is idempotent).
            if (media.frameSource) media.frameSource.stop();
          }
        },
      });
      checkAbort();
      if (!ex.stillCurrent()) return;
      const name = fileNameFor(target.entry.name, fileLabel, path === 'server' ? 'mp4' : 'webm');
      triggerDownload(blob, name);
      outcome = { notice: `已导出：${name}` };
    } catch (err) {
      if ((err && err.name === 'AbortError') || signal.aborted) {
        outcome = { notice: '已取消导出' }; // 11.4
      } else if (err instanceof ExportError && err.stage === 'unsupported') {
        unsupportedTarget = target;
        outcome = { notice: state.exporting === ex ? state.exportNotice : '', unsupported: true };
      } else {
        console.error(err);
        const before = state.exporting === ex ? state.exportNotice : '';
        outcome = { notice: [before, exportErrorText(err)].filter(Boolean).join(' ') };
      }
    } finally {
      finishExport(ex, outcome);
    }
  })();
  return ex.settled;
}

/** 取消导出: stops the upload / polling (DELETE is sent) or the recording (11.2, 11.3). */
function cancelExport() {
  const ex = state.exporting;
  if (!ex || ex.mode === 'wav') return;
  ex.abort.abort();
  ex.text = '正在取消…';
  renderExport();
}

/**
 * Opens the chooser. Video mode: 导出视频, 导出视频（带可视化）when Vis_Data is
 * ready (9.1). Audio mode: 导出视频 hidden, 可视化视频 shown (9.2). The two
 * buttons are reset on every open.
 */
function openExportSheet({ audio = false, vis = false } = {}) {
  if (!els.exportSheet) return;
  for (const b of els.exportOptions) {
    if (b.dataset.export === 'video') b.hidden = audio;
    else if (b.dataset.export === 'visvideo') {
      b.hidden = !vis;
      b.textContent = audio ? '可视化视频' : '导出视频（带可视化）';
    }
  }
  els.exportSheet.hidden = false;
  if (els.exportBackdrop) els.exportBackdrop.hidden = false;
  requestAnimationFrame(() => document.body.classList.add('sheet-open'));
  const first = els.exportOptions.find((b) => !b.hidden);
  if (first && typeof first.focus === 'function') first.focus();
}
function closeExportSheet() {
  if (!els.exportSheet || els.exportSheet.hidden) return;
  document.body.classList.remove('sheet-open');
  els.exportSheet.hidden = true;
  if (els.exportBackdrop) els.exportBackdrop.hidden = true;
}

function onExportClick() {
  if (state.exporting) return;
  const target = exportTarget();
  if (!target) return;
  // Vis_Data reference taken once, now (9.4).
  const visData = currentVisData();
  const audio = target.entry.kind === 'audio';
  if (audio && !visData) {
    startWavExport(target); // Vis_Data not ready: WAV directly, as before (2.2, 9.3)
    return;
  }
  // The Export_Stem is fixed now; the chooser only picks the format.
  pendingExportTarget = { ...target, visData };
  openExportSheet({ audio, vis: !!visData });
}

/** Option in the chooser: 导出视频 / 只导出音频（WAV）/ 取消 (2.3–2.5). */
function onExportOption(kind) {
  const target = pendingExportTarget;
  pendingExportTarget = null;
  closeExportSheet();
  if (kind === 'cancel' || !target) return; // Playback_State untouched (2.5)
  if (state.current !== target.entry) return;
  if (kind === 'video') startVideoExport(target);
  else if (kind === 'wav') startWavExport(target);
  else if (kind === 'visvideo') startVisExport(target);
}

if (els.exportBtn) els.exportBtn.addEventListener('click', onExportClick);
for (const b of els.exportOptions) b.addEventListener('click', () => onExportOption(b.dataset.export));
if (els.exportBackdrop) els.exportBackdrop.addEventListener('click', () => onExportOption('cancel'));
if (els.cancelExport) els.cancelExport.addEventListener('click', cancelExport);
if (els.exportWavFallback) {
  // WAV entry after 当前浏览器无法导出视频: the same Export_Stem as the failed video export (5.5).
  els.exportWavFallback.addEventListener('click', () => {
    if (state.exporting) return;
    const t = unsupportedTarget;
    const stillValid = t && t.entry === state.current && t.entry.cache && t.entry.cache.urls[t.stemId] === t.url;
    startWavExport(stillValid ? t : exportTarget());
  });
}

// progress bar: pointer events cover mouse, touch and pen
function ratioFromEvent(e) {
  const rect = els.progress.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
}
els.progress.addEventListener('pointerdown', (e) => {
  if (exportLocked() || !player.duration) return;
  els.progress.setPointerCapture(e.pointerId);
  scrubbing = ratioFromEvent(e);
  els.progress.classList.add('scrubbing');
  render();
});
els.progress.addEventListener('pointermove', (e) => {
  if (scrubbing == null) return;
  scrubbing = ratioFromEvent(e);
  render();
});
const endScrub = (e) => {
  if (scrubbing == null) return;
  if (exportLocked()) {
    scrubbing = null;
    els.progress.classList.remove('scrubbing');
    render();
    return;
  }
  if (e.type === 'pointerup') scrubbing = ratioFromEvent(e);
  player.seek(scrubbing * player.duration);
  scrubbing = null;
  els.progress.classList.remove('scrubbing');
  render();
};
els.progress.addEventListener('pointerup', endScrub);
els.progress.addEventListener('pointercancel', endScrub);
els.progress.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    e.stopPropagation();
    if (exportLocked()) return;
    player.seek(player.currentTime + (e.key === 'ArrowLeft' ? -5 : 5));
  }
});

// keyboard shortcuts (desktop)
// Space toggles playback even when a button has focus, so stop the button's own activation.
window.addEventListener('keyup', (e) => {
  if ((e.key === ' ' || e.code === 'Space') && state.current && e.target && e.target.tagName === 'BUTTON') e.preventDefault();
}, true);
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target && e.target.tagName) || '';
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
  if (e.key === 'Escape') { closeSheet(); closeExportSheet(); return; }
  if (!state.current) return;
  if (exportLocked()) {
    // Keep Space from activating a focused button while the controls are locked.
    if (e.key === ' ' || e.code === 'Space') e.preventDefault();
    return;
  }
  if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    player.seek(player.currentTime - 5);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    player.seek(player.currentTime + 5);
  } else if (/^[1-9]$/.test(e.key)) {
    selectStem(STEMS[Number(e.key) - 1].id);
  } else if (e.key === 'l' || e.key === 'L') {
    player.setLoop(!player.loop);
  }
});

// ---------------------------------------------------------------------------
// Tabs and 音乐台
// ---------------------------------------------------------------------------

function showView(name) {
  for (const v of els.views) {
    const on = v.dataset.view === name;
    v.hidden = !on;
    v.classList.toggle('active', on);
  }
  for (const t of els.tabs) {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  }
  window.scrollTo(0, 0);
}
for (const t of els.tabs) t.addEventListener('click', () => showView(t.dataset.tab));
for (const b of $$('[data-goto]')) b.addEventListener('click', () => showView(b.dataset.goto));

function renderLibrary() {
  els.libraryList.textContent = '';
  els.libraryEmpty.hidden = state.entries.length > 0;
  for (const entry of state.entries) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'library-item' + (entry === state.current ? ' current' : '');
    const icon = document.createElement('span');
    icon.className = 'library-icon';
    icon.textContent = entry.kind === 'video' ? '🎬' : '🎵';
    const text = document.createElement('span');
    text.className = 'library-text';
    const name = document.createElement('span');
    name.className = 'library-name';
    name.textContent = entry.name;
    const meta = document.createElement('span');
    meta.className = 'library-meta';
    meta.textContent = `${entry.kind === 'video' ? '视频' : '音频'} · ${entry.duration ? formatTime(entry.duration) : '读取中'}${entry === state.current ? ' · 正在练习' : ''}`;
    text.append(name, meta);
    btn.append(icon, text);
    btn.addEventListener('click', () => {
      showView('practice');
      if (entry !== state.current) openEntry(entry);
    });
    li.append(btn);
    els.libraryList.append(li);
  }
}

// ---------------------------------------------------------------------------
// 真实分析 sheet
// ---------------------------------------------------------------------------

function row(label, value) {
  const div = document.createElement('div');
  div.className = 'stat';
  const l = document.createElement('span');
  l.textContent = label;
  const v = document.createElement('strong');
  v.textContent = value;
  div.append(l, v);
  return div;
}

function renderSheet() {
  if (els.sheet.hidden) return;
  const body = els.sheetBody;
  body.textContent = '';
  if (!state.current) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '先上传一个视频或音频，这里会显示时长、采样率、声道和估计的 BPM。';
    body.append(p);
    return;
  }
  const a = state.analysis;
  const pending = state.separating ? '读取中' : '未知';
  const stats = document.createElement('div');
  stats.className = 'stats';
  stats.append(
    row('文件', state.current.name),
    row('时长', a ? formatTime(a.duration) : player.duration ? formatTime(player.duration) : pending),
    row('采样率', a ? `${a.sampleRate} Hz` : pending),
    row('声道', a ? (a.channels > 1 ? `立体声（${a.channels}）` : '单声道') : pending),
    row('估计 BPM', a && a.bpm ? String(Math.round(a.bpm)) : state.separating ? '分析中…' : '未知'),
    row('分离方式', separationMethodText(a)),
  );
  body.append(stats);
  const engine = a && a.engine;
  const dspNotes = engine === 'dsp' ? stemNotes(a.qualityMode)
    : engine ? stemNotes('high') : stemNotes(isMobile() ? 'fast' : 'high');

  const h = document.createElement('h4');
  h.textContent = '每条音轨是怎么来的';
  body.append(h);
  const list = document.createElement('ul');
  list.className = 'stem-notes';
  for (const s of STEMS) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = s.label;
    li.append(b, document.createTextNode(`：${stemNoteFor(s.id, engine, a, dspNotes)}`));
    list.append(li);
  }
  body.append(list);

  const note = document.createElement('p');
  note.className = 'muted small';
  note.textContent = engine === 'demucs'
    ? '说明：人声、鼓、贝斯等主音轨来自本地服务器上运行的 Demucs AI 模型；额外打击乐、效果音、其他音效是在这些音轨基础上用信号处理算法进一步拆出来的。'
      + ' 文件只上传到你自己电脑上运行的本地服务器，处理完就删除。'
    : '说明：这些音轨是浏览器里用信号处理算法（中置声道提取、谐波/打击分离、滤波）近似拆出来的，不是 AI 模型，不同歌曲效果差别较大。'
      + (a && a.channels < 2 ? ' 当前文件是单声道，人声和伴奏只能按频段和音色粗分。' : '')
      + ' 所有处理都在你的设备上完成，文件不会上传。';
  body.append(note);
}

/** 「分离方式」 row text for the Analysis_Panel. */
function separationMethodText(a) {
  if (a && a.engine === 'demucs') return `Demucs AI（${a.model || DEFAULT_DEMUCS_MODEL}）`;
  if (a && a.engine === 'dsp') return `浏览器 DSP（${QUALITY_LABELS[a.qualityMode] || QUALITY_LABELS.fast}）`;
  if (state.separating) return a ? '分离中…' : '读取中';
  return '未知';
}

/** Per-stem note: 原曲 is fixed; Demucs uses analysis.sources; DSP uses the mode's notes. */
function stemNoteFor(id, engine, a, dspNotes) {
  const fallback = (dspNotes && dspNotes[id]) || STEM_NOTES[id];
  if (id === 'original') return STEM_NOTES.original || fallback;
  if (engine === 'demucs') return (a.sources && a.sources[id]) || fallback;
  return fallback;
}

function openSheet() {
  els.sheet.hidden = false;
  els.sheetBackdrop.hidden = false;
  requestAnimationFrame(() => document.body.classList.add('sheet-open'));
  renderSheet();
  els.sheetClose.focus();
}
function closeSheet() {
  if (els.sheet.hidden) return;
  document.body.classList.remove('sheet-open');
  els.sheet.hidden = true;
  els.sheetBackdrop.hidden = true;
}
els.analysisLink.addEventListener('click', (e) => { e.preventDefault(); openSheet(); });
els.sheetClose.addEventListener('click', closeSheet);
els.sheetBackdrop.addEventListener('click', closeSheet);

renderStems();
renderLibrary();
render();
renderVis();
