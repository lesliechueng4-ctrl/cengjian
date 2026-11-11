// Browser client for stem export (design.md section 5). No DOM access at
// import time and every global (`fetch`, `document`, `URL`, `setTimeout`, …)
// is injectable, so Node tests can import it directly. Zero dependencies.
//
// Sections:
//   5.1 file names            (task 6.1)
//   5.2 button state          (task 6.1)
//   5.3 status / texts        (task 6.1)
//   5.7 read and download     (task 6.1)
//   5.4 runServerMux          (task 6.2, appended below)
//   5.5 browser recording     (task 6.3, appended below)
//   5.6 path selection        (task 6.4, appended below)

// ---------------------------------------------------------------------------
// 5.1 File names (Requirement 4)
// ---------------------------------------------------------------------------

/** Characters that are unsafe in a file name on some system → '_' (4.2). */
export const UNSAFE_FILE_NAME_RE = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

/** Max code points of `<base>-<label>` (4.5). */
export const MAX_FILE_BODY = 80;

const EDGE_SPACE_DOT_RE = /^[ .]+|[ .]+$/g;
const TRAILING_SPACE_DOT_RE = /[ .]+$/;

/** Removes the last extension; '.name' without another '.' has none (4.1). */
function stripExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Export_File_Name: `<Source_File 名去掉最后一个扩展名>-<Stem 名>.<ext>`.
 *
 * fileNameFor('练习 v2.final.mp4', '人声', 'mp4') === '练习 v2.final-人声.mp4'
 *
 * Lengths are counted in code points (Array.from) so a surrogate pair is never
 * cut in half. `stemLabel` is the display name of the Export_Stem recorded
 * when the export started (2.6); it is kept whole (4.5).
 *
 * @param {string} sourceName
 * @param {string} stemLabel
 * @param {'mp4'|'webm'|'wav'} ext
 * @returns {string}
 */
export function fileNameFor(sourceName, stemLabel, ext) {
  const raw = typeof sourceName === 'string' ? sourceName : '';
  let base = stripExtension(raw)
    .replace(UNSAFE_FILE_NAME_RE, '_')
    .replace(EDGE_SPACE_DOT_RE, '');
  if (!base) base = '导出';

  const label = String(stemLabel ?? '').replace(UNSAFE_FILE_NAME_RE, '_');
  const suffix = `-${label}`;
  const baseChars = Array.from(base);
  const room = MAX_FILE_BODY - Array.from(suffix).length;
  if (baseChars.length > room) {
    // Step 3 guarantees base does not start with ' ' or '.', so the cut base
    // keeps at least its first character.
    base = baseChars.slice(0, Math.max(1, room)).join('').replace(TRAILING_SPACE_DOT_RE, '');
  }
  return `${base}${suffix}.${ext}`;
}

/**
 * Stem label for a Vis_Export file name, passed to fileNameFor (9.5):
 * fileNameFor(name, visFileLabel('人声'), 'mp4') → '<base>-人声-可视化.mp4'.
 * @param {string} label
 * @returns {string}
 */
export function visFileLabel(label) {
  return `${label ?? ''}-可视化`;
}

// ---------------------------------------------------------------------------
// 5.2 Export button state (Requirements 1.2–1.6, 3.4)
// ---------------------------------------------------------------------------

/**
 * Independent of FFmpeg / recording support, so WAV_Export stays available
 * when neither works (3.4).
 *
 * @param {{ hasFile: boolean, separating: boolean, stemsReady: boolean,
 *           selected: string, hasStemUrl: boolean, exporting: boolean }} ctx
 * @returns {{ disabled: boolean, hint: string }}
 */
export function exportButtonState(ctx) {
  if (!ctx || !ctx.hasFile || ctx.separating || !ctx.stemsReady) return { disabled: true, hint: '' };
  if (ctx.selected === 'original') return { disabled: true, hint: '原曲就是原文件，无需导出' };
  if (!ctx.hasStemUrl) return { disabled: true, hint: '' };
  return { disabled: !!ctx.exporting, hint: '' };
}

// ---------------------------------------------------------------------------
// 5.3 Status detection and texts (Requirements 5.1, 9.6)
// ---------------------------------------------------------------------------

export const EXPORT_API = '/api/export';

export const UNSUPPORTED_TEXT = '当前浏览器无法导出视频，可以选择只导出音频（WAV）';

/**
 * Ask the server whether Server_Mux can be used. Never throws.
 *
 * Same shape as fetchDemucsStatus: 3 s timeout; network error, timeout,
 * external abort, non-2xx or invalid JSON → null. `checking: true` forces
 * `available: false` (5.1, 5.3).
 *
 * @param {{fetch?: typeof fetch, timeoutMs?: number, signal?: AbortSignal,
 *   setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout}} [opts]
 * @returns {Promise<{available: boolean, checking: boolean,
 *   maxUploadBytes: number|null, queueLength: number}|null>}
 */
export async function fetchExportStatus({
  fetch = globalThis.fetch, timeoutMs = 3000, signal,
  setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout,
} = {}) {
  if (typeof fetch !== 'function') return null;
  if (signal && signal.aborted) return null;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  // Reject on timeout as well, in case an injected fetch ignores the signal.
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { ctrl.abort(); reject(new Error('timeout')); }, timeoutMs);
  });
  const aborted = new Promise((_, reject) => {
    ctrl.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  timeout.catch(() => {});
  aborted.catch(() => {});
  try {
    const res = await Promise.race([
      fetch(`${EXPORT_API}/status`, { signal: ctrl.signal, cache: 'no-store' }),
      timeout, aborted,
    ]);
    if (!res || !res.ok) return null;
    const body = await Promise.race([res.json(), timeout, aborted]);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const checking = body.checking === true;
    return {
      available: body.available === true && !checking,
      checking,
      maxUploadBytes: Number.isFinite(body.maxUploadBytes) ? body.maxUploadBytes : null,
      queueLength: Number.isFinite(body.queueLength) ? body.queueLength : 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Progress area text for an export phase (9.6, 12.5).
 * @param {{stage: 'upload'|'queued'|'running'|'rendering'|'download'|'recording',
 *   position?: number, progress?: number|null}} phase
 * @returns {string}
 */
export function exportProgressText(phase) {
  switch (phase && phase.stage) {
    case 'upload':
      return '上传到本地服务器…';
    case 'queued':
      return `排队中（第 ${phase.position ?? 1} 位）`;
    case 'running':
      return Number.isFinite(phase.progress) ? `合成视频 ${phase.progress}%` : '合成视频中…';
    case 'rendering':
      return Number.isFinite(phase.progress) ? `渲染可视化视频 ${phase.progress}%` : '渲染可视化视频中…';
    case 'download':
      return '下载视频…';
    case 'recording':
      return `浏览器录制中 ${phase.progress ?? 0}%（需要和视频一样长的时间）`;
    default:
      return '';
  }
}

/**
 * Notice shown when Server_Mux fails and the app switches to recording (5.4).
 * @param {unknown} err
 * @returns {string}
 */
export function exportFallbackNotice(err) {
  const reason = err && typeof err.reason === 'string' ? err.reason.trim() : '';
  return reason
    ? `视频合成失败（${reason}），改用浏览器录制。`
    : '本地服务器无法合成视频，改用浏览器录制。';
}

/** An export failure. `stage: 'unsupported'` means no video export path exists. */
export class ExportError extends Error {
  /**
   * @param {{reason?: string, stage?: 'upload'|'job'|'download'|'record'|'unsupported', cause?: unknown}} [opts]
   */
  constructor({ reason = '', stage = 'job', cause } = {}) {
    const message = stage === 'unsupported'
      ? (reason || UNSUPPORTED_TEXT)
      : (reason ? `导出失败：${reason}` : '导出失败');
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ExportError';
    this.reason = reason;
    this.stage = stage;
  }
}

// ---------------------------------------------------------------------------
// 5.7 Read and download (Requirements 3.1–3.3)
// ---------------------------------------------------------------------------

/**
 * Read the cached stem WAV back as a Blob, byte-identical to the one used for
 * playback (3.1). Only `blob:` URLs are accepted, so this never sends a
 * request to the Server (3.2).
 *
 * @param {string} url
 * @param {{fetch?: typeof fetch}} [opts]
 * @returns {Promise<Blob>}
 */
export async function readStemBlob(url, { fetch = globalThis.fetch } = {}) {
  if (typeof url !== 'string' || !url.startsWith('blob:')) {
    throw new ExportError({ stage: 'download', reason: '音轨不存在' });
  }
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new ExportError({ stage: 'download', reason: '无法读取音轨', cause: err });
  }
  if (!res || (res.ok === false)) throw new ExportError({ stage: 'download', reason: '无法读取音轨' });
  return res.blob();
}

/**
 * Download `blob` as `name` via a temporary `<a download>`. Only the Blob URL
 * created here is revoked, one event-loop turn plus 1 s after the click; the
 * Player's and Library_Cache's URLs are left alone (3.3).
 *
 * @param {Blob} blob
 * @param {string} name
 * @param {{document?: Document, URL?: typeof URL, setTimeout?: typeof setTimeout}} [opts]
 * @returns {string} the temporary Blob URL
 */
export function triggerDownload(blob, name, {
  document = globalThis.document, URL = globalThis.URL, setTimeout = globalThis.setTimeout,
} = {}) {
  const url = URL.createObjectURL(blob);
  const revoke = () => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } };
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    if (a.style) a.style.display = 'none';
    const parent = document.body || document.documentElement;
    if (parent) parent.appendChild(a);
    a.click();
    if (parent && typeof a.remove === 'function') a.remove();
  } catch (err) {
    revoke();
    throw err;
  }
  setTimeout(() => { setTimeout(revoke, 1000); }, 0);
  return url;
}

// ---------------------------------------------------------------------------
// 5.4 runServerMux / sourceExt (task 6.2) — append below this line.
// ---------------------------------------------------------------------------

/** Copy of demucs-service.js UPLOAD_EXTS (server file cannot load in the browser). */
export const UPLOAD_EXTS = Object.freeze(['mp4', 'm4a', 'mp3', 'wav', 'aac', 'flac', 'ogg', 'webm', 'mov', 'mkv']);

const MIME_EXTS = Object.freeze({
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
});

/** Consecutive poll failures (network, non-2xx other than 404, bad JSON) tolerated. */
const MAX_POLL_FAILURES = 5;

/**
 * Extension sent as `ext`: the file name's (lowercase) if whitelisted, else
 * from the MIME type, else 'mp4'. FFmpeg detects the format from content, so
 * the extension only names the temp file.
 * @param {{name?: string, type?: string}} file
 * @returns {string}
 */
export function sourceExt(file) {
  const name = file && typeof file.name === 'string' ? file.name : '';
  const dot = name.lastIndexOf('.');
  if (dot >= 0) {
    const ext = name.slice(dot + 1).toLowerCase();
    if (UPLOAD_EXTS.includes(ext)) return ext;
  }
  const type = file && typeof file.type === 'string' ? file.type.split(';')[0].trim().toLowerCase() : '';
  return MIME_EXTS[type] || 'mp4';
}

function exportAbortError() {
  return new DOMException('已取消', 'AbortError');
}

function isAbort(err) {
  return !!err && err.name === 'AbortError';
}

/** Resolves after `ms`, rejects with AbortError as soon as `signal` aborts. */
function defaultExportSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(exportAbortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(exportAbortError()); };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function readExportErrorReason(res) {
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string' && body.error.trim()) return body.error.trim();
  } catch { /* fall through */ }
  return `HTTP ${res.status}`;
}

/**
 * Server_Mux: upload WAV + Source_File in one POST, poll, download
 * `result.mp4`, DELETE the job (design.md section 5.4).
 *
 * - URL holds only `ext` and `wavBytes`, always relative (4.6, 5.6).
 * - Network error or non-202 upload (413 / 429 / 500 / 503 …) →
 *   ExportError stage 'upload' with the server's `error` (5.4).
 * - `failed` / `cancelled` / 404 / 5 consecutive poll failures → stage 'job';
 *   download failure → stage 'download'; both send a DELETE.
 * - Abort: fire-and-forget `keepalive` DELETE, throw AbortError (11.2).
 *
 * @param {File} sourceFile
 * @param {Blob} wavBlob  WAV of the Export_Stem
 * @param {{
 *   signal?: AbortSignal,
 *   onPhase?: (phase: {stage: 'upload'|'queued'|'running'|'download', position?: number, progress?: number|null}) => void,
 *   fetch?: typeof fetch,
 *   pollMs?: number,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   vis?: { payload: Blob, layout: 'stacked'|'standalone' },
 * }} [opts]
 *
 * With `vis` (Vis_Server_Render, stem-visualizer design section 10): the URL
 * also carries `visBytes` and `layout`, the body is WAV + Vis_Payload +
 * Source_File, and the running phase is reported as `stage: 'rendering'`.
 * Without `vis` the request is exactly as before (9.8, 10.3).
 * @returns {Promise<Blob>} MP4
 */
export async function runServerMux(sourceFile, wavBlob, {
  signal, onPhase, fetch = globalThis.fetch, pollMs = 1000, sleep = defaultExportSleep, vis,
} = {}) {
  const runningStage = vis ? 'rendering' : 'running';
  let jobId = null;
  const phase = (p) => { if (onPhase) onPhase(p); };
  const checkAbort = () => { if (signal && signal.aborted) throw exportAbortError(); };
  const jobUrl = () => `${EXPORT_API}/${encodeURIComponent(jobId)}`;
  const deleteJob = (extra) => {
    if (!jobId) return Promise.resolve();
    const url = jobUrl();
    jobId = null;
    try {
      return Promise.resolve(fetch(url, { method: 'DELETE', ...extra })).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  };

  try {
    checkAbort();

    // 1. Upload.
    phase({ stage: 'upload' });
    let query = `ext=${encodeURIComponent(sourceExt(sourceFile))}&wavBytes=${wavBlob.size}`;
    if (vis) query += `&visBytes=${vis.payload.size}&layout=${encodeURIComponent(vis.layout)}`;
    let res;
    try {
      res = await fetch(`${EXPORT_API}?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: vis ? new Blob([wavBlob, vis.payload, sourceFile]) : new Blob([wavBlob, sourceFile]),
        signal,
      });
    } catch (err) {
      checkAbort();
      throw new ExportError({ stage: 'upload', reason: '无法连接本地服务器', cause: err });
    }
    checkAbort();
    if (!res || res.status !== 202) {
      throw new ExportError({ stage: 'upload', reason: res ? await readExportErrorReason(res) : '无法连接本地服务器' });
    }
    let created;
    try { created = await res.json(); } catch { created = null; }
    checkAbort();
    if (!created || typeof created.id !== 'string' || !created.id) {
      throw new ExportError({ stage: 'upload', reason: '服务器返回的任务无效' });
    }
    jobId = created.id;

    // 2. Poll until done.
    let failures = 0;
    const pollFailed = (cause) => {
      failures += 1;
      if (failures >= MAX_POLL_FAILURES) {
        throw new ExportError({ stage: 'job', reason: '无法获取任务状态', cause });
      }
    };
    for (;;) {
      await sleep(pollMs, signal);
      checkAbort();
      let job = null;
      let pollErr = null;
      try {
        const r = await fetch(jobUrl(), { signal, cache: 'no-store' });
        checkAbort();
        if (r && r.status === 404) throw new ExportError({ stage: 'job', reason: '任务已被服务器清理' });
        if (!r || !r.ok) throw new Error(r ? `HTTP ${r.status}` : 'no response');
        job = await r.json();
        if (!job || typeof job !== 'object') throw new Error('无效的任务状态');
      } catch (err) {
        if (err instanceof ExportError || isAbort(err)) throw err;
        checkAbort();
        pollErr = err;
      }
      if (pollErr) { pollFailed(pollErr); continue; }

      if (job.status === 'queued') {
        failures = 0;
        phase({ stage: 'queued', position: Number.isFinite(job.position) ? job.position : 1 });
      } else if (job.status === 'running') {
        failures = 0;
        const progress = Number.isFinite(job.progress)
          ? Math.round(Math.min(100, Math.max(0, job.progress)))
          : null;
        phase({ stage: runningStage, progress });
      } else if (job.status === 'done') {
        break;
      } else if (job.status === 'failed') {
        const reason = typeof job.error === 'string' && job.error.trim() ? job.error.trim() : '服务器合成视频失败';
        throw new ExportError({ stage: 'job', reason });
      } else if (job.status === 'cancelled') {
        throw new ExportError({ stage: 'job', reason: '任务已被服务器清理' });
      } else {
        pollFailed(new Error('未知的任务状态'));
      }
    }

    // 3. Download.
    phase({ stage: 'download' });
    let blob;
    try {
      const r = await fetch(`${jobUrl()}/result.mp4`, { signal, cache: 'no-store' });
      checkAbort();
      if (!r || !r.ok) throw new Error(`下载视频失败（${r ? `HTTP ${r.status}` : '无响应'}）`);
      blob = await r.blob();
      checkAbort();
    } catch (err) {
      checkAbort();
      if (isAbort(err)) throw err;
      throw new ExportError({ stage: 'download', reason: err && err.message ? err.message : '下载视频失败', cause: err });
    }

    // 4. Free the server copy (failure ignored), return.
    await deleteJob();
    return blob;
  } catch (err) {
    if ((signal && signal.aborted) || isAbort(err)) {
      deleteJob({ keepalive: true });
      throw isAbort(err) ? err : exportAbortError();
    }
    if (err instanceof ExportError && (err.stage === 'job' || err.stage === 'download')) {
      deleteJob();
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 5.5 Browser recording (task 6.3) — append below this line.
// ---------------------------------------------------------------------------

/** WEBM types tried in order (12.3). */
export const RECORDER_TYPES = Object.freeze([
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
]);

/** Drift (seconds) between recAudio and the video above which recAudio is pulled back. */
export const RECORD_DRIFT_LIMIT = 0.25;

export const AUTOPLAY_BLOCKED_TEXT = '浏览器阻止了播放，请再点一次导出';

/**
 * First RECORDER_TYPES entry for which `isTypeSupported` is true, else null.
 * @param {typeof MediaRecorder} [MediaRecorderCtor]
 * @returns {string|null}
 */
export function pickRecorderMime(MediaRecorderCtor) {
  if (!MediaRecorderCtor || typeof MediaRecorderCtor.isTypeSupported !== 'function') return null;
  for (const type of RECORDER_TYPES) {
    try {
      if (MediaRecorderCtor.isTypeSupported(type)) return type;
    } catch { /* try the next one */ }
  }
  return null;
}

function audioContextCtor(env) {
  return (env && (env.AudioContext || env.webkitAudioContext)) || null;
}

function hasCaptureStream(target) {
  return !!target && (typeof target.captureStream === 'function' || typeof target.mozCaptureStream === 'function');
}

/**
 * Whether Browser_Recording can run: captureStream / mozCaptureStream on the
 * media element prototype (or on `video` if given), a MediaRecorder with a
 * supported WEBM type, and an AudioContext (12.3, 12.4).
 * @param {object} [env]
 * @param {HTMLMediaElement|null} [video]
 * @returns {boolean}
 */
export function canBrowserRecord(env = globalThis, video = null) {
  if (!env) return false;
  const proto = env.HTMLMediaElement && env.HTMLMediaElement.prototype;
  if (!hasCaptureStream(video) && !hasCaptureStream(proto)) return false;
  if (typeof env.MediaRecorder !== 'function' || !pickRecorderMime(env.MediaRecorder)) return false;
  return typeof audioContextCtor(env) === 'function';
}

/**
 * Recording progress: round(t / d * 100) clamped to 0..100; 0 if d is unknown (12.5).
 * @param {number} t
 * @param {number} d
 * @returns {number}
 */
export function recordingPercent(t, d) {
  if (!Number.isFinite(t) || !Number.isFinite(d) || d <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((t / d) * 100)));
}

/**
 * Playback_State snapshot.
 * @param {{currentTime: number, rate: number, paused: boolean, loop: boolean}} player
 * @param {string} selected  Selected_Stem at the moment recording starts
 */
export function capturePlaybackState(player, selected) {
  return { time: player.currentTime, rate: player.rate, playing: !player.paused, loop: player.loop, selected };
}

/**
 * Restore a snapshot: setRate → setLoop → select(selected) → seek(time) →
 * play() or pause(). Never throws; each step runs even if an earlier one fails.
 * @param {object} player SyncPlayer
 * @param {ReturnType<typeof capturePlaybackState>} saved
 */
export async function restorePlaybackState(player, saved) {
  if (!player || !saved) return;
  const step = (fn) => { try { fn(); } catch { /* keep restoring */ } };
  step(() => player.setRate(saved.rate));
  step(() => player.setLoop(saved.loop));
  step(() => player.select(saved.selected));
  step(() => player.seek(saved.time));
  try {
    if (saved.playing) await player.play();
    else player.pause();
  } catch { /* autoplay refusal: leave it paused */ }
}

/**
 * Browser_Recording (design.md decision 5, section 5.5): the video's picture
 * via captureStream (video tracks only) + the Export_Stem's sound via a
 * dedicated hidden `recAudio` → AudioContext → MediaStreamDestination.
 *
 * Resolves with a WEBM Blob when the video ends. MediaRecorder / media errors
 * and autoplay refusal reject with ExportError stage 'record'; abort rejects
 * with AbortError; no data is returned in either case. Always releases every
 * resource and restores the Playback_State (selected track = `selected`).
 * The Stem Blob URL is never revoked (13.1).
 *
 * @param {{ player: object, video: HTMLVideoElement, stemId: string, stemUrl: string, selected: string,
 *           signal?: AbortSignal, onProgress?: (pct: number) => void, env?: object,
 *           frameSource?: { stream: MediaStream, start(): void, stop(): void } }} opts
 *
 * With `frameSource` (Vis_Browser_Recording, stem-visualizer decision 7) the
 * picture tracks come from `frameSource.stream` and `video.captureStream` is
 * never called; `video` is still the clock and the `ended` / `timeupdate` /
 * `error` source (it may be the Player's hidden master `<audio>`).
 * `frameSource.start()` runs right before `player.play()`, `stop()` in
 * `finally` (14.2, 14.4, 14.7).
 * @returns {Promise<Blob>}
 */
export async function runBrowserRecording({
  player, video, stemId, stemUrl, selected, signal, onProgress, env = globalThis, frameSource,
}) {
  const saved = capturePlaybackState(player, selected);
  const mime = pickRecorderMime(env.MediaRecorder);
  const AC = audioContextCtor(env);
  const hasPicture = frameSource
    ? !!frameSource.stream && typeof frameSource.stream.getVideoTracks === 'function'
    : hasCaptureStream(video);
  if (!mime || !AC || !hasPicture) throw new ExportError({ stage: 'unsupported' });
  if (signal && signal.aborted) throw exportAbortError();

  const progress = (pct) => { if (onProgress) { try { onProgress(pct); } catch { /* ignore */ } } };

  // One promise that rejects on the first failure or abort; every wait races it.
  let failed = null;
  let rejectRun;
  const failure = new Promise((_, reject) => { rejectRun = reject; });
  failure.catch(() => {});
  const fail = (err) => {
    if (failed) return;
    failed = err;
    rejectRun(err);
  };
  const race = (p) => Promise.race([Promise.resolve(p), failure]);

  const listeners = [];
  const on = (target, type, fn) => {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn);
    listeners.push([target, type, fn]);
  };

  let recAudio = null;
  let ctx = null;
  let dest = null;
  let capture = null;
  let recorder = null;
  let chunks = [];
  let touchedPlayer = false;

  const mediaErrorReason = (el, what) => {
    const msg = el && el.error && typeof el.error.message === 'string' ? el.error.message.trim() : '';
    return msg ? `${what}播放出错（${msg}）` : `${what}播放出错`;
  };

  try {
    if (signal) on(signal, 'abort', () => fail(exportAbortError()));

    // 2. Dedicated recording element, never connected to the speakers.
    recAudio = new env.Audio();
    on(recAudio, 'error', () => fail(new ExportError({ stage: 'record', reason: mediaErrorReason(recAudio, '音轨') })));
    const metadata = new Promise((resolve) => {
      if (recAudio.readyState >= 1) { resolve(); return; }
      on(recAudio, 'loadedmetadata', () => resolve());
    });
    recAudio.preload = 'auto';
    recAudio.src = stemUrl;
    if (typeof recAudio.load === 'function') recAudio.load();
    await race(metadata);

    // 3. recAudio → MediaStreamDestination (not ctx.destination).
    ctx = new AC();
    dest = ctx.createMediaStreamDestination();
    ctx.createMediaElementSource(recAudio).connect(dest);
    if (typeof ctx.resume === 'function') await race(ctx.resume());

    // 4. Picture only: drop the Source_File's own audio (12.2). With a
    //    frameSource the picture is the recording canvas; frameSource.stop()
    //    releases its tracks.
    let pictureTracks;
    if (frameSource) {
      pictureTracks = frameSource.stream.getVideoTracks();
    } else {
      capture = typeof video.captureStream === 'function' ? video.captureStream() : video.mozCaptureStream();
      pictureTracks = capture.getVideoTracks();
    }
    const stream = new env.MediaStream([...pictureTracks, ...dest.stream.getAudioTracks()]);

    // 5. Player to the Export_Stem from the start, 1x, no loop (12.1).
    on(video, 'error', () => fail(new ExportError({ stage: 'record', reason: mediaErrorReason(video, '视频') })));
    touchedPlayer = true;
    player.pause();
    player.select(stemId);
    player.setLoop(false);
    player.setRate(1);
    player.seek(0);
    recAudio.currentTime = 0;
    progress(0);

    // 6. Record.
    let ended = false;
    let resolveStop;
    const stoppedP = new Promise((resolve) => { resolveStop = resolve; });
    recorder = new env.MediaRecorder(stream, { mimeType: mime });
    recorder.ondataavailable = (e) => {
      if (!failed && e && e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = (e) => {
      const err = e && (e.error || e);
      const msg = err && typeof err.message === 'string' && err.message.trim() ? err.message.trim() : '';
      fail(new ExportError({ stage: 'record', reason: msg ? `录制出错（${msg}）` : '录制出错', cause: err }));
    };
    recorder.onstop = () => {
      if (!ended) fail(new ExportError({ stage: 'record', reason: '录制意外停止' }));
      resolveStop();
    };

    // 7. Drift correction + progress; 8. stop at the end.
    on(video, 'timeupdate', () => {
      if (failed || ended) return;
      const t = video.currentTime || 0;
      if (Math.abs((recAudio.currentTime || 0) - t) > RECORD_DRIFT_LIMIT) recAudio.currentTime = t;
      progress(recordingPercent(t, player.duration));
    });
    on(video, 'ended', () => {
      if (failed || ended) return;
      ended = true;
      progress(100);
      try { recAudio.pause(); } catch { /* ignore */ }
      if (recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { resolveStop(); }
      } else {
        resolveStop();
      }
    });

    try {
      recorder.start(1000);
    } catch (err) {
      throw new ExportError({ stage: 'record', reason: '无法开始录制', cause: err });
    }

    if (frameSource) frameSource.start();
    await race(player.play());
    try {
      await race(recAudio.play());
    } catch (err) {
      if (failed) throw failed;
      throw new ExportError({ stage: 'record', reason: AUTOPLAY_BLOCKED_TEXT, cause: err });
    }
    if (failed) throw failed;
    if (player.paused && !ended) throw new ExportError({ stage: 'record', reason: AUTOPLAY_BLOCKED_TEXT });

    await race(stoppedP);
    if (failed) throw failed;
    const blob = new Blob(chunks, { type: 'video/webm' });
    if (!blob.size) throw new ExportError({ stage: 'record', reason: '录制结果为空' });
    return blob;
  } catch (err) {
    chunks = [];
    if (failed) throw failed;
    if (isAbort(err) || err instanceof ExportError) throw err;
    throw new ExportError({
      stage: 'record',
      reason: err && typeof err.message === 'string' && err.message ? err.message : '录制失败',
      cause: err,
    });
  } finally {
    // 10. Release everything, then put the Player back (12.9).
    chunks = [];
    for (const [target, type, fn] of listeners) {
      try { target.removeEventListener(type, fn); } catch { /* ignore */ }
    }
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
    }
    const stopTracks = (s) => {
      if (!s || typeof s.getTracks !== 'function') return;
      for (const track of s.getTracks()) { try { track.stop(); } catch { /* ignore */ } }
    };
    stopTracks(capture);
    stopTracks(dest && dest.stream);
    if (frameSource && typeof frameSource.stop === 'function') {
      try { frameSource.stop(); } catch { /* ignore */ }
    }
    if (ctx && typeof ctx.close === 'function') {
      try { await Promise.resolve(ctx.close()).catch(() => {}); } catch { /* ignore */ }
    }
    if (recAudio) {
      try { recAudio.pause(); } catch { /* ignore */ }
      try {
        recAudio.removeAttribute ? recAudio.removeAttribute('src') : (recAudio.src = '');
        if (typeof recAudio.load === 'function') recAudio.load();
      } catch { /* ignore */ }
    }
    if (touchedPlayer) {
      try { player.pause(); } catch { /* ignore */ }
    }
    await restorePlaybackState(player, saved);
  }
}

// ---------------------------------------------------------------------------
// 5.6 Path selection (Requirements 5.2–5.5, 7.13, 11.2, 12.4)
// ---------------------------------------------------------------------------

/**
 * Pick the video export path. Server_Mux runs only when the status says
 * `available && !checking`; any non-abort Server_Mux failure (upload incl.
 * 500 disk-write errors, job, download) is reported via `onNotice` and falls
 * back to browser recording. AbortError is rethrown unchanged and never
 * falls back.
 * @param {{ fetchStatus: () => Promise<any>, runServer: () => Promise<Blob>,
 *   runBrowser: () => Promise<Blob>, canRecord: () => boolean,
 *   onNotice?: (text: string) => void }} deps
 * @returns {Promise<{ path: 'server' | 'browser', blob: Blob }>}
 * @throws AbortError unchanged; ExportError('unsupported') when recording is
 *   needed but `canRecord()` is false.
 */
export async function exportVideoWithFallback({ fetchStatus, runServer, runBrowser, canRecord, onNotice }) {
  let status = null;
  try { status = await fetchStatus(); } catch (err) { if (isAbort(err)) throw err; }
  if (status && status.available === true && status.checking !== true) {
    try {
      return { path: 'server', blob: await runServer() };
    } catch (err) {
      if (isAbort(err)) throw err;
      if (onNotice) onNotice(exportFallbackNotice(err));
    }
  }
  if (!canRecord()) throw new ExportError({ stage: 'unsupported' });
  return { path: 'browser', blob: await runBrowser() };
}
