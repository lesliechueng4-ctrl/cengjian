// Browser client for the local Demucs_Service (/api/separate). No DOM access
// and an injectable `fetch`, so Node tests can import it directly.
//
// The allowed model list duplicates the server's (demucs-service.js) on
// purpose: that file is server-side and must not be loaded in the browser.

import { decodeWav } from './wav.js';
import { mapDemucsStems, STEM_SOURCES } from './stem-mapper.js';

export const DEFAULT_DEMUCS_MODEL = 'htdemucs';
export const DEMUCS_MODELS = Object.freeze(['htdemucs', 'htdemucs_6s']);
export const API = '/api/separate';

/**
 * Any value that is not an allowed model name becomes `htdemucs`
 * (Requirements 7.2, 7.4).
 * @param {unknown} v
 * @returns {'htdemucs'|'htdemucs_6s'}
 */
export function sanitizeDemucsModel(v) {
  return typeof v === 'string' && DEMUCS_MODELS.includes(v) ? v : DEFAULT_DEMUCS_MODEL;
}

/**
 * Ask the server whether Demucs can be used. Never throws.
 *
 * Returns null on network error, timeout, external abort, non-2xx status or
 * invalid JSON. While the server is still probing (`checking: true`) the
 * result has `available: false`, so callers treat it as unavailable
 * (Requirements 1.5, 1.6, 2.8).
 *
 * @param {{fetch?: typeof fetch, timeoutMs?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<{available: boolean, checking: boolean, models: string[],
 *   maxUploadBytes: number|null, queueLength: number}|null>}
 */
export async function fetchDemucsStatus({ fetch = globalThis.fetch, timeoutMs = 3000, signal } = {}) {
  if (typeof fetch !== 'function') return null;
  if (signal && signal.aborted) return null;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/status`, { signal: ctrl.signal, cache: 'no-store' });
    if (!res || !res.ok) return null;
    const body = await res.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const checking = body.checking === true;
    const models = Array.isArray(body.models)
      ? body.models.filter((m) => DEMUCS_MODELS.includes(m))
      : [];
    return {
      available: body.available === true && !checking,
      checking,
      models,
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
 * Progress area text for a remote separation phase (Requirement 3.5).
 * @param {{stage: 'upload'|'queued'|'running'|'download', position?: number, progress?: number}} phase
 * @returns {string}
 */
export function remoteProgressText(phase) {
  switch (phase && phase.stage) {
    case 'upload':
      return '上传到本地服务器…';
    case 'queued':
      return `排队中（第 ${phase.position} 位）`;
    case 'running':
      return `AI 分离中 ${phase.progress ?? 0}%`;
    case 'download':
      return '整理 AI 音轨…';
    default:
      return '';
  }
}

/**
 * Notice shown when the app falls back to browser separation
 * (Requirements 6.1, 6.2).
 * @param {unknown} err
 * @returns {string}
 */
export function fallbackNotice(err) {
  const reason = err && typeof err.reason === 'string' ? err.reason.trim() : '';
  return reason
    ? `AI 分离失败（${reason}），已改用浏览器分离。`
    : 'AI 分离暂时不可用，已改用浏览器分离。';
}

/** A Demucs failure that should make the app fall back to DSP. */
export class DemucsError extends Error {
  /**
   * @param {{reason?: string, stage?: 'upload'|'job'|'download', cause?: unknown}} [opts]
   */
  constructor({ reason = '', stage = 'job', cause } = {}) {
    super(reason ? `AI 分离失败：${reason}` : 'AI 分离失败', cause === undefined ? undefined : { cause });
    this.name = 'DemucsError';
    this.reason = reason;
    this.stage = stage;
  }
}

function isAbortError(err) {
  return !!err && err.name === 'AbortError';
}

/**
 * Engine choice and fallback, with every dependency injected (Properties 1, 12).
 *
 * - Status null, `available` not true, or `checking` true → only `runDsp`.
 * - `runDemucs(status)` throws AbortError → rethrown, `runDsp` not called (6.4).
 * - `runDemucs` throws anything else → `onNotice(fallbackNotice(err))`, then
 *   `runDsp` (6.1, 6.2).
 * - If `stillCurrent()` turns false before an engine would start, returns null
 *   without starting it.
 *
 * @param {{
 *   fetchStatus: () => Promise<any>,
 *   runDemucs: (status: any) => Promise<any>,
 *   runDsp: () => Promise<any>,
 *   onNotice?: (text: string) => void,
 *   stillCurrent?: () => boolean,
 * }} deps
 * @returns {Promise<{engine: 'demucs'|'dsp', result: any}|null>}
 */
export async function separateWithFallback({ fetchStatus, runDemucs, runDsp, onNotice, stillCurrent = () => true }) {
  let status = null;
  try {
    status = await fetchStatus();
  } catch (err) {
    if (isAbortError(err)) throw err;
    status = null;
  }
  if (!stillCurrent()) return null;

  if (status && status.available === true && status.checking !== true) {
    try {
      return { engine: 'demucs', result: await runDemucs(status) };
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (!stillCurrent()) return null;
      if (onNotice) onNotice(fallbackNotice(err));
    }
  }

  return { engine: 'dsp', result: await runDsp() };
}

// ---------------------------------------------------------------------------
// runDemucsSeparation (task 12.2): upload, poll, download, map to the 8
// Derived_Stems. See design.md section 2 for the step list.
// ---------------------------------------------------------------------------

/** Consecutive poll failures (network, non-2xx other than 404, bad JSON) tolerated. */
const MAX_POLL_FAILURES = 5;

/** Lowercase file extension made of letters/digits only, else ''. */
function extOf(name) {
  if (typeof name !== 'string') return '';
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return '';
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(ext) ? ext : '';
}

function abortError() {
  return new DOMException('已取消', 'AbortError');
}

/** Resolves after `ms`, rejects with AbortError as soon as `signal` aborts. */
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function defaultCreateObjectURL(wav) {
  return URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
}

function defaultRevokeObjectURL(url) {
  URL.revokeObjectURL(url);
}

async function readErrorReason(res) {
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string' && body.error.trim()) return body.error.trim();
  } catch { /* fall through */ }
  return `HTTP ${res.status}`;
}

/**
 * Upload, poll, download and map to the 8 Derived_Stems (design.md section 2).
 *
 * - User abort (`signal`): fire-and-forget `keepalive` DELETE, revoke created
 *   Blob URLs, stop polling, throw AbortError (4.2, 6.4).
 * - Upload failure → DemucsError stage 'upload'; job `failed` / `cancelled` /
 *   404, or 5 consecutive poll failures → stage 'job'; download, decode or
 *   mapping failure → revoke URLs, DELETE, stage 'download' (6.1–6.3).
 *
 * @param {Blob & {name?: string}} file
 * @param {{
 *   model?: string,
 *   signal?: AbortSignal,
 *   encode: (channels: Float32Array[], sampleRate: number) => ArrayBuffer,
 *   onPhase?: (phase: {stage: 'upload'|'queued'|'running'|'download', position?: number, progress?: number}) => void,
 *   onProgress?: (p: number) => void,
 *   fetch?: typeof fetch,
 *   pollMs?: number,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   createObjectURL?: (wav: ArrayBuffer) => string,
 *   revokeObjectURL?: (url: string) => void,
 * }} opts
 * @returns {Promise<{urls: Record<string, string>, bpm: number, model: string,
 *   sources: Record<string, string>, sampleRate: number, mono: boolean, duration: number}>}
 */
export async function runDemucsSeparation(file, {
  model: requestedModel, signal, encode, onPhase, onProgress,
  fetch = globalThis.fetch, pollMs = 1000, sleep = defaultSleep,
  createObjectURL = defaultCreateObjectURL, revokeObjectURL = defaultRevokeObjectURL,
} = {}) {
  const model = sanitizeDemucsModel(requestedModel);
  const urls = {};
  let jobId = null;
  const phase = (p) => { if (onPhase) onPhase(p); };
  const progress = (p) => { if (onProgress) onProgress(Math.min(1, Math.max(0, p))); };
  const checkAbort = () => { if (signal && signal.aborted) throw abortError(); };

  const revokeAll = () => {
    for (const id of Object.keys(urls)) {
      try { revokeObjectURL(urls[id]); } catch { /* ignore */ }
      delete urls[id];
    }
  };
  const deleteJob = (extra) => {
    if (!jobId) return Promise.resolve();
    try {
      return Promise.resolve(fetch(`${API}/${encodeURIComponent(jobId)}`, { method: 'DELETE', ...extra }))
        .catch(() => {});
    } catch {
      return Promise.resolve();
    }
  };

  try {
    checkAbort();

    // 1. Upload.
    phase({ stage: 'upload' });
    progress(0.02);
    const ext = extOf(file && file.name);
    const query = `model=${encodeURIComponent(model)}${ext ? `&ext=${ext}` : ''}`;
    let res;
    try {
      res = await fetch(`${API}?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
        signal,
      });
    } catch (err) {
      checkAbort();
      throw new DemucsError({ stage: 'upload', reason: '无法连接本地服务器', cause: err });
    }
    checkAbort();
    if (!res || res.status !== 202) {
      throw new DemucsError({ stage: 'upload', reason: res ? await readErrorReason(res) : '无法连接本地服务器' });
    }
    let created;
    try { created = await res.json(); } catch { created = null; }
    checkAbort();
    if (!created || typeof created.id !== 'string' || !created.id) {
      throw new DemucsError({ stage: 'upload', reason: '服务器返回的任务无效' });
    }
    jobId = created.id;

    // 2. Poll until done.
    let failures = 0;
    for (;;) {
      await sleep(pollMs, signal);
      checkAbort();
      let job = null;
      let pollErr = null;
      try {
        const r = await fetch(`${API}/${encodeURIComponent(jobId)}`, { signal, cache: 'no-store' });
        checkAbort();
        if (r && r.status === 404) {
          throw new DemucsError({ stage: 'job', reason: '任务已被服务器清理' });
        }
        if (!r || !r.ok) throw new Error(r ? `HTTP ${r.status}` : 'no response');
        job = await r.json();
        if (!job || typeof job !== 'object') throw new Error('无效的任务状态');
      } catch (err) {
        if (err instanceof DemucsError || isAbortError(err)) throw err;
        checkAbort();
        pollErr = err;
      }
      if (pollErr) {
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) {
          throw new DemucsError({ stage: 'job', reason: '无法获取任务状态', cause: pollErr });
        }
        continue;
      }
      failures = 0;

      if (job.status === 'queued') {
        const position = Number.isFinite(job.position) ? job.position : 1;
        phase({ stage: 'queued', position });
        progress(0.05);
      } else if (job.status === 'running') {
        const p = Number.isFinite(job.progress) ? Math.min(100, Math.max(0, job.progress)) : 0;
        phase({ stage: 'running', progress: Math.round(p) });
        progress(0.05 + 0.85 * p / 100);
      } else if (job.status === 'done') {
        break;
      } else if (job.status === 'failed') {
        const reason = typeof job.error === 'string' && job.error.trim() ? job.error.trim() : '服务器分离失败';
        throw new DemucsError({ stage: 'job', reason });
      } else if (job.status === 'cancelled') {
        throw new DemucsError({ stage: 'job', reason: '任务已被服务器清理' });
      } else {
        // Unknown status: treat like a failed poll.
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) {
          throw new DemucsError({ stage: 'job', reason: '无法获取任务状态' });
        }
      }
    }

    // 3. Download, decode and map.
    phase({ stage: 'download' });
    progress(0.9);
    const total = Object.keys(STEM_SOURCES[model]).length;
    let emitted = 0;
    let rate = 0;
    const load = async (name) => {
      checkAbort();
      const r = await fetch(`${API}/${encodeURIComponent(jobId)}/${name}.wav`, { signal, cache: 'no-store' });
      checkAbort();
      if (!r || !r.ok) throw new Error(`下载 ${name} 失败（${r ? `HTTP ${r.status}` : '无响应'}）`);
      const decoded = decodeWav(await r.arrayBuffer());
      checkAbort();
      if (!rate) rate = decoded.sampleRate;
      return decoded;
    };
    const emit = (id, chs) => {
      checkAbort();
      urls[id] = createObjectURL(encode(chs, rate));
      emitted += 1;
      progress(0.9 + 0.1 * emitted / total);
    };
    let mapped;
    try {
      mapped = await mapDemucsStems({ model, load, emit });
    } catch (err) {
      checkAbort();
      if (isAbortError(err)) throw err;
      revokeAll();
      await deleteJob();
      jobId = null;
      const reason = err && err.message ? err.message : '下载 AI 音轨失败';
      throw new DemucsError({ stage: 'download', reason, cause: err });
    }
    checkAbort();

    // 4. Done: free the server copy (failure ignored), return.
    await deleteJob();
    jobId = null;
    progress(1);
    return {
      urls: { ...urls },
      bpm: mapped.bpm,
      model,
      sources: { ...STEM_SOURCES[model] },
      sampleRate: mapped.sampleRate,
      mono: mapped.mono,
      duration: mapped.duration,
    };
  } catch (err) {
    if ((signal && signal.aborted) || isAbortError(err)) {
      deleteJob({ keepalive: true });
      jobId = null;
      revokeAll();
      throw isAbortError(err) ? err : abortError();
    }
    if (err instanceof DemucsError && err.stage === 'job') {
      // failed / cancelled / gone: server-side copy is either gone or will
      // expire; a DELETE is harmless and frees it sooner.
      deleteJob();
    }
    revokeAll();
    throw err;
  }
}
