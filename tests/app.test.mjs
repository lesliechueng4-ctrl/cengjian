import test from 'node:test';
import assert from 'node:assert/strict';
import { STEMS } from '../public/js/separator.js';

// Drives app.js through a stubbed DOM to check the openEntry flow: the
// duration guard runs before the file is read, old stem caches are dropped
// before a new separation starts, and a cached file reopens without
// separating again. Separation runs on the main thread (Node has no Worker).

let metaDuration = 1; // what the next loaded media element reports
let mobile = true;

class FakeEl extends EventTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = tag.toUpperCase();
    this.hidden = false;
    this.dataset = {};
    this.children = [];
    this._text = '';
    this.style = { setProperty() {} };
    const classes = new Set();
    this.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined) on = !classes.has(c); if (on) classes.add(c); else classes.delete(c); return on; },
    };
    // media element bits
    this.duration = NaN;
    this.currentTime = 0;
    this.paused = true;
    this.src = '';
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  focus() {}
  click() { this.dispatchEvent(new Event('click')); }
  getBoundingClientRect() { return { left: 0, width: 100 }; }
  setPointerCapture() {}
  pause() { this.paused = true; }
  play() { this.paused = false; return Promise.resolve(); }
  load() {
    this.duration = NaN;
    if (!this.src) return;
    const d = metaDuration;
    setTimeout(() => { this.duration = d; this.dispatchEvent(new Event('loadedmetadata')); }, 5);
  }
}

const elements = new Map();
const stemButtons = STEMS.map((s) => { const b = new FakeEl('button'); b.dataset.stem = s.id; return b; });
globalThis.document = {
  body: new FakeEl('body'),
  querySelector(sel) {
    if (!elements.has(sel)) {
      const el = new FakeEl(sel === '#video' ? 'video' : 'div');
      if (sel === '#analysisSheet') el.hidden = true;
      elements.set(sel, el);
    }
    return elements.get(sel);
  },
  querySelectorAll(sel) { return sel === '.stem-btn' ? stemButtons : []; },
  createElement: (tag) => new FakeEl(tag),
  createTextNode: (text) => ({ textContent: text }),
};
const OfflineAudioContext = class {
  decodeAudioData(buf, ok) {
    const length = 44100;
    const data = [0, 1].map(() => Float32Array.from({ length }, (_, i) => Math.sin(i / 7) * 0.3));
    setTimeout(() => ok({ duration: 1, sampleRate: 44100, numberOfChannels: 2, length, getChannelData: (c) => data[c] }), 0);
  }
};
globalThis.window = {
  addEventListener() {},
  scrollTo() {},
  matchMedia: () => ({ matches: mobile }),
  OfflineAudioContext,
};
const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
});
// The HTML starts with the hint hidden; app.js reveals it once the status check answers.
{
  const hint = new FakeEl('p');
  hint.hidden = true;
  elements.set('#demucsHint', hint);
}
globalThis.requestAnimationFrame = () => 1;
console.error = () => {}; // app.js logs the expected "too long" error
globalThis.Audio = class extends FakeEl { constructor() { super('audio'); } };

// Track which Blob URLs are stem WAVs and which of those get revoked.
const urlType = new Map();
const revokedWav = [];
const realCreate = URL.createObjectURL.bind(URL);
const realRevoke = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (blob) => { const u = realCreate(blob); urlType.set(u, blob instanceof File ? 'file' : blob.type); return u; };
URL.revokeObjectURL = (u) => { if (urlType.get(u) === 'audio/wav') revokedWav.push(u); realRevoke(u); };

await import('../public/js/app.js');

const $ = (sel) => document.querySelector(sel);
const status = () => $('#stemStatus').textContent;
const reads = [];
function makeFile(name, type, onRead) {
  const f = new File([new Uint8Array(16)], name, { type });
  f.arrayBuffer = async () => { reads.push(name); if (onRead) onRead(); return new ArrayBuffer(16); };
  return f;
}
function upload(file) {
  $('#fileInput').files = [file];
  $('#fileInput').dispatchEvent(new Event('change'));
}
async function waitFor(cond, ms = 30000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out, status: ${status()}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
function openFromLibrary(name) {
  for (const li of $('#libraryList').children) {
    const btn = li.children[0];
    const label = btn.children[1].children[0].textContent;
    if (label === name) { btn.click(); return; }
  }
  throw new Error(`${name} not in 音乐台`);
}

test('a long phone video is refused by metadata duration before it is read', async () => {
  mobile = true;
  metaDuration = 600;
  upload(makeFile('long.mp4', 'video/mp4'));
  await waitFor(() => status().includes('6 分钟'));
  assert.deepEqual(reads, []);
  assert.ok(stemButtons.slice(1).every((b) => b.disabled));
});

test('phones drop older stem caches before separating, and cached files reopen instantly', async () => {
  mobile = true;
  metaDuration = 1;
  upload(makeFile('a.wav', 'audio/wav'));
  await waitFor(() => status().startsWith('音轨已就绪'));
  upload(makeFile('b.wav', 'audio/wav'));
  await waitFor(() => status().startsWith('音轨已就绪'));
  assert.equal(revokedWav.length, 0, 'a and b fit the phone cache (current + 1 other)');

  let revokedBeforeRead = -1;
  upload(makeFile('c.wav', 'audio/wav', () => { revokedBeforeRead = revokedWav.length; }));
  await waitFor(() => status().startsWith('音轨已就绪') && reads.includes('c.wav'));
  assert.equal(revokedBeforeRead, STEMS.length - 1, "a's stems were revoked before c was read");

  // b still has its cache: no read, ready right away
  openFromLibrary('b.wav');
  assert.ok(status().startsWith('音轨已就绪'));
  assert.ok(stemButtons.every((btn) => !btn.disabled));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(reads.filter((n) => n === 'b.wav').length, 1);

  // a lost its cache, so reopening separates again
  openFromLibrary('a.wav');
  assert.ok(status().startsWith('正在分离音轨'));
  await waitFor(() => status().startsWith('音轨已就绪') && reads.filter((n) => n === 'a.wav').length === 2);
});

// ---------------------------------------------------------------------------
// Demucs path and Quality_Mode. From here on `fetch` is a stub of the local
// server and `Worker` a fake DSP worker: every runSeparation call shows up in
// `workerRuns` with the mode it was given.
// ---------------------------------------------------------------------------

const { encodeWav } = await import('../public/js/wav.js');

const workerRuns = [];
const tinyWav = () => encodeWav([0, 1].map((c) => Float32Array.from({ length: 2048 }, (_, i) => Math.sin(i / (5 + c)) * 0.2)), 44100);
// The Vis_Analyzer worker (vis-analysis.worker.js) says 'ready' but never
// answers: Vis_Data stays pending, it is not counted in `workerRuns`, and
// app.js's start timeout never falls back to the main thread mid-test.
class FakeWorker {
  constructor(url) {
    this.vis = String(url).includes('vis-analysis.worker.js');
    if (this.vis) setTimeout(() => { if (this.onmessage) this.onmessage({ data: { type: 'ready' } }); }, 0);
  }
  postMessage(data) {
    if (this.vis) return;
    workerRuns.push(data.mode);
    setTimeout(() => {
      this.onmessage({ data: { type: 'ready' } });
      for (const s of STEMS) this.onmessage({ data: { type: 'stem', id: s.id, wav: tinyWav() } });
      this.onmessage({ data: { type: 'done', bpm: 120, mode: data.mode } });
    }, 0);
  }
  terminate() {}
}

const requests = []; // { method, url }
let server = {}; // per-test behaviour of the fake local server
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const AVAILABLE = { available: true, checking: false, models: ['htdemucs', 'htdemucs_6s'], maxUploadBytes: 1e9, queueLength: 0 };
async function fakeFetch(url, init = {}) {
  const method = init.method || 'GET';
  requests.push({ method, url: String(url) });
  if (url === '/api/separate/status') return server.status ? json(server.status) : json({ error: 'down' }, 500);
  if (method === 'POST') return server.post();
  if (method === 'DELETE') return new Response(null, { status: 204 });
  if (/\.wav$/.test(url)) return new Response(tinyWav());
  return server.poll();
}
const posts = () => requests.filter((r) => r.method === 'POST');
const deletes = () => requests.filter((r) => r.method === 'DELETE');

function textOf(node) {
  return (node.textContent ?? '') + (node.children || []).map(textOf).join('');
}
const sheetText = () => textOf($('#sheetBody'));
const derived = () => stemButtons.slice(1);

test('Demucs: only 原曲 is playable while separating, then all 8 stems, and the sheet names the model', async () => {
  globalThis.Worker = FakeWorker;
  globalThis.fetch = fakeFetch;
  mobile = false;
  let release;
  const gate = new Promise((r) => { release = r; });
  server = {
    status: AVAILABLE,
    post: async () => { await gate; return json({ id: 'job-d' }, 202); },
    poll: () => json({ status: 'done' }),
  };
  $('#analysisLink').click(); // keep the 真实分析 sheet open from here on
  const runsBefore = workerRuns.length;

  upload(makeFile('d.wav', 'audio/wav'));
  await waitFor(() => status().includes('上传到本地服务器'));
  assert.equal(stemButtons[0].disabled, false, '原曲 stays playable');
  assert.ok(derived().every((b) => b.disabled), 'derived stems wait for separation');
  assert.equal($('#cancelSeparation').hidden, false);
  release();

  await waitFor(() => status().startsWith('音轨已就绪'));
  assert.equal(derived().length, 8);
  assert.ok(stemButtons.every((b) => !b.disabled));
  assert.equal(posts().length, 1);
  assert.match(posts()[0].url, /^\/api\/separate\?model=htdemucs&ext=wav$/);
  assert.equal(workerRuns.length, runsBefore, 'browser DSP not used');
  assert.ok(sheetText().includes('Demucs AI（htdemucs）'), 'analysis.engine is demucs and the model is shown');
  assert.equal($('#demucsHint').hidden, true, 'hint hidden while Demucs is available');
  assert.ok(deletes().some((r) => r.url === '/api/separate/job-d'), 'server copy freed');
});

test('status unavailable shows the hint and runs DSP; reopening the Demucs file sends no POST', async () => {
  mobile = false;
  server = { status: null };
  upload(makeFile('e.wav', 'audio/wav'));
  await waitFor(() => status().startsWith('音轨已就绪') && reads.includes('e.wav'));
  assert.equal($('#demucsHint').hidden, false);
  assert.equal(posts().length, 1, 'no upload when Demucs is unavailable');

  openFromLibrary('d.wav');
  assert.ok(status().startsWith('音轨已就绪'));
  assert.ok(stemButtons.every((b) => !b.disabled));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(posts().length, 1);
  assert.ok(sheetText().includes('Demucs AI（htdemucs）'));
});

test('a failed upload (HTTP 500) falls back to browser separation with a notice', async () => {
  mobile = false;
  server = { status: AVAILABLE, post: () => json({ error: 'boom' }, 500) };
  const runsBefore = workerRuns.length;
  upload(makeFile('f.wav', 'audio/wav'));
  await waitFor(() => status().startsWith('音轨已就绪') && reads.includes('f.wav'));
  assert.ok(status().includes('浏览器分离'), status());
  assert.equal(workerRuns.length, runsBefore + 1);
  assert.ok(sheetText().includes('浏览器 DSP'));
});

test('取消分离 during a Demucs job sends DELETE and never starts DSP', async () => {
  mobile = false;
  server = {
    status: AVAILABLE,
    post: () => json({ id: 'job-g' }, 202),
    poll: () => json({ status: 'running', progress: 10 }),
  };
  const runsBefore = workerRuns.length;
  upload(makeFile('g.wav', 'audio/wav'));
  await waitFor(() => status().includes('AI 分离中'));
  assert.ok(derived().every((b) => b.disabled));
  $('#cancelSeparation').click();
  await waitFor(() => deletes().some((r) => r.url === '/api/separate/job-g'));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(status().includes('已取消'), status());
  assert.equal($('#cancelSeparation').hidden, true);
  assert.equal(workerRuns.length, runsBefore, 'runSeparation not called');
  assert.equal(reads.includes('g.wav'), false);
  assert.ok(derived().every((b) => b.disabled));
});

test('phones run DSP in fast mode and desktops in high quality mode', async () => {
  server = { status: null };
  mobile = true;
  upload(makeFile('m.wav', 'audio/wav'));
  await waitFor(() => status().startsWith('音轨已就绪') && reads.includes('m.wav'));
  assert.equal(workerRuns.at(-1), 'fast');
  assert.ok(sheetText().includes('浏览器 DSP（快速模式）'), sheetText());

  mobile = false;
  upload(makeFile('h.wav', 'audio/wav'));
  await waitFor(() => status().startsWith('音轨已就绪') && reads.includes('h.wav'));
  assert.equal(workerRuns.at(-1), 'high');
  assert.ok(sheetText().includes('浏览器 DSP（高质量模式）'), sheetText());
  assert.equal($('#demucsHint').hidden, false);
});

test('changing the Demucs model saves it to localStorage', () => {
  const select = $('#demucsModel');
  assert.equal(select.value, 'htdemucs');
  select.value = 'htdemucs_6s';
  select.dispatchEvent(new Event('change'));
  assert.equal(JSON.parse(storage.get('cengjian.settings')).demucsModel, 'htdemucs_6s');
  select.value = 'bogus';
  select.dispatchEvent(new Event('change'));
  assert.equal(select.value, 'htdemucs');
  assert.equal(JSON.parse(storage.get('cengjian.settings')).demucsModel, 'htdemucs');
});

// loadSettings runs once at import and is not exported, so each run imports a
// fresh app.js instance (unique query string) and reads the result back from
// #demucsModel. Each run gets its own select element so earlier instances'
// change listeners don't write to storage. Kept last: the leftover instances
// stay wired to the other shared fake elements.
// **Validates: Requirements 7.2, 7.3, 7.4**
test('Feature: separation-accuracy, Property 13: 模型设置的保存往返与清洗', async () => {
  const { forAll, gen } = await import('./helpers/prop.mjs');
  const { sanitizeDemucsModel, DEMUCS_MODELS } = await import('../public/js/remote-separator.js');
  server = { status: null }; // each import's status check answers right away
  const KEY = 'cengjian.settings';
  const modelGen = gen.oneOf(
    gen.oneOf(...DEMUCS_MODELS),
    gen.oneOf('HTDEMUCS', ' htdemucs', 'htdemucs_6S', 'mdx', ''),
    gen.string({ maxLength: 8 }),
    gen.int(-5, 5),
    null, true, () => ['htdemucs'], () => ({ m: 'htdemucs' }),
  );
  const storedGen = gen.oneOf(
    (rng) => JSON.stringify({ speed: 1, loop: false, demucsModel: modelGen(rng) }), // valid / bad model
    (rng) => JSON.stringify({ speed: 1, loop: true }), // missing key
    (rng) => JSON.stringify({ demucsModel: modelGen(rng) }).slice(0, -1 - gen.int(0, 5)(rng)), // corrupted
    gen.oneOf('null', '42', '"htdemucs"', '[]', '["htdemucs_6s"]', 'true', '{', ''),
    () => null, // nothing saved yet
  );
  const caseGen = (rng) => ({ stored: storedGen(rng), picked: modelGen(rng) });
  const expectedFrom = (raw) => {
    try {
      const s = JSON.parse(raw || '{}');
      return s !== null && typeof s === 'object' ? sanitizeDemucsModel(s.demucsModel) : 'htdemucs';
    } catch { return 'htdemucs'; }
  };

  let n = 0;
  await forAll(caseGen, async ({ stored, picked }) => {
    if (stored === null) storage.delete(KEY); else storage.set(KEY, stored);
    const select = new FakeEl('select');
    elements.set('#demucsModel', select);
    await import(`../public/js/app.js?property13=${n++}`);

    const loaded = select.value;
    assert.ok(DEMUCS_MODELS.includes(loaded), `loaded ${loaded}`);
    assert.equal(loaded, expectedFrom(stored));

    select.value = picked;
    select.dispatchEvent(new Event('change'));
    const saved = sanitizeDemucsModel(picked);
    assert.equal(select.value, saved);
    assert.equal(JSON.parse(storage.get(KEY)).demucsModel, saved);
  }, { runs: 100 });
});
