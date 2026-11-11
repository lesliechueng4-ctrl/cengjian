// Export_Service 集成测试（design.md「export-service.test.mjs」一节，Requirement 14.2）。
// 真实 HTTP 服务 + 假 FFmpeg（process.execPath + tests/fixtures/fake-ffmpeg.mjs）。
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExportService } from '../export-service.js';
import { createDemucsService } from '../demucs-service.js';
import { createServer } from '../server.js';
import { listenFetchable } from './helpers/listen.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-ffmpeg.mjs', import.meta.url));
const FAKE_CMD = { file: process.execPath, args: [FIXTURE] };
const ENABLED_MSG = '已启用 FFmpeg';
const FALLBACK_MSG = '未检测到 FFmpeg';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls fn until it returns a truthy value; throws after timeout. */
async function waitFor(fn, message, { timeout = 8000, interval = 20 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${message}`);
    await sleep(interval);
  }
}

const exists = (p) => fs.existsSync(p);
const listDir = (p) => {
  try {
    return fs.statSync(p).isDirectory() ? fs.readdirSync(p) : [];
  } catch {
    return [];
  }
};
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** A minimal RIFF/WAVE buffer of `bytes` bytes (>= 12). */
function makeWav(bytes = 64) {
  const buf = Buffer.alloc(bytes, 0x11);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(bytes - 8, 4);
  buf.write('WAVE', 8, 'ascii');
  return buf;
}

/** A fake source file whose first line drives the Fake_FFmpeg probe output. */
function makeSource(header = 'FAKEVIDEO codec=h264 duration=00:00:02.00', extra = 256) {
  const tail = crypto.randomBytes(extra);
  return Buffer.concat([Buffer.from(`${header}\n`, 'latin1'), tail]);
}

/** Does arr contain seq as a contiguous run? */
function hasSeq(arr, seq) {
  for (let i = 0; i + seq.length <= arr.length; i++) {
    if (seq.every((v, k) => arr[i + k] === v)) return true;
  }
  return false;
}

/**
 * Creates an Export_Service with its own mkdtemp tempRoot, recording every execFile / spawn
 * call (options + child), and an HTTP server on a fetch-allowed port. Closed in t.after.
 */
async function setup(t, { mode = 'ok', init = true, ...opts } = {}) {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cengjian-export-test-'));
  const logs = [];
  const calls = []; // { kind: 'execFile' | 'spawn', args, options, child }
  const execFile = (file, args, options, cb) => {
    const child = childProcess.execFile(file, args, options, cb);
    calls.push({ kind: 'execFile', file, args, options, child });
    return child;
  };
  const spawn = (file, args, options) => {
    const child = childProcess.spawn(file, args, options);
    calls.push({ kind: 'spawn', file, args, options, child });
    return child;
  };
  const svc = createExportService({
    command: FAKE_CMD,
    maxUploadBytes: 1024 * 1024,
    timeoutMs: 20_000,
    tempRoot,
    retentionMs: 60_000,
    tombstoneMs: 60_000,
    probeTimeoutMs: 8000,
    env: { ...process.env, FAKE_FFMPEG_MODE: mode },
    log: (m) => logs.push(m),
    execFile,
    spawn,
    ...opts,
  });
  const extra = opts.demucs ? { demucs: opts.demucs } : {};
  const server = createServer(undefined, { exporter: svc, ...extra });
  await listenFetchable(server);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await svc.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.promises.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  if (init) await svc.init();
  const api = `${base}/api/export`;
  const getJson = async (p) => {
    const res = await fetch(`${api}${p}`);
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  /** POST wav + source; query overrides the default ?ext=mp4&wavBytes=<wav.length>. */
  const upload = async ({ wav = makeWav(), source = makeSource(), query, body } = {}) => {
    const q = query ?? `ext=mp4&wavBytes=${wav.length}`;
    const res = await fetch(`${api}?${q}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: body ?? Buffer.concat([wav, source]),
    });
    return { status: res.status, body: await res.json() };
  };
  const del = async (id) => (await fetch(`${api}/${id}`, { method: 'DELETE' })).status;
  return { svc, server, port, base, api, tempRoot, logs, calls, getJson, upload, del };
}

const jobDir = (ctx, id) => path.join(ctx.tempRoot, id);

async function waitStatus(ctx, id, statuses, opts) {
  const want = [].concat(statuses);
  return waitFor(async () => {
    const r = await ctx.getJson(`/${id}`);
    return want.includes(r.body.status) ? r.body : null;
  }, `job ${id} -> ${want.join('/')}`, opts);
}

/** Uploads, waits for done, downloads result.mp4 and parses the FAKEMP4 record. */
async function runToResult(ctx, source, wav = makeWav()) {
  const post = await ctx.upload({ wav, source });
  assert.equal(post.status, 202, JSON.stringify(post.body));
  const { id } = post.body;
  const final = await waitStatus(ctx, id, ['done', 'failed']);
  assert.equal(final.status, 'done', JSON.stringify(final));
  const res = await fetch(`${ctx.api}/${id}/result.mp4`);
  assert.equal(res.status, 200);
  const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
  assert.ok(text.startsWith('FAKEMP4 '), text.slice(0, 40));
  return { id, res, record: JSON.parse(text.slice('FAKEMP4 '.length)) };
}

const childGone = (child) => child.exitCode !== null || child.signalCode !== null;
const waitExit = (child, ms = 5000) =>
  Promise.race([
    new Promise((r) => (childGone(child) ? r() : child.once('exit', r))),
    sleep(ms).then(() => assert.fail('child process was not terminated')),
  ]);

/** Raw http.request; returns { req, response: Promise<{ status, text }> }. */
function rawPost(ctx, pathAndQuery, headers = {}) {
  const req = http.request({ host: '127.0.0.1', port: ctx.port, method: 'POST', path: pathAndQuery, headers });
  req.on('error', () => {});
  const response = new Promise((resolve) => {
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
  });
  return { req, response };
}

// ---------------------------------------------------------------- startup check (6.1–6.3, 6.6)

test('startup check: ok -> available, logs enabled message', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const r = await ctx.getJson('/status');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { available: true, checking: false, maxUploadBytes: 1024 * 1024, queueLength: 0 });
  assert.match(r.headers.get('content-type'), /^application\/json/);
  assert.equal(ctx.logs.length, 1);
  assert.ok(ctx.logs[0].includes(ENABLED_MSG), ctx.logs[0]);
  const version = ctx.calls.find((c) => c.args.includes('-version'));
  assert.ok(version && version.kind === 'execFile');
  assert.equal(version.options.timeout, 8000);
});

test('startup check: probefail -> unavailable with exit code reason', async (t) => {
  const ctx = await setup(t, { mode: 'probefail' });
  assert.equal(ctx.svc.status().available, false);
  assert.equal(ctx.logs.length, 1);
  assert.ok(ctx.logs[0].includes(FALLBACK_MSG) && ctx.logs[0].includes('退出码 1'), ctx.logs[0]);
});

test('startup check: missing command -> unavailable (ENOENT)', async (t) => {
  const missing = path.join(os.tmpdir(), 'cengjian-no-such-ffmpeg-command-xyz.exe');
  const ctx = await setup(t, { command: { file: missing, args: [] } });
  assert.equal(ctx.svc.status().available, false);
  assert.ok(ctx.logs.some((m) => m.includes(FALLBACK_MSG) && m.includes('ENOENT')), ctx.logs.join('\n'));
});

test('startup check: command null -> unavailable with parse reason', async (t) => {
  const ctx = await setup(t, { command: null, commandError: 'FFMPEG_CMD 无法解析' });
  assert.equal(ctx.svc.status().available, false);
  assert.ok(ctx.logs.some((m) => m.includes(FALLBACK_MSG) && m.includes('FFMPEG_CMD 无法解析')), ctx.logs.join('\n'));
});

test('startup check: probehang times out; checking is true while probing', async (t) => {
  const ctx = await setup(t, { mode: 'probehang', probeTimeoutMs: 200, init: false });
  const p = ctx.svc.init();
  assert.deepEqual(
    { available: ctx.svc.status().available, checking: ctx.svc.status().checking },
    { available: false, checking: true },
  );
  const during = await ctx.getJson('/status');
  assert.equal(during.body.checking, true);
  assert.equal(during.body.available, false);
  // POST while checking -> 503
  assert.equal((await ctx.upload()).status, 503);
  await p;
  assert.equal(ctx.svc.status().checking, false);
  assert.equal(ctx.svc.status().available, false);
  assert.equal(ctx.logs.length, 1);
  assert.ok(ctx.logs[0].includes(FALLBACK_MSG) && ctx.logs[0].includes('检测超时'), ctx.logs[0]);
});

// ---------------------------------------------------------------- 503 (7.3, 6.7)

test('unavailable: POST -> 503 without files; static files and /api/separate still work', async (t) => {
  const demucsRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cengjian-export-demucs-'));
  const demucs = createDemucsService({ command: null, tempRoot: demucsRoot, log: () => {} });
  t.after(async () => {
    await demucs.close();
    await fs.promises.rm(demucsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await demucs.init();
  const ctx = await setup(t, { mode: 'probefail', demucs });
  const r = await ctx.upload({ source: makeSource(undefined, 8192) });
  assert.equal(r.status, 503);
  assert.ok(typeof r.body.error === 'string' && r.body.error);
  await sleep(100);
  assert.deepEqual(listDir(ctx.tempRoot), []);
  assert.equal(ctx.svc._internal.jobs.size, 0);
  assert.equal(ctx.svc.status().queueLength, 0);

  const page = await fetch(`${ctx.base}/index.html`);
  assert.equal(page.status, 200);
  await page.arrayBuffer();
  const sep = await fetch(`${ctx.base}/api/separate/status`);
  assert.equal(sep.status, 200);
  assert.equal(typeof (await sep.json()).available, 'boolean');
});

// ---------------------------------------------------------------- full flow (7.2, 7.9–7.12, 8.x, 10.3, 10.4)

test('full flow: upload -> done -> result.mp4 (inputs byte-identical) -> DELETE', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const wav = makeWav(4096);
  const source = makeSource('FAKEVIDEO codec=h264 duration=00:00:02.00', 20_000);
  const post = await ctx.upload({ wav, source });
  assert.equal(post.status, 202, JSON.stringify(post.body));
  const { id } = post.body;
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(post.body.status, 'queued');
  assert.equal(post.body.position, 1);

  const final = await waitStatus(ctx, id, ['done', 'failed']);
  assert.deepEqual(final, { id, status: 'done' });

  const res = await fetch(`${ctx.api}/${id}/result.mp4`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(Number(res.headers.get('content-length')), buf.length);
  const text = buf.toString('utf8');
  assert.ok(text.startsWith('FAKEMP4 '));
  const record = JSON.parse(text.slice('FAKEMP4 '.length));
  // Input 0 is the source, input 1 the stem WAV; both byte-identical to the upload.
  assert.deepEqual(record.inputs, [
    { bytes: source.length, sha256: sha256(source) },
    { bytes: wav.length, sha256: sha256(wav) },
  ]);
  const { argv } = record;
  assert.ok(hasSeq(argv, ['-map', '0:v:0']), argv.join(' '));
  assert.ok(hasSeq(argv, ['-map', '1:a:0']));
  assert.ok(hasSeq(argv, ['-c:v', 'copy']));
  assert.ok(!argv.includes('libx264'));
  assert.ok(!argv.includes('-tag:v'));
  assert.ok(hasSeq(argv, ['-af', 'apad']));
  assert.ok(hasSeq(argv, ['-c:a', 'aac', '-b:a', '192k']));
  assert.ok(hasSeq(argv, ['-t', '2']));
  assert.ok(!argv.includes('-shortest'));
  assert.ok(hasSeq(argv, ['-movflags', '+faststart']));
  assert.ok(!argv.some((a) => /^0:a/.test(a)), 'original audio is never mapped');
  // Paths are server-chosen: tempRoot/<id>/input.mp4, audio.wav, output.mp4.
  const dir = jobDir(ctx, id);
  assert.ok(argv.includes(path.join(dir, 'input.mp4')));
  assert.ok(argv.includes(path.join(dir, 'audio.wav')));
  assert.equal(argv[argv.length - 1], path.join(dir, 'output.mp4'));

  // Uploads deleted, only the result kept (10.3).
  await waitFor(() => listDir(dir).join() === 'output.mp4', 'only output.mp4 left');
  assert.equal(ctx.svc.status().queueLength, 0);

  assert.equal(await ctx.del(id), 204);
  await waitFor(() => !exists(dir), 'job dir removed');
  assert.equal((await fetch(`${ctx.api}/${id}/result.mp4`)).status, 404);
  assert.equal((await ctx.getJson(`/${id}`)).body.status, 'cancelled');
});

// ---------------------------------------------------------------- codec rules (8.2, 8.3, 8.5, 8.7, 8.8, 9.3)

test('HEVC: copy with hvc1 tag', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const { record } = await runToResult(ctx, makeSource('FAKEVIDEO codec=hevc duration=00:00:03.50'));
  assert.ok(hasSeq(record.argv, ['-c:v', 'copy']));
  assert.ok(hasSeq(record.argv, ['-tag:v', 'hvc1']));
  assert.ok(hasSeq(record.argv, ['-t', '3.5']));
});

test('VP9: re-encoded with libx264 veryfast crf 20 yuv420p', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const { record } = await runToResult(ctx, makeSource('FAKEVIDEO codec=vp9 duration=00:00:01.00'));
  assert.ok(hasSeq(record.argv, ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']));
  assert.ok(!hasSeq(record.argv, ['-c:v', 'copy']));
  assert.ok(!record.argv.includes('-tag:v'));
});

test('duration N/A: -shortest instead of -t, running progress is null', async (t) => {
  const ctx = await setup(t, { mode: 'slow' });
  const post = await ctx.upload({ source: makeSource('FAKEVIDEO codec=h264 duration=N/A') });
  assert.equal(post.status, 202);
  const { id } = post.body;
  // Progress is 0 while probing; once the mux runs without a known duration it is null.
  await waitFor(() => ctx.calls.some((c) => c.kind === 'spawn'), 'mux started', { interval: 5 });
  const running = (await ctx.getJson(`/${id}`)).body;
  assert.equal(running.status, 'running');
  assert.ok('progress' in running);
  assert.equal(running.progress, null);
  await waitFor(async () => {
    const r = await ctx.getJson(`/${id}`);
    if (r.body.status === 'running') assert.equal(r.body.progress, null);
    return r.body.status === 'done';
  }, 'done');
  const res = await fetch(`${ctx.api}/${id}/result.mp4`);
  const record = JSON.parse((await res.text()).slice('FAKEMP4 '.length));
  assert.ok(record.argv.includes('-shortest'));
  assert.ok(!record.argv.includes('-t'));
  assert.ok(hasSeq(record.argv, ['-af', 'apad']));
});

test('known duration: running progress is an integer 0..100 that does not go down', async (t) => {
  const ctx = await setup(t, { mode: 'slow' });
  const post = await ctx.upload({ source: makeSource('FAKEVIDEO codec=h264 duration=00:00:10.00') });
  const { id } = post.body;
  const seen = [];
  await waitFor(async () => {
    const r = await ctx.getJson(`/${id}`);
    if (r.body.status === 'running') {
      assert.ok(Number.isInteger(r.body.progress) && r.body.progress >= 0 && r.body.progress <= 100);
      seen.push(r.body.progress);
    }
    return r.body.status === 'done';
  }, 'done', { interval: 30 });
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], `${seen}`);
  assert.ok(seen.some((p) => p > 0), `progress never rose: ${seen}`);
});

test('attached pic first: maps 0:v:1', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const { record } = await runToResult(ctx, makeSource('FAKEVIDEO codec=h264 duration=00:00:01.00 attached=1'));
  assert.ok(hasSeq(record.argv, ['-map', '0:v:1']), record.argv.join(' '));
  assert.ok(hasSeq(record.argv, ['-c:v', 'copy']));
});

test('no video stream: failed 文件里没有画面, dir removed', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const post = await ctx.upload({ source: makeSource('FAKEVIDEO codec=none duration=00:00:01.00') });
  assert.equal(post.status, 202);
  const { id } = post.body;
  const body = await waitStatus(ctx, id, ['failed', 'done']);
  assert.deepEqual(body, { id, status: 'failed', error: '文件里没有画面' });
  await waitFor(() => !exists(jobDir(ctx, id)), 'failed dir removed');
  assert.ok(!ctx.calls.some((c) => c.kind === 'spawn'), 'mux never started');
  assert.equal((await fetch(`${ctx.api}/${id}/result.mp4`)).status, 404);
});

test('unreadable source: failed with the FFmpeg probe error line', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const post = await ctx.upload({ source: Buffer.from('not a video at all') });
  const body = await waitStatus(ctx, post.body.id, ['failed', 'done']);
  assert.equal(body.status, 'failed');
  assert.ok(body.error.includes('Invalid data found when processing input'), body.error);
});

// ---------------------------------------------------------------- 400 (7.4)

test('400: bad query parameters, no files written', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const wav = makeWav();
  for (const query of [
    `wavBytes=${wav.length}`,
    `ext=exe&wavBytes=${wav.length}`,
    'ext=mp4',
    'ext=mp4&wavBytes=abc',
  ]) {
    const r = await ctx.upload({ wav, query });
    assert.equal(r.status, 400, query);
    assert.ok(r.body.error, query);
  }
  await sleep(50);
  assert.deepEqual(listDir(ctx.tempRoot), []);
  assert.equal(ctx.svc._internal.jobs.size, 0);
  assert.equal(ctx.svc.status().queueLength, 0);
});

test('400: WAV header is not RIFF/WAVE, even with a large body; dir removed', async (t) => {
  const ctx = await setup(t, { mode: 'ok', maxUploadBytes: 512 * 1024 });
  const wav = Buffer.alloc(64, 0x22); // no RIFF header
  const r = await ctx.upload({ wav, source: makeSource(undefined, 400 * 1024) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, '音轨不是 WAV 格式');
  await waitFor(() => listDir(ctx.tempRoot).length === 0, 'upload dir removed');
  assert.equal(ctx.svc._internal.jobs.size, 0);
  assert.equal(ctx.svc.status().queueLength, 0);
});

test('400: body contains only the WAV (declared and chunked); dir removed', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const wav = makeWav(256);
  const r = await ctx.upload({ wav, body: wav });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, '缺少原文件');

  // Without Content-Length the check happens when the body ends.
  const { req, response } = rawPost(ctx, `/api/export?ext=mp4&wavBytes=${wav.length}`, {
    'Transfer-Encoding': 'chunked',
  });
  req.write(wav.subarray(0, 100));
  await sleep(30);
  req.end(wav.subarray(100));
  const rr = await response;
  assert.equal(rr.status, 400, rr.text);
  assert.equal(JSON.parse(rr.text).error, '缺少原文件');
  await waitFor(() => listDir(ctx.tempRoot).length === 0, 'upload dir removed');
  assert.equal(ctx.svc._internal.jobs.size, 0);
  assert.equal(ctx.svc.status().queueLength, 0);
});

// ---------------------------------------------------------------- 404 (7.7, 7.11)

test('404: malformed id, unknown id, result of an unfinished job', async (t) => {
  const ctx = await setup(t, { mode: 'hang' });
  assert.equal((await fetch(`${ctx.api}/xyz`)).status, 404);
  assert.equal((await fetch(`${ctx.api}/xyz`, { method: 'DELETE' })).status, 404);
  const unknown = '0123456789abcdef0123456789abcdef';
  assert.equal((await fetch(`${ctx.api}/${unknown}`)).status, 404);
  assert.equal((await fetch(`${ctx.api}/${unknown}/result.mp4`)).status, 404);

  const post = await ctx.upload();
  const { id } = post.body;
  await waitStatus(ctx, id, 'running');
  const res = await fetch(`${ctx.api}/${id}/result.mp4`);
  assert.equal(res.status, 404);
  await res.arrayBuffer();
  assert.equal((await fetch(`${ctx.api}/${id}/other.mp4`)).status, 404);
});

// ---------------------------------------------------------------- 413 (7.5)

test('413: declared Content-Length over the limit; no files', async (t) => {
  const ctx = await setup(t, { mode: 'ok', maxUploadBytes: 4096 });
  const wav = makeWav(64);
  const r = await ctx.upload({ wav, source: makeSource(undefined, 4096) });
  assert.equal(r.status, 413);
  assert.ok(r.body.error);
  await sleep(50);
  assert.deepEqual(listDir(ctx.tempRoot), []);
  assert.equal(ctx.svc._internal.jobs.size, 0);
});

test('413: chunked upload (no Content-Length) exceeding the limit; partial files removed', async (t) => {
  const ctx = await setup(t, { mode: 'ok', maxUploadBytes: 4096 });
  const wav = makeWav(64);
  const body = Buffer.concat([wav, makeSource(undefined, 4600)]);
  const { req, response } = rawPost(ctx, `/api/export?ext=mp4&wavBytes=${wav.length}`, {
    'Transfer-Encoding': 'chunked',
  });
  for (let off = 0; off < body.length; off += 512) {
    req.write(body.subarray(off, off + 512));
    await sleep(2);
  }
  req.end();
  const r = await response;
  assert.equal(r.status, 413, r.text);
  assert.ok(JSON.parse(r.text).error);
  await waitFor(() => listDir(ctx.tempRoot).length === 0, 'partial upload removed');
  assert.equal(ctx.svc._internal.jobs.size, 0);
  assert.equal(ctx.svc.status().queueLength, 0);
});

// ---------------------------------------------------------------- 429 (7.6)

test('429: four unfinished jobs fill the slots; fifth rejected without a directory', async (t) => {
  const ctx = await setup(t, { mode: 'hang' });
  for (let i = 0; i < 4; i++) {
    const r = await ctx.upload();
    assert.equal(r.status, 202, JSON.stringify(r.body));
  }
  assert.equal((await ctx.getJson('/status')).body.queueLength, 4);
  const fifth = await ctx.upload();
  assert.equal(fifth.status, 429);
  assert.ok(fifth.body.error);
  assert.equal(listDir(ctx.tempRoot).length, 4);
  assert.equal(ctx.svc._internal.jobs.size, 4);
});

// ---------------------------------------------------------------- queue order (9.1)

test('queue: FIFO, positions reported, at most one FFmpeg mux process at a time', async (t) => {
  const ctx = await setup(t, { mode: 'slow' });
  let live = 0;
  let maxLive = 0;
  const startOrder = [];
  const origPush = ctx.calls.push.bind(ctx.calls);
  ctx.calls.push = (c) => {
    if (c.kind === 'spawn') {
      live++;
      maxLive = Math.max(maxLive, live);
      startOrder.push(path.basename(path.dirname(c.args[c.args.length - 1])));
      c.child.once('exit', () => { live--; });
    }
    return origPush(c);
  };

  const ids = [];
  const positions = [];
  for (let i = 0; i < 3; i++) {
    const r = await ctx.upload();
    assert.equal(r.status, 202);
    ids.push(r.body.id);
    positions.push(r.body.position);
  }
  // The first job starts right away; the others wait behind it.
  assert.deepEqual(positions, [1, 1, 2]);
  const snap = await Promise.all(ids.map(async (id) => (await ctx.getJson(`/${id}`)).body));
  assert.deepEqual(snap.slice(1).map((j) => [j.status, j.position]), [['queued', 1], ['queued', 2]]);

  const doneOrder = [];
  await waitFor(async () => {
    const s = await Promise.all(ids.map(async (id) => (await ctx.getJson(`/${id}`)).body));
    assert.ok(s.filter((j) => j.status === 'running').length <= 1, JSON.stringify(s));
    for (const j of s) if (j.status === 'done' && !doneOrder.includes(j.id)) doneOrder.push(j.id);
    assert.ok(!s.some((j) => j.status === 'failed'), JSON.stringify(s));
    return doneOrder.length === 3;
  }, 'all done', { timeout: 20_000, interval: 25 });
  assert.deepEqual(doneOrder, ids);
  assert.deepEqual(startOrder, ids);
  assert.equal(maxLive, 1);
});

// ---------------------------------------------------------------- cancel (7.12)

test('cancel: queued job leaves the queue; running job is killed and the next starts', async (t) => {
  const ctx = await setup(t, { mode: 'hang' });
  const a = (await ctx.upload()).body.id;
  const b = (await ctx.upload()).body.id;
  const c = (await ctx.upload()).body.id;
  await waitStatus(ctx, a, 'running');
  assert.equal((await ctx.getJson(`/${b}`)).body.position, 1);
  assert.equal((await ctx.getJson(`/${c}`)).body.position, 2);

  // Queued
  assert.equal(await ctx.del(b), 204);
  assert.deepEqual((await ctx.getJson(`/${b}`)).body, { id: b, status: 'cancelled' });
  assert.equal((await ctx.getJson(`/${c}`)).body.position, 1);
  await waitFor(() => !exists(jobDir(ctx, b)), 'queued dir removed');
  assert.equal(ctx.svc.status().queueLength, 2);

  // Running: wait until the mux process exists, then DELETE.
  const child = await waitFor(() => {
    const call = ctx.calls.find((x) => x.kind === 'spawn' && x.args.includes(path.join(jobDir(ctx, a), 'output.mp4')));
    return call && call.child;
  }, 'mux process for a');
  assert.equal(await ctx.del(a), 204);
  assert.equal((await ctx.getJson(`/${a}`)).body.status, 'cancelled');
  await waitExit(child);
  await waitFor(() => !exists(jobDir(ctx, a)), 'running dir removed');
  await waitStatus(ctx, c, 'running');
  assert.equal(ctx.svc._internal.queue.runningId(), c);
  assert.equal(ctx.svc.status().queueLength, 1);
  // DELETE on an already cancelled job is a no-op.
  assert.equal(await ctx.del(a), 204);
  assert.equal((await ctx.getJson(`/${a}`)).body.status, 'cancelled');
});

// ---------------------------------------------------------------- timeouts (9.4)

test('timeout during mux (hang): failed, process terminated, dir removed', async (t) => {
  const ctx = await setup(t, { mode: 'hang', timeoutMs: 300 });
  const post = await ctx.upload();
  const { id } = post.body;
  const body = await waitStatus(ctx, id, ['failed', 'done']);
  assert.equal(body.status, 'failed');
  assert.ok(body.error.includes('超过'), body.error);
  const children = ctx.calls.filter((c) => !c.args.includes('-version')).map((c) => c.child);
  assert.ok(children.length >= 1);
  for (const child of children) await waitExit(child);
  await waitFor(() => !exists(jobDir(ctx, id)), 'timed-out dir removed');
  assert.equal(ctx.svc.status().queueLength, 0);
});

test('timeout during probe (inspecthang): failed, probe process terminated', async (t) => {
  const ctx = await setup(t, { mode: 'inspecthang', timeoutMs: 300 });
  const post = await ctx.upload();
  const { id } = post.body;
  const body = await waitStatus(ctx, id, ['failed', 'done']);
  assert.equal(body.status, 'failed');
  assert.ok(body.error.includes('超过'), body.error);
  const probes = ctx.calls.filter((c) => c.kind === 'execFile' && !c.args.includes('-version'));
  assert.equal(probes.length, 1);
  await waitExit(probes[0].child);
  assert.ok(!ctx.calls.some((c) => c.kind === 'spawn'), 'mux never started');
  await waitFor(() => !exists(jobDir(ctx, id)), 'timed-out dir removed');
  assert.equal(ctx.svc.status().queueLength, 0);
});

// ---------------------------------------------------------------- write failure (7.13)

test('write failure: tempRoot replaced by a file -> 500, slot released, no record left', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  await fs.promises.rm(ctx.tempRoot, { recursive: true, force: true });
  await fs.promises.writeFile(ctx.tempRoot, 'not a directory');
  const r = await ctx.upload({ source: makeSource(undefined, 16 * 1024) });
  assert.equal(r.status, 500);
  assert.equal(r.body.error, '服务器无法保存上传文件');
  await waitFor(() => ctx.svc._internal.jobs.size === 0, 'no job record');
  assert.equal((await ctx.getJson('/status')).body.queueLength, 0);
  assert.ok(fs.statSync(ctx.tempRoot).isFile());
});

// ---------------------------------------------------------------- failures (9.5)

test('fail: FFmpeg exits non-zero -> failed with the last stderr line', async (t) => {
  const ctx = await setup(t, { mode: 'fail' });
  const { id } = (await ctx.upload()).body;
  const body = await waitStatus(ctx, id, ['failed', 'done']);
  assert.deepEqual(body, { id, status: 'failed', error: 'Conversion failed!' });
  await waitFor(() => !exists(jobDir(ctx, id)), 'failed dir removed');
  assert.equal(ctx.svc.status().queueLength, 0);
});

test('nooutput: exit 0 without an output file -> failed', async (t) => {
  const ctx = await setup(t, { mode: 'nooutput' });
  const { id } = (await ctx.upload()).body;
  const body = await waitStatus(ctx, id, ['failed', 'done']);
  assert.equal(body.status, 'failed');
  assert.equal(body.error, 'FFmpeg 没有生成视频文件');
  await waitFor(() => !exists(jobDir(ctx, id)), 'failed dir removed');
});

// ---------------------------------------------------------------- expiry (10.4, 10.5)

test('expiry: done result removed after retentionMs', async (t) => {
  const ctx = await setup(t, { mode: 'ok', retentionMs: 500 });
  const { id } = (await ctx.upload()).body;
  await waitStatus(ctx, id, 'done', { interval: 10 });
  await waitFor(async () => (await ctx.getJson(`/${id}`)).status === 404, 'status 404');
  assert.equal((await fetch(`${ctx.api}/${id}/result.mp4`)).status, 404);
  await waitFor(() => !exists(jobDir(ctx, id)), 'expired dir removed');
});

test('expiry: failed tombstone removed after tombstoneMs', async (t) => {
  const ctx = await setup(t, { mode: 'fail', tombstoneMs: 500 });
  const { id } = (await ctx.upload()).body;
  await waitStatus(ctx, id, 'failed', { interval: 10 });
  await waitFor(async () => (await ctx.getJson(`/${id}`)).status === 404, 'tombstone gone');
});

// ---------------------------------------------------------------- startup cleanup (10.1)

test('init() empties tempRoot', async (t) => {
  const ctx = await setup(t, { mode: 'ok', init: false });
  const stale = path.join(ctx.tempRoot, '0123456789abcdef0123456789abcdef');
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, 'output.mp4'), 'old');
  fs.writeFileSync(path.join(ctx.tempRoot, 'stray.txt'), 'old');
  await ctx.svc.init();
  assert.ok(exists(ctx.tempRoot));
  assert.deepEqual(listDir(ctx.tempRoot), []);
  assert.equal(ctx.svc.status().available, true);
});

// ---------------------------------------------------------------- disconnect (7.8)

test('client disconnect mid-upload removes the directory and frees the slot', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const wav = makeWav(1024);
  const { req } = rawPost(ctx, `/api/export?ext=mp4&wavBytes=${wav.length}`, { 'Transfer-Encoding': 'chunked' });
  req.on('response', (res) => res.resume());
  req.write(Buffer.concat([wav, makeSource(undefined, 4096)]));

  const id = await waitFor(() => {
    const names = listDir(ctx.tempRoot);
    if (names.length !== 1) return null;
    const input = path.join(ctx.tempRoot, names[0], 'input.mp4');
    return exists(input) && fs.statSync(input).size > 0 ? names[0] : null;
  }, 'upload started');
  const during = (await ctx.getJson(`/${id}`)).body;
  assert.equal(during.status, 'queued');
  assert.equal(ctx.svc.status().queueLength, 1);

  req.destroy();
  await waitFor(() => listDir(ctx.tempRoot).length === 0, 'upload dir removed');
  await waitFor(() => ctx.svc._internal.jobs.size === 0, 'no job record');
  assert.equal(ctx.svc.status().queueLength, 0);
  assert.equal((await ctx.getJson(`/${id}`)).status, 404);
});

// ---------------------------------------------------------------- no shell (6.4)

test('child processes get argument arrays and never shell: true', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  await runToResult(ctx, makeSource());
  const kinds = ctx.calls.map((c) => c.kind);
  assert.deepEqual(kinds, ['execFile', 'execFile', 'spawn']); // -version, probe, mux
  for (const c of ctx.calls) {
    assert.equal(c.file, process.execPath);
    assert.ok(Array.isArray(c.args) && c.args[0] === FIXTURE);
    assert.ok(!c.options.shell, `${c.kind} used a shell`);
    assert.equal(c.options.windowsHide, true);
  }
});
