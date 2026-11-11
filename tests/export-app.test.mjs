import test from 'node:test';
import assert from 'node:assert/strict';
import { STEMS } from '../public/js/separator.js';
import { SyncPlayer } from '../public/js/player.js';
import { encodeWav } from '../public/js/wav.js';
import { UNSUPPORTED_TEXT } from '../public/js/export-client.js';

// Drives the export flow of app.js through a stubbed DOM (same FakeEl idea as
// app.test.mjs), a controllable fake local server (`fetch`), a fake DSP
// worker, and fake MediaRecorder / AudioContext / captureStream for
// Browser_Recording. Requirement 14.4.

let metaDuration = 10; // what the next loaded media element reports

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

const downloads = []; // { name, href } for every <a download> clicked

class FakeEl extends EventTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = tag.toUpperCase();
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.children = [];
    this.attrs = new Map();
    this._text = '';
    this.style = { setProperty() {} };
    const classes = new Set();
    this.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on === undefined) on = !classes.has(c); if (on) classes.add(c); else classes.delete(c); return on; },
    };
    this.duration = NaN;
    this.currentTime = 0;
    this.paused = true;
    this.src = '';
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  removeAttribute(name) { this.attrs.delete(name); if (name === 'src') this.src = ''; }
  focus() {}
  click() {
    if (this.tagName === 'A' && this.download) downloads.push({ name: this.download, href: this.href });
    this.dispatchEvent(new Event('click'));
  }
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
const preset = (sel, tag, hidden) => { const el = new FakeEl(tag); el.hidden = hidden; elements.set(sel, el); return el; };
preset('#video', 'video', true);
preset('#analysisSheet', 'div', true);
preset('#exportSheet', 'div', true);
preset('#exportBackdrop', 'div', true);
preset('#demucsHint', 'p', true);
const stemButtons = STEMS.map((s) => { const b = new FakeEl('button'); b.dataset.stem = s.id; return b; });
const exportOptions = ['video', 'wav', 'cancel'].map((kind) => { const b = new FakeEl('button'); b.dataset.export = kind; return b; });

globalThis.document = {
  body: new FakeEl('body'),
  querySelector(sel) {
    if (!elements.has(sel)) elements.set(sel, new FakeEl('div'));
    return elements.get(sel);
  },
  querySelectorAll(sel) {
    if (sel === '.stem-btn') return stemButtons;
    if (sel === '[data-export]') return exportOptions;
    return [];
  },
  createElement: (tag) => new FakeEl(tag),
  createTextNode: (text) => ({ textContent: text }),
};

// Browser_Recording fakes. They live on both `window` (canBrowserRecord) and
// globalThis (runBrowserRecording's default env), like in a real browser.
class FakeTrack {
  constructor(kind, from) { this.kind = kind; this.from = from; this.stopped = false; }
  stop() { this.stopped = true; }
}
class FakeMediaStream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
}
const audioContexts = [];
class FakeAudioContext {
  constructor() { this.sources = []; this.closed = false; audioContexts.push(this); }
  createMediaStreamDestination() { return { stream: new FakeMediaStream([new FakeTrack('audio', 'dest')]) }; }
  createMediaElementSource(el) { this.sources.push(el); return { connect() {} }; }
  resume() { return Promise.resolve(); }
  close() { this.closed = true; return Promise.resolve(); }
}
const recorders = [];
class FakeMediaRecorder {
  static isTypeSupported(type) { return type === 'video/webm;codecs=vp8,opus' || type === 'video/webm'; }
  constructor(stream, opts) { this.stream = stream; this.mimeType = opts && opts.mimeType; this.state = 'inactive'; recorders.push(this); }
  start() { this.state = 'recording'; }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    if (this.ondataavailable) this.ondataavailable({ data: new Blob(['WEBMDATA'], { type: 'video/webm' }) });
    if (this.onstop) this.onstop();
  }
}
const video = elements.get('#video');
const captureStream = () => new FakeMediaStream([new FakeTrack('video', 'source'), new FakeTrack('audio', 'source')]);
video.captureStream = captureStream;

const OfflineAudioContext = class {
  decodeAudioData(buf, ok) {
    const length = 44100;
    const data = [0, 1].map(() => Float32Array.from({ length }, (_, i) => Math.sin(i / 7) * 0.3));
    setTimeout(() => ok({ duration: 1, sampleRate: 44100, numberOfChannels: 2, length, getChannelData: (c) => data[c] }), 0);
  }
};
const windowListeners = new Map();
globalThis.window = {
  addEventListener(type, fn) {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(fn);
  },
  scrollTo() {},
  matchMedia: () => ({ matches: false }), // desktop
  OfflineAudioContext,
  MediaRecorder: FakeMediaRecorder,
  AudioContext: FakeAudioContext,
  MediaStream: FakeMediaStream,
};
globalThis.MediaRecorder = FakeMediaRecorder;
globalThis.AudioContext = FakeAudioContext;
globalThis.MediaStream = FakeMediaStream;
const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
});
globalThis.requestAnimationFrame = () => 1;
console.error = () => {}; // app.js logs expected failures
globalThis.Audio = class extends FakeEl { constructor() { super('audio'); } };

// Blob URLs: remember every Blob (downloads are revoked 1 s after the click)
// and which URLs get revoked.
const urlBlobs = new Map();
const revoked = new Set();
const realCreate = URL.createObjectURL.bind(URL);
const realRevoke = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (blob) => { const u = realCreate(blob); urlBlobs.set(u, blob); return u; };
URL.revokeObjectURL = (u) => { revoked.add(u); realRevoke(u); };

// Fake DSP worker: every stem gets a WAV of a different length, so the
// Export_Stem's bytes can be told apart from the other stems'.
const stemWav = (index) => encodeWav([0, 1].map((c) => Float32Array.from({ length: 1024 + index * 64 }, (_, i) => Math.sin(i / (5 + c + index)) * 0.2)), 44100);
// The Vis_Analyzer worker (vis-analysis.worker.js) says 'ready' but never
// answers, so Vis_Data stays pending in every test here: 导出 on an audio-only
// file keeps downloading the WAV directly (Requirement 16.8). Saying 'ready'
// also stops app.js's start timeout from falling back to the main thread.
globalThis.Worker = class {
  constructor(url) {
    this.vis = String(url).includes('vis-analysis.worker.js');
    if (this.vis) setTimeout(() => { if (this.onmessage) this.onmessage({ data: { type: 'ready' } }); }, 0);
  }
  postMessage(data) {
    if (this.vis) return;
    setTimeout(() => {
      this.onmessage({ data: { type: 'ready' } });
      STEMS.forEach((s, i) => this.onmessage({ data: { type: 'stem', id: s.id, wav: stemWav(i) } }));
      this.onmessage({ data: { type: 'done', bpm: 120, mode: data.mode } });
    }, 0);
  }
  terminate() {}
};

// Fake local server. Demucs is never available, so separation uses the worker.
const requests = []; // { method, url, keepalive }
let server = {};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const AVAILABLE = { available: true, checking: false, maxUploadBytes: 1e10, queueLength: 0 };
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = init.method || 'GET';
  if (url.startsWith('blob:')) {
    const blob = urlBlobs.get(url);
    return blob ? new Response(blob) : new Response(null, { status: 404 });
  }
  requests.push({ method, url, keepalive: !!init.keepalive });
  if (url === '/api/separate/status') return json({ error: 'down' }, 500);
  if (url === '/api/export/status') {
    if (server.statusGate) await server.statusGate;
    return server.exportStatus ? json(server.exportStatus) : json({ error: 'down' }, 500);
  }
  if (method === 'POST' && url.startsWith('/api/export?')) return server.post(url, init);
  if (method === 'DELETE') return new Response(null, { status: 204 });
  if (/^\/api\/export\/[^/]+\/result\.mp4$/.test(url)) return new Response(new Blob(['MP4DATA'], { type: 'video/mp4' }));
  if (/^\/api\/export\/[^/]+$/.test(url)) return server.poll(url);
  return json({ error: 'not found' }, 404);
};

// Spy on the Player: same module instance as app.js's './player.js'.
let player = null;
const selectCalls = [];
{
  const { load, select } = SyncPlayer.prototype;
  SyncPlayer.prototype.load = function (...args) { player = this; return load.apply(this, args); };
  SyncPlayer.prototype.select = function (id) { selectCalls.push(id); return select.call(this, id); };
}

await import('../public/js/app.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const status = () => $('#stemStatus').textContent;
const exportText = () => $('#exportStatus').textContent;
const stemBtn = (id) => stemButtons.find((b) => b.dataset.stem === id);
const label = (id) => STEMS.find((s) => s.id === id).label;
const exportRequests = () => requests.filter((r) => r.url.startsWith('/api/export'));
const posts = () => requests.filter((r) => r.method === 'POST' && r.url.startsWith('/api/export'));
const deletes = () => requests.filter((r) => r.method === 'DELETE');

async function waitFor(cond, what = 'condition', ms = 15000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}; stems: ${status()}; export: ${exportText()}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function makeFile(name, type) {
  return new File([new TextEncoder().encode(`SOURCE ${name}`)], name, { type });
}
function upload(file) {
  $('#fileInput').files = [file];
  $('#fileInput').dispatchEvent(new Event('change'));
}
async function openReady(name, type) {
  const file = makeFile(name, type);
  upload(file);
  await waitFor(() => status().startsWith('音轨已就绪') && $('#audioName').textContent === name, `${name} ready`);
  return file;
}
function openFromLibrary(name) {
  for (const li of $('#libraryList').children) {
    const btn = li.children[0];
    if (btn.children[1].children[0].textContent === name) { btn.click(); return; }
  }
  throw new Error(`${name} not in 音乐台`);
}
/** Stem id → Blob URL the Player uses, i.e. the current entry's cache.urls. */
const stemUrls = () => Object.fromEntries(Object.entries(player.stems).map(([id, el]) => [id, el.src]));
const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
function pointer(type, clientX) {
  const e = new Event(type);
  e.clientX = clientX;
  e.pointerId = 1;
  $('#progress').dispatchEvent(e);
}
function press(key) {
  const e = { key, code: key === ' ' ? 'Space' : '', target: { tagName: 'BODY' }, preventDefault() {}, stopPropagation() {} };
  for (const fn of windowListeners.get('keydown') || []) fn(e);
}
function chooseVideoExport() {
  $('#exportBtn').click();
  assert.equal($('#exportSheet').hidden, false, 'video files open the chooser');
  exportOptions[0].click();
}
const recorderCount = () => recorders.length;
async function waitForRecording(before) {
  await waitFor(() => recorders.length > before && recorders.at(-1).state === 'recording' && !player.paused, 'recording to start');
  return recorders.at(-1);
}
function endVideo() {
  video.dispatchEvent(new Event('ended'));
}
const idle = () => $('#cancelExport').hidden && !exportText().includes('…') && !exportText().includes('%');
const controls = () => ['#playBtn', '#ctlPlay', '#speedBtn', '#loopBtn'].map((s) => $(s));

/** Puts the Player in a non-default Playback_State: 1.25×, loop on, at 3 s, playing. */
function setPlaybackState() {
  $('#speedBtn').click(); // 1 → 1.25
  $('#loopBtn').click();
  pointer('pointerdown', 30);
  pointer('pointerup', 30); // 30 % of 10 s
  $('#ctlPlay').click();
  assert.equal(player.rate, 1.25);
  assert.equal(player.loop, true);
  assert.equal(player.currentTime, 3);
  assert.equal(player.paused, false);
}
function assertPlaybackState(selected) {
  assert.equal(player.rate, 1.25);
  assert.equal(player.loop, true);
  assert.equal(player.currentTime, 3);
  assert.equal(player.paused, false);
  assert.equal(player.activeId, selected);
  assert.ok(stemBtn(selected).classList.contains('selected'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('export button: disabled without a file, while separating and on 原曲 (with hint); enabled on a derived stem', async () => {
  assert.equal($('#exportBtn').disabled, true, 'no file');
  assert.equal($('#exportHint').hidden, true);

  upload(makeFile('song.mp3', 'audio/mpeg'));
  assert.ok(status().startsWith('正在分离音轨'));
  assert.equal($('#exportBtn').disabled, true, 'separating');
  await waitFor(() => status().startsWith('音轨已就绪'), 'song ready');

  assert.equal($('#exportBtn').disabled, true, '原曲 selected');
  assert.equal($('#exportHint').hidden, false);
  assert.equal($('#exportHint').textContent, '原曲就是原文件，无需导出');

  stemBtn('vocal').click();
  assert.equal($('#exportBtn').disabled, false);
  assert.equal($('#exportHint').hidden, true);
});

test('audio-only file: 导出 downloads the cached stem WAV byte for byte, no /api/export request, cache untouched', async () => {
  // continues with song.mp3, 人声 selected
  const urls = stemUrls();
  const before = exportRequests().length;
  $('#exportBtn').click();
  assert.equal($('#exportSheet').hidden, true, 'no chooser for audio-only files');
  await waitFor(() => downloads.length === 1, 'WAV download');

  assert.equal(downloads[0].name, 'song-人声.wav');
  assert.deepEqual(await bytes(urlBlobs.get(downloads[0].href)), await bytes(urlBlobs.get(urls.vocal)));
  assert.equal(exportRequests().length, before, 'no /api/export request');
  await waitFor(() => exportText() === '已导出：song-人声.wav', 'done notice');
  assert.deepEqual(stemUrls(), urls, 'entry.cache.urls unchanged');
  assert.ok(Object.values(urls).every((u) => !revoked.has(u)), 'no cached URL revoked');

  // The cache still works: open another file, come back, no new separation.
  await openReady('other.wav', 'audio/wav');
  openFromLibrary('song.mp3');
  assert.ok(status().startsWith('音轨已就绪'));
  assert.deepEqual(stemUrls(), urls);
});

test('Server_Mux: switching stems mid-export changes neither the uploaded WAV nor the file name', async () => {
  const file = await openReady('mux.mp4', 'video/mp4');
  stemBtn('vocal').click();
  const urls = stemUrls();
  let releaseStatus;
  let releasePost;
  let postBody = null;
  server = {
    exportStatus: AVAILABLE,
    statusGate: new Promise((r) => { releaseStatus = r; }),
    post: async (url, init) => {
      postBody = init.body;
      await new Promise((r) => { releasePost = r; });
      return json({ id: 'job-ok' }, 202);
    },
    poll: () => json({ status: 'done' }),
  };
  chooseVideoExport();
  await waitFor(() => exportText().includes('正在检查本地服务器'), 'status check');
  assert.equal($('#exportBtn').disabled, true, 'one export at a time');

  stemBtn('drums').click(); // the Player stays usable during Server_Mux (13.2)
  assert.equal(player.activeId, 'drums');
  releaseStatus();
  await waitFor(() => postBody && releasePost, 'upload');
  stemBtn('bass').click();
  releasePost();
  await waitFor(() => downloads.some((d) => d.name.endsWith('.mp4')), 'MP4 download');

  const dl = downloads.at(-1);
  assert.equal(dl.name, 'mux-人声.mp4');
  assert.equal(await urlBlobs.get(dl.href).text(), 'MP4DATA');
  const vocal = await bytes(urlBlobs.get(urls.vocal));
  const post = posts().at(-1);
  assert.equal(post.url, `/api/export?ext=mp4&wavBytes=${vocal.length}`, 'only ext and wavBytes, no file name');
  const body = await bytes(postBody);
  assert.deepEqual(body.slice(0, vocal.length), vocal, 'uploaded WAV is the Export_Stem');
  assert.deepEqual(body.slice(vocal.length), await bytes(file));
  assert.ok(deletes().some((r) => r.url === '/api/export/job-ok'), 'server copy freed');
  assert.equal(player.activeId, 'bass', 'the user selection is left alone');
  assert.deepEqual(stemUrls(), urls);
  assert.ok(Object.values(urls).every((u) => !revoked.has(u)));
});

test('status unavailable: records in the browser with controls locked, then restores Playback_State', async () => {
  await openReady('rec.mp4', 'video/mp4');
  stemBtn('vocal').click();
  const urls = stemUrls();
  setPlaybackState();
  server = { exportStatus: null };
  const postsBefore = posts().length;
  const dlBefore = downloads.length;
  const n = recorderCount();
  chooseVideoExport();
  const rec = await waitForRecording(n);

  // Recording setup: Export_Stem from 0 s at 1×, no loop; picture-only capture + dest audio.
  assert.equal(posts().length, postsBefore, 'no upload when the server is unavailable');
  assert.equal(player.activeId, 'vocal');
  assert.equal(player.rate, 1);
  assert.equal(player.loop, false);
  assert.equal(player.currentTime, 0);
  assert.deepEqual(rec.stream.getTracks().map((t) => `${t.kind}:${t.from}`), ['video:source', 'audio:dest']);
  assert.equal(audioContexts.at(-1).sources[0].src, urls.vocal);
  assert.ok(exportText().includes('浏览器录制中 0%'), exportText());

  // Controls are locked (12.6): buttons, progress bar, stem buttons and shortcuts.
  assert.ok(controls().every((b) => b.disabled));
  assert.ok(stemButtons.every((b) => b.disabled));
  assert.equal($('#progress').getAttribute('aria-disabled'), 'true');
  assert.equal($('#cancelExport').hidden, false);
  $('#speedBtn').click();
  $('#loopBtn').click();
  $('#ctlPlay').click();
  stemBtn('drums').click();
  pointer('pointerdown', 80);
  pointer('pointerup', 80);
  press('ArrowRight');
  press('l');
  press('4');
  press(' ');
  assert.equal(player.rate, 1);
  assert.equal(player.loop, false);
  assert.equal(player.paused, false);
  assert.equal(player.activeId, 'vocal');
  assert.equal(player.currentTime, 0);

  video.currentTime = 5;
  video.dispatchEvent(new Event('timeupdate'));
  assert.ok(exportText().includes('浏览器录制中 50%'), exportText());
  endVideo();
  await waitFor(() => downloads.length > dlBefore, 'WEBM download');

  const dl = downloads.at(-1);
  assert.equal(dl.name, 'rec-人声.webm');
  assert.equal(urlBlobs.get(dl.href).type, 'video/webm');
  assert.equal(await urlBlobs.get(dl.href).text(), 'WEBMDATA');
  await waitFor(() => exportText() === '已导出：rec-人声.webm', 'done notice');
  await waitFor(() => !player.paused, 'playback resumed');
  assertPlaybackState('vocal');
  assert.ok(controls().every((b) => !b.disabled), 'controls unlocked');
  assert.ok(stemButtons.every((b) => !b.disabled));
  assert.equal($('#progress').getAttribute('aria-disabled'), null);
  assert.equal($('#cancelExport').hidden, true);
  assert.ok(audioContexts.at(-1).closed);
  assert.deepEqual(stemUrls(), urls, 'entry.cache.urls unchanged');
  assert.ok(Object.values(urls).every((u) => !revoked.has(u)), 'no cached URL revoked');
});

test('Server_Mux job failed: shows the reason, falls back to recording, frees the job', async () => {
  await openReady('fail.mp4', 'video/mp4');
  stemBtn('drums').click();
  server = {
    exportStatus: AVAILABLE,
    post: () => json({ id: 'job-f' }, 202),
    poll: () => json({ status: 'failed', error: 'Conversion failed!' }),
  };
  const n = recorderCount();
  chooseVideoExport();
  await waitForRecording(n);
  assert.ok(exportText().includes('视频合成失败（Conversion failed!），改用浏览器录制。'), exportText());
  assert.ok(deletes().some((r) => r.url === '/api/export/job-f'));
  endVideo();
  await waitFor(() => exportText() === '已导出：fail-鼓.webm', 'done notice');
  assert.equal(downloads.at(-1).name, 'fail-鼓.webm');
});

test('POST 500 (server cannot save): reason shown, recording uses the Export_Stem, then the switched stem is restored', async () => {
  await openReady('disk.mp4', 'video/mp4');
  stemBtn('vocal').click();
  const urls = stemUrls();
  setPlaybackState();
  let releaseStatus;
  let postBody = null;
  server = {
    exportStatus: AVAILABLE,
    statusGate: new Promise((r) => { releaseStatus = r; }),
    post: (url, init) => { postBody = init.body; return json({ error: '服务器无法保存上传文件' }, 500); },
  };
  const n = recorderCount();
  chooseVideoExport();
  await waitFor(() => exportText().includes('正在检查本地服务器'), 'status check');
  stemBtn('bass').click(); // user switches during Server_Mux
  releaseStatus();
  await waitForRecording(n);

  assert.ok(exportText().includes('视频合成失败（服务器无法保存上传文件），改用浏览器录制。'), exportText());
  const vocal = await bytes(urlBlobs.get(urls.vocal));
  assert.deepEqual((await bytes(postBody)).slice(0, vocal.length), vocal, 'uploaded WAV is the Export_Stem');
  assert.equal(selectCalls.at(-1), 'vocal', 'player.select got the Export_Stem');
  assert.equal(player.activeId, 'vocal');
  assert.ok(stemBtn('vocal').classList.contains('selected'), 'the recorded stem is highlighted');
  assert.equal(audioContexts.at(-1).sources[0].src, urls.vocal);

  endVideo();
  await waitFor(() => exportText() === '已导出：disk-人声.webm', 'done notice');
  assert.equal(downloads.at(-1).name, 'disk-人声.webm');
  await waitFor(() => !player.paused, 'playback resumed');
  assert.equal(selectCalls.at(-1), 'bass');
  assertPlaybackState('bass');
  assert.ok(!stemBtn('vocal').classList.contains('selected'));
});

test('recording unsupported: shows UNSUPPORTED_TEXT and a WAV button that exports the same Export_Stem', async () => {
  await openReady('nocap.mp4', 'video/mp4');
  stemBtn('vocal').click();
  video.captureStream = undefined;
  try {
    server = { exportStatus: null };
    const n = recorderCount();
    chooseVideoExport();
    await waitFor(() => exportText() === UNSUPPORTED_TEXT, 'unsupported text');
    assert.equal(recorderCount(), n);
    assert.equal($('#exportWavFallback').hidden, false);
    assert.equal($('#exportBtn').disabled, false, 'WAV export stays available (3.4)');

    stemBtn('drums').click();
    const dlBefore = downloads.length;
    $('#exportWavFallback').click();
    await waitFor(() => downloads.length > dlBefore, 'WAV download');
    assert.equal(downloads.at(-1).name, 'nocap-人声.wav');
    assert.equal($('#exportWavFallback').hidden, true);
  } finally {
    video.captureStream = captureStream;
  }
});

test('取消导出 during Server_Mux sends a keepalive DELETE, shows 已取消导出 and never records', async () => {
  await openReady('cancel.mp4', 'video/mp4');
  stemBtn('bass').click();
  server = {
    exportStatus: AVAILABLE,
    post: () => json({ id: 'job-c' }, 202),
    poll: () => json({ status: 'running', progress: 40 }),
  };
  const n = recorderCount();
  const dlBefore = downloads.length;
  chooseVideoExport();
  await waitFor(() => exportText().includes('合成视频 40%'), 'running');
  assert.equal($('#cancelExport').hidden, false);
  $('#cancelExport').click();
  await waitFor(() => deletes().some((r) => r.url === '/api/export/job-c' && r.keepalive), 'DELETE');
  await waitFor(() => exportText() === '已取消导出', 'cancelled notice');
  await tick(50);
  assert.equal(recorderCount(), n, 'no recording');
  assert.equal(downloads.length, dlBefore, 'no download');
  assert.equal($('#cancelExport').hidden, true);
  assert.equal(player.activeId, 'bass');
});

test('取消导出 during recording downloads nothing and restores Playback_State', async () => {
  await openReady('cancelrec.mp4', 'video/mp4');
  stemBtn('harmony').click();
  const urls = stemUrls();
  setPlaybackState();
  server = { exportStatus: null };
  const dlBefore = downloads.length;
  const rec = await (async () => { const n = recorderCount(); chooseVideoExport(); return waitForRecording(n); })();
  $('#cancelExport').click();
  await waitFor(() => exportText() === '已取消导出', 'cancelled notice');
  await waitFor(() => !player.paused, 'playback resumed');
  await tick(50);
  assert.equal(downloads.length, dlBefore, 'no download');
  assert.equal(rec.state, 'inactive');
  assertPlaybackState('harmony');
  assert.ok(controls().every((b) => !b.disabled));
  assert.ok(stemButtons.every((b) => !b.disabled));
  assert.deepEqual(stemUrls(), urls);
  assert.ok(Object.values(urls).every((u) => !revoked.has(u)));
});

test('opening another file during an export cancels it', async () => {
  await openReady('first.mp4', 'video/mp4');
  stemBtn('vocal').click();
  server = { exportStatus: null };
  const dlBefore = downloads.length;
  const n = recorderCount();
  chooseVideoExport();
  const rec = await waitForRecording(n);

  upload(makeFile('second.wav', 'audio/wav'));
  await waitFor(() => $('#audioName').textContent === 'second.wav' && status().startsWith('音轨已就绪'), 'second ready');
  await tick(50);
  assert.equal(rec.state, 'inactive');
  assert.equal(downloads.length, dlBefore, 'no download');
  assert.equal(exportText(), '已取消导出');
  assert.ok(idle());
  assert.equal(player.master, $('#masterAudio'), 'the new file is loaded');
  assert.ok(controls().every((b) => !b.disabled));
});
