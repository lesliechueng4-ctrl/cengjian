// Demucs_Service: optional server-side AI separation via a local Demucs install.
// Node >= 18 built-ins only. Lives outside public/ so it is never served statically.
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRejectDrainer,
  lastStderrLine,
  positiveInt,
  positiveNumber,
  sendError,
  sendJson,
  truncate,
} from './server-util.js';

export const DEMUCS_MODELS = ['htdemucs', 'htdemucs_6s'];
export const MODEL_STEMS = {
  htdemucs: ['vocals', 'drums', 'bass', 'other'],
  htdemucs_6s: ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'],
};
export const UPLOAD_EXTS = ['mp4', 'm4a', 'mp3', 'wav', 'aac', 'flac', 'ogg', 'webm', 'mov', 'mkv'];
export const JOB_ID_RE = /^[0-9a-f]{32}$/;

const DEFAULT_CMD = 'demucs';
const DEFAULT_MAX_UPLOAD_MB = 2048;
const DEFAULT_TIMEOUT_MIN = 30;

/**
 * Parse DEMUCS_CMD. A value starting with "[" is a JSON array of strings;
 * otherwise it is split on whitespace, with double-quoted parts kept as one argument.
 * Returns { file, args } or null when the value cannot be parsed.
 */
export function parseDemucsCmd(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  let parts;
  if (text.startsWith('[')) {
    try {
      parts = JSON.parse(text);
    } catch {
      return null;
    }
    if (!Array.isArray(parts) || parts.some((p) => typeof p !== 'string')) return null;
  } else {
    parts = [];
    let cur = '';
    let inQuote = false;
    let hasToken = false;
    for (const ch of text) {
      if (ch === '"') {
        inQuote = !inQuote;
        hasToken = true;
      } else if (!inQuote && /\s/.test(ch)) {
        if (hasToken) parts.push(cur);
        cur = '';
        hasToken = false;
      } else {
        cur += ch;
        hasToken = true;
      }
    }
    if (inQuote) return null;
    if (hasToken) parts.push(cur);
  }
  if (parts.length === 0 || !parts[0]) return null;
  return { file: parts[0], args: parts.slice(1) };
}

/**
 * Read service configuration from the environment.
 * command is null when DEMUCS_CMD is set but unparseable (treated as unavailable).
 */
export function readConfig(env = process.env) {
  const rawCmd = env.DEMUCS_CMD;
  const command = parseDemucsCmd(rawCmd == null || rawCmd.trim() === '' ? DEFAULT_CMD : rawCmd);
  const maxMb = positiveInt(env.DEMUCS_MAX_UPLOAD_MB, DEFAULT_MAX_UPLOAD_MB);
  const timeoutMin = positiveNumber(env.DEMUCS_TIMEOUT_MIN, DEFAULT_TIMEOUT_MIN);
  return {
    command,
    maxUploadBytes: maxMb * 1024 * 1024,
    timeoutMs: Math.round(timeoutMin * 60 * 1000),
  };
}

export function isAllowedModel(m) {
  return typeof m === 'string' && DEMUCS_MODELS.includes(m);
}

export function isJobId(s) {
  return typeof s === 'string' && JOB_ID_RE.test(s);
}

/** Lower-cased extension if whitelisted, otherwise 'bin'. Never throws. */
export function safeExt(ext) {
  if (typeof ext !== 'string') return 'bin';
  const e = ext.trim().replace(/^\./, '').toLowerCase();
  return UPLOAD_EXTS.includes(e) ? e : 'bin';
}

/**
 * Paths for a job, built only from tempRoot, a server-generated id and a whitelisted
 * extension. Client-supplied names never reach the filesystem.
 */
export function jobPaths(tempRoot, id, ext) {
  if (!isJobId(id)) throw new Error('invalid job id');
  const dir = path.join(tempRoot, id);
  const outDir = path.join(dir, 'out');
  return {
    dir,
    input: path.join(dir, `input.${safeExt(ext)}`),
    outDir,
    resultDir(model) {
      if (!isAllowedModel(model)) throw new Error('invalid model');
      return path.join(outDir, model);
    },
  };
}

export function buildDemucsArgs(fixedArgs, model, paths) {
  return [...(fixedArgs || []), '-n', model, '-o', paths.outDir, '--filename', '{stem}.{ext}', paths.input];
}

/** Last tqdm-style percentage ("42%|") in text, rounded and clamped to 0..100, or null. */
export function parseProgress(text) {
  if (typeof text !== 'string') return null;
  const re = /(\d{1,3}(?:\.\d+)?)%\|/g;
  let last = null;
  let m;
  while ((m = re.exec(text)) !== null) last = m[1];
  if (last == null) return null;
  return Math.min(100, Math.max(0, Math.round(Number(last))));
}

export function defaultTempRoot() {
  return path.join(os.tmpdir(), 'cengjian-demucs');
}

// createJobQueue (task 10.2) and createDemucsService (tasks 10.4/10.5) go below.

/**
 * Pure job scheduler: no files, no processes, no timers. Runs at most one job at a time,
 * in FIFO order, and caps unfinished jobs (uploading + queued + running) at maxUnfinished.
 *
 * Lifecycle of an id inside the queue:
 *   submit(job, { uploading: true }) -> 'uploading'  (holds a slot, not yet runnable)
 *   enqueue(id)                      -> 'queued'     (upload finished, joins the FIFO)
 *   submit(job)                      -> 'queued'     (shortcut: reserve + enqueue)
 *   pump                             -> 'running'    (runner(job, done) is called)
 *   done(status) / finish(id, status) / cancel(id) -> removed (no longer unfinished)
 * Finished, failed and cancelled jobs are forgotten; the caller keeps tombstones itself.
 *
 * @param {object} opts
 * @param {(job: object, done: (status?: string) => void) => void} opts.runner
 *   Called when a job starts running. `done` ends that run; calls after the job was
 *   cancelled or already finished are ignored. `done` may be called synchronously.
 * @param {number} [opts.maxUnfinished=4]
 * @returns {{
 *   submit(job: {id: string}, opts?: {uploading?: boolean}): boolean,
 *   enqueue(id: string): boolean,
 *   finish(id: string, status?: string): boolean,
 *   cancel(id: string): string | null,
 *   position(id: string): number | null,
 *   state(id: string): 'uploading' | 'queued' | 'running' | null,
 *   unfinished(): number,
 *   runningId(): string | null,
 * }}
 *   submit: false when the cap is reached, the id is already unfinished, or job has no id.
 *   enqueue: moves an 'uploading' id into the FIFO; false otherwise.
 *   finish: ends a running job or drops an uploading/queued one (e.g. upload failed); false if unknown.
 *   cancel: removes the id and returns the state it had (caller kills the child if 'running'), or null.
 *   position: 1-based index in the waiting queue (the running job is not counted), else null.
 */
export function createJobQueue({ runner, maxUnfinished = 4 } = {}) {
  if (typeof runner !== 'function') throw new TypeError('runner must be a function');
  const entries = new Map(); // id -> { job, state }
  const waiting = []; // ids with state 'queued', FIFO
  let running = null;
  let pumping = false;

  function pump() {
    if (pumping) return; // runner may call done() synchronously; the loop below picks up
    pumping = true;
    try {
      while (running === null && waiting.length > 0) {
        const id = waiting.shift();
        const entry = entries.get(id);
        entry.state = 'running';
        running = id;
        let ended = false;
        const done = (status) => {
          if (ended) return;
          ended = true;
          if (running === id && entries.get(id) === entry) finish(id, status);
        };
        try {
          runner(entry.job, done);
        } catch {
          done('failed');
        }
      }
    } finally {
      pumping = false;
    }
  }

  function remove(id) {
    const entry = entries.get(id);
    if (!entry) return null;
    entries.delete(id);
    if (entry.state === 'queued') {
      const i = waiting.indexOf(id);
      if (i >= 0) waiting.splice(i, 1);
    }
    if (running === id) running = null;
    return entry.state;
  }

  function submit(job, { uploading = false } = {}) {
    if (!job || typeof job.id !== 'string' || !job.id) return false;
    if (entries.has(job.id) || entries.size >= maxUnfinished) return false;
    entries.set(job.id, { job, state: 'uploading' });
    if (!uploading) enqueue(job.id);
    return true;
  }

  function enqueue(id) {
    const entry = entries.get(id);
    if (!entry || entry.state !== 'uploading') return false;
    entry.state = 'queued';
    waiting.push(id);
    pump();
    return true;
  }

  // status is informational: the queue forgets the job either way.
  // eslint-disable-next-line no-unused-vars
  function finish(id, status) {
    const prev = remove(id);
    if (prev === null) return false;
    if (prev === 'running') pump();
    return true;
  }

  function cancel(id) {
    const prev = remove(id);
    if (prev === 'running') pump();
    return prev;
  }

  return {
    submit,
    enqueue,
    finish,
    cancel,
    position(id) {
      const i = waiting.indexOf(id);
      return i >= 0 ? i + 1 : null;
    },
    state(id) {
      const entry = entries.get(id);
      return entry ? entry.state : null;
    },
    unfinished: () => entries.size,
    runningId: () => running,
  };
}

export const API_PREFIX = '/api/separate';

/** How long a rejected upload may keep sending its (discarded) body before the socket is destroyed. */
const REJECT_DRAIN_MS = 10_000;

/**
 * Demucs_Service (design.md 1.1–1.6). Owns tempRoot, probes the Demucs command, accepts
 * uploads and schedules jobs through createJobQueue (one Demucs process at a time).
 *
 * @param {object} options
 * @param {{file: string, args: string[]} | null} options.command  null -> unavailable
 * @param {number} options.maxUploadBytes
 * @param {number} options.timeoutMs
 * @param {string} options.tempRoot
 * @param {number} [options.retentionMs=30 min]
 * @param {number} [options.tombstoneMs=5 min]
 * @param {number} [options.maxUnfinished=4]
 * @param {number} [options.probeTimeoutMs=10_000]
 * @param {object} [options.env]  environment for the Demucs child processes
 * @param {(msg: string) => void} [options.log=console.log]
 * @param {typeof childProcess.execFile} [options.execFile=child_process.execFile]
 */
export function createDemucsService(options = {}) {
  const {
    command = null,
    maxUploadBytes = DEFAULT_MAX_UPLOAD_MB * 1024 * 1024,
    timeoutMs = DEFAULT_TIMEOUT_MIN * 60 * 1000,
    tempRoot = defaultTempRoot(),
    retentionMs = 30 * 60 * 1000,
    tombstoneMs = 5 * 60 * 1000,
    maxUnfinished = 4,
    probeTimeoutMs = 10_000,
    env,
    log = console.log,
    execFile = childProcess.execFile,
  } = options;

  /** @type {Map<string, object>} id -> Separation_Job (see design Data Models) */
  const jobs = new Map();
  let available = false;
  let checking = false;
  let initPromise = null;
  let closed = false;

  const queue = createJobQueue({ runner: runJob, maxUnfinished });

  function warn(msg) {
    console.warn(`[demucs] ${msg}`);
  }

  async function removeDir(dir, id) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch (err) {
      warn(`删除任务 ${id} 的临时目录失败：${err && err.code ? err.code : err}`);
    }
  }

  // ---------------------------------------------------------------- init / probe (1.2)

  function probe() {
    return new Promise((resolve) => {
      if (!command || typeof command.file !== 'string' || !command.file) {
        resolve(false);
        return;
      }
      const probeOpts = { timeout: probeTimeoutMs, windowsHide: true };
      if (env) probeOpts.env = env;
      try {
        execFile(command.file, [...(command.args || []), '--help'], probeOpts, (err) => resolve(!err));
      } catch {
        resolve(false);
      }
    });
  }

  function init() {
    if (initPromise) return initPromise;
    checking = true;
    available = false;
    initPromise = (async () => {
      let rootReady = true;
      try {
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
      } catch (err) {
        warn(`清理临时目录失败：${err && err.code ? err.code : err}`);
      }
      try {
        await fs.promises.mkdir(tempRoot, { recursive: true });
      } catch (err) {
        rootReady = false;
        warn(`无法创建临时目录：${err && err.code ? err.code : err}`);
      }
      const ok = rootReady && (await probe());
      if (closed) return;
      available = ok;
      checking = false;
      log(ok
        ? '  AI 分离:  已启用 Demucs（htdemucs / htdemucs_6s）'
        : '  AI 分离:  未检测到 Demucs，将使用浏览器分离');
    })();
    return initPromise;
  }

  function status() {
    return {
      available: available && !checking,
      checking,
      models: [...DEMUCS_MODELS],
      maxUploadBytes,
      queueLength: queue.unfinished(),
    };
  }

  // ---------------------------------------------------------------- runner (1.5)

  function clearJobTimers(job) {
    if (job.timer) clearTimeout(job.timer);
    if (job.expireTimer) clearTimeout(job.expireTimer);
    job.timer = null;
    job.expireTimer = null;
  }

  /** Drop the record (if it is still this job) after ms; no timer once the service is closed. */
  function scheduleExpire(job, ms) {
    if (job.expireTimer) clearTimeout(job.expireTimer);
    job.expireTimer = null;
    if (closed) return;
    const t = setTimeout(() => {
      job.expireTimer = null;
      if (jobs.get(job.id) === job) jobs.delete(job.id);
      if (job.status === 'done') removeDir(job.paths.dir, job.id);
    }, ms);
    if (typeof t.unref === 'function') t.unref();
    job.expireTimer = t;
  }

  function timeoutMessage() {
    const min = timeoutMs / 60000;
    const n = Number.isInteger(min) ? min : Number(min.toPrecision(2));
    return `AI 分离超过 ${n} 分钟未完成，已终止`;
  }

  function failJob(job, done, message) {
    job.status = 'failed';
    job.error = truncate(message || 'AI 分离失败');
    job.child = null;
    console.error(`[demucs] 任务 ${job.id} 失败：${job.error}`);
    removeDir(job.paths.dir, job.id);
    scheduleExpire(job, tombstoneMs);
    done('failed');
  }

  async function missingStems(job) {
    const dir = job.paths.resultDir(job.model);
    for (const stem of MODEL_STEMS[job.model]) {
      try {
        const st = await fs.promises.stat(path.join(dir, `${stem}.wav`));
        if (!st.isFile()) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  /**
   * Called by the Job_Queue when a job starts: runs Demucs, tracks progress from stderr,
   * enforces the timeout and finally calls done(status) so the queue pumps the next job.
   * A cancelled job (DELETE or close) is ignored here; the canceller already updated it.
   */
  function runJob(job, done) {
    if (closed || job.cancelled || jobs.get(job.id) !== job) {
      done('cancelled');
      return;
    }
    job.status = 'running';
    job.progress = 0;
    job.error = '';
    job.timedOut = false;

    const execOpts = { windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
    if (env) execOpts.env = env;

    let child;
    const onExit = (err, _stdout, stderr) => {
      if (job.timer) clearTimeout(job.timer);
      job.timer = null;
      job.child = null;
      if (job.cancelled) {
        // DELETE / close already set the status; the directory is removed only now,
        // because the running process may still hold files open (Windows).
        removeDir(job.paths.dir, job.id);
        done('cancelled');
        return;
      }
      if (job.timedOut) {
        failJob(job, done, timeoutMessage());
        return;
      }
      if (err) {
        const code = err.code != null ? err.code : (err.signal || '未知');
        failJob(job, done, lastStderrLine(stderr) || `Demucs 退出码 ${code}`);
        return;
      }
      missingStems(job).then((missing) => {
        if (job.cancelled) {
          removeDir(job.paths.dir, job.id);
          done('cancelled');
          return;
        }
        if (missing) {
          failJob(job, done, 'Demucs 没有生成完整的音轨文件');
          return;
        }
        job.status = 'done';
        job.progress = 100;
        fs.promises.rm(job.paths.input, { force: true }).catch((e) => {
          warn(`删除任务 ${job.id} 的上传文件失败：${e && e.code ? e.code : e}`);
        });
        scheduleExpire(job, retentionMs);
        done('done');
      }, (e) => failJob(job, done, `检查输出文件失败：${e && e.code ? e.code : e}`));
    };

    try {
      child = execFile(command.file, buildDemucsArgs(command.args, job.model, job.paths), execOpts, onExit);
    } catch (err) {
      failJob(job, done, `无法启动 Demucs：${err && err.code ? err.code : err}`);
      return;
    }
    job.child = child;
    if (child && child.stderr) {
      child.stderr.on('data', (chunk) => {
        const p = parseProgress(String(chunk));
        if (p != null && p !== job.progress && job.status === 'running') job.progress = p;
      });
    }
    const t = setTimeout(() => {
      job.timer = null;
      job.timedOut = true;
      try {
        child.kill();
      } catch {
        // already gone
      }
    }, timeoutMs);
    if (typeof t.unref === 'function') t.unref();
    job.timer = t;
  }

  // ---------------------------------------------------------------- upload (1.4)

  function newJobId() {
    let id;
    do id = crypto.randomBytes(16).toString('hex');
    while (jobs.has(id));
    return id;
  }

  /**
   * Drop an upload that did not complete (over limit, client gone, write error, DELETE):
   * removes the job record, frees the queue slot and deletes its directory.
   * Safe to call more than once. Exposed to 10.5 for DELETE of an 'uploading' job.
   */
  function abortUpload(job) {
    const up = job.upload;
    if (!up || up.settled) return;
    up.settled = true;
    up.req.removeListener('data', up.onData);
    up.req.pause();
    if (jobs.get(job.id) === job) jobs.delete(job.id);
    queue.finish(job.id, 'cancelled');
    const ws = up.ws;
    const rm = () => removeDir(job.paths.dir, job.id);
    if (up.mkdirPending) {
      up.afterMkdir = rm; // directory may appear after this point; remove it once it does
    } else if (!ws || ws.closed) {
      rm();
    } else {
      ws.once('close', rm);
      ws.destroy();
    }
  }

  /** Rejects uploads mid-body (413 / 500) and drains the rest; close() kills what is still draining. */
  const drainer = createRejectDrainer({ maxExtraBytes: maxUploadBytes, drainMs: REJECT_DRAIN_MS });

  function handleUpload(req, res, url) {
    // 1. unavailable -> 503, discard body, no files
    if (!available || checking) {
      req.resume();
      sendError(res, 503, 'AI 分离不可用');
      return;
    }
    // 2. model whitelist; ext only picks the extension
    const model = url.searchParams.get('model') || '';
    if (!isAllowedModel(model)) {
      req.resume();
      sendError(res, 400, '不支持的分离模型');
      return;
    }
    const ext = safeExt(url.searchParams.get('ext'));
    // 3. unfinished cap (includes uploads in progress)
    if (queue.unfinished() >= maxUnfinished) {
      req.resume();
      sendError(res, 429, 'AI 分离任务过多，请稍后再试');
      return;
    }
    // 4. declared size over limit
    const declared = req.headers['content-length'];
    if (declared !== undefined && /^\d+$/.test(declared) && Number(declared) > maxUploadBytes) {
      drainer.reject(req, res, 413, '文件超过 AI 分离的大小上限');
      return;
    }

    // 5. reserve a slot as 'uploading', then stream to tempRoot/<id>/input.<ext>
    const id = newJobId();
    const job = {
      id,
      model,
      ext,
      status: 'uploading',
      progress: 0,
      error: '',
      createdAt: Date.now(),
      paths: jobPaths(tempRoot, id, ext),
      child: null,
      timer: null,
      expireTimer: null,
      upload: null,
    };
    if (!queue.submit(job, { uploading: true })) {
      req.resume();
      sendError(res, 429, 'AI 分离任务过多，请稍后再试');
      return;
    }
    jobs.set(id, job);

    let bytes = 0;
    const up = {
      req,
      ws: null,
      settled: false,
      mkdirPending: true,
      afterMkdir: null,
      onData: null,
    };
    job.upload = up;

    // 7. client disconnects before the body is complete
    const onGone = () => {
      if (!up.settled && !req.complete) abortUpload(job);
    };
    req.on('aborted', onGone);
    req.on('close', onGone);
    req.on('error', onGone);

    // 6. byte counting covers chunked uploads without Content-Length
    up.onData = (chunk) => {
      if (up.settled) return;
      bytes += chunk.length;
      if (bytes > maxUploadBytes) {
        abortUpload(job);
        drainer.reject(req, res, 413, '文件超过 AI 分离的大小上限');
        return;
      }
      if (!up.ws.write(chunk)) req.pause();
    };

    const fail = (err) => {
      if (up.settled) return;
      console.error(`[demucs] 任务 ${id} 上传失败：${err && err.code ? err.code : err}`);
      abortUpload(job);
      drainer.reject(req, res, 500, '保存上传文件失败');
    };

    fs.promises.mkdir(job.paths.dir, { recursive: true }).then(() => {
      up.mkdirPending = false;
      if (up.settled) {
        if (up.afterMkdir) up.afterMkdir();
        return;
      }
      const ws = fs.createWriteStream(job.paths.input);
      up.ws = ws;
      ws.on('error', fail);
      ws.on('drain', () => {
        if (!up.settled) req.resume();
      });
      // 8. file fully written -> queued, 202, pump
      ws.on('finish', () => {
        if (up.settled) return;
        if (res.destroyed) {
          abortUpload(job);
          return;
        }
        up.settled = true;
        req.removeListener('aborted', onGone);
        req.removeListener('close', onGone);
        job.upload = null;
        if (closed) return;
        let position = 1;
        for (const other of jobs.values()) if (queue.state(other.id) === 'queued') position++;
        job.status = 'queued';
        sendJson(res, 202, { id, status: 'queued', position });
        queue.enqueue(id); // pumps; runJob may start this job right away
      });
      req.on('data', up.onData);
      req.on('end', () => {
        if (!up.settled) ws.end();
      });
    }, (err) => {
      up.mkdirPending = false;
      fail(err);
    });
  }

  // ---------------------------------------------------------------- job routes (1.3 / 1.6)

  function jobJson(job) {
    const out = { id: job.id, model: job.model };
    if (job.status === 'uploading' || job.status === 'queued') {
      out.status = 'queued';
      const pos = queue.position(job.id);
      if (pos != null) out.position = pos;
    } else {
      out.status = job.status;
    }
    if (job.status === 'running') out.progress = Math.min(100, Math.max(0, Math.round(job.progress || 0)));
    if (job.status === 'failed') out.error = job.error || 'AI 分离失败';
    if (job.status === 'done') out.stems = [...MODEL_STEMS[job.model]];
    return out;
  }

  /** DELETE in any state (design 1.6). The record stays as a 'cancelled' tombstone. */
  function cancelJob(job) {
    if (job.status === 'failed' || job.status === 'cancelled') return; // already final
    const prev = job.status;
    job.cancelled = true;
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    if (prev === 'uploading') {
      abortUpload(job); // removes record, frees slot, deletes the directory
      queue.finish(job.id, 'cancelled'); // no-op unless the upload had already settled
      jobs.set(job.id, job);
    } else if (prev === 'running') {
      const child = job.child;
      queue.cancel(job.id); // frees the slot and pumps the next job
      if (child) {
        try {
          child.kill();
        } catch {
          // already gone; onExit still runs and removes the directory
        }
      } else {
        removeDir(job.paths.dir, job.id); // between exit and the result check
      }
    } else {
      queue.cancel(job.id); // 'queued' leaves the FIFO; no-op for 'done'
      removeDir(job.paths.dir, job.id);
    }
    job.status = 'cancelled';
    job.progress = 0;
    scheduleExpire(job, tombstoneMs);
  }

  function sendStem(req, res, job, stemFile) {
    const m = /^([a-z0-9_]+)\.wav$/.exec(stemFile);
    const stem = m && m[1];
    if (job.status !== 'done' || !stem || !MODEL_STEMS[job.model].includes(stem)) {
      sendError(res, 404, '未找到');
      return;
    }
    const file = path.join(job.paths.resultDir(job.model), `${stem}.wav`);
    fs.promises.stat(file).then((st) => {
      if (!st.isFile() || job.status !== 'done' || jobs.get(job.id) !== job) {
        sendError(res, 404, '未找到');
        return;
      }
      const stream = fs.createReadStream(file);
      stream.once('open', () => {
        if (res.headersSent || res.destroyed) {
          stream.destroy();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': st.size,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        stream.pipe(res);
      });
      stream.once('error', () => {
        if (!res.headersSent) sendError(res, 404, '未找到');
        else res.destroy();
      });
      res.once('close', () => stream.destroy());
    }, () => sendError(res, 404, '未找到'));
  }

  /**
   * GET /api/separate/<id>, GET /api/separate/<id>/<stem>.wav, DELETE /api/separate/<id>,
   * 405 for other methods, 404 for invalid/unknown ids or paths.
   */
  function handleJobRoute(req, res, rest) {
    req.resume();
    const parts = rest.split('/');
    if (parts.length > 2) {
      sendError(res, 404, '未找到');
      return;
    }
    const allow = parts.length === 1 ? 'GET, DELETE' : 'GET';
    if (req.method !== 'GET' && !(parts.length === 1 && req.method === 'DELETE')) {
      methodNotAllowed(req, res, allow);
      return;
    }
    const id = parts[0];
    const job = isJobId(id) ? jobs.get(id) : undefined;
    if (!job) {
      sendError(res, 404, '未找到');
      return;
    }
    if (parts.length === 2) {
      sendStem(req, res, job, parts[1]);
      return;
    }
    if (req.method === 'DELETE') {
      cancelJob(job);
      res.writeHead(204, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end();
      return;
    }
    sendJson(res, 200, jobJson(job));
  }

  // ---------------------------------------------------------------- dispatch (1.3)

  function methodNotAllowed(req, res, allow) {
    req.resume();
    sendError(res, 405, '不支持的请求方法', { Allow: allow });
  }

  function handle(req, res) {
    const rawPath = (req.url || '').split('?')[0];
    if (rawPath !== API_PREFIX && !rawPath.startsWith(`${API_PREFIX}/`)) return false;
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      req.resume();
      sendError(res, 404, '未找到');
      return true;
    }
    const pathname = url.pathname;
    if (pathname === API_PREFIX) {
      if (req.method === 'POST') handleUpload(req, res, url);
      else methodNotAllowed(req, res, 'POST');
      return true;
    }
    if (pathname === `${API_PREFIX}/status`) {
      if (req.method === 'GET') {
        req.resume();
        sendJson(res, 200, status());
      } else {
        methodNotAllowed(req, res, 'GET');
      }
      return true;
    }
    handleJobRoute(req, res, pathname.slice(API_PREFIX.length + 1));
    return true;
  }

  // ---------------------------------------------------------------- close

  /** Stops every Demucs process and clears all timers. Resolves once the children exited. */
  async function close() {
    closed = true;
    available = false;
    checking = false;
    const exits = [];
    const all = [...jobs.values()];
    // Drop waiting jobs first so killing the running one does not start another process.
    for (const job of all) {
      if (queue.state(job.id) === 'queued') {
        job.cancelled = true;
        queue.cancel(job.id);
      }
    }
    for (const job of all) {
      if (job.upload) abortUpload(job);
      clearJobTimers(job);
      const child = job.child;
      if (child) {
        job.cancelled = true;
        if (child.exitCode === null && child.signalCode === null) {
          exits.push(new Promise((resolve) => {
            child.once('close', resolve);
            child.once('error', resolve);
          }));
        }
        try {
          child.kill();
        } catch {
          // already gone
        }
      }
    }
    if (exits.length) {
      let cap;
      await Promise.race([
        Promise.all(exits),
        new Promise((resolve) => {
          cap = setTimeout(resolve, 5000);
          if (typeof cap.unref === 'function') cap.unref();
        }),
      ]);
      clearTimeout(cap);
    }
    for (const job of jobs.values()) clearJobTimers(job);
      drainer.killAll();
  }

  return {
    init,
    status,
    handle,
    close,
    // Internals shared with task 10.5 (runner, DELETE) and tests; not part of the HTTP API.
    _internal: { jobs, queue, abortUpload, removeDir, options: { command, timeoutMs, retentionMs, tombstoneMs, env } },
  };
}
