// computeVisData 示例测试：假 Worker、假 fetch，WAV 用 encodeWav 生成，走真实的 decodeWav + analyzeStem。
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeVisData, VIS_COMPUTE_ERROR } from '../public/js/vis-compute.js';
import { VIS_STEM_IDS } from '../public/js/vis-data.js';
import { encodeWav, decodeWav } from '../public/js/wav.js';
import { analyzeStem } from '../public/js/vis-analysis.js';

const SR = 8000;

/** 确定性的测试信号：安静开头，随后若干段噪声爆发；不同 Stem 长度不同。 */
function makeWav(seed, seconds) {
  const n = Math.round(SR * seconds);
  const ch = [new Float32Array(n), new Float32Array(n)];
  let s = seed >>> 0 || 1;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const burst = Math.floor(t / 0.2) % 2 === 1 ? Math.exp(-((t % 0.2) / 0.03)) : 0.02;
    ch[0][i] = rnd() * burst * (0.3 + 0.05 * (seed % 5));
    ch[1][i] = ch[0][i] * 0.8;
  }
  return encodeWav(ch, SR);
}

/** 8 条 Stem 的 blob URL 与对应 WAV。 */
function makeStems(ids = VIS_STEM_IDS) {
  const urls = {};
  const wavs = new Map();
  ids.forEach((id, k) => {
    const url = `blob:http://localhost/${id}-${k}`;
    urls[id] = url;
    wavs.set(url, makeWav(k + 3, 0.6 + 0.1 * k));
  });
  urls.original = 'blob:http://localhost/original';
  return { urls, wavs };
}

/** 假 fetch：URL → 新的 ArrayBuffer 副本；未知 URL 拒绝；记录调用。 */
function makeFetch(wavs, { fail = new Set() } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    if (fail.has(url) || !wavs.has(url)) throw new TypeError('Failed to fetch');
    const buf = wavs.get(url);
    return { ok: true, arrayBuffer: async () => buf.slice(0) };
  };
  fn.calls = calls;
  return fn;
}

const tick = () => new Promise((r) => setImmediate(r));

/**
 * 假 Worker，行为仿照 vis-analysis.worker.js。
 * mode: 'ok'（先 ready 再工作）、'error-before-ready'、'hang'（ready 后不回复）
 * stemErrors: 这些 id 回 stem-error
 */
function makeWorkerFactory({ mode = 'ok', stemErrors = new Set() } = {}) {
  const log = { created: 0, posted: [], inFlight: 0, maxInFlight: 0, terminated: 0, workers: [] };
  const factory = () => {
    log.created++;
    const w = {
      onmessage: null,
      onerror: null,
      terminated: false,
      postMessage(msg, transfer) {
        assert.ok(!w.terminated, 'postMessage after terminate');
        assert.ok(msg.wav instanceof ArrayBuffer, 'wav must be an ArrayBuffer');
        assert.deepEqual(transfer, [msg.wav], 'wav buffer is transferred');
        // 模拟转移：发送方的缓冲区被分离
        const { id, wav } = structuredClone(msg, { transfer: [msg.wav] });
        log.posted.push(id);
        log.inFlight++;
        log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
        if (mode === 'hang') return;
        setImmediate(() => {
          log.inFlight--;
          if (w.terminated) return;
          if (stemErrors.has(id)) {
            w.onmessage?.({ data: { type: 'stem-error', id, message: 'bad' } });
            return;
          }
          try {
            const { channels, sampleRate } = decodeWav(wav);
            const r = analyzeStem(id, channels, sampleRate);
            w.onmessage?.({ data: { type: 'result', id, env: r.env, onsets: r.onsets, duration: r.duration } });
          } catch (err) {
            w.onmessage?.({ data: { type: 'stem-error', id, message: String(err) } });
          }
        });
      },
      terminate() { w.terminated = true; log.terminated++; },
    };
    log.workers.push(w);
    setImmediate(() => {
      if (w.terminated) return;
      if (mode === 'error-before-ready') w.onerror?.({ preventDefault() {} });
      else w.onmessage?.({ data: { type: 'ready' } });
    });
    return w;
  };
  return { factory, log };
}

const throwingWorker = () => { throw new Error('Worker unsupported'); };

/** 主线程参考结果（Worker 构造失败）。 */
async function mainThreadResult(urls, wavs) {
  return computeVisData(urls, { fetch: makeFetch(wavs), createWorker: throwingWorker, yieldFn: async () => {} });
}

test('Worker 路径：ready 后逐条分析，一次只有一条 Stem，结果与主线程一致', async () => {
  const { urls, wavs } = makeStems();
  const { factory, log } = makeWorkerFactory();
  let yields = 0;
  const vis = await computeVisData(urls, { fetch: makeFetch(wavs), createWorker: factory, yieldFn: async () => { yields++; } });
  assert.equal(log.created, 1);
  assert.deepEqual(log.posted, [...VIS_STEM_IDS]);
  assert.equal(log.maxInFlight, 1);
  assert.equal(log.terminated, 1, 'worker terminated when done');
  assert.equal(yields, 0, 'yieldFn only used on the main thread');
  assert.deepEqual(Object.keys(vis.stems), [...VIS_STEM_IDS]);
  assert.ok(vis.frames > 0 && vis.duration > 0);
  for (const id of VIS_STEM_IDS) {
    assert.ok(vis.stems[id].env instanceof Uint8Array);
    assert.equal(vis.stems[id].env.length, vis.frames);
  }
  const ref = await mainThreadResult(urls, wavs);
  assert.deepEqual(vis, ref);
});

test('Worker 构造失败 → 主线程逐条分析，每条之间调用 yieldFn', async () => {
  const { urls, wavs } = makeStems();
  const events = [];
  const vis = await computeVisData(urls, {
    fetch: makeFetch(wavs),
    createWorker: throwingWorker,
    yieldFn: async () => { events.push('yield'); },
    analyzeStem: (id, ch, sr) => { events.push(id); return analyzeStem(id, ch, sr); },
  });
  const expected = [];
  VIS_STEM_IDS.forEach((id, k) => { if (k > 0) expected.push('yield'); expected.push(id); });
  assert.deepEqual(events, expected);
  assert.deepEqual(Object.keys(vis.stems), [...VIS_STEM_IDS]);
});

test('ready 前 Worker 出错 → 回退主线程，结果与主线程一致，每条之间让出', async () => {
  const { urls, wavs } = makeStems();
  const { factory, log } = makeWorkerFactory({ mode: 'error-before-ready' });
  let yields = 0;
  const vis = await computeVisData(urls, { fetch: makeFetch(wavs), createWorker: factory, yieldFn: async () => { yields++; } });
  assert.equal(log.created, 1);
  assert.deepEqual(log.posted, [], 'nothing posted to a worker that never became ready');
  assert.ok(log.terminated >= 1);
  assert.equal(yields, VIS_STEM_IDS.length - 1);
  assert.deepEqual(vis, await mainThreadResult(urls, wavs));
});

test('单条 stem-error 被跳过，其余照常', async () => {
  const { urls, wavs } = makeStems();
  const { factory, log } = makeWorkerFactory({ stemErrors: new Set(['bass', 'fx']) });
  const vis = await computeVisData(urls, { fetch: makeFetch(wavs), createWorker: factory, yieldFn: async () => {} });
  assert.deepEqual(log.posted, [...VIS_STEM_IDS], 'still uses the worker after a stem-error');
  assert.deepEqual(Object.keys(vis.stems), VIS_STEM_IDS.filter((id) => id !== 'bass' && id !== 'fx'));
});

test('无法读取或无法解码的 Stem 被跳过（主线程）', async () => {
  const { urls, wavs } = makeStems();
  wavs.set(urls.harmony, new ArrayBuffer(10)); // 不是 WAV
  const fetchFn = makeFetch(wavs, { fail: new Set([urls.vocal]) });
  const vis = await computeVisData(urls, { fetch: fetchFn, createWorker: throwingWorker, yieldFn: async () => {} });
  assert.deepEqual(Object.keys(vis.stems), VIS_STEM_IDS.filter((id) => id !== 'vocal' && id !== 'harmony'));
});

test('全部失败时抛出「可视化数据生成失败」', async () => {
  const { urls, wavs } = makeStems();
  const { factory, log } = makeWorkerFactory({ stemErrors: new Set(VIS_STEM_IDS) });
  await assert.rejects(
    computeVisData(urls, { fetch: makeFetch(wavs), createWorker: factory, yieldFn: async () => {} }),
    (err) => err instanceof Error && err.message === VIS_COMPUTE_ERROR,
  );
  assert.equal(log.terminated, 1);
  await assert.rejects(
    computeVisData(urls, { fetch: makeFetch(new Map()), createWorker: throwingWorker, yieldFn: async () => {} }),
    { message: VIS_COMPUTE_ERROR },
  );
  await assert.rejects(
    computeVisData({}, { fetch: makeFetch(wavs), createWorker: throwingWorker, yieldFn: async () => {} }),
    { message: VIS_COMPUTE_ERROR },
  );
});

test('分析中途中止：terminate Worker 并抛 AbortError', async () => {
  const { urls, wavs } = makeStems();
  const { factory, log } = makeWorkerFactory({ mode: 'hang' });
  const ac = new AbortController();
  const p = computeVisData(urls, { signal: ac.signal, fetch: makeFetch(wavs), createWorker: factory, yieldFn: async () => {} });
  for (let i = 0; i < 20 && log.posted.length === 0; i++) await tick();
  assert.deepEqual(log.posted, ['inst']);
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
  assert.equal(log.terminated, 1);
  assert.ok(log.workers[0].terminated);
});

test('主线程回退中中止：停止循环并抛 AbortError', async () => {
  const { urls, wavs } = makeStems();
  const ac = new AbortController();
  const analyzed = [];
  const p = computeVisData(urls, {
    signal: ac.signal,
    fetch: makeFetch(wavs),
    createWorker: throwingWorker,
    yieldFn: async () => { if (analyzed.length === 2) ac.abort(); },
    analyzeStem: (id, ch, sr) => { analyzed.push(id); return analyzeStem(id, ch, sr); },
  });
  await assert.rejects(p, { name: 'AbortError' });
  assert.deepEqual(analyzed, ['inst', 'vocal']);
});

test('已中止的 signal 立即抛 AbortError，不创建 Worker、不读取', async () => {
  const { urls, wavs } = makeStems();
  const { factory, log } = makeWorkerFactory();
  const fetchFn = makeFetch(wavs);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    computeVisData(urls, { signal: ac.signal, fetch: fetchFn, createWorker: factory, yieldFn: async () => {} }),
    { name: 'AbortError' },
  );
  assert.equal(log.created, 0);
  assert.equal(fetchFn.calls.length, 0);
});

test('urls 对象和其中的 URL 不变，也不回收 Blob URL', async () => {
  const { urls, wavs } = makeStems();
  const snapshot = { ...urls };
  const fetchFn = makeFetch(wavs);
  const revoked = [];
  const orig = URL.revokeObjectURL;
  URL.revokeObjectURL = (u) => { revoked.push(u); };
  try {
    const { factory } = makeWorkerFactory();
    await computeVisData(urls, { fetch: fetchFn, createWorker: factory, yieldFn: async () => {} });
    await computeVisData(urls, { fetch: fetchFn, createWorker: throwingWorker, yieldFn: async () => {} });
  } finally {
    URL.revokeObjectURL = orig;
  }
  assert.deepEqual(urls, snapshot);
  assert.deepEqual(Object.keys(urls), Object.keys(snapshot));
  assert.deepEqual(revoked, []);
  assert.ok(!fetchFn.calls.includes(urls.original), 'original is not analyzed');
  assert.deepEqual(fetchFn.calls, [...VIS_STEM_IDS.map((id) => urls[id]), ...VIS_STEM_IDS.map((id) => urls[id])]);
});
