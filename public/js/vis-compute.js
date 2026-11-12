// Browser driver for the Vis_Analyzer: reads each cached Derived_Stem WAV and
// analyzes it in a module Worker (one Stem at a time), falling back to the main
// thread when the Worker cannot start. All globals are injectable for tests.
import { VIS_STEM_IDS, createVisData } from './vis-data.js';
import { decodeWav as defaultDecodeWav } from './wav.js';
import { analyzeStem as defaultAnalyzeStem } from './vis-analysis.js';

export const VIS_COMPUTE_ERROR = '可视化数据生成失败';

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('已取消', 'AbortError');
  const err = new Error('已取消');
  err.name = 'AbortError';
  return err;
}

function defaultCreateWorker() {
  if (typeof Worker === 'undefined') throw new Error('Worker unsupported');
  return new Worker(new URL('./vis-analysis.worker.js', import.meta.url), { type: 'module' });
}

const defaultYield = () => new Promise((r) => setTimeout(r, 0));

/**
 * Worker session. `ready` resolves true after the worker's 'ready' message, or
 * false when construction fails / the worker errors before 'ready' (fallback).
 * After 'ready', an error event fails the in-flight Stem and marks the worker dead.
 */
function startWorker(createWorker) {
  let worker;
  try {
    worker = createWorker();
  } catch {
    return null;
  }
  const s = { worker, started: false, dead: false, pending: null, resolveReady: null };
  s.ready = new Promise((r) => { s.resolveReady = r; });
  worker.onmessage = ({ data }) => {
    if (!data || s.dead) return;
    if (data.type === 'ready') {
      s.started = true;
      s.resolveReady(true);
      return;
    }
    const p = s.pending;
    if (!p || data.id !== p.id) return;
    s.pending = null;
    if (data.type === 'result') {
      const r = { env: data.env, onsets: data.onsets ?? null, duration: data.duration };
      if (data.marks) r.marks = data.marks;
      p.resolve(r);
    }
    else p.resolve(null); // 'stem-error' → skip this Stem
  };
  worker.onerror = (e) => {
    e?.preventDefault?.();
    if (s.dead) return;
    s.dead = true;
    try { worker.terminate(); } catch { /* ignore */ }
    if (!s.started) s.resolveReady(false);
    const p = s.pending;
    s.pending = null;
    p?.resolve(null);
  };
  s.analyze = (id, wav) => new Promise((resolve) => {
    s.pending = { id, resolve };
    worker.postMessage({ id, wav }, [wav]);
  });
  s.terminate = () => {
    s.dead = true;
    try { worker.terminate(); } catch { /* ignore */ }
    s.resolveReady(false);
    s.pending?.resolve(null);
    s.pending = null;
  };
  return s;
}

/**
 * Reads urls[id] (in VIS_STEM_IDS order) and analyzes one Stem at a time in a
 * Worker (1.8). Worker construction failure or an error before 'ready' → main
 * thread, awaiting yieldFn() between Stems (1.9). A Stem that cannot be read or
 * decoded is skipped (1.10). Abort → terminate the worker and throw AbortError
 * without partial results (2.3). No Stem succeeded → Error('可视化数据生成失败')
 * (2.6). Blob URLs in `urls` are never modified or revoked (2.8).
 * @param {Record<string,string>} urls  entry.cache.urls
 * @param {{ signal?: AbortSignal, fetch?: typeof fetch, createWorker?: () => Worker,
 *           yieldFn?: () => Promise<void>, decodeWav?: Function, analyzeStem?: Function }} [opts]
 * @returns {Promise<object>} Vis_Data
 */
export async function computeVisData(urls, opts = {}) {
  const {
    signal,
    fetch: fetchFn = globalThis.fetch?.bind(globalThis),
    createWorker = defaultCreateWorker,
    yieldFn = defaultYield,
    decodeWav = defaultDecodeWav,
    analyzeStem = defaultAnalyzeStem,
  } = opts;

  if (signal?.aborted) throw abortError();

  // Every await is raced against the abort signal so cancellation is immediate.
  let onAbort;
  const abortPromise = new Promise((_, reject) => {
    onAbort = () => reject(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  abortPromise.catch(() => {});
  const guard = (p) => (signal ? Promise.race([p, abortPromise]) : p);

  let session = startWorker(createWorker);
  let useWorker = !!session;

  const mainThreadAnalyze = (id, wav) => {
    try {
      const { channels, sampleRate } = decodeWav(wav);
      return analyzeStem(id, channels, sampleRate);
    } catch {
      return null;
    }
  };

  const results = {};
  let analyzedOnMain = false;
  try {
    for (const id of VIS_STEM_IDS) {
      const url = urls && Object.prototype.hasOwnProperty.call(urls, id) ? urls[id] : null;
      if (typeof url !== 'string' || !url) continue;

      let wav;
      try {
        const res = await guard(Promise.resolve().then(() => fetchFn(url)));
        if (!res || res.ok === false) continue;
        wav = await guard(Promise.resolve().then(() => res.arrayBuffer()));
      } catch (err) {
        if (signal?.aborted) throw abortError();
        continue; // unreadable Stem → skip
      }
      if (signal?.aborted) throw abortError();

      if (useWorker && !(await guard(session.ready))) useWorker = false;
      if (useWorker && session.dead) useWorker = false;

      let r;
      if (useWorker) {
        r = await guard(session.analyze(id, wav));
      } else {
        // Main thread: yield between Stems so the UI stays responsive.
        if (analyzedOnMain) await guard(Promise.resolve().then(() => yieldFn()));
        if (signal?.aborted) throw abortError();
        r = mainThreadAnalyze(id, wav);
        analyzedOnMain = true;
      }
      wav = null;
      if (signal?.aborted) throw abortError();
      if (r && r.env) results[id] = r;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    session?.terminate();
    session = null;
  }

  if (signal?.aborted) throw abortError();
  const visData = createVisData(results);
  if (Object.keys(visData.stems).length === 0 || !(visData.frames > 0) || !(visData.duration > 0)) {
    throw new Error(VIS_COMPUTE_ERROR);
  }
  return visData;
}
