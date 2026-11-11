// Unit tests for public/js/remote-separator.js (task 12.3).
// Requirements 1.5, 3.5, 4.2, 4.5, 6.3, 6.4, 10.5.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DEMUCS_MODEL,
  DEMUCS_MODELS,
  API,
  sanitizeDemucsModel,
  fetchDemucsStatus,
  remoteProgressText,
  fallbackNotice,
  DemucsError,
  separateWithFallback,
  runDemucsSeparation,
} from '../public/js/remote-separator.js';
import { encodeWav } from '../public/js/wav.js';
import { forAll, gen } from './helpers/prop.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SR = 22050;
const FRAMES = Math.round(SR * 0.1);

/** Small stereo WAV with a different tone per stem. */
function fakeStemWav(seed) {
  const L = new Float32Array(FRAMES);
  const R = new Float32Array(FRAMES);
  for (let i = 0; i < FRAMES; i++) {
    L[i] = 0.3 * Math.sin((2 * Math.PI * (200 + 100 * seed) * i) / SR);
    R[i] = 0.2 * Math.sin((2 * Math.PI * (300 + 150 * seed) * i) / SR);
  }
  return encodeWav([L, R], SR);
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    arrayBuffer: async () => { throw new Error('not binary'); },
  };
}

function wavResponse(buf) {
  return {
    status: 200,
    ok: true,
    json: async () => { throw new Error('not json'); },
    arrayBuffer: async () => buf.slice(0),
  };
}

const JOB = 'job-123';
const STEMS = ['vocals', 'drums', 'bass', 'other'];

/**
 * Fake server for the Demucs API. `statuses` is the sequence of job states
 * returned by successive polls (last one repeats). `failStem` makes that
 * stem's download return HTTP 500. `onPoll(n)` runs before each poll reply.
 */
function fakeServer({ statuses, failStem = null, onPoll = null } = {}) {
  const calls = [];
  let polls = 0;
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, init });
    if (init.signal && init.signal.aborted && method !== 'DELETE') {
      throw new DOMException('aborted', 'AbortError');
    }
    if (method === 'POST' && url.startsWith(`${API}?`)) {
      return jsonResponse(202, { id: JOB });
    }
    if (method === 'DELETE' && url === `${API}/${JOB}`) {
      return jsonResponse(200, { ok: true });
    }
    if (method === 'GET' && url === `${API}/${JOB}`) {
      const s = statuses[Math.min(polls, statuses.length - 1)];
      polls += 1;
      if (onPoll) onPoll(polls);
      return jsonResponse(200, s);
    }
    const m = method === 'GET' && url.match(new RegExp(`^${API}/${JOB}/(\\w+)\\.wav$`));
    if (m) {
      if (m[1] === failStem) return jsonResponse(500, { error: 'boom' });
      const idx = STEMS.indexOf(m[1]);
      if (idx < 0) return jsonResponse(404, { error: 'no such stem' });
      return wavResponse(fakeStemWav(idx));
    }
    return jsonResponse(404, { error: 'unexpected' });
  };
  return { fetch, calls, get polls() { return polls; } };
}

function fakeUrls() {
  let n = 0;
  const created = [];
  const revoked = [];
  return {
    created,
    revoked,
    createObjectURL: (wav) => {
      assert.ok(wav instanceof ArrayBuffer);
      const u = `blob:fake/${++n}`;
      created.push(u);
      return u;
    },
    revokeObjectURL: (u) => { revoked.push(u); },
  };
}

function fakeSleep() {
  const waits = [];
  const sleep = async (ms, signal) => {
    waits.push(ms);
    if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
  };
  return { sleep, waits };
}

const file = Object.assign(new Blob([new Uint8Array(16)]), { name: 'song.MP3' });

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

test('sanitizeDemucsModel keeps allowed names, defaults everything else', () => {
  assert.equal(sanitizeDemucsModel('htdemucs'), 'htdemucs');
  assert.equal(sanitizeDemucsModel('htdemucs_6s'), 'htdemucs_6s');
  for (const v of [undefined, null, '', 'mdx', 'HTDEMUCS', 42, {}, ['htdemucs']]) {
    assert.equal(sanitizeDemucsModel(v), DEFAULT_DEMUCS_MODEL);
  }
});

test('remoteProgressText covers each stage (Requirement 3.5)', () => {
  assert.equal(remoteProgressText({ stage: 'upload' }), '上传到本地服务器…');
  assert.equal(remoteProgressText({ stage: 'queued', position: 2 }), '排队中（第 2 位）');
  assert.equal(remoteProgressText({ stage: 'running', progress: 37 }), 'AI 分离中 37%');
  assert.equal(remoteProgressText({ stage: 'download' }), '整理 AI 音轨…');
  assert.equal(remoteProgressText({ stage: 'nope' }), '');
});

test('fallbackNotice includes the reason when present', () => {
  assert.equal(fallbackNotice(new DemucsError({ reason: '显存不足' })), 'AI 分离失败（显存不足），已改用浏览器分离。');
  assert.equal(fallbackNotice(new Error('x')), 'AI 分离暂时不可用，已改用浏览器分离。');
  assert.equal(fallbackNotice(null), 'AI 分离暂时不可用，已改用浏览器分离。');
});

test('separateWithFallback: unavailable status runs only DSP', async () => {
  let demucs = 0;
  const r = await separateWithFallback({
    fetchStatus: async () => ({ available: false, checking: false }),
    runDemucs: async () => { demucs++; },
    runDsp: async () => 'dsp-result',
  });
  assert.deepEqual(r, { engine: 'dsp', result: 'dsp-result' });
  assert.equal(demucs, 0);
});

test('separateWithFallback: Demucs failure shows notice and falls back', async () => {
  const notices = [];
  const r = await separateWithFallback({
    fetchStatus: async () => ({ available: true, checking: false }),
    runDemucs: async () => { throw new DemucsError({ reason: '超时' }); },
    runDsp: async () => 'dsp',
    onNotice: (t) => notices.push(t),
  });
  assert.deepEqual(r, { engine: 'dsp', result: 'dsp' });
  assert.deepEqual(notices, ['AI 分离失败（超时），已改用浏览器分离。']);
});

test('separateWithFallback: AbortError is rethrown without DSP (Requirement 6.4)', async () => {
  let dsp = 0;
  await assert.rejects(
    separateWithFallback({
      fetchStatus: async () => ({ available: true, checking: false }),
      runDemucs: async () => { throw new DOMException('x', 'AbortError'); },
      runDsp: async () => { dsp++; },
    }),
    { name: 'AbortError' },
  );
  assert.equal(dsp, 0);
});

// ---------------------------------------------------------------------------
// fetchDemucsStatus
// ---------------------------------------------------------------------------

test('fetchDemucsStatus returns null promptly when the request never settles (Requirement 1.5)', async () => {
  // Never responds; rejects only when aborted, like a real fetch.
  const abortable = (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });

  // Guard so a regression reports a failure instead of stalling the run.
  const guard = (p) => Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error('did not return in time')), 1000)),
  ]);

  const t0 = Date.now();
  assert.equal(await guard(fetchDemucsStatus({ fetch: abortable, timeoutMs: 50 })), null);
  assert.ok(Date.now() - t0 < 500, 'abortable fetch should resolve near timeoutMs');
});

test('fetchDemucsStatus parses a valid body and treats checking as unavailable', async () => {
  const ok = await fetchDemucsStatus({
    fetch: async () => jsonResponse(200, { available: true, checking: false, models: ['htdemucs', 'bad'], maxUploadBytes: 100, queueLength: 1 }),
  });
  assert.deepEqual(ok, { available: true, checking: false, models: ['htdemucs'], maxUploadBytes: 100, queueLength: 1 });

  const checking = await fetchDemucsStatus({
    fetch: async () => jsonResponse(200, { available: true, checking: true }),
  });
  assert.equal(checking.available, false);

  assert.equal(await fetchDemucsStatus({ fetch: async () => jsonResponse(500, {}) }), null);
  assert.equal(await fetchDemucsStatus({ fetch: async () => { throw new TypeError('net'); } }), null);
});

// ---------------------------------------------------------------------------
// runDemucsSeparation
// ---------------------------------------------------------------------------

test('runDemucsSeparation polls every 1000 ms and DELETEs after all downloads (Requirements 4.5, 10.5)', async () => {
  const server = fakeServer({
    statuses: [
      { status: 'queued', position: 2 },
      { status: 'running', progress: 40 },
      { status: 'done', stems: STEMS },
    ],
  });
  const urls = fakeUrls();
  const { sleep, waits } = fakeSleep();
  const phases = [];

  const result = await runDemucsSeparation(file, {
    model: 'htdemucs',
    encode: encodeWav,
    fetch: server.fetch,
    sleep,
    onPhase: (p) => phases.push(p),
    createObjectURL: urls.createObjectURL,
    revokeObjectURL: urls.revokeObjectURL,
  });

  // Polling interval defaults to 1000 ms.
  assert.ok(waits.length >= 3);
  assert.ok(waits.every((ms) => ms === 1000));

  // Upload carried model and extension.
  const post = server.calls.find((c) => c.method === 'POST');
  assert.equal(post.url, `${API}?model=htdemucs&ext=mp3`);

  // All 8 derived stems are returned, none revoked.
  assert.deepEqual(Object.keys(result.urls).sort(),
    ['bass', 'drums', 'fx', 'harmony', 'inst', 'other', 'perc', 'vocal']);
  assert.equal(urls.created.length, 8);
  assert.equal(urls.revoked.length, 0);
  assert.equal(result.model, 'htdemucs');
  assert.equal(result.sampleRate, SR);

  // DELETE comes after every stem download.
  const delIdx = server.calls.findIndex((c) => c.method === 'DELETE');
  assert.ok(delIdx >= 0, 'expected a DELETE');
  assert.equal(server.calls[delIdx].url, `${API}/${JOB}`);
  const lastWav = server.calls.map((c) => c.url.endsWith('.wav')).lastIndexOf(true);
  assert.ok(delIdx > lastWav);
  assert.deepEqual(
    server.calls.filter((c) => c.url.endsWith('.wav')).map((c) => c.url.split('/').pop()),
    ['vocals.wav', 'drums.wav', 'bass.wav', 'other.wav'],
  );

  assert.deepEqual(phases.map((p) => p.stage), ['upload', 'queued', 'running', 'download']);
  assert.deepEqual(phases[1], { stage: 'queued', position: 2 });
  assert.deepEqual(phases[2], { stage: 'running', progress: 40 });
});

test('runDemucsSeparation: 3rd download failing revokes URLs, DELETEs, throws DemucsError (Requirement 6.3)', async () => {
  const server = fakeServer({ statuses: [{ status: 'done', stems: STEMS }], failStem: 'bass' });
  const urls = fakeUrls();
  const { sleep } = fakeSleep();

  await assert.rejects(
    runDemucsSeparation(file, {
      encode: encodeWav,
      fetch: server.fetch,
      sleep,
      createObjectURL: urls.createObjectURL,
      revokeObjectURL: urls.revokeObjectURL,
    }),
    (err) => {
      assert.ok(err instanceof DemucsError);
      assert.equal(err.stage, 'download');
      return true;
    },
  );

  // vocal, drums and perc were emitted before bass failed.
  assert.equal(urls.created.length, 3);
  assert.deepEqual([...urls.revoked].sort(), [...urls.created].sort());
  assert.ok(server.calls.some((c) => c.method === 'DELETE' && c.url === `${API}/${JOB}`));
  assert.ok(!server.calls.some((c) => c.url.endsWith('/other.wav')));
});

test('runDemucsSeparation: abort while running sends keepalive DELETE, stops polling, throws AbortError (Requirements 4.2, 6.4)', async () => {
  const ctrl = new AbortController();
  let pollsAtAbort = -1;
  const server = fakeServer({
    statuses: [{ status: 'running', progress: 10 }],
    onPoll: (n) => {
      if (n === 2) { pollsAtAbort = n; ctrl.abort(); }
    },
  });
  const urls = fakeUrls();
  const { sleep } = fakeSleep();

  await assert.rejects(
    runDemucsSeparation(file, {
      signal: ctrl.signal,
      encode: encodeWav,
      fetch: server.fetch,
      sleep,
      createObjectURL: urls.createObjectURL,
      revokeObjectURL: urls.revokeObjectURL,
    }),
    { name: 'AbortError' },
  );
  // Let the fire-and-forget DELETE settle.
  await new Promise((r) => setImmediate(r));

  assert.equal(server.polls, pollsAtAbort, 'no polls after abort');
  const dels = server.calls.filter((c) => c.method === 'DELETE');
  assert.equal(dels.length, 1);
  assert.equal(dels[0].url, `${API}/${JOB}`);
  assert.equal(dels[0].init.keepalive, true);
  assert.ok(!server.calls.some((c) => c.url.endsWith('.wav')));
  assert.equal(urls.created.length, 0);
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

// **Validates: Requirements 3.5**
test('Feature: separation-accuracy, Property 8: 进度文字包含位置和百分比', async () => {
  const phaseGen = (rng) => ({
    position: gen.int(1, 1000)(rng),
    progress: gen.int(0, 100)(rng),
  });
  await forAll(phaseGen, ({ position, progress }) => {
    const queued = remoteProgressText({ stage: 'queued', position });
    assert.equal(queued, `排队中（第 ${position} 位）`);
    assert.ok(queued.includes(String(position)));

    const running = remoteProgressText({ stage: 'running', progress });
    assert.equal(running, `AI 分离中 ${progress}%`);
    assert.ok(running.includes(`${progress}%`));
  }, { runs: 200 });
});

// **Validates: Requirements 7.2, 7.3, 7.4**
test('Feature: separation-accuracy, Property 13: 模型设置的保存往返与清洗', async () => {
  const nearMiss = gen.oneOf(
    'HTDEMUCS', ' htdemucs', 'htdemucs ', 'htdemucs_6S', 'htdemucs6s', 'htdemucs_6', 'ht demucs',
    'htdemucs\0', 'mdx', 'mdx_extra', '', 'htdemucs_ft',
  );
  const allowed = gen.oneOf(...DEMUCS_MODELS);
  const valueGen = gen.oneOf(
    allowed,
    allowed,
    nearMiss,
    gen.string(),
    gen.int(-1e6, 1e6),
    gen.float(-10, 10),
    NaN, Infinity, 0, true, false, null, undefined,
    () => ({ demucsModel: 'htdemucs' }),
    () => ['htdemucs'],
    () => new String('htdemucs'),
    () => ({ toString: () => 'htdemucs_6s' }),
  );
  await forAll(valueGen, (v) => {
    const out = sanitizeDemucsModel(v);
    assert.ok(DEMUCS_MODELS.includes(out), `result ${out} not an allowed model`);
    const isAllowed = typeof v === 'string' && DEMUCS_MODELS.includes(v);
    assert.equal(out, isAllowed ? v : DEFAULT_DEMUCS_MODEL);
    assert.equal(sanitizeDemucsModel(out), out, 'idempotent');
  }, { runs: 300 });

  // Save/load round trip through JSON, as app.js stores settings.
  await forAll(allowed, (m) => {
    const stored = JSON.stringify({ speed: 1, loop: false, demucsModel: m });
    assert.equal(sanitizeDemucsModel(JSON.parse(stored).demucsModel), m);
  }, { runs: 100 });
});

// ---------------------------------------------------------------------------
// Property 1: 状态未确认可用时不上传
// ---------------------------------------------------------------------------

const STATUS_URL = `${API}/status`;
const STATUS_TIMEOUT_MS = 20;

/** Anything except the literal `true`. */
const notTrueGen = gen.oneOf(false, 'true', 1, 0, null, 'yes', () => ({}), () => [true]);

/** Plain-data descriptions of status-endpoint behaviours that must not count as "available". */
const badStatusGen = gen.oneOf(
  () => ({ kind: 'network' }),
  () => ({ kind: 'hang' }),
  (rng) => ({
    kind: 'http',
    status: gen.oneOf(gen.int(400, 499), gen.int(500, 599), gen.int(300, 399), 100, 0)(rng),
    body: gen.oneOf(
      () => ({ available: true, checking: false }),
      gen.string(),
      null,
    )(rng),
  }),
  () => ({ kind: 'bad-json' }),
  (rng) => ({
    kind: 'json',
    body: gen.oneOf(null, gen.int(-1e6, 1e6), gen.string(), () => [{ available: true }], true, false)(rng),
  }),
  (rng) => {
    const body = { checking: gen.oneOf(false, true, undefined)(rng) };
    if (rng() < 0.75) body.available = notTrueGen(rng);
    return { kind: 'json', body };
  },
  (rng) => ({ kind: 'json', body: { available: true, checking: true, queueLength: gen.int(0, 5)(rng) } }),
);

/** Builds a fake fetch whose status endpoint behaves as `desc`; records every call. */
function statusFetch(desc, delegate = null) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method });
    if (url !== STATUS_URL || method !== 'GET') {
      if (delegate) return delegate(url, init);
      return jsonResponse(404, { error: 'unexpected' });
    }
    switch (desc.kind) {
      case 'network':
        throw new TypeError('Failed to fetch');
      case 'hang':
        return new Promise((_, reject) => {
          const sig = init.signal;
          if (!sig) return;
          if (sig.aborted) reject(new DOMException('aborted', 'AbortError'));
          sig.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      case 'http':
        return jsonResponse(desc.status, desc.body);
      case 'bad-json':
        return {
          status: 200,
          ok: true,
          json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      case 'json':
        return jsonResponse(200, desc.body);
      default:
        throw new Error(`unknown kind ${desc.kind}`);
    }
  };
  return { fetch, calls };
}

/** Wires separateWithFallback the way app.js does, with a DSP stub. */
async function runPipeline(fakeFetch) {
  const urls = fakeUrls();
  const { sleep } = fakeSleep();
  const notices = [];
  let dspCalls = 0;
  const DSP_MARKER = { dsp: true };
  const r = await separateWithFallback({
    fetchStatus: () => fetchDemucsStatus({ fetch: fakeFetch, timeoutMs: STATUS_TIMEOUT_MS }),
    runDemucs: () => runDemucsSeparation(file, {
      fetch: fakeFetch,
      encode: encodeWav,
      sleep,
      createObjectURL: urls.createObjectURL,
      revokeObjectURL: urls.revokeObjectURL,
    }),
    runDsp: async () => { dspCalls++; return DSP_MARKER; },
    onNotice: (t) => notices.push(t),
  });
  return { r, dspCalls, notices, DSP_MARKER };
}

// **Validates: Requirements 1.6, 2.8**
test('Feature: separation-accuracy, Property 1: 状态未确认可用时不上传', async () => {
  await forAll(badStatusGen, async (desc) => {
    const { fetch: fakeFetch, calls } = statusFetch(desc);
    const { r, dspCalls, notices, DSP_MARKER } = await runPipeline(fakeFetch);

    assert.equal(r.engine, 'dsp');
    assert.equal(r.result, DSP_MARKER);
    assert.equal(dspCalls, 1, 'runDsp called exactly once');
    assert.ok(!calls.some((c) => c.method === 'POST'), 'no POST was sent');
    assert.deepEqual(calls, [{ url: STATUS_URL, method: 'GET' }], 'only the status GET was requested');
    assert.deepEqual(notices, [], 'unavailable status is not a failure, so no notice');
  }, { runs: 150 });
});

test('Property 1 positive control: confirmed-available status does upload and uses Demucs', async () => {
  const server = fakeServer({ statuses: [{ status: 'done', stems: STEMS }] });
  const { fetch: fakeFetch, calls } = statusFetch(
    { kind: 'json', body: { available: true, checking: false } },
    server.fetch,
  );
  const { r, dspCalls, notices } = await runPipeline(fakeFetch);

  assert.equal(r.engine, 'demucs');
  assert.equal(dspCalls, 0);
  assert.deepEqual(notices, []);
  assert.equal(calls[0].url, STATUS_URL);
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.ok(posts[0].url.startsWith(`${API}?`));
});

// ---------------------------------------------------------------------------
// Property 12: 回退时给出提示并带上失败原因
// ---------------------------------------------------------------------------

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Random reason string with lone surrogates removed and non-empty after trim. */
const reasonGen = (rng) => {
  const base = gen.string({ minLength: 1, maxLength: 24 });
  for (;;) {
    const s = base(rng).replace(LONE_SURROGATE, '');
    if (s.trim()) return s;
  }
};

const errorStatusGen = gen.int(400, 599);

/** Plain-data failure scenarios after the status endpoint says "available". */
const failureGen = gen.oneOf(
  (rng) => ({ kind: 'post-error', status: errorStatusGen(rng), body: { error: reasonGen(rng) } }),
  (rng) => ({
    kind: 'post-error',
    status: errorStatusGen(rng),
    body: gen.oneOf('no-json', null, () => ({}), () => ({ error: 42 }), () => ({ error: '  \n' }), 'text')(rng),
  }),
  () => ({ kind: 'post-network' }),
  (rng) => ({ kind: 'job-failed', error: reasonGen(rng) }),
  (rng) => ({ kind: 'download-error', status: errorStatusGen(rng), stem: gen.oneOf(...STEMS)(rng) }),
);

/** Fake Demucs API (everything except /status) that fails as `sc` describes. */
function failingServer(sc) {
  const server = fakeServer({
    statuses: sc.kind === 'job-failed'
      ? [{ status: 'running', progress: 10 }, { status: 'failed', error: sc.error }]
      : [{ status: 'done', stems: STEMS }],
  });
  return async (url, init = {}) => {
    const method = init.method || 'GET';
    if (method === 'POST' && url.startsWith(`${API}?`)) {
      if (sc.kind === 'post-network') throw new TypeError('Failed to fetch');
      if (sc.kind === 'post-error') {
        if (sc.body === 'no-json') {
          return {
            status: sc.status,
            ok: false,
            json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        }
        return jsonResponse(sc.status, sc.body);
      }
    }
    if (sc.kind === 'download-error' && method === 'GET' && url === `${API}/${JOB}/${sc.stem}.wav`) {
      return jsonResponse(sc.status, { error: 'stem failed' });
    }
    return server.fetch(url, init);
  };
}

/** The reason runDemucsSeparation should carry, or null when not asserted precisely. */
function expectedReason(sc) {
  switch (sc.kind) {
    case 'post-error': {
      const e = sc.body && typeof sc.body === 'object' && typeof sc.body.error === 'string' ? sc.body.error.trim() : '';
      return e || `HTTP ${sc.status}`;
    }
    case 'post-network':
      return '无法连接本地服务器';
    case 'job-failed':
      return sc.error.trim();
    default:
      return null;
  }
}

// **Validates: Requirements 6.1, 6.2**
test('Feature: separation-accuracy, Property 12: 回退时给出提示并带上失败原因', async () => {
  await forAll(failureGen, async (sc) => {
    const { fetch: fakeFetch } = statusFetch(
      { kind: 'json', body: { available: true, checking: false } },
      failingServer(sc),
    );
    const { r, dspCalls, notices, DSP_MARKER } = await runPipeline(fakeFetch);

    assert.equal(r.engine, 'dsp');
    assert.equal(r.result, DSP_MARKER);
    assert.equal(dspCalls, 1, 'runDsp called exactly once');
    assert.equal(notices.length, 1, 'exactly one notice');
    const notice = notices[0];
    assert.ok(notice.includes('浏览器分离'), `notice mentions browser separation: ${notice}`);

    const reason = expectedReason(sc);
    if (reason !== null) {
      assert.ok(notice.includes(reason), `notice ${JSON.stringify(notice)} includes reason ${JSON.stringify(reason)}`);
      assert.equal(notice, fallbackNotice(new DemucsError({ reason })));
    } else {
      // download-error: reason names the stem and the HTTP status.
      assert.ok(notice.includes(`HTTP ${sc.status}`), `notice includes status: ${notice}`);
      assert.ok(notice.startsWith('AI 分离失败（'), notice);
    }
  }, { runs: 150 });
});
