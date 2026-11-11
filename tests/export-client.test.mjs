import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fileNameFor, UNSAFE_FILE_NAME_RE, MAX_FILE_BODY,
  exportButtonState, exportProgressText, fetchExportStatus, triggerDownload,
} from '../public/js/export-client.js';
import { STEMS } from '../public/js/separator.js';
import { forAll, gen } from './helpers/prop.mjs';

const STEM_IDS = STEMS.map((s) => s.id); // 9 ids, including 'original'
const EXPORT_LABELS = STEMS.filter((s) => s.id !== 'original').map((s) => s.label);
const EXTS = ['mp4', 'webm', 'wav'];
const UNSAFE_ONE = new RegExp(UNSAFE_FILE_NAME_RE.source); // non-global: no lastIndex state

const cps = (s) => Array.from(s).length;

/** Base name as processed before truncation (strip ext → replace unsafe → trim spaces / dots). */
function processedBase(name) {
  const dot = name.lastIndexOf('.');
  const stripped = dot > 0 ? name.slice(0, dot) : name;
  return stripped.replace(new RegExp(UNSAFE_FILE_NAME_RE.source, 'g'), '_').replace(/^[ .]+|[ .]+$/g, '');
}

// Source names: hostile strings, very long names, names padded with spaces / dots,
// multiple extensions, and the empty name.
const sourceNameGen = gen.oneOf(
  gen.string({ maxLength: 24 }),
  gen.string({ minLength: 40, maxLength: 120 }),
  (rng) => ' .'.repeat(gen.int(0, 3)(rng)) + gen.string({ maxLength: 10 })(rng) + '. '.repeat(gen.int(0, 3)(rng)),
  (rng) => `${gen.string({ maxLength: 12 })(rng)}.${gen.string({ maxLength: 4 })(rng)}.${gen.oneOf('mp4', 'mov', 'mkv')(rng)}`,
  (rng) => '层'.repeat(gen.int(60, 200)(rng)) + '.mp4',
  (rng) => '😀'.repeat(gen.int(60, 120)(rng)),
  '', '.', '...', ' ', '.mp4', '..mp4',
);

const pick = (list) => (rng) => list[Math.floor(rng() * list.length)];

// Feature: stem-video-export, Property 1: 导出文件名不变式
test('Feature: stem-video-export, Property 1: 导出文件名不变式', async () => {
  // **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5**
  const g = (rng) => ({ name: sourceNameGen(rng), label: pick(EXPORT_LABELS)(rng), ext: pick(EXTS)(rng) });
  await forAll(g, ({ name, label, ext }) => {
    const out = fileNameFor(name, label, ext);
    const tail = `-${label}.${ext}`;
    assert.ok(out.endsWith(tail), `ends with ${tail}: ${JSON.stringify(out)}`);
    const body = out.slice(0, -(ext.length + 1));
    assert.ok(cps(body) <= MAX_FILE_BODY, `body ≤ ${MAX_FILE_BODY} code points: ${cps(body)}`);
    assert.ok(!UNSAFE_ONE.test(body), `no unsafe char in body: ${JSON.stringify(body)}`);
    assert.ok(!/^[ .]/.test(body) && !/[ .]$/.test(body), `body edges: ${JSON.stringify(body)}`);
    const base = body.slice(0, -(label.length + 1));
    assert.ok(cps(base) >= 1, 'base keeps at least one character');
    if (processedBase(name) === '') assert.ok(body.startsWith('导出'), `empty base → 导出: ${JSON.stringify(body)}`);
  }, { runs: 300 });
});

const SAFE_CHARS = 'abcXYZ019-_层间音乐é😀 .';
const SAFE_EDGE = 'abcXYZ019-_层间音乐é😀';

// Feature: stem-video-export, Property 2: 安全短名保持不变
test('Feature: stem-video-export, Property 2: 安全短名保持不变', async () => {
  // **Validates: Requirements 4.1**
  const g = (rng) => {
    const label = pick(EXPORT_LABELS)(rng);
    const maxLen = MAX_FILE_BODY - 1 - cps(label);
    const len = gen.int(1, maxLen)(rng);
    const chars = Array.from({ length: len }, (_, i) =>
      pick(Array.from(i === 0 || i === len - 1 ? SAFE_EDGE : SAFE_CHARS))(rng));
    const e = Array.from({ length: gen.int(0, 5)(rng) }, () => pick(Array.from('abcmp4MOV'))(rng)).join('');
    return { base: chars.join(''), e, label, ext: pick(EXTS)(rng) };
  };
  await forAll(g, ({ base, e, label, ext }) => {
    assert.equal(fileNameFor(`${base}.${e}`, label, ext), `${base}-${label}.${ext}`);
  }, { runs: 300 });
});

// Feature: stem-video-export, Property 4: 导出按钮状态模型
test('Feature: stem-video-export, Property 4: 导出按钮状态模型', async () => {
  // **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 3.4**
  const bool = (rng) => rng() < 0.5;
  const g = (rng) => ({
    ctx: {
      hasFile: bool(rng), separating: bool(rng), stemsReady: bool(rng),
      selected: pick(STEM_IDS)(rng), hasStemUrl: bool(rng), exporting: bool(rng),
    },
    ffmpeg: bool(rng), canRecord: bool(rng),
  });
  await forAll(g, ({ ctx, ffmpeg, canRecord }) => {
    const s = exportButtonState(ctx);
    const enabled = ctx.hasFile && !ctx.separating && ctx.stemsReady
      && ctx.selected !== 'original' && ctx.hasStemUrl && !ctx.exporting;
    assert.equal(s.disabled === false, enabled);
    const done = ctx.hasFile && !ctx.separating && ctx.stemsReady;
    assert.equal(s.hint === '原曲就是原文件，无需导出', done && ctx.selected === 'original');
    // Independent of FFmpeg / recording support.
    assert.deepEqual(exportButtonState({ ...ctx, ffmpegAvailable: ffmpeg, canRecord }), s);
  }, { runs: 300 });
});

test('fileNameFor examples', () => {
  assert.equal(fileNameFor('练习 v2.final.mp4', '人声', 'mp4'), '练习 v2.final-人声.mp4');
  assert.equal(fileNameFor('', '鼓', 'wav'), '导出-鼓.wav');
  assert.equal(fileNameFor('a/b:c.mp4', '贝斯', 'webm'), 'a_b_c-贝斯.webm');
});

test('exportProgressText covers every stage', () => {
  assert.equal(exportProgressText({ stage: 'upload' }), '上传到本地服务器…');
  assert.equal(exportProgressText({ stage: 'queued', position: 3 }), '排队中（第 3 位）');
  assert.equal(exportProgressText({ stage: 'queued' }), '排队中（第 1 位）');
  assert.equal(exportProgressText({ stage: 'running', progress: 42 }), '合成视频 42%');
  assert.equal(exportProgressText({ stage: 'running', progress: null }), '合成视频中…');
  assert.equal(exportProgressText({ stage: 'download' }), '下载视频…');
  assert.equal(exportProgressText({ stage: 'recording', progress: 7 }), '浏览器录制中 7%（需要和视频一样长的时间）');
  assert.equal(exportProgressText({ stage: 'recording' }), '浏览器录制中 0%（需要和视频一样长的时间）');
  assert.equal(exportProgressText({ stage: 'nope' }), '');
  assert.equal(exportProgressText(null), '');
});

test('triggerDownload revokes only its own Blob URL, after the click', () => {
  const created = [];
  const revoked = [];
  const timers = [];
  const anchors = [];
  const fakeURL = {
    createObjectURL: () => { const u = `blob:test/${created.length}`; created.push(u); return u; },
    revokeObjectURL: (u) => revoked.push(u),
  };
  const body = { children: [], appendChild(a) { this.children.push(a); } };
  const fakeDoc = {
    body,
    createElement: () => {
      const a = { style: {}, clicked: false, click() { this.clicked = true; }, remove() {
        body.children = body.children.filter((c) => c !== this);
      } };
      anchors.push(a);
      return a;
    },
  };
  const fakeSetTimeout = (fn, ms) => { timers.push({ fn, ms }); };

  const url = triggerDownload(new Blob(['x']), '歌-人声.mp4', { document: fakeDoc, URL: fakeURL, setTimeout: fakeSetTimeout });
  assert.equal(url, 'blob:test/0');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].href, url);
  assert.equal(anchors[0].download, '歌-人声.mp4');
  assert.ok(anchors[0].clicked);
  assert.equal(body.children.length, 0);
  assert.deepEqual(revoked, [], 'not revoked synchronously');

  while (timers.length) timers.shift().fn();
  assert.deepEqual(revoked, [url], 'only its own URL is revoked');
});

test('fetchExportStatus returns null on timeout', async () => {
  const neverFetch = () => new Promise(() => {}); // ignores the abort signal
  const t0 = Date.now();
  assert.equal(await fetchExportStatus({ fetch: neverFetch, timeoutMs: 30 }), null);
  assert.ok(Date.now() - t0 < 2000);
});

test('fetchExportStatus parses a valid response and forces available=false while checking', async () => {
  const ok = (body) => async () => ({ ok: true, json: async () => body });
  assert.deepEqual(await fetchExportStatus({ fetch: ok({ available: true, checking: false, maxUploadBytes: 10, queueLength: 2 }) }),
    { available: true, checking: false, maxUploadBytes: 10, queueLength: 2 });
  assert.deepEqual(await fetchExportStatus({ fetch: ok({ available: true, checking: true }) }),
    { available: false, checking: true, maxUploadBytes: null, queueLength: 0 });
});

// ---------------------------------------------------------------------------
// runServerMux (task 6.6)
// ---------------------------------------------------------------------------

// Import declarations are hoisted, so this second import is valid here.
import { runServerMux, ExportError, EXPORT_API } from '../public/js/export-client.js';

const jsonRes = (status, body) => ({
  status, ok: status >= 200 && status < 300,
  json: async () => body,
  blob: async () => new Blob([JSON.stringify(body)]),
});
const mp4Res = (bytes = 'MP4DATA') => ({
  status: 200, ok: true,
  json: async () => { throw new Error('not json'); },
  blob: async () => new Blob([bytes], { type: 'video/mp4' }),
});

/**
 * Fake Server: answers POST with `upload`, each poll with the next entry of
 * `polls` (then 'done'), result.mp4 with `download`, DELETE with 204. Entries
 * are a response object, a function returning one, or 'neterr' (fetch rejects).
 * Records every call.
 */
function fakeServer({ upload = jsonRes(202, { id: 'job1', status: 'queued', position: 1 }), polls = [], download = mp4Res() } = {}) {
  const calls = [];
  let i = 0;
  const answer = (r, init) => {
    const v = typeof r === 'function' ? r(init) : r;
    if (v === 'neterr') return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve(v);
  };
  const fetch = (url, init = {}) => {
    calls.push({ url, init });
    const method = init.method || 'GET';
    if (method === 'POST') return answer(upload, init);
    if (method === 'DELETE') return Promise.resolve(jsonRes(204, {}));
    if (url.endsWith('/result.mp4')) return answer(download, init);
    const next = i < polls.length ? polls[i++] : jsonRes(200, { status: 'done' });
    return answer(next, init);
  };
  return { fetch, calls };
}

const noSleep = async () => {};
const makeFile = (name, type = 'video/mp4') => new File(['VIDEO-BYTES'], name, { type });
const makeWav = () => new Blob(['RIFF....WAVEfmt ']);

// A distinctive non-ASCII fragment is always inserted into the base name so a
// match in an (ASCII) URL or header cannot be a coincidence with the fixed
// template such as `ext=mp4&wavBytes=`.
const MARKERS = ['层', '间', '音乐', 'Ж', '😀', 'é'];
const muxNameGen = (rng) => {
  const a = gen.string({ minLength: 0, maxLength: 12 })(rng);
  const b = gen.string({ minLength: 1, maxLength: 12 })(rng);
  const m = MARKERS[Math.floor(rng() * MARKERS.length)];
  const ext = gen.oneOf('mp4', 'MOV', 'mkv', 'webm', 'avi', '', 'tar.gz')(rng);
  return ext ? `${a}${m}${b}.${ext}` : `${a}${m}${b}`;
};
const uploadGen = gen.oneOf(
  () => jsonRes(202, { id: 'a1b2c3', status: 'queued', position: 1 }),
  () => jsonRes(202, { id: 'a1b2c3', status: 'queued', position: 1 }),
  () => jsonRes(413, { error: '上传的文件太大' }),
  () => jsonRes(429, { error: '导出任务过多，请稍后再试' }),
  () => jsonRes(500, { error: '服务器无法保存上传文件' }),
  () => jsonRes(503, { error: '视频导出不可用' }),
  () => 'neterr',
);
const pollGen = gen.oneOf(
  () => jsonRes(200, { status: 'queued', position: 2 }),
  () => jsonRes(200, { status: 'running', progress: 42 }),
  () => jsonRes(200, { status: 'running', progress: null }),
  () => jsonRes(200, { status: 'done' }),
  () => jsonRes(200, { status: 'failed', error: 'ffmpeg 退出码 1' }),
  () => jsonRes(200, { status: 'cancelled' }),
  () => jsonRes(404, { error: '任务不存在' }),
  () => jsonRes(500, { error: 'boom' }),
  () => 'neterr',
);
const muxCaseGen = (rng) => ({
  name: muxNameGen(rng),
  upload: uploadGen(rng),
  polls: gen.array(pollGen, { minLength: 0, maxLength: 8 })(rng),
  download: gen.oneOf(() => mp4Res(), () => jsonRes(404, { error: '结果不存在' }), () => 'neterr')(rng),
});

function headerValues(headers) {
  if (!headers) return [];
  if (typeof headers.entries === 'function') return [...headers.entries()].flat();
  return Object.entries(headers).flat().map(String);
}

// Feature: stem-video-export, Property 3: 发往 Server 的请求不含文件名且只发往本地
test('Feature: stem-video-export, Property 3: 发往 Server 的请求不含文件名且只发往本地', async () => {
  // **Validates: Requirements 4.6, 5.6**
  await forAll(muxCaseGen, async ({ name, upload, polls, download }) => {
    const { fetch, calls } = fakeServer({ upload, polls, download });
    try {
      await runServerMux(makeFile(name), makeWav(), { fetch, sleep: noSleep, pollMs: 1 });
    } catch (err) {
      assert.ok(err instanceof ExportError, `unexpected error ${err && err.name}: ${err && err.message}`);
    }
    assert.ok(calls.length >= 1);
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const enc = (s) => { try { return encodeURIComponent(s); } catch { return s; } }; // lone surrogates
    const needles = [name, enc(name)];
    if (cps(base) >= 3) needles.push(base, enc(base));
    for (const { url, init } of calls) {
      assert.equal(typeof url, 'string');
      assert.ok(url.startsWith(EXPORT_API), `not relative /api/export: ${url}`);
      assert.ok(!url.includes('//'), `absolute or protocol-relative URL: ${url}`);
      const hay = [url, ...headerValues(init.headers)];
      for (const h of hay) {
        for (const n of needles) assert.ok(!h.includes(n), `file name leaked into ${JSON.stringify(h)}`);
      }
    }
    const post = calls.find((c) => c.init.method === 'POST');
    const query = new URL(post.url, 'http://localhost').searchParams;
    assert.deepEqual([...query.keys()].sort(), ['ext', 'wavBytes']);
  }, { runs: 150 });
});

test('runServerMux waits pollMs before each poll and reports phases in order', async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const { fetch, calls } = fakeServer({
    polls: [
      jsonRes(200, { status: 'queued', position: 3 }),
      jsonRes(200, { status: 'running', progress: 12.6 }),
      jsonRes(200, { status: 'running', progress: 150 }),
      jsonRes(200, { status: 'done' }),
    ],
  });
  const phases = [];
  const blob = await runServerMux(makeFile('练习.mp4'), makeWav(), {
    fetch, sleep, pollMs: 750, onPhase: (p) => phases.push(p),
  });
  assert.equal(await blob.text(), 'MP4DATA');
  assert.deepEqual(sleeps, [750, 750, 750, 750]);
  const polls = calls.filter((c) => !c.init.method && !c.url.endsWith('/result.mp4'));
  assert.equal(polls.length, 4);
  assert.deepEqual(phases, [
    { stage: 'upload' },
    { stage: 'queued', position: 3 },
    { stage: 'running', progress: 13 },
    { stage: 'running', progress: 100 },
    { stage: 'download' },
  ]);
});

test('runServerMux sends the upload as one POST and DELETEs the job after download', async () => {
  const { fetch, calls } = fakeServer({ upload: jsonRes(202, { id: 'job42', status: 'queued', position: 1 }) });
  const wav = makeWav();
  await runServerMux(makeFile('clip.MOV'), wav, { fetch, sleep: noSleep });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].url, `${EXPORT_API}?ext=mov&wavBytes=${wav.size}`);
  assert.equal(calls[0].init.body.size, wav.size + 'VIDEO-BYTES'.length);
  const last = calls[calls.length - 1];
  assert.equal(last.url, `${EXPORT_API}/job42`);
  assert.equal(last.init.method, 'DELETE');
  assert.notEqual(last.init.keepalive, true);
  assert.equal(calls.filter((c) => c.init.method === 'DELETE').length, 1);
  assert.ok(calls.some((c) => c.url === `${EXPORT_API}/job42/result.mp4`));
});

test('runServerMux abort while polling sends a keepalive DELETE and throws AbortError', async () => {
  const ctrl = new AbortController();
  const { fetch, calls } = fakeServer({
    polls: [() => { ctrl.abort(); return jsonRes(200, { status: 'running', progress: 5 }); }],
  });
  await assert.rejects(
    runServerMux(makeFile('a.mp4'), makeWav(), { fetch, sleep: noSleep, signal: ctrl.signal }),
    (err) => err.name === 'AbortError',
  );
  const dels = calls.filter((c) => c.init.method === 'DELETE');
  assert.equal(dels.length, 1);
  assert.equal(dels[0].url, `${EXPORT_API}/job1`);
  assert.equal(dels[0].init.keepalive, true);
  assert.ok(!calls.some((c) => c.url.endsWith('/result.mp4')));
});

test('runServerMux abort during upload throws AbortError without DELETE', async () => {
  const ctrl = new AbortController();
  const { fetch, calls } = fakeServer({
    upload: () => { ctrl.abort(); return 'neterr'; },
  });
  await assert.rejects(
    runServerMux(makeFile('a.mp4'), makeWav(), { fetch, sleep: noSleep, signal: ctrl.signal }),
    (err) => err.name === 'AbortError',
  );
  assert.equal(calls.length, 1);
});

for (const [status, error] of [
  [413, '上传的文件太大'],
  [429, '导出任务过多，请稍后再试'],
  [500, '服务器无法保存上传文件'],
  [503, '视频导出不可用'],
]) {
  test(`runServerMux upload ${status} → ExportError('upload') with the server's error`, async () => {
    const { fetch, calls } = fakeServer({ upload: jsonRes(status, { error }) });
    await assert.rejects(
      runServerMux(makeFile('a.mp4'), makeWav(), { fetch, sleep: noSleep }),
      (err) => err instanceof ExportError && err.stage === 'upload' && err.reason === error,
    );
    assert.equal(calls.length, 1, 'no poll or DELETE after a rejected upload');
  });
}

test("runServerMux upload network error → ExportError('upload')", async () => {
  const { fetch, calls } = fakeServer({ upload: 'neterr' });
  await assert.rejects(
    runServerMux(makeFile('a.mp4'), makeWav(), { fetch, sleep: noSleep }),
    (err) => err instanceof ExportError && err.stage === 'upload' && err.reason.length > 0,
  );
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// Path selection and browser recording (task 6.7)
// ---------------------------------------------------------------------------

import {
  exportVideoWithFallback, pickRecorderMime, RECORDER_TYPES, canBrowserRecord,
  runBrowserRecording, AUTOPLAY_BLOCKED_TEXT,
} from '../public/js/export-client.js';
import { SPEEDS } from '../public/js/player.js';

const DERIVED_IDS = STEM_IDS.filter((id) => id !== 'original');
const abortErr = () => new DOMException('已取消', 'AbortError');

// Feature: stem-video-export, Property 5: 视频导出路径选择模型
test('Feature: stem-video-export, Property 5: 视频导出路径选择模型', async () => {
  // **Validates: Requirements 5.2, 5.3, 5.4, 5.5, 11.2, 12.4**
  const bool = (rng) => rng() < 0.5;
  const g = (rng) => ({
    status: gen.oneOf('null', 'throw', 'object')(rng),
    available: bool(rng),
    checking: bool(rng),
    server: gen.oneOf('ok', 'export', 'abort')(rng),
    canRecord: bool(rng),
    browser: gen.oneOf('ok', 'export')(rng),
  });
  await forAll(g, async (c) => {
    const serverBlob = new Blob(['server']);
    const browserBlob = new Blob(['browser']);
    const serverErr = c.server === 'abort' ? abortErr() : new ExportError({ stage: 'job', reason: 'ffmpeg 退出码 1' });
    const browserErr = new ExportError({ stage: 'record', reason: '录制出错' });
    let serverCalls = 0;
    let browserCalls = 0;
    const notices = [];
    const deps = {
      fetchStatus: async () => {
        if (c.status === 'null') return null;
        if (c.status === 'throw') throw new TypeError('Failed to fetch');
        return { available: c.available, checking: c.checking, maxUploadBytes: 1, queueLength: 0 };
      },
      runServer: async () => { serverCalls += 1; if (c.server === 'ok') return serverBlob; throw serverErr; },
      runBrowser: async () => { browserCalls += 1; if (c.browser === 'ok') return browserBlob; throw browserErr; },
      canRecord: () => c.canRecord,
      onNotice: (text) => notices.push(text),
    };
    let result = null;
    let error = null;
    try { result = await exportVideoWithFallback(deps); } catch (err) { error = err; }

    const serverExpected = c.status === 'object' && c.available && !c.checking;
    assert.equal(serverCalls, serverExpected ? 1 : 0, 'runServer called iff available && !checking');
    const serverFailed = serverExpected && c.server === 'export';
    assert.equal(notices.length, serverFailed ? 1 : 0, 'onNotice iff runServer failed with a non-abort error');

    if (serverExpected && c.server === 'ok') {
      assert.equal(error, null);
      assert.deepEqual(result, { path: 'server', blob: serverBlob });
      assert.equal(browserCalls, 0);
      return;
    }
    if (serverExpected && c.server === 'abort') {
      assert.equal(error, serverErr, 'AbortError rethrown unchanged');
      assert.equal(browserCalls, 0);
      return;
    }
    if (!c.canRecord) {
      assert.ok(error instanceof ExportError && error.stage === 'unsupported', `expected unsupported, got ${error}`);
      assert.equal(browserCalls, 0);
      return;
    }
    assert.equal(browserCalls, 1);
    if (c.browser === 'ok') {
      assert.equal(error, null);
      assert.deepEqual(result, { path: 'browser', blob: browserBlob });
    } else {
      assert.equal(error, browserErr);
    }
  }, { runs: 300 });
});

const OTHER_TYPES = ['video/mp4', 'video/webm;codecs=h264', 'video/x-matroska', 'audio/webm', 'video/webm;codecs=av1'];

// Feature: stem-video-export, Property 14: 录制格式选择
test('Feature: stem-video-export, Property 14: 录制格式选择', async () => {
  // **Validates: Requirements 12.3, 12.4**
  const g = (rng) => [...RECORDER_TYPES, ...OTHER_TYPES].filter(() => rng() < 0.4);
  await forAll(g, (supported) => {
    const set = new Set(supported);
    class MR { static isTypeSupported(t) { return set.has(t); } }
    const expected = RECORDER_TYPES.find((t) => set.has(t)) ?? null;
    const mime = pickRecorderMime(MR);
    assert.equal(mime, expected);
    // Every other capability is present, so recording support depends only on the MIME type.
    const env = {
      HTMLMediaElement: { prototype: { captureStream() {} } },
      MediaRecorder: MR,
      AudioContext: class {},
    };
    assert.equal(canBrowserRecord(env), mime !== null);
  }, { runs: 200 });
});

// --- Fake browser environment for runBrowserRecording ---------------------

class FakeTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { const s = this.listeners.get(type); if (s) s.delete(fn); }
  dispatch(type) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, target: this }); }
  listenerCount() { let n = 0; for (const s of this.listeners.values()) n += s.size; return n; }
}

const fakeTrack = (kind, label) => ({ kind, label, stopped: false, stop() { this.stopped = true; } });

class FakeStream {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
}

/**
 * outcome: 'ended' | 'cancel' | 'recorderError' | 'mediaError' | 'autoplay'.
 * The outcome is triggered right after the Player's first play() (the one
 * made by the recording). `trigger` is wired into the fake player.
 */
function makeRecordingEnv({ outcome, mediaErrorOn = 'video', autoplayVia = 'player' }) {
  const log = { audios: [], recorders: [], contexts: [], connections: [], capture: null };
  const ctrl = new AbortController();

  class FakeAudio extends FakeTarget {
    constructor() {
      super();
      this.readyState = 0; this._src = ''; this.srcHistory = [];
      this.currentTime = 0; this.paused = true; this.error = null; this.preload = '';
      log.audios.push(this);
    }
    get src() { return this._src; }
    set src(v) { this._src = v; this.srcHistory.push(v); }
    load() {
      if (this._src) setTimeout(() => { this.readyState = 1; this.dispatch('loadedmetadata'); }, 0);
    }
    removeAttribute(name) { if (name === 'src') this._src = ''; }
    play() {
      if (outcome === 'autoplay' && autoplayVia === 'recAudio') {
        return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
      }
      this.paused = false;
      return Promise.resolve();
    }
    pause() { this.paused = true; }
  }

  class FakeAudioContext {
    constructor() { this.destination = { name: 'speakers' }; this.closed = false; log.contexts.push(this); }
    createMediaStreamDestination() { this.dest = { stream: new FakeStream([fakeTrack('audio', 'dest')]) }; return this.dest; }
    createMediaElementSource(el) { return { connect: (node) => log.connections.push({ el, node }) }; }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
  }

  class FakeMediaRecorder {
    static isTypeSupported(t) { return t === 'video/webm;codecs=vp8,opus' || t === 'video/webm'; }
    constructor(stream, opts) {
      this.stream = stream; this.opts = opts; this.state = 'inactive';
      this.ondataavailable = null; this.onerror = null; this.onstop = null;
      log.recorders.push(this);
    }
    start(timeslice) { this.state = 'recording'; this.timeslice = timeslice; }
    stop() {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      setTimeout(() => {
        if (this.ondataavailable) this.ondataavailable({ data: new Blob(['WEBM-DATA']) });
        if (this.onstop) this.onstop();
      }, 0);
    }
  }

  const video = new FakeTarget();
  video.currentTime = 0;
  video.error = null;
  video.captureStream = () => {
    log.capture = new FakeStream([fakeTrack('video', 'picture'), fakeTrack('audio', 'source-audio')]);
    return log.capture;
  };

  const trigger = (player) => {
    if (outcome === 'ended') {
      // Some data arrives while recording, then the video reaches its end.
      const rec = log.recorders[0];
      if (rec && rec.ondataavailable) rec.ondataavailable({ data: new Blob(['CHUNK']) });
      video.currentTime = player.duration;
      video.dispatch('timeupdate');
      video.dispatch('ended');
    } else if (outcome === 'cancel') {
      const rec = log.recorders[0];
      if (rec && rec.ondataavailable) rec.ondataavailable({ data: new Blob(['CHUNK']) });
      ctrl.abort();
    } else if (outcome === 'recorderError') {
      log.recorders[0].onerror({ error: new Error('encoder died') });
    } else if (outcome === 'mediaError') {
      const el = mediaErrorOn === 'video' ? video : log.audios[0];
      el.error = { message: 'decode error' };
      el.dispatch('error');
    }
  };

  const env = { Audio: FakeAudio, AudioContext: FakeAudioContext, MediaRecorder: FakeMediaRecorder, MediaStream: FakeStream };
  return { env, video, log, ctrl, trigger, blockFirstPlay: outcome === 'autoplay' && autoplayVia === 'player' };
}

/** Fake SyncPlayer. `plays[i]` snapshots the state at each play() call. */
function makeFakePlayer(init, { onFirstPlay, blockFirstPlay = false } = {}) {
  const p = {
    currentTime: init.time, rate: init.rate, paused: !init.playing, loop: init.loop,
    selected: init.selected, duration: init.duration, plays: [],
    select(id) { this.selected = id; },
    seek(t) { this.currentTime = t; },
    setRate(r) { this.rate = r; },
    setLoop(on) { this.loop = !!on; },
    pause() { this.paused = true; },
    async play() {
      const first = this.plays.length === 0;
      this.plays.push({ selected: this.selected, currentTime: this.currentTime, rate: this.rate, loop: this.loop });
      if (first && blockFirstPlay) return; // autoplay refused: SyncPlayer swallows it and stays paused
      this.paused = false;
      if (first && onFirstPlay) setTimeout(() => onFirstPlay(p), 0);
    },
  };
  return p;
}

function setupRecording(state, outcomeOpts, extra = {}) {
  const r = makeRecordingEnv(outcomeOpts);
  const player = makeFakePlayer(state, { onFirstPlay: r.trigger, blockFirstPlay: r.blockFirstPlay });
  const opts = {
    player, video: r.video, stemId: state.stemId, stemUrl: `blob:test/${state.stemId}`,
    selected: state.selected, signal: r.ctrl.signal, env: r.env, ...extra,
  };
  return { ...r, player, opts };
}

// Feature: stem-video-export, Property 15: 录制结束后恢复 Playback_State
test('Feature: stem-video-export, Property 15: 录制结束后恢复 Playback_State', async () => {
  // **Validates: Requirements 2.6, 12.1, 12.9**
  const g = (rng) => {
    const duration = gen.float(0.5, 600)(rng);
    return {
      duration,
      time: gen.float(0, duration)(rng),
      rate: pick(SPEEDS)(rng),
      playing: rng() < 0.5,
      loop: rng() < 0.5,
      selected: pick(STEM_IDS)(rng),  // may differ from stemId
      stemId: pick(DERIVED_IDS)(rng),
      outcome: gen.oneOf('ended', 'cancel', 'recorderError', 'mediaError', 'autoplay')(rng),
      mediaErrorOn: gen.oneOf('video', 'recAudio')(rng),
      autoplayVia: gen.oneOf('player', 'recAudio')(rng),
    };
  };
  await forAll(g, async (s) => {
    const { player, video, opts } = setupRecording(s, s);
    let result = null;
    let error = null;
    try { result = await runBrowserRecording(opts); } catch (err) { error = err; }

    if (s.outcome === 'ended') {
      assert.equal(error, null, `unexpected error: ${error && error.message}`);
      assert.ok(result instanceof Blob && result.size > 0 && result.type === 'video/webm');
    } else if (s.outcome === 'cancel') {
      assert.equal(result, null);
      assert.equal(error && error.name, 'AbortError');
    } else {
      assert.equal(result, null);
      assert.ok(error instanceof ExportError && error.stage === 'record', `expected record error, got ${error}`);
    }

    // During recording: stemId, from 0, 1x, no loop.
    assert.ok(player.plays.length >= 1);
    assert.deepEqual(player.plays[0], { selected: s.stemId, currentTime: 0, rate: 1, loop: false });

    // After: back to the snapshot, with the track the user had selected.
    assert.equal(player.currentTime, s.time);
    assert.equal(player.rate, s.rate);
    assert.equal(player.paused, !s.playing);
    assert.equal(player.loop, s.loop);
    assert.equal(player.selected, s.selected);
    assert.equal(video.listenerCount(), 0, 'video listeners removed');
  }, { runs: 150 });
});

const EXAMPLE_STATE = { duration: 30, time: 12.5, rate: 1.25, playing: true, loop: true, selected: 'original', stemId: 'vocals' };

test('runBrowserRecording records only the video track plus the dest audio track', async () => {
  const { opts, log } = setupRecording(EXAMPLE_STATE, { outcome: 'ended' });
  const blob = await runBrowserRecording(opts);
  assert.equal(await blob.text(), 'CHUNKWEBM-DATA');
  assert.equal(log.recorders.length, 1);
  const rec = log.recorders[0];
  assert.equal(rec.opts.mimeType, 'video/webm;codecs=vp8,opus');
  const ctx = log.contexts[0];
  const [pictureTrack] = log.capture.getVideoTracks();
  const [destTrack] = ctx.dest.stream.getAudioTracks();
  assert.deepEqual(rec.stream.getTracks(), [pictureTrack, destTrack], 'no Source_File audio track');
  assert.ok(!rec.stream.getTracks().some((t) => t.label === 'source-audio'));
  // recAudio goes to the MediaStreamDestination, not the speakers.
  assert.deepEqual(log.connections.map((c) => c.node), [ctx.dest]);
  assert.equal(log.connections[0].el, log.audios[0]);
  // Everything released.
  assert.ok(log.capture.getTracks().every((t) => t.stopped));
  assert.ok(destTrack.stopped);
  assert.ok(ctx.closed);
});

test('runBrowserRecording plays the Export_Stem URL on a dedicated recAudio element', async () => {
  const { opts, log } = setupRecording({ ...EXAMPLE_STATE, stemId: 'drums' }, { outcome: 'ended' });
  await runBrowserRecording(opts);
  assert.equal(log.audios.length, 1);
  const recAudio = log.audios[0];
  assert.equal(recAudio.srcHistory[0], 'blob:test/drums');
  assert.equal(recAudio.src, '', 'recAudio detached afterwards');
  assert.equal(recAudio.paused, true);
});

test('runBrowserRecording cancel rejects with AbortError and returns no data', async () => {
  const progress = [];
  const { opts, log } = setupRecording(EXAMPLE_STATE, { outcome: 'cancel' }, { onProgress: (p) => progress.push(p) });
  await assert.rejects(runBrowserRecording(opts), (err) => err.name === 'AbortError');
  assert.ok(!progress.includes(100));
  assert.equal(log.recorders[0].state, 'inactive');
  assert.ok(log.capture.getTracks().every((t) => t.stopped));
});

test('runBrowserRecording already-aborted signal rejects before touching the player', async () => {
  const { opts, player, ctrl, log } = setupRecording(EXAMPLE_STATE, { outcome: 'ended' });
  ctrl.abort();
  await assert.rejects(runBrowserRecording(opts), (err) => err.name === 'AbortError');
  assert.equal(player.plays.length, 0);
  assert.equal(log.recorders.length, 0);
});

for (const [name, outcomeOpts, reasonCheck] of [
  ['MediaRecorder error', { outcome: 'recorderError' }, (r) => r.includes('encoder died')],
  ['video media error', { outcome: 'mediaError', mediaErrorOn: 'video' }, (r) => r.includes('decode error')],
  ['recAudio media error', { outcome: 'mediaError', mediaErrorOn: 'recAudio' }, (r) => r.includes('decode error')],
  ['autoplay refused (player stays paused)', { outcome: 'autoplay', autoplayVia: 'player' }, (r) => r === AUTOPLAY_BLOCKED_TEXT],
  ['autoplay refused (recAudio.play rejects)', { outcome: 'autoplay', autoplayVia: 'recAudio' }, (r) => r === AUTOPLAY_BLOCKED_TEXT],
]) {
  test(`runBrowserRecording ${name} → ExportError('record')`, async () => {
    const { opts } = setupRecording(EXAMPLE_STATE, outcomeOpts);
    await assert.rejects(
      runBrowserRecording(opts),
      (err) => err instanceof ExportError && err.stage === 'record' && reasonCheck(err.reason),
    );
  });
}
