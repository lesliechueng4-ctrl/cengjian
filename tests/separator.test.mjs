import test from 'node:test';
import assert from 'node:assert/strict';
import { runSeparation } from '../public/js/separator.js';
import { encodeWav } from '../public/js/wav.js';

// Fake module worker: records instances so a test can drive its events.
const workers = [];
class FakeWorker {
  constructor(url, opts) {
    this.url = String(url);
    this.opts = opts;
    this.terminated = false;
    this.posted = [];
    workers.push(this);
  }
  postMessage(data) { this.posted.push(data); }
  terminate() { this.terminated = true; }
  emit(data) { this.onmessage({ data }); }
  fail(message) { this.onerror({ message, preventDefault() {} }); }
}

function fakeAudioBuffer(seconds = 0.5, sampleRate = 8000) {
  const n = Math.floor(seconds * sampleRate);
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 0.3;
  return { sampleRate, numberOfChannels: 1, getChannelData: () => ch };
}

test('runSeparation', async (t) => {
  globalThis.Worker = FakeWorker;
  t.after(() => { delete globalThis.Worker; });

  await t.test('falls back to the main thread when the worker fails to start', async () => {
    workers.length = 0;
    const p = runSeparation(fakeAudioBuffer(), { encode: encodeWav });
    const w = workers[0];
    assert.equal(w.opts.type, 'module');
    w.fail('module workers unsupported');
    const { urls } = await p;
    assert.ok(w.terminated);
    assert.equal(Object.keys(urls).length, 8, 'main thread produced every stem');
  });

  await t.test('reports errors after the worker started instead of rerunning', async () => {
    workers.length = 0;
    const p = runSeparation(fakeAudioBuffer(), { encode: encodeWav });
    const w = workers[0];
    w.emit({ type: 'ready' });
    w.emit({ type: 'progress', value: 0.1 });
    w.emit({ type: 'error', message: 'Array buffer allocation failed' });
    await assert.rejects(p, /音轨分离失败：Array buffer allocation failed/);
    assert.ok(w.terminated);
    assert.equal(workers.length, 1);
  });

  await t.test('a worker crash after start is reported, not rerun', async () => {
    workers.length = 0;
    const p = runSeparation(fakeAudioBuffer(), { encode: encodeWav });
    const w = workers[0];
    w.emit({ type: 'ready' });
    w.fail('');
    await assert.rejects(p, /内存不足/);
  });

  await t.test('resolves with stem URLs streamed from the worker', async () => {
    workers.length = 0;
    const progress = [];
    const p = runSeparation(fakeAudioBuffer(), { encode: encodeWav, onProgress: (v) => progress.push(v) });
    const w = workers[0];
    w.emit({ type: 'ready' });
    w.emit({ type: 'progress', value: 0.5 });
    w.emit({ type: 'stem', id: 'vocal', wav: encodeWav([new Float32Array(4)], 8000) });
    w.emit({ type: 'done', bpm: 120 });
    const { urls, bpm } = await p;
    assert.equal(bpm, 120);
    assert.match(urls.vocal, /^blob:/);
    assert.deepEqual(progress, [0.5]);
  });

  await t.test('abort rejects with AbortError and stops the worker', async () => {
    workers.length = 0;
    const ac = new AbortController();
    const p = runSeparation(fakeAudioBuffer(), { encode: encodeWav, signal: ac.signal });
    workers[0].emit({ type: 'ready' });
    ac.abort();
    await assert.rejects(p, (e) => e.name === 'AbortError');
    assert.ok(workers[0].terminated);
  });
});
