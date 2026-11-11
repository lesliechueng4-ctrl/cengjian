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

// ---------------------------------------------------------------------------
// Fast_Mode: stem notes and separateChannels options (Requirements 9.4, 9.6, 10.4)

import { stemNotes, STEM_NOTES_BY_MODE, separateChannels } from '../public/js/separator.js';

const STEM_KEYS = ['original', 'inst', 'vocal', 'drums', 'bass', 'harmony', 'perc', 'fx', 'other'];

test('stemNotes: high and fast each have the 9 stem keys with different text', () => {
  const high = stemNotes('high');
  const fast = stemNotes('fast');
  assert.deepEqual(Object.keys(high).sort(), [...STEM_KEYS].sort());
  assert.deepEqual(Object.keys(fast).sort(), [...STEM_KEYS].sort());
  for (const k of STEM_KEYS) {
    assert.equal(typeof high[k], 'string');
    assert.ok(fast[k].length > 0, `fast.${k} empty`);
  }
  assert.notDeepEqual(high, fast);
  assert.ok(STEM_KEYS.some((k) => high[k] !== fast[k]));
});

test('stemNotes: unknown mode falls back to fast', () => {
  assert.equal(stemNotes('bogus'), STEM_NOTES_BY_MODE.fast);
  assert.equal(stemNotes(undefined), STEM_NOTES_BY_MODE.fast);
});

test('fast stem notes describe the tuned Fast_Mode kernel frequencies', () => {
  const fast = stemNotes('fast');
  assert.match(fast.vocal, /160\s*Hz/, 'vocal band start');
  assert.match(fast.vocal, /8\s*kHz/, 'vocal band end');
  assert.match(fast.perc, /6(\.8)?\s*kHz/, 'perc split');
  assert.match(fast.fx, /1\.7\s*kHz/, 'fx split');
});

function tone(freq, seconds, sr, amp = 0.3) {
  const n = Math.floor(seconds * sr);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return x;
}

test('separateChannels: default mode is fast and mono input gives 1-channel stems', async () => {
  const sr = 22050;
  const x = tone(300, 0.5, sr);
  const got = {};
  const res = await separateChannels([x], sr, { onStem: (id, chs) => { got[id] = chs; } });
  assert.equal(res.mode, 'fast');
  assert.equal(typeof res.bpm, 'number');
  assert.equal(Object.keys(got).length, 8);
  for (const [id, chs] of Object.entries(got)) assert.equal(chs.length, 1, `${id} channels`);
});

test('separateChannels: caller arrays are untouched unless consumeInput is set', async () => {
  const sr = 22050;
  const L = tone(440, 0.5, sr);
  const R = tone(660, 0.5, sr, 0.2);
  const L0 = L.slice(), R0 = R.slice();
  const res = await separateChannels([L, R], sr, {}, { mode: 'high' });
  assert.equal(res.mode, 'high');
  assert.deepEqual(L, L0);
  assert.deepEqual(R, R0);
  const bogus = await separateChannels([L, R], sr, {}, { mode: 'bogus' });
  assert.equal(bogus.mode, 'fast');
  assert.deepEqual(L, L0);
});

// ---------------------------------------------------------------------------
// Worker behaviour for both modes (Requirement 8.7)

for (const mode of ['high', 'fast']) {
  test(`runSeparation worker behaviour (mode=${mode})`, async (t) => {
    globalThis.Worker = FakeWorker;
    t.after(() => { delete globalThis.Worker; });

    await t.test('runs on the main thread when Worker is undefined', async () => {
      workers.length = 0;
      delete globalThis.Worker;
      try {
        const res = await runSeparation(fakeAudioBuffer(), { mode, encode: encodeWav });
        assert.equal(workers.length, 0);
        assert.equal(res.mode, mode);
        assert.equal(typeof res.bpm, 'number');
        assert.equal(Object.keys(res.urls).length, 8);
      } finally {
        globalThis.Worker = FakeWorker;
      }
    });

    await t.test('falls back to the main thread on failure before ready', async () => {
      workers.length = 0;
      const p = runSeparation(fakeAudioBuffer(), { mode, encode: encodeWav });
      const w = workers[0];
      assert.equal(w.posted[0].mode, mode);
      w.fail('module workers unsupported');
      const res = await p;
      assert.ok(w.terminated);
      assert.equal(res.mode, mode);
      assert.equal(Object.keys(res.urls).length, 8);
    });

    await t.test('reports failure after ready instead of rerunning', async () => {
      workers.length = 0;
      const p = runSeparation(fakeAudioBuffer(), { mode, encode: encodeWav });
      const w = workers[0];
      w.emit({ type: 'ready' });
      w.emit({ type: 'error', message: 'boom' });
      await assert.rejects(p, /音轨分离失败：boom/);
      assert.ok(w.terminated);
      assert.equal(workers.length, 1);

      workers.length = 0;
      const p2 = runSeparation(fakeAudioBuffer(), { mode, encode: encodeWav });
      workers[0].emit({ type: 'ready' });
      workers[0].fail('');
      await assert.rejects(p2, /内存不足/);
      assert.equal(workers.length, 1);
    });

    await t.test('abort rejects with AbortError and revokes stem URLs', async () => {
      workers.length = 0;
      const orig = URL.revokeObjectURL;
      const revoked = [];
      URL.revokeObjectURL = (u) => { revoked.push(u); return orig.call(URL, u); };
      try {
        const ac = new AbortController();
        const p = runSeparation(fakeAudioBuffer(), { mode, encode: encodeWav, signal: ac.signal });
        const w = workers[0];
        w.emit({ type: 'ready' });
        const wav = encodeWav([new Float32Array(4)], 8000);
        w.emit({ type: 'stem', id: 'vocal', wav });
        w.emit({ type: 'stem', id: 'drums', wav });
        ac.abort();
        await assert.rejects(p, (e) => e.name === 'AbortError');
        assert.ok(w.terminated);
        assert.equal(revoked.length, 2);
        for (const u of revoked) assert.match(u, /^blob:/);
      } finally {
        URL.revokeObjectURL = orig;
      }
    });

    await t.test('passes mode to the worker and returns it from done', async () => {
      workers.length = 0;
      const p = runSeparation(fakeAudioBuffer(), { mode, encode: encodeWav });
      const w = workers[0];
      assert.equal(w.posted.length, 1);
      assert.equal(w.posted[0].mode, mode);
      assert.equal(w.posted[0].sampleRate, 8000);
      assert.equal(w.posted[0].channels.length, 1);
      w.emit({ type: 'ready' });
      w.emit({ type: 'done', bpm: 100, mode });
      const res = await p;
      assert.equal(res.mode, mode);
      assert.equal(res.bpm, 100);

      // Without mode in 'done', the requested mode is returned.
      workers.length = 0;
      const p2 = runSeparation(fakeAudioBuffer(), { mode, encode: encodeWav });
      workers[0].emit({ type: 'ready' });
      workers[0].emit({ type: 'done', bpm: 90 });
      assert.equal((await p2).mode, mode);
    });
  });
}
