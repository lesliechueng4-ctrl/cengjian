// Demucs_Service 集成测试（design.md 第 1 节、测试策略「单元与集成测试」）。
// 使用假 Demucs_Command（process.execPath + tests/fixtures/fake-demucs.mjs），真实 HTTP 服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemucsService, MODEL_STEMS } from '../demucs-service.js';
import { createServer } from '../server.js';
import { listenFetchable } from './helpers/listen.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-demucs.mjs', import.meta.url));
const FAKE_CMD = { file: process.execPath, args: [FIXTURE] };
const ENABLED_MSG = '已启用 Demucs';
const FALLBACK_MSG = '未检测到 Demucs';

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
const listDir = (p) => (exists(p) ? fs.readdirSync(p) : []);

/**
 * Creates a service with its own mkdtemp tempRoot and an HTTP server on a random port.
 * Everything is closed in t.after.
 */
async function setup(t, { mode = 'ok', init = true, ...opts } = {}) {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cengjian-demucs-test-'));
  const logs = [];
  const svc = createDemucsService({
    command: FAKE_CMD,
    maxUploadBytes: 1024 * 1024,
    timeoutMs: 20_000,
    tempRoot,
    retentionMs: 60_000,
    tombstoneMs: 60_000,
    probeTimeoutMs: 8000,
    env: { ...process.env, FAKE_DEMUCS_MODE: mode },
    log: (m) => logs.push(m),
    ...opts,
  });
  const server = createServer(undefined, { demucs: svc });
  await listenFetchable(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await svc.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.promises.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  if (init) await svc.init();
  const api = `${base}/api/separate`;
  const getJson = async (p) => {
    const res = await fetch(`${api}${p}`);
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  const upload = async (model = 'htdemucs', ext = 'mp3', bytes = 2048) => {
    const res = await fetch(`${api}?model=${model}&ext=${ext}`, {
      method: 'POST',
      body: Buffer.alloc(bytes, 7),
    });
    return { status: res.status, body: await res.json() };
  };
  const del = async (id) => (await fetch(`${api}/${id}`, { method: 'DELETE' })).status;
  return { svc, server, base, api, tempRoot, logs, getJson, upload, del };
}

const jobDir = (ctx, id) => path.join(ctx.tempRoot, id);

async function waitStatus(ctx, id, statuses, opts) {
  const want = [].concat(statuses);
  return waitFor(async () => {
    const r = await ctx.getJson(`/${id}`);
    return want.includes(r.body.status) ? r.body : null;
  }, `job ${id} -> ${want.join('/')}`, opts);
}

// ---------------------------------------------------------------- probe (1.1, 1.3, 1.4)

test('probe: ok -> available, prints enabled message', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const s = ctx.svc.status();
  assert.equal(s.available, true);
  assert.equal(s.checking, false);
  assert.equal(ctx.logs.length, 1);
  assert.ok(ctx.logs[0].includes(ENABLED_MSG), ctx.logs[0]);
});

test('probe: nohelp -> unavailable, prints fallback message', async (t) => {
  const ctx = await setup(t, { mode: 'nohelp' });
  assert.equal(ctx.svc.status().available, false);
  assert.equal(ctx.logs.length, 1);
  assert.ok(ctx.logs[0].includes(FALLBACK_MSG), ctx.logs[0]);
});

test('probe: missing command -> unavailable, prints fallback message', async (t) => {
  const missing = path.join(os.tmpdir(), 'cengjian-no-such-demucs-command-xyz.exe');
  const ctx = await setup(t, { command: { file: missing, args: [] } });
  assert.equal(ctx.svc.status().available, false);
  assert.ok(ctx.logs.some((m) => m.includes(FALLBACK_MSG)));
});

test('probe: unparseable command (null) -> unavailable', async (t) => {
  const ctx = await setup(t, { command: null });
  assert.equal(ctx.svc.status().available, false);
  assert.ok(ctx.logs.some((m) => m.includes(FALLBACK_MSG)));
});

test('probe: probehang times out -> unavailable; checking while probing', async (t) => {
  const ctx = await setup(t, { mode: 'probehang', probeTimeoutMs: 200, init: false });
  const p = ctx.svc.init();
  const during = ctx.svc.status();
  assert.equal(during.checking, true);
  assert.equal(during.available, false);
  const r = await ctx.getJson('/status');
  assert.equal(r.body.checking, true);
  await p;
  const after = ctx.svc.status();
  assert.equal(after.checking, false);
  assert.equal(after.available, false);
  assert.equal(ctx.logs.length, 1);
  assert.ok(ctx.logs[0].includes(FALLBACK_MSG), ctx.logs[0]);
});

// ---------------------------------------------------------------- status / 503 (1.2, 2.5)

test('GET /status has all fields and safe headers', async (t) => {
  const ctx = await setup(t, { mode: 'ok', maxUploadBytes: 12345 });
  const r = await ctx.getJson('/status');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    available: true,
    checking: false,
    models: ['htdemucs', 'htdemucs_6s'],
    maxUploadBytes: 12345,
    queueLength: 0,
  });
  assert.match(r.headers.get('content-type'), /^application\/json/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('POST while unavailable -> 503 and no files', async (t) => {
  const ctx = await setup(t, { mode: 'nohelp' });
  const r = await ctx.upload('htdemucs', 'mp3', 4096);
  assert.equal(r.status, 503);
  assert.ok(typeof r.body.error === 'string' && r.body.error);
  await sleep(100);
  assert.deepEqual(listDir(ctx.tempRoot), []);
  assert.equal(ctx.svc._internal.jobs.size, 0);
  assert.equal(ctx.svc.status().queueLength, 0);
});

// ---------------------------------------------------------------- full flow (2.1, 3.3, 3.4, 4.4, 5.1)

test('full success flow: progress rises, every stem served, upload deleted, DELETE removes dir', async (t) => {
  const ctx = await setup(t, { mode: 'slow' });
  const model = 'htdemucs_6s';
  const post = await ctx.upload(model, 'MP4', 4096);
  assert.equal(post.status, 202);
  const { id } = post.body;
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(post.body.status, 'queued');
  assert.equal(post.body.position, 1);

  // Server-chosen paths only: input.<whitelisted ext>.
  const dir = jobDir(ctx, id);
  assert.ok(exists(path.join(dir, 'input.mp4')));

  const progress = [];
  const final = await waitFor(async () => {
    const r = await ctx.getJson(`/${id}`);
    assert.equal(r.status, 200);
    if (r.body.status === 'running') {
      assert.ok(Number.isInteger(r.body.progress) && r.body.progress >= 0 && r.body.progress <= 100);
      progress.push(r.body.progress);
    }
    return r.body.status === 'done' || r.body.status === 'failed' ? r.body : null;
  }, 'job done', { timeout: 15_000, interval: 30 });

  assert.equal(final.status, 'done', JSON.stringify(final));
  assert.deepEqual(final.stems, MODEL_STEMS[model]);
  assert.ok(progress.length >= 2, `running observations: ${progress}`);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i] >= progress[i - 1], `${progress}`);
  assert.ok(new Set(progress).size >= 2, `progress never rose: ${progress}`);

  for (const stem of MODEL_STEMS[model]) {
    const res = await fetch(`${ctx.api}/${id}/${stem}.wav`);
    assert.equal(res.status, 200, stem);
    assert.equal(res.headers.get('content-type'), 'audio/wav');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.equal(Number(res.headers.get('content-length')), buf.length);
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  }
  // Not a stem of this model / not a .wav name.
  assert.equal((await fetch(`${ctx.api}/${id}/drums.mp3`)).status, 404);

  // Upload deleted, results kept.
  await waitFor(() => !exists(path.join(dir, 'input.mp4')), 'upload removed');
  assert.ok(exists(path.join(dir, 'out', model, 'vocals.wav')));

  assert.equal(await ctx.del(id), 204);
  await waitFor(() => !exists(dir), 'job dir removed');
  assert.equal((await fetch(`${ctx.api}/${id}/vocals.wav`)).status, 404);
  const after = await ctx.getJson(`/${id}`);
  assert.equal(after.body.status, 'cancelled');
});

test('result expires after retentionMs: 404 and dir removed', async (t) => {
  const ctx = await setup(t, { mode: 'ok', retentionMs: 400 });
  const post = await ctx.upload('htdemucs');
  assert.equal(post.status, 202);
  const { id } = post.body;
  await waitStatus(ctx, id, 'done', { interval: 10 });
  await waitFor(async () => (await fetch(`${ctx.api}/${id}/vocals.wav`)).status === 404, 'stem 404');
  assert.equal((await ctx.getJson(`/${id}`)).status, 404);
  await waitFor(() => !exists(jobDir(ctx, id)), 'expired dir removed');
});

// ---------------------------------------------------------------- failures (4.3, 3.7)

test('fail: job failed with reason, dir removed right away', async (t) => {
  const ctx = await setup(t, { mode: 'fail' });
  const post = await ctx.upload('htdemucs');
  assert.equal(post.status, 202);
  const { id } = post.body;
  const body = await waitStatus(ctx, id, ['failed', 'done']);
  assert.equal(body.status, 'failed');
  assert.ok(body.error.includes('fake failure'), body.error);
  await waitFor(() => !exists(jobDir(ctx, id)), 'failed dir removed', { timeout: 2000 });
  assert.equal(ctx.svc.status().queueLength, 0);
  assert.equal((await fetch(`${ctx.api}/${id}/vocals.wav`)).status, 404);
});

test('hang: killed after timeoutMs and reported as failed', async (t) => {
  const ctx = await setup(t, { mode: 'hang', timeoutMs: 300 });
  const post = await ctx.upload('htdemucs');
  assert.equal(post.status, 202);
  const { id } = post.body;
  const body = await waitStatus(ctx, id, ['failed', 'done']);
  assert.equal(body.status, 'failed');
  assert.ok(body.error.includes('超过'), body.error);
  await waitFor(() => !exists(jobDir(ctx, id)), 'timed-out dir removed');
  assert.equal(ctx.svc.status().queueLength, 0);
});

// ---------------------------------------------------------------- queue (3.1, 3.2, 3.3)

test('slow x5: fifth gets 429; jobs run one at a time in FIFO order with positions', async (t) => {
  const ctx = await setup(t, { mode: 'slow' });
  const ids = [];
  const positions = [];
  for (let i = 0; i < 4; i++) {
    const r = await ctx.upload('htdemucs');
    assert.equal(r.status, 202, JSON.stringify(r.body));
    ids.push(r.body.id);
    positions.push(r.body.position);
  }
  assert.deepEqual(positions, [1, 1, 2, 3]);
  const fifth = await ctx.upload('htdemucs');
  assert.equal(fifth.status, 429);
  assert.ok(fifth.body.error);
  assert.equal(listDir(ctx.tempRoot).length, 4, 'rejected upload creates no directory');
  assert.equal((await ctx.getJson('/status')).body.queueLength, 4);

  const snapshot = async () => Promise.all(ids.map(async (id) => (await ctx.getJson(`/${id}`)).body));
  let s = await snapshot();
  assert.equal(s[0].status, 'running');
  assert.equal(s[0].position, undefined);
  assert.deepEqual(s.slice(1).map((j) => [j.status, j.position]), [['queued', 1], ['queued', 2], ['queued', 3]]);

  // Cancelling the running job starts the next one in submission order.
  for (let k = 0; k < 3; k++) {
    assert.equal(ctx.svc._internal.queue.runningId(), ids[k]);
    assert.equal(await ctx.del(ids[k]), 204);
    assert.equal(ctx.svc._internal.queue.runningId(), ids[k + 1]);
    s = await snapshot();
    assert.equal(s[k].status, 'cancelled');
    assert.equal(s[k + 1].status, 'running');
    assert.deepEqual(s.slice(k + 2).map((j) => j.position), [1, 2, 3].slice(0, 2 - k));
  }
  // A slot is free again.
  assert.equal((await ctx.getJson('/status')).body.queueLength, 1);
  assert.equal(await ctx.del(ids[3]), 204);
  assert.equal(ctx.svc.status().queueLength, 0);
  await waitFor(() => listDir(ctx.tempRoot).length === 0, 'all job dirs removed');
});

test('DELETE queued job leaves the queue; DELETE running job kills the process', async (t) => {
  const ctx = await setup(t, { mode: 'hang' });
  const a = (await ctx.upload('htdemucs')).body.id;
  const b = (await ctx.upload('htdemucs')).body.id;
  assert.equal((await ctx.getJson(`/${a}`)).body.status, 'running');
  assert.equal((await ctx.getJson(`/${b}`)).body.position, 1);

  // Queued
  assert.equal(await ctx.del(b), 204);
  const qb = await ctx.getJson(`/${b}`);
  assert.equal(qb.status, 200);
  assert.equal(qb.body.status, 'cancelled');
  assert.equal(ctx.svc._internal.queue.state(b), null);
  assert.equal(ctx.svc.status().queueLength, 1);
  await waitFor(() => !exists(jobDir(ctx, b)), 'queued dir removed');

  // Running
  const child = ctx.svc._internal.jobs.get(a).child;
  assert.ok(child, 'running job has a child process');
  const exited = new Promise((r) => {
    if (child.exitCode !== null || child.signalCode !== null) r();
    else child.once('exit', r);
  });
  assert.equal(await ctx.del(a), 204);
  assert.equal((await ctx.getJson(`/${a}`)).body.status, 'cancelled');
  await Promise.race([exited, sleep(5000).then(() => assert.fail('child not killed'))]);
  await waitFor(() => !exists(jobDir(ctx, a)), 'running dir removed');
  assert.equal(ctx.svc.status().queueLength, 0);
  assert.equal(ctx.svc._internal.queue.runningId(), null, 'cancelled queued job never starts');
  assert.equal((await ctx.getJson(`/${a}`)).body.status, 'cancelled');
});

// ---------------------------------------------------------------- init cleanup (4.6)

test('init() removes leftover files in tempRoot', async (t) => {
  const ctx = await setup(t, { mode: 'ok', init: false });
  const stale = path.join(ctx.tempRoot, '0123456789abcdef0123456789abcdef');
  fs.mkdirSync(path.join(stale, 'out', 'htdemucs'), { recursive: true });
  fs.writeFileSync(path.join(stale, 'input.mp3'), 'old');
  fs.writeFileSync(path.join(ctx.tempRoot, 'stray.txt'), 'old');
  await ctx.svc.init();
  assert.ok(exists(ctx.tempRoot), 'tempRoot recreated');
  assert.deepEqual(listDir(ctx.tempRoot), []);
  assert.equal(ctx.svc.status().available, true);
});

// ---------------------------------------------------------------- upload disconnect

test('client disconnect mid-upload removes the directory and creates no job', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const { port } = ctx.server.address();
  const req = http.request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: '/api/separate?model=htdemucs&ext=mp3',
    headers: { 'Transfer-Encoding': 'chunked' },
  });
  req.on('error', () => {});
  req.on('response', (res) => res.resume());
  req.write(Buffer.alloc(8192, 1));

  const id = await waitFor(() => {
    const names = listDir(ctx.tempRoot);
    if (names.length !== 1) return null;
    const input = path.join(ctx.tempRoot, names[0], 'input.mp3');
    return exists(input) && fs.statSync(input).size > 0 ? names[0] : null;
  }, 'upload started');
  const during = (await ctx.getJson(`/${id}`)).body;
  assert.equal(during.status, 'queued');
  assert.equal(during.position, undefined);
  assert.equal(ctx.svc.status().queueLength, 1);

  req.destroy();
  await waitFor(() => listDir(ctx.tempRoot).length === 0, 'upload dir removed');
  await waitFor(() => ctx.svc._internal.jobs.size === 0, 'no job record');
  assert.equal(ctx.svc.status().queueLength, 0);
  assert.equal((await ctx.getJson(`/${id}`)).status, 404);
});

// ---------------------------------------------------------------- over-limit drain

test('over-limit upload: 413 is delivered, extra body is discarded, endless sender is cut off', async (t) => {
  const ctx = await setup(t, { mode: 'ok', maxUploadBytes: 1024 });
  const { port } = ctx.server.address();
  const req = http.request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: '/api/separate?model=htdemucs&ext=mp3',
    headers: { 'Transfer-Encoding': 'chunked' },
  });
  req.on('error', () => {});
  const response = new Promise((resolve) => {
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
  });
  const closed = new Promise((r) => req.on('close', r));
  // Keep sending well past limit + maxUploadBytes and never end the request.
  let sent = 0;
  const pump = setInterval(() => {
    if (req.destroyed || sent > 64 * 1024) return;
    req.write(Buffer.alloc(512, 3));
    sent += 512;
  }, 2);
  t.after(() => clearInterval(pump));

  const r = await response;
  assert.equal(r.status, 413, r.text);
  assert.ok(JSON.parse(r.text).error);
  await Promise.race([closed, sleep(5000).then(() => assert.fail('server did not cut off the sender'))]);
  clearInterval(pump);
  assert.ok(sent <= 64 * 1024, `sent ${sent}`);
  await waitFor(() => listDir(ctx.tempRoot).length === 0, 'no upload files');
  assert.equal(ctx.svc._internal.jobs.size, 0);
  assert.equal(ctx.svc.status().queueLength, 0);
});
