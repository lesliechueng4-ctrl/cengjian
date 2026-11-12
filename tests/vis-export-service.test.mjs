// Vis_Export_Job 集成测试（stem-visualizer design「vis-export-service.test.mjs」一节，Requirement 16.5）。
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
import { createServer } from '../server.js';
import { createVisData, encodeVisPayload, decodeVisPayload } from '../public/js/vis-data.js';
import { createRasterizer } from '../public/js/vis-raster.js';
import { lanesAt, stageAt, stackedLayout, LANE_BACKGROUND } from '../public/js/vis-lanes.js';
import { listenFetchable } from './helpers/listen.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-ffmpeg.mjs', import.meta.url));
const FAKE_CMD = { file: process.execPath, args: [FIXTURE] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, message, { timeout = 15_000, interval = 20 } = {}) {
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

function makeWav(bytes = 64) {
  const buf = Buffer.alloc(bytes, 0x11);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(bytes - 8, 4);
  buf.write('WAVE', 8, 'ascii');
  return buf;
}

function makeSource(header, extra = 256) {
  return Buffer.concat([Buffer.from(`${header}\n`, 'latin1'), crypto.randomBytes(extra)]);
}

/** A valid Vis_Payload (UTF-8 bytes) of the given duration; drums carry onsets. */
function makePayload(duration = 2, selected = 'drums') {
  const frames = Math.ceil(duration * 100);
  const env = (phase) => Uint8Array.from({ length: frames }, (_, i) => Math.round(127.5 + 127.5 * Math.sin(i / 7 + phase)));
  const onsets = Int32Array.from({ length: Math.floor(frames / 25) }, (_, k) => k * 25);
  const results = {
    inst: { env: env(0), onsets: null, duration },
    vocal: { env: env(1), onsets: null, duration },
    drums: { env: env(2), onsets, duration },
    bass: { env: env(3), onsets: null, duration },
  };
  return Buffer.from(encodeVisPayload(createVisData(results), selected), 'utf8');
}

function hasSeq(arr, seq) {
  for (let i = 0; i + seq.length <= arr.length; i++) {
    if (seq.every((v, k) => arr[i + k] === v)) return true;
  }
  return false;
}

const argAfter = (argv, flag) => argv[argv.indexOf(flag) + 1];

async function setup(t, { mode = 'ok', ...opts } = {}) {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cengjian-vis-export-test-'));
  const calls = [];
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
    timeoutMs: 30_000,
    tempRoot,
    retentionMs: 60_000,
    tombstoneMs: 60_000,
    probeTimeoutMs: 8000,
    env: { ...process.env, FAKE_FFMPEG_MODE: mode },
    log: () => {},
    execFile,
    spawn,
    ...opts,
  });
  const server = createServer(undefined, { exporter: svc });
  await listenFetchable(server);
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await svc.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.promises.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await svc.init();
  const api = `${base}/api/export`;
  const getJson = async (p) => {
    const res = await fetch(`${api}${p}`);
    return { status: res.status, body: await res.json() };
  };
  /** POST wav + payload + source; query overrides the computed one; body overrides the concat. */
  const upload = async ({ wav = makeWav(), payload = makePayload(), source, layout = 'stacked', query, body } = {}) => {
    const q = query ?? `ext=mp4&wavBytes=${wav.length}&visBytes=${payload.length}&layout=${layout}`;
    const res = await fetch(`${api}?${q}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: body ?? Buffer.concat([wav, payload, source]),
    });
    return { status: res.status, body: await res.json() };
  };
  const del = async (id) => (await fetch(`${api}/${id}`, { method: 'DELETE' })).status;
  const spawns = () => calls.filter((c) => c.kind === 'spawn');
  return { svc, port, api, tempRoot, calls, spawns, getJson, upload, del };
}

const jobDir = (ctx, id) => path.join(ctx.tempRoot, id);

async function waitStatus(ctx, id, statuses, opts) {
  const want = [].concat(statuses);
  return waitFor(async () => {
    const r = await ctx.getJson(`/${id}`);
    return want.includes(r.body.status) ? r.body : null;
  }, `job ${id} -> ${want.join('/')}`, opts);
}

async function fetchRecord(ctx, id) {
  const res = await fetch(`${ctx.api}/${id}/result.mp4`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
  assert.ok(text.startsWith('FAKEMP4 '), text.slice(0, 40));
  return JSON.parse(text.slice('FAKEMP4 '.length));
}

/** Uploads, waits for done, returns { id, record }. */
async function runToResult(ctx, uploadOpts, waitOpts) {
  const post = await ctx.upload(uploadOpts);
  assert.equal(post.status, 202, JSON.stringify(post.body));
  const { id } = post.body;
  const final = await waitStatus(ctx, id, ['done', 'failed'], waitOpts);
  assert.equal(final.status, 'done', JSON.stringify(final));
  return { id, record: await fetchRecord(ctx, id) };
}

const childGone = (child) => child.exitCode !== null || child.signalCode !== null;
const waitExit = (child, ms = 5000) =>
  Promise.race([
    new Promise((r) => (childGone(child) ? r() : child.once('exit', r))),
    sleep(ms).then(() => assert.fail('child process was not terminated')),
  ]);

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

/** Chunked upload (no Content-Length) of body in 512-byte pieces. */
async function chunkedPost(ctx, query, body) {
  const { req, response } = rawPost(ctx, `/api/export?${query}`, { 'Transfer-Encoding': 'chunked' });
  for (let off = 0; off < body.length; off += 512) {
    req.write(body.subarray(off, off + 512));
    await sleep(1);
  }
  req.end();
  return response;
}

const visQuery = (wav, payload, layout = 'stacked') =>
  `ext=mp4&wavBytes=${wav.length}&visBytes=${payload.length}&layout=${layout}`;

// ---------------------------------------------------------------- full flow (10.8, 11.4–11.6, 11.8, 11.10)

test('stacked full flow: 60 Lane_Strip frames at 960x192, vstack of 1280:720 + 1280:256, -t 2, no payload file, DELETE', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const wav = makeWav(4096);
  const source = makeSource('FAKEVIDEO codec=h264 duration=00:00:02.00 size=1280x720', 10_000);
  const payload = makePayload(2);
  const post = await ctx.upload({ wav, payload, source });
  assert.equal(post.status, 202, JSON.stringify(post.body));
  const { id } = post.body;
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(post.body.status, 'queued');

  const final = await waitStatus(ctx, id, ['done', 'failed']);
  assert.deepEqual(final, { id, status: 'done' });
  const record = await fetchRecord(ctx, id);
  assert.deepEqual(record.stdin && {
    frames: record.stdin.frames, remainder: record.stdin.remainder, size: record.stdin.size, bytes: record.stdin.bytes,
  }, { frames: 60, remainder: 0, size: '960x192', bytes: 60 * 960 * 192 * 3 });

  const { argv } = record;
  const dir = jobDir(ctx, id);
  // inputs: 0 = source, 1 = pipe:0, 2 = WAV; the fake hashes the file inputs (source, WAV).
  assert.deepEqual(record.inputs, [
    { bytes: source.length, sha256: sha256(source) },
    { bytes: wav.length, sha256: sha256(wav) },
  ]);
  assert.ok(hasSeq(argv, ['-i', path.join(dir, 'input.mp4')]));
  assert.ok(hasSeq(argv, ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '960x192', '-r', '30', '-i', 'pipe:0']), argv.join(' '));
  assert.ok(hasSeq(argv, ['-i', path.join(dir, 'audio.wav')]));
  const graph = argAfter(argv, '-filter_complex');
  assert.ok(graph.includes('vstack=inputs=2'), graph);
  assert.ok(graph.includes('scale=1280:720:force_original_aspect_ratio=decrease'), graph);
  assert.ok(graph.includes('pad=1280:720'), graph);
  assert.ok(graph.includes('scale=1280:256'), graph);
  assert.ok(!graph.includes('blend'), graph);
  assert.ok(graph.includes('apad'), graph);
  assert.ok(!/\[0:a/.test(graph), 'original audio is never used');
  assert.ok(hasSeq(argv, ['-map', '[v]', '-map', '[a]']));
  assert.ok(hasSeq(argv, ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']));
  assert.ok(hasSeq(argv, ['-c:a', 'aac', '-b:a', '192k']));
  assert.ok(hasSeq(argv, ['-t', '2']));
  assert.ok(hasSeq(argv, ['-movflags', '+faststart']));
  assert.ok(!argv.includes('-shortest'));
  assert.equal(argv[argv.length - 1], path.join(dir, 'output.mp4'));
  assert.equal(ctx.svc._internal.renderedFrames(), 60);

  // The frames are lanesAt + rasterizer output on #0b0d14 at the render size (stem-lanes 12.5).
  const { visData, selected } = decodeVisPayload(payload);
  const raster = createRasterizer(960, 192);
  const hash = crypto.createHash('sha256');
  for (let k = 0; k < 60; k++) {
    const shapes = lanesAt(k / 30, visData, { selected, width: 960, height: 192, reducedMotion: false });
    hash.update(raster.render(shapes, LANE_BACKGROUND));
  }
  assert.equal(record.stdin.sha256, hash.digest('hex'));

  // Only the result is left; the payload never touched the disk (10.8).
  await waitFor(() => listDir(dir).join() === 'output.mp4', 'only output.mp4 left');
  assert.equal(ctx.svc._internal.jobs.get(id).vis, null);
  assert.equal(ctx.svc.status().queueLength, 0);

  assert.equal(await ctx.del(id), 204);
  await waitFor(() => !exists(dir), 'job dir removed');
  assert.equal((await fetch(`${ctx.api}/${id}/result.mp4`)).status, 404);
  assert.equal((await ctx.getJson(`/${id}`)).body.status, 'cancelled');
});

test('standalone: no source in argv, scale=1280:720, ceil(D × 30) frames from the probe duration, exact pixels', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const wav = makeWav(512);
  const source = makeSource('FAKEVIDEO codec=none duration=00:00:01.25');
  const payload = makePayload(1, 'vocal'); // payload duration differs; the probe duration wins
  const { id, record } = await runToResult(ctx, { wav, payload, source, layout: 'standalone' });
  const frames = Math.ceil(1.25 * 30);
  assert.equal(frames, 38);
  assert.equal(record.stdin.frames, frames);
  assert.equal(record.stdin.remainder, 0);
  assert.equal(record.stdin.size, '640x360');
  const { argv } = record;
  const dir = jobDir(ctx, id);
  assert.ok(!argv.includes(path.join(dir, 'input.mp4')), argv.join(' '));
  assert.deepEqual(record.inputs, [{ bytes: wav.length, sha256: sha256(wav) }]);
  const graph = argAfter(argv, '-filter_complex');
  assert.ok(graph.includes('scale=1280:720'), graph);
  assert.ok(!graph.includes('blend'), graph);
  assert.ok(hasSeq(argv, ['-t', '1.25']));

  // The frames are stageAt (flowing timeline over the dim ambient scene) + rasterizer output on #0b0d14 with the payload's selected stem.
  const { visData, selected } = decodeVisPayload(payload);
  assert.equal(selected, 'vocal');
  const raster = createRasterizer(640, 360);
  const hash = crypto.createHash('sha256');
  for (let k = 0; k < frames; k++) {
    const shapes = stageAt(k / 30, visData, { selected, width: 640, height: 360, reducedMotion: false });
    hash.update(raster.render(shapes, [11, 13, 20]));
  }
  assert.equal(record.stdin.sha256, hash.digest('hex'));
});

test('duration N/A: frames and -t come from the payload duration', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const D = 0.5;
  const { record } = await runToResult(ctx, {
    payload: makePayload(D),
    source: makeSource('FAKEVIDEO codec=h264 duration=N/A size=640x360'),
  });
  assert.equal(record.stdin.frames, Math.ceil(D * 30));
  assert.equal(record.stdin.remainder, 0);
  assert.ok(hasSeq(record.argv, ['-t', '0.5']));
  assert.ok(!record.argv.includes('-shortest'));
});

test('stacked without a video stream: failed 文件里没有画面, no mux, dir removed', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const post = await ctx.upload({ source: makeSource('FAKEVIDEO codec=none duration=00:00:01.00') });
  assert.equal(post.status, 202);
  const { id } = post.body;
  assert.deepEqual(await waitStatus(ctx, id, ['failed', 'done']), { id, status: 'failed', error: '文件里没有画面' });
  await waitFor(() => !exists(jobDir(ctx, id)), 'failed dir removed');
  assert.equal(ctx.spawns().length, 0);
  assert.equal(ctx.svc._internal.renderedFrames(), 0);
});

test('rotate=90 with size=1920x1080: portrait stacked output 970x1918, Lane_Strip rendered at 960x192', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const { record } = await runToResult(ctx, {
    payload: makePayload(0.5),
    source: makeSource('FAKEVIDEO codec=h264 duration=00:00:00.50 size=1920x1080 rotate=90'),
  });
  assert.deepEqual(stackedLayout(1080, 1920, 1920, 1920), { width: 970, pictureHeight: 1724, stripHeight: 194 });
  assert.equal(argAfter(record.argv, '-s'), '960x192');
  assert.equal(record.stdin.size, '960x192');
  assert.equal(record.stdin.frames, 15);
  assert.equal(record.stdin.remainder, 0);
  const graph = argAfter(record.argv, '-filter_complex');
  assert.ok(graph.includes('scale=970:1724:force_original_aspect_ratio=decrease'), graph);
  assert.ok(graph.includes('pad=970:1724'), graph);
  assert.ok(graph.includes('scale=970:194'), graph);
  assert.ok(graph.includes('vstack=inputs=2'), graph);
});

test('400 可视化布局参数无效: layout=overlay is no longer accepted, no files written', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const r = await ctx.upload({ source: makeSource('FAKEVIDEO codec=h264 duration=00:00:01.00 size=1280x720'), layout: 'overlay' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, '可视化布局参数无效');
  await sleep(50);
  assert.deepEqual(listDir(ctx.tempRoot), []);
  assert.equal(ctx.svc._internal.jobs.size, 0);
  assert.equal(ctx.spawns().length, 0);
});

// ---------------------------------------------------------------- 400 / 413 (10.4–10.7)

test('400: bad visualizer query parameters, no files written', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const wav = makeWav();
  const payload = makePayload(0.5);
  const source = makeSource('FAKEVIDEO codec=h264 duration=00:00:01.00');
  const base = `ext=mp4&wavBytes=${wav.length}`;
  for (const q of [
    `${base}&visBytes=${payload.length}`,
    `${base}&layout=stacked`,
    `${base}&visBytes=1&layout=stacked`,
    `${base}&visBytes=16777217&layout=stacked`,
    `${base}&visBytes=${payload.length}&layout=overlay`,
    `${base}&visBytes=${payload.length}&layout=side`,
  ]) {
    const r = await ctx.upload({ wav, payload, source, query: q });
    assert.equal(r.status, 400, q);
    assert.ok(r.body.error, q);
  }
  await sleep(50);
  assert.deepEqual(listDir(ctx.tempRoot), []);
  assert.equal(ctx.svc._internal.jobs.size, 0);
  assert.equal(ctx.svc.status().queueLength, 0);
});

test('400 可视化数据无效: invalid JSON and inconsistent frames; dir removed', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const wav = makeWav();
  const source = makeSource('FAKEVIDEO codec=h264 duration=00:00:01.00', 4096);
  const good = JSON.parse(makePayload(0.5).toString('utf8'));
  const badFrames = Buffer.from(JSON.stringify({ ...good, frames: good.frames + 1 }), 'utf8');
  for (const payload of [Buffer.from('{"not json', 'utf8'), Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), badFrames]) {
    const r = await ctx.upload({ wav, payload, source });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, '可视化数据无效');
  }
  await waitFor(() => listDir(ctx.tempRoot).length === 0, 'upload dirs removed');
  assert.equal(ctx.svc._internal.jobs.size, 0);
  assert.equal(ctx.svc.status().queueLength, 0);
});

test('400: body ends inside the payload or right after it (declared and chunked); dirs removed', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const wav = makeWav(256);
  const payload = makePayload(0.5);
  const q = visQuery(wav, payload);
  const partial = Buffer.concat([wav, payload.subarray(0, Math.floor(payload.length / 2))]);
  const headOnly = Buffer.concat([wav, payload]);

  // With Content-Length the up-front check rejects both.
  for (const body of [partial, headOnly]) {
    const r = await ctx.upload({ query: q, body });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, '缺少原文件');
  }
  // Chunked: judged when the body ends.
  const r1 = await chunkedPost(ctx, q, partial);
  assert.equal(r1.status, 400, r1.text);
  assert.equal(JSON.parse(r1.text).error, '可视化数据不完整');
  const r2 = await chunkedPost(ctx, q, headOnly);
  assert.equal(r2.status, 400, r2.text);
  assert.equal(JSON.parse(r2.text).error, '缺少原文件');

  await waitFor(() => listDir(ctx.tempRoot).length === 0, 'upload dirs removed');
  assert.equal(ctx.svc._internal.jobs.size, 0);
  assert.equal(ctx.svc.status().queueLength, 0);
});

test('413: WAV + payload + source over maxUploadBytes (declared and chunked); no files left', async (t) => {
  const ctx = await setup(t, { mode: 'ok', maxUploadBytes: 64 * 1024 });
  const wav = makeWav(1024);
  const payload = makePayload(2);
  // The source alone fits; only the total exceeds the limit.
  const source = makeSource('FAKEVIDEO codec=h264 duration=00:00:01.00', 64 * 1024 - wav.length - payload.length + 100);
  const r = await ctx.upload({ wav, payload, source });
  assert.equal(r.status, 413);
  assert.ok(r.body.error);
  await sleep(50);
  assert.deepEqual(listDir(ctx.tempRoot), []);

  const rr = await chunkedPost(ctx, visQuery(wav, payload), Buffer.concat([wav, payload, source]));
  assert.equal(rr.status, 413, rr.text);
  await waitFor(() => listDir(ctx.tempRoot).length === 0, 'partial upload removed');
  assert.equal(ctx.svc._internal.jobs.size, 0);
  assert.equal(ctx.svc.status().queueLength, 0);
});

// ---------------------------------------------------------------- regression (10.3)

test('no visualizer parameters: original stem-video-export flow', async (t) => {
  const ctx = await setup(t, { mode: 'ok' });
  const wav = makeWav(2048);
  const source = makeSource('FAKEVIDEO codec=h264 duration=00:00:02.00 size=1280x720', 8192);
  const { id, record } = await runToResult(ctx, { wav, source, query: `ext=mp4&wavBytes=${wav.length}`, body: Buffer.concat([wav, source]) });
  assert.deepEqual(record.inputs, [
    { bytes: source.length, sha256: sha256(source) },
    { bytes: wav.length, sha256: sha256(wav) },
  ]);
  assert.equal(record.stdin, undefined);
  const { argv } = record;
  assert.ok(!argv.includes('pipe:0'));
  assert.ok(!argv.includes('-filter_complex'));
  assert.ok(hasSeq(argv, ['-map', '0:v:0']));
  assert.ok(hasSeq(argv, ['-map', '1:a:0']));
  assert.ok(hasSeq(argv, ['-c:v', 'copy']));
  assert.ok(hasSeq(argv, ['-af', 'apad']));
  assert.ok(hasSeq(argv, ['-c:a', 'aac', '-b:a', '192k']));
  assert.ok(hasSeq(argv, ['-t', '2']));
  assert.ok(hasSeq(argv, ['-movflags', '+faststart']));
  assert.ok(argv.includes('-nostdin'));
  assert.equal(argv[argv.length - 1], path.join(jobDir(ctx, id), 'output.mp4'));
  assert.equal(ctx.svc._internal.renderedFrames(), 0);
  await waitFor(() => listDir(jobDir(ctx, id)).join() === 'output.mp4', 'only output.mp4 left');
});

// ---------------------------------------------------------------- backpressure (11.7, 11.14)

test('slowstdin: job completes with all frames; status requests answer within 500 ms', async (t) => {
  const ctx = await setup(t, { mode: 'slowstdin' });
  const post = await ctx.upload({
    payload: makePayload(1),
    source: makeSource('FAKEVIDEO codec=h264 duration=00:00:01.00 size=320x180'),
  });
  assert.equal(post.status, 202);
  const { id } = post.body;
  let maxLatency = 0;
  let samples = 0;
  let sawRunning = false;
  await waitFor(async () => {
    const t0 = Date.now();
    const res = await fetch(`${ctx.api}/status`);
    await res.json();
    const dt = Date.now() - t0;
    if (ctx.svc._internal.renderedFrames() > 0) {
      maxLatency = Math.max(maxLatency, dt);
      samples++;
    }
    const job = (await ctx.getJson(`/${id}`)).body;
    if (job.status === 'running') sawRunning = true;
    assert.notEqual(job.status, 'failed', JSON.stringify(job));
    return job.status === 'done';
  }, 'slowstdin job done', { timeout: 30_000, interval: 50 });
  assert.ok(sawRunning);
  assert.ok(samples >= 3, `only ${samples} samples during rendering`);
  assert.ok(maxLatency < 500, `status latency ${maxLatency} ms`);
  const record = await fetchRecord(ctx, id);
  assert.equal(record.stdin.frames, 30);
  assert.equal(record.stdin.remainder, 0);
  assert.equal(record.stdin.size, '320x96'); // 320×180 picture → Lane_Strip 320×96
  assert.equal(ctx.svc._internal.renderedFrames(), 30);
});

// ---------------------------------------------------------------- early exit (11.12)

test('stdinexit: failed with the FFmpeg stderr line, no uncaught EPIPE', async (t) => {
  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);
  t.after(() => process.removeListener('uncaughtException', onUncaught));
  const ctx = await setup(t, { mode: 'stdinexit' });
  const post = await ctx.upload({
    payload: makePayload(2),
    source: makeSource('FAKEVIDEO codec=h264 duration=00:00:02.00 size=1280x720'),
  });
  assert.equal(post.status, 202);
  const { id } = post.body;
  const body = await waitStatus(ctx, id, ['failed', 'done']);
  assert.deepEqual(body, { id, status: 'failed', error: 'Error while decoding stream' });
  await waitFor(() => !exists(jobDir(ctx, id)), 'failed dir removed');
  assert.ok(ctx.svc._internal.renderedFrames() < 60);
  await sleep(100);
  assert.deepEqual(uncaught, []);
  assert.equal(ctx.svc.status().queueLength, 0);
});

// ---------------------------------------------------------------- cancel / timeout (11.13)

test('cancel while rendering: FFmpeg killed, rendering stops, dir removed', async (t) => {
  const ctx = await setup(t, { mode: 'slowstdin' });
  const post = await ctx.upload({
    payload: makePayload(1),
    source: makeSource('FAKEVIDEO codec=h264 duration=00:00:10.00 size=1280x720'),
  });
  const { id } = post.body;
  await waitFor(() => ctx.svc._internal.renderedFrames() >= 2, 'rendering started');
  const [mux] = ctx.spawns();
  assert.ok(mux);
  assert.equal(await ctx.del(id), 204);
  const after = ctx.svc._internal.renderedFrames();
  assert.equal((await ctx.getJson(`/${id}`)).body.status, 'cancelled');
  await waitExit(mux.child);
  await waitFor(() => !exists(jobDir(ctx, id)), 'cancelled dir removed');
  await sleep(300);
  assert.equal(ctx.svc._internal.renderedFrames(), after);
  assert.ok(after < 300);
  assert.equal(ctx.svc.status().queueLength, 0);
});

test('timeout while rendering: failed, FFmpeg terminated, dir removed', async (t) => {
  const ctx = await setup(t, { mode: 'slowstdin', timeoutMs: 1500 });
  const post = await ctx.upload({
    payload: makePayload(1),
    source: makeSource('FAKEVIDEO codec=h264 duration=00:00:10.00 size=1280x720'),
  });
  const { id } = post.body;
  const body = await waitStatus(ctx, id, ['failed', 'done']);
  assert.equal(body.status, 'failed');
  assert.ok(body.error.includes('超过'), body.error);
  const [mux] = ctx.spawns();
  assert.ok(mux, 'rendering had started');
  await waitExit(mux.child);
  const rendered = ctx.svc._internal.renderedFrames();
  assert.ok(rendered > 0 && rendered < 300, `rendered ${rendered}`);
  await waitFor(() => !exists(jobDir(ctx, id)), 'timed-out dir removed');
  await sleep(200);
  assert.equal(ctx.svc._internal.renderedFrames(), rendered);
  assert.equal(ctx.svc.status().queueLength, 0);
});

// ---------------------------------------------------------------- shared queue (10.10)

test('queue: Vis_Export_Jobs and plain Export_Jobs share the 4 slots and the single process', async (t) => {
  const ctx = await setup(t, { mode: 'hang' });
  const wav = makeWav();
  const src = () => makeSource('FAKEVIDEO codec=h264 duration=00:00:01.00 size=640x360');
  const plain = async () => {
    const source = src();
    return ctx.upload({ query: `ext=mp4&wavBytes=${wav.length}`, body: Buffer.concat([wav, source]) });
  };
  const vis = () => ctx.upload({ wav, payload: makePayload(1), source: src() });

  const ids = [];
  for (const up of [vis, plain, vis, plain]) {
    const r = await up();
    assert.equal(r.status, 202, JSON.stringify(r.body));
    ids.push(r.body.id);
  }
  assert.equal(ctx.svc.status().queueLength, 4);
  const fifthVis = await vis();
  assert.equal(fifthVis.status, 429);
  const fifthPlain = await plain();
  assert.equal(fifthPlain.status, 429);
  assert.equal(listDir(ctx.tempRoot).length, 4);

  const usesStdin = (c) => c.args.includes('pipe:0');
  const muxFor = (id) => ctx.spawns().find((c) => c.args[c.args.length - 1] === path.join(jobDir(ctx, id), 'output.mp4'));
  await waitFor(() => muxFor(ids[0]), 'vis mux A');
  await sleep(100);
  assert.equal(ctx.spawns().length, 1);
  assert.ok(usesStdin(muxFor(ids[0])));
  assert.deepEqual((await Promise.all(ids.slice(1).map((id) => ctx.getJson(`/${id}`)))).map((r) => r.body.status),
    ['queued', 'queued', 'queued']);

  // Cancelling A starts the plain job B, then C (visualizer) after B.
  assert.equal(await ctx.del(ids[0]), 204);
  await waitExit(muxFor(ids[0]).child);
  await waitFor(() => muxFor(ids[1]), 'plain mux B');
  assert.ok(!usesStdin(muxFor(ids[1])));
  assert.equal(ctx.spawns().filter((c) => !childGone(c.child)).length, 1);
  assert.equal(await ctx.del(ids[1]), 204);
  await waitExit(muxFor(ids[1]).child);
  await waitFor(() => muxFor(ids[2]), 'vis mux C');
  assert.ok(usesStdin(muxFor(ids[2])));
  assert.equal(ctx.spawns().filter((c) => !childGone(c.child)).length, 1);
  assert.equal(ctx.svc.status().queueLength, 2);
});
