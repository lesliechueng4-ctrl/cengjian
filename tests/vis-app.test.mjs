import test from 'node:test';
import assert from 'node:assert/strict';
import { STEMS } from '../public/js/separator.js';
import { SyncPlayer } from '../public/js/player.js';
import { encodeWav, decodeWav } from '../public/js/wav.js';
import { analyzeStem } from '../public/js/vis-analysis.js';
import { VIS_STEM_IDS, createVisData, encodeVisPayload, decodeVisPayload } from '../public/js/vis-data.js';
import { readVisSettings } from '../public/js/visualizer.js';
import { UNSUPPORTED_TEXT } from '../public/js/export-client.js';
import {
  lanesAt, laneLayout, laneLabelSpecs, laneHeaderHeight, ROW_NAMES, ROW_COLORS,
} from '../public/js/vis-lanes.js';
import { readFileSync } from 'node:fs';

// Drives the stem-visualizer wiring of app.js (Requirement 16.6) through the
// same kind of stubbed DOM as app.test.mjs / export-app.test.mjs, plus:
// - a fake Worker that tells the separation worker from vis-analysis.worker.js
//   by URL and speaks the vis worker protocol ('ready', then 'result' /
//   'stem-error' per Stem) with the real decodeWav + analyzeStem, or hangs;
// - fake matchMedia and a manually flushed requestAnimationFrame queue;
// - HTMLCanvasElement.prototype.captureStream on window for the recording path.
// app.js is imported once, so the tests below run in order and share state.

let metaDuration = 10; // what the next loaded media element reports

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

const downloads = []; // { name, href } for every <a download> clicked
const canvases = []; // every <canvas> made with document.createElement

/** Canvas2D stand-in: records method names, returns a gradient-like object for every call. */
function fakeContext(canvas) {
  const calls = [];
  const gradient = { addColorStop() {} };
  const target = { canvas, calls, globalCompositeOperation: 'source-over', globalAlpha: 1 };
  return new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (typeof key !== 'string') return undefined;
      return (...args) => { calls.push(key); return gradient; };
    },
    set(t, key, value) { t[key] = value; return true; },
  });
}

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
    if (this.tagName === 'CANVAS') {
      this.width = 300;
      this.height = 150;
      this.ctx = null;
      this.streams = [];
    }
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
  getContext(type) {
    if (this.tagName !== 'CANVAS' || type !== '2d') return null;
    if (!this.ctx) this.ctx = fakeContext(this);
    return this.ctx;
  }
  captureStream(fps) {
    const stream = new FakeMediaStream([new FakeTrack('video', 'canvas')]);
    stream.fps = fps;
    this.streams.push(stream);
    return stream;
  }
}

const elements = new Map();
const preset = (sel, tag, hidden) => { const el = new FakeEl(tag); el.hidden = hidden; elements.set(sel, el); return el; };
preset('#video', 'video', true);
preset('#analysisSheet', 'div', true);
preset('#exportSheet', 'div', true);
preset('#exportBackdrop', 'div', true);
preset('#demucsHint', 'p', true);
preset('#audioArt', 'div', true);
const visCanvas = preset('#visCanvas', 'canvas', true);
visCanvas.setAttribute('aria-hidden', 'true');
visCanvas.clientWidth = 320;
visCanvas.clientHeight = 180;
const visToggle = preset('#visToggle', 'button', false);
visToggle.disabled = true;
visToggle.setAttribute('aria-pressed', 'false');
preset('#visHint', 'span', true);
// Lane_Strip (stem-lanes): fake elements have no layout, so their CSS size is set here.
const laneStrip = preset('#laneStrip', 'div', true);
laneStrip.clientWidth = 320;
laneStrip.clientHeight = 160;
const laneCanvas = preset('#laneCanvas', 'canvas', false);
laneCanvas.setAttribute('aria-hidden', 'true');
laneCanvas.clientWidth = 320;
laneCanvas.clientHeight = 160;
const laneLabels = preset('#laneLabels', 'div', false);
laneLabels.setAttribute('aria-hidden', 'true');
const stemButtons = STEMS.map((s) => { const b = new FakeEl('button'); b.dataset.stem = s.id; return b; });
const exportOptions = ['video', 'visvideo', 'wav', 'cancel'].map((kind) => {
  const b = new FakeEl('button');
  b.dataset.export = kind;
  if (kind === 'visvideo') { b.hidden = true; b.textContent = '导出视频（带可视化）'; }
  return b;
});
const option = (kind) => exportOptions.find((b) => b.dataset.export === kind);

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
  createElement: (tag) => {
    const el = new FakeEl(tag);
    if (el.tagName === 'CANVAS') canvases.push(el);
    return el;
  },
  createTextNode: (text) => ({ textContent: text }),
};

// Recording fakes (on both window and globalThis, like in a browser).
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
const canvasProto = { captureStream() {} }; // only checked for existence (canBrowserVisRecord)
const realCaptureStream = canvasProto.captureStream;

const OfflineAudioContext = class {
  decodeAudioData(buf, ok) {
    const length = 44100;
    const data = [0, 1].map(() => Float32Array.from({ length }, (_, i) => Math.sin(i / 7) * 0.3));
    setTimeout(() => ok({ duration: 1, sampleRate: 44100, numberOfChannels: 2, length, getChannelData: (c) => data[c] }), 0);
  }
};
const mediaQueries = [];
const mqls = new Map(); // query → shared MediaQueryList stand-in (tests flip `matches`)
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
function setReducedMotion(on) {
  const mql = mqls.get(REDUCED_MOTION);
  mql.matches = on;
  for (const fn of mql.listeners) fn({ matches: on, media: REDUCED_MOTION });
}
const windowListeners = new Map();
globalThis.window = {
  addEventListener(type, fn) {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(fn);
  },
  scrollTo() {},
  matchMedia: (q) => {
    mediaQueries.push(q);
    if (!mqls.has(q)) {
      const listeners = new Set();
      mqls.set(q, {
        matches: false,
        media: q,
        listeners,
        addEventListener(type, fn) { if (type === 'change') listeners.add(fn); },
        removeEventListener(type, fn) { listeners.delete(fn); },
      });
    }
    return mqls.get(q);
  },
  OfflineAudioContext,
  MediaRecorder: FakeMediaRecorder,
  AudioContext: FakeAudioContext,
  MediaStream: FakeMediaStream,
  HTMLCanvasElement: { prototype: canvasProto },
};
globalThis.MediaRecorder = FakeMediaRecorder;
globalThis.AudioContext = FakeAudioContext;
globalThis.MediaStream = FakeMediaStream;

// Saved settings with invalid switch values: the defaults must apply (6.8).
const SETTINGS_KEY = 'cengjian.settings';
const storage = new Map([[SETTINGS_KEY, JSON.stringify({ speed: 1, loop: false, visVideo: 'yes', visAudio: 0 })]]);
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
});
const savedSettings = () => JSON.parse(storage.get(SETTINGS_KEY));

// requestAnimationFrame queue, flushed by the tests.
const rafQueue = new Map();
let rafId = 0;
globalThis.requestAnimationFrame = (cb) => { rafQueue.set(++rafId, cb); return rafId; };
globalThis.cancelAnimationFrame = (id) => { rafQueue.delete(id); };
function flushFrames() {
  const list = [...rafQueue.values()];
  rafQueue.clear();
  for (const cb of list) cb(performance.now());
}

console.error = () => {}; // app.js logs expected failures
globalThis.Audio = class extends FakeEl { constructor() { super('audio'); } };

// Blob URLs: remember every Blob and which URLs get revoked.
const urlBlobs = new Map();
const revoked = new Set();
const realCreate = URL.createObjectURL.bind(URL);
const realRevoke = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (blob) => { const u = realCreate(blob); urlBlobs.set(u, blob); return u; };
URL.revokeObjectURL = (u) => { revoked.add(u); realRevoke(u); };

// ---------------------------------------------------------------------------
// Fake workers
// ---------------------------------------------------------------------------

// Separation worker: the n-th separation gets stems of about n × 0.1 s, so
// every file's Vis_Data is different.
let separations = 0;
const stemWav = (n, index) => encodeWav([0, 1].map((c) => Float32Array.from(
  { length: 4410 * n + index * 64 },
  (_, i) => Math.sin(i / (5 + c + index)) * (0.1 + 0.05 * index) * (i % 1500 < 200 ? 2 : 1),
)), 44100);
class FakeSeparationWorker {
  constructor() { this.n = ++separations; }
  postMessage(data) {
    setTimeout(() => {
      this.onmessage({ data: { type: 'ready' } });
      STEMS.forEach((s, i) => this.onmessage({ data: { type: 'stem', id: s.id, wav: stemWav(this.n, i) } }));
      this.onmessage({ data: { type: 'done', bpm: 120, mode: data.mode } });
    }, 0);
  }
  terminate() {}
}

// Vis worker: 'ok' analyzes with the real Vis_Analyzer, 'hang' never answers
// a Stem, 'fail' answers 'stem-error' for every Stem.
let visMode = 'ok';
const visWorkers = [];
class FakeVisWorker {
  constructor(url, opts) {
    this.url = String(url);
    this.opts = opts;
    this.mode = visMode;
    this.terminated = false;
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
    visWorkers.push(this);
    setTimeout(() => this.reply({ type: 'ready' }), 0);
  }
  reply(data) {
    if (!this.terminated && this.onmessage) this.onmessage({ data });
  }
  /** A hanging worker starts answering: the pending Stem and every later one. */
  resume() {
    this.mode = 'ok';
    if (this.pending) this.postMessage(this.pending, { again: true });
  }
  postMessage(msg, { again = false } = {}) {
    if (!again) this.posted.push(msg.id);
    if (this.mode === 'hang') { this.pending = msg; return; }
    this.pending = null;
    setTimeout(() => {
      if (this.terminated) return;
      if (this.mode === 'fail') {
        this.reply({ type: 'stem-error', id: msg.id, message: 'broken' });
        return;
      }
      const { channels, sampleRate } = decodeWav(msg.wav);
      const r = analyzeStem(msg.id, channels, sampleRate);
      const data = { type: 'result', id: msg.id, env: r.env, onsets: r.onsets, duration: r.duration };
      if (r.marks) data.marks = r.marks;
      this.reply(data);
    }, 0);
  }
  terminate() { this.terminated = true; }
}
globalThis.Worker = class {
  constructor(url, opts) {
    if (String(url).includes('vis-analysis.worker.js')) return new FakeVisWorker(url, opts);
    return new FakeSeparationWorker(url, opts);
  }
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
  if (url === '/api/export/status') return server.exportStatus ? json(server.exportStatus) : json({ error: 'down' }, 500);
  if (method === 'POST' && url.startsWith('/api/export?')) return server.post(url, init);
  if (method === 'DELETE') return new Response(null, { status: 204 });
  if (/^\/api\/export\/[^/]+\/result\.mp4$/.test(url)) return new Response(new Blob(['MP4DATA'], { type: 'video/mp4' }));
  if (/^\/api\/export\/[^/]+$/.test(url)) return server.poll(url);
  return json({ error: 'not found' }, 404);
};

let player = null;
{
  const { load } = SyncPlayer.prototype;
  SyncPlayer.prototype.load = function (...args) { player = this; return load.apply(this, args); };
}

await import('../public/js/app.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const status = () => $('#stemStatus').textContent;
const exportText = () => $('#exportStatus').textContent;
const hint = () => ($('#visHint').hidden ? '' : $('#visHint').textContent);
const stemBtn = (id) => stemButtons.find((b) => b.dataset.stem === id);
const posts = () => requests.filter((r) => r.method === 'POST' && r.url.startsWith('/api/export'));
const deletes = () => requests.filter((r) => r.method === 'DELETE');
const mediaCard = () => $('#mediaCard');
const visShown = () => !visCanvas.hidden && mediaCard().classList.contains('vis-on');
const visReady = () => !visToggle.disabled;
const callCount = (canvas) => (canvas.ctx ? canvas.ctx.calls.length : 0);
const callsSince = (canvas, n) => (canvas.ctx ? canvas.ctx.calls.slice(n) : []);
/** Lane_Label spans in #laneLabels → { id, text, top, hidden, color } in DOM order. */
const labelState = () => laneLabels.children.map((s) => ({
  text: s.textContent, top: s.style.top, hidden: s.hidden, color: s.style.color, cls: s.className,
}));
const stemLabel = (id) => STEMS.find((s) => s.id === id).label;
function resize(height) {
  laneStrip.clientHeight = height;
  laneCanvas.clientHeight = height;
  for (const fn of windowListeners.get('resize') || []) fn(new Event('resize'));
}

async function waitFor(cond, what = 'condition', ms = 10000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}; stems: ${status()}; vis: ${hint()}; export: ${exportText()}`);
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

/** Vis_Data computed directly from the cached stem WAVs with the real Vis_Analyzer. */
/** Lane_Labels app.js should show: one per row of the timeline, at the row's middle (320 px wide strip). */
let laneData = null;
function expectedLabels(selected, height) {
  const layout = laneLayout(laneData, selected, height, laneHeaderHeight(laneData, 320, height));
  return laneLabelSpecs(layout).map((spec) => {
    const c = ROW_COLORS[spec.id];
    return { text: ROW_NAMES[spec.id], top: `${spec.top}px`, hidden: !spec.visible, color: `rgb(${c[0]}, ${c[1]}, ${c[2]})`, cls: 'lane-label' };
  });
}

async function expectedVis(urls) {
  const results = {};
  for (const id of VIS_STEM_IDS) {
    const { channels, sampleRate } = decodeWav(await urlBlobs.get(urls[id]).arrayBuffer());
    results[id] = analyzeStem(id, channels, sampleRate);
  }
  return createVisData(results);
}
function chooseExport(kind) {
  $('#exportBtn').click();
  assert.equal($('#exportSheet').hidden, false, 'the chooser opens');
  option(kind).click();
}
async function waitForRecording(before) {
  await waitFor(() => recorders.length > before && recorders.at(-1).state === 'recording' && !player.paused, 'recording to start');
  return recorders.at(-1);
}
/** Captures the POST body; the job is done on the first poll. */
function doneServer() {
  const s = {
    exportStatus: AVAILABLE,
    url: null,
    body: null,
    post: (url, init) => { s.url = url; s.body = init.body; return json({ id: 'job-vis' }, 202); },
    poll: () => json({ status: 'done' }),
  };
  return s;
}
async function checkVisUpload(s, { urls, stemId, file, layout }) {
  const m = /^\/api\/export\?ext=(\w+)&wavBytes=(\d+)&visBytes=(\d+)&layout=(\w+)$/.exec(s.url);
  assert.ok(m, s.url);
  assert.equal(m[1], file.name.split('.').pop());
  assert.equal(m[4], layout);
  const wav = await bytes(urlBlobs.get(urls[stemId]));
  const wavBytes = Number(m[2]);
  const visBytes = Number(m[3]);
  assert.equal(wavBytes, wav.length);
  const body = await bytes(s.body);
  assert.deepEqual(body.slice(0, wavBytes), wav, 'uploaded WAV is the Export_Stem');
  const payload = body.slice(wavBytes, wavBytes + visBytes);
  assert.deepEqual(body.slice(wavBytes + visBytes), await bytes(file), 'then the Source_File');
  const text = new TextDecoder().decode(payload);
  assert.equal(text, encodeVisPayload(await expectedVis(urls), stemId), 'Vis_Payload is this file\'s own Vis_Data');
  assert.equal(decodeVisPayload(payload).selected, stemId);
  assert.ok(!text.includes(file.name), 'no file name in the payload (10.9)');
  return decodeVisPayload(payload).visData;
}

const snapshots = {}; // file name → entry.cache.urls at first ready (15.2)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('before any file: Vis_Toggle disabled, canvas hidden, no hint; reduced-motion query is watched', () => {
  assert.equal(visToggle.disabled, true);
  assert.equal(visToggle.getAttribute('aria-pressed'), 'false');
  assert.equal(visCanvas.hidden, true);
  assert.equal(visCanvas.getAttribute('aria-hidden'), 'true');
  assert.equal(hint(), '');
  assert.ok(mediaQueries.includes('(prefers-reduced-motion: reduce)'));
  assert.equal(mqls.get(REDUCED_MOTION).listeners.size, 2, 'cover and lane visualizers both watch it');
  assert.equal(laneStrip.hidden, true, 'no Lane_Strip without a file');
  assert.equal(visWorkers.length, 0);
});

test('page structure: #laneStrip sits between #stage and .controls, outside the stage (1.2, 1.3, 1.5, 7.4)', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8');
  const stage = html.indexOf('id="stage"');
  const stageTap = html.indexOf('id="stageTap"');
  const strip = html.indexOf('id="laneStrip"');
  const controls = html.indexOf('class="controls"');
  assert.ok(stage > 0 && stageTap > stage && strip > stageTap && controls > strip, 'order: stage … laneStrip … controls');
  // The stage's closing tag comes before the strip: no other <div> opens between stageTap and the strip.
  const between = html.slice(stageTap, html.lastIndexOf('<div', strip));
  assert.equal((between.match(/<\/div>/g) || []).length, 1, 'stage closed right before the strip');
  assert.ok(!/<div/.test(between));
  assert.match(html, /<canvas[^>]*id="laneCanvas"[^>]*aria-hidden="true"|<canvas[^>]*aria-hidden="true"[^>]*id="laneCanvas"/);
  assert.match(html, /<div[^>]*id="laneLabels"[^>]*aria-hidden="true"|<div[^>]*aria-hidden="true"[^>]*id="laneLabels"/);
  const rule = /\.lane-strip\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, '.lane-strip rule');
  assert.ok(rule[1].includes('clamp(112px, 20cqw, 160px)'), rule[1]);
  assert.ok(rule[1].toLowerCase().includes('#0b0d14'), rule[1]);
  assert.ok(!/position\s*:\s*absolute/.test(rule[1]), 'normal flow, not over the video');
});

test('while Vis_Data is computing: 可视化准备中…, switch unusable, audio-only 导出 still downloads the WAV directly', async () => {
  visMode = 'hang';
  await openReady('song.mp3', 'audio/mpeg');
  snapshots['song.mp3'] = stemUrls();
  await waitFor(() => visWorkers.length === 1 && visWorkers[0].posted.length === 1, 'vis worker got a Stem');

  const w = visWorkers[0];
  assert.ok(w.url.endsWith('/vis-analysis.worker.js'), w.url);
  assert.equal(w.opts && w.opts.type, 'module');
  assert.deepEqual(w.posted, ['inst'], 'one Stem at a time');
  assert.equal(hint(), '可视化准备中…');
  assert.equal(visToggle.disabled, true);
  assert.equal(visToggle.getAttribute('aria-pressed'), 'true', 'audio-only default is on (invalid saved value ignored)');
  assert.equal(visCanvas.hidden, true, 'no canvas before Vis_Data is ready');
  assert.equal(laneStrip.hidden, true, 'no Lane_Strip for an audio-only file (1.4)');
  assert.ok(!mediaCard().classList.contains('vis-on'));
  assert.equal($('#audioArt').hidden, false, 'the cover is shown');

  visToggle.click(); // disabled in the browser; the handler ignores it too
  assert.equal(storage.get(SETTINGS_KEY), JSON.stringify({ speed: 1, loop: false, visVideo: 'yes', visAudio: 0 }));

  stemBtn('vocal').click();
  const before = downloads.length;
  $('#exportBtn').click();
  assert.equal($('#exportSheet').hidden, true, 'no chooser while Vis_Data is not ready (9.3)');
  await waitFor(() => downloads.length > before, 'WAV download');
  assert.equal(downloads.at(-1).name, 'song-人声.wav');
  assert.equal(posts().length, 0);

  $('#ctlPlay').click();
  assert.equal(player.paused, false, 'playback unaffected');
  $('#ctlPlay').click();
  assert.equal(player.paused, true);
});

test('opening another file mid-computation terminates the vis worker; video default is on, Lane_Strip holds its place while computing', async () => {
  visMode = 'hang'; // the new computation waits until resumed below
  await openReady('other.mp4', 'video/mp4');
  snapshots['other.mp4'] = stemUrls();
  assert.equal(visWorkers[0].terminated, true, 'old computation stopped (2.3)');
  await waitFor(() => visWorkers.length === 2 && visWorkers[1].posted.length === 1, 'other.mp4 vis worker got a Stem');
  visMode = 'ok'; // later workers answer right away

  // Computing: strip shown as an empty placeholder, nothing drawn (6.3, 6.4).
  assert.equal(hint(), '可视化准备中…');
  assert.equal(visToggle.getAttribute('aria-pressed'), 'true', 'video default is on (6.1; invalid saved value ignored)');
  assert.equal(laneStrip.hidden, false, 'Lane_Strip placeholder while computing');
  assert.equal(visCanvas.hidden, true, 'Cover_Canvas hidden for a video file (1.1)');
  assert.ok(!mediaCard().classList.contains('vis-on'));
  assert.equal($('#video').hidden, false);
  const coverCalls = callCount(visCanvas);
  flushFrames();
  assert.equal(callCount(laneCanvas), 0, 'Lane_Canvas not drawn before Vis_Data is ready');
  assert.equal(laneLabels.children.length, 0, 'no labels without Vis_Data');

  globalThis.devicePixelRatio = 1.5;
  visWorkers[1].resume();
  await waitFor(visReady, 'other.mp4 Vis_Data');
  assert.equal(visWorkers.length, 2);
  assert.deepEqual(visWorkers[1].posted, [...VIS_STEM_IDS], 'every Derived_Stem analyzed in the worker (1.1)');
  assert.equal(visWorkers[1].terminated, true, 'worker released after the computation');
  assert.equal(hint(), '');
  assert.equal(laneStrip.hidden, false);
  assert.equal(visCanvas.hidden, true);
  assert.ok(!mediaCard().classList.contains('vis-on'), 'vis-on only follows the cover replacement');

  // Ready: the Lane_Visualizer draws at CSS size × dpr; the cover visualizer stays idle (10.2, 10.3).
  flushFrames();
  assert.ok(laneCanvas.ctx, 'Lane_Canvas has a 2d context');
  assert.ok(laneCanvas.ctx.calls.includes('fillRect'), 'opaque #0b0d14 background');
  assert.ok(laneCanvas.ctx.calls.includes('fill'), 'Bands drawn');
  assert.equal(laneCanvas.width, 480);
  assert.equal(laneCanvas.height, 240);
  assert.equal(callCount(visCanvas), coverCalls, 'Cover_Canvas never drawn for a video file');
  globalThis.devicePixelRatio = undefined;

  // Labels: one per row of the timeline (Kick / Snare / Hi-hat or 鼓, 贝斯, 人声, 和声), all visible at 160 px.
  laneData = await expectedVis(snapshots['other.mp4']);
  const labels = expectedLabels('original', 160);
  assert.ok(labels.length >= 4 && labels.length <= 6, `rows: ${labels.map((l) => l.text)}`);
  assert.ok(labels.every((l) => !l.hidden));
  assert.deepEqual(labelState(), labels);
});

test('Vis_Toggle on a video file: Lane_Strip hidden / shown, both switches saved with the other settings', async () => {
  visToggle.click();
  assert.equal(visToggle.getAttribute('aria-pressed'), 'false');
  assert.equal(laneStrip.hidden, true, 'switch off: no Lane_Strip (6.5)');
  assert.equal(laneLabels.children.length, 0);
  assert.equal(visCanvas.hidden, true);
  const saved = savedSettings();
  assert.equal(saved.visVideo, false);
  assert.equal(saved.visAudio, true, 'audio-only default saved as a boolean');
  assert.equal(saved.speed, 1, 'existing settings kept');
  assert.deepEqual(readVisSettings(saved), { visVideo: false, visAudio: true }, 'a reload keeps the switches');
  const drawn = callCount(laneCanvas);
  flushFrames();
  assert.equal(callCount(laneCanvas), drawn, 'nothing drawn while off');

  visToggle.click();
  assert.equal(visToggle.getAttribute('aria-pressed'), 'true');
  assert.equal(laneStrip.hidden, false);
  assert.equal(visCanvas.hidden, true);
  assert.equal($('#video').hidden, false);
  assert.equal(savedSettings().visVideo, true);
  assert.equal(laneLabels.children.length, expectedLabels('original', 160).length, 'labels back');
  flushFrames();
  assert.ok(callCount(laneCanvas) > drawn, 'drawn again after switching on');
  assert.deepEqual(readVisSettings({ visVideo: 1, visAudio: 'no' }), { visVideo: true, visAudio: true });
});

test('switching the Selected_Stem moves the Lane_Labels; short lanes hide theirs (2.4, 2.5, 5.4)', () => {
  const spans = [...laneLabels.children];
  const before = labelState();
  stemBtn('vocal').click();
  // The selected row is 1.8× as tall, so every label moves; the rows themselves stay the same.
  let state = labelState();
  assert.deepEqual(laneLabels.children, spans, 'the same span per row is reused');
  assert.deepEqual(state, expectedLabels('vocal', 160));
  assert.notDeepEqual(state.map((s) => s.top), before.map((s) => s.top), 'labels moved');

  const drawn = callCount(laneCanvas);
  flushFrames();
  assert.ok(callCount(laneCanvas) > drawn, 'new layout drawn on the next frame');

  // 72 px: rows shorter than 14 px hide their label; the selected row keeps it longest.
  resize(72);
  state = labelState();
  assert.deepEqual(state, expectedLabels('vocal', 72));
  assert.ok(state.some((s) => s.hidden), 'short rows hide their label');
  assert.equal(state.find((s) => s.text === ROW_NAMES.vocal).hidden, false, 'the selected row is tall enough');

  // 原曲 at 112 px (narrow phone): every row is at least 14 px → all visible.
  resize(112);
  stemBtn('original').click();
  state = labelState();
  assert.deepEqual(state, expectedLabels('original', 112));
  assert.ok(state.every((s) => !s.hidden));
});

test('prefers-reduced-motion change: the next Lane_Strip frame drops the Pop rings', async () => {
  resize(160);
  const data = await expectedVis(snapshots['other.mp4']);
  const opts = { selected: 'original', width: 480, height: 240, reducedMotion: false };
  let t = null;
  for (let k = 0; k <= Math.round(data.duration * 1000) && t == null; k++) {
    if (lanesAt(k / 1000, data, opts).some((s) => s.role === 'pop')) t = k / 1000;
  }
  assert.ok(t != null, 'test data has a hit to pop on');
  const gradients = (calls) => calls.filter((c) => c === 'createRadialGradient').length;
  globalThis.devicePixelRatio = 1.5;
  try {
    player.seek(t);
    let n = callCount(laneCanvas);
    flushFrames();
    let calls = callsSince(laneCanvas, n);
    assert.ok(calls.length > 0, 'redrawn at the new time');
    const withPop = gradients(calls);
    assert.ok(withPop > 0, 'hits and Pop rings drawn as radial shapes');

    setReducedMotion(true);
    n = callCount(laneCanvas);
    flushFrames();
    calls = callsSince(laneCanvas, n);
    assert.ok(calls.includes('fillRect'), 'redrawn after the setting changed');
    assert.ok(gradients(calls) < withPop, 'no Pop rings with reduced motion');
    assert.ok(calls.includes('fill'), 'still scrolling: Bands drawn');
  } finally {
    setReducedMotion(false);
    globalThis.devicePixelRatio = undefined;
    player.seek(0);
    flushFrames();
  }
});

test('video chooser with Vis_Data ready shows 导出视频（带可视化）after 导出视频', () => {
  stemBtn('vocal').click();
  $('#exportBtn').click();
  assert.equal($('#exportSheet').hidden, false);
  assert.equal(option('video').hidden, false);
  assert.equal(option('visvideo').hidden, false);
  assert.equal(option('visvideo').textContent, '导出视频（带可视化）');
  assert.equal(option('wav').hidden, false);
  option('cancel').click();
  assert.equal($('#exportSheet').hidden, true);
  assert.equal($('#cancelExport').hidden, true, 'no export started');
  assert.equal(posts().length, 0);
});

test('reopening a cached file without Vis_Data computes it; audio-only shows the canvas in place of the cover', async () => {
  const n = visWorkers.length;
  openFromLibrary('song.mp3');
  assert.equal(hint(), '可视化准备中…', 'cached stems without Vis_Data (1.2)');
  await waitFor(visReady, 'song.mp3 Vis_Data');
  assert.equal(visWorkers.length, n + 1);
  assert.deepEqual(stemUrls(), snapshots['song.mp3']);

  assert.ok(mediaCard().classList.contains('audio-only'));
  assert.ok(visShown(), 'canvas replaces the cover (6.2)');
  assert.equal($('#audioName').textContent, 'song.mp3', 'file name kept');
  assert.equal(visToggle.getAttribute('aria-pressed'), 'true');
  flushFrames();
  assert.ok(visCanvas.ctx.calls.includes('fillRect'), 'opaque background for the cover replacement');

  visToggle.click();
  assert.equal(visCanvas.hidden, true);
  assert.ok(!mediaCard().classList.contains('vis-on'), 'cover back');
  assert.equal(savedSettings().visAudio, false);
  visToggle.click();
  assert.ok(visShown());
  assert.equal(savedSettings().visAudio, true);
});

test('reopening a file whose Vis_Data is cached uses it without a new worker (2.2)', async () => {
  const n = visWorkers.length;
  openFromLibrary('other.mp4');
  assert.ok(visReady(), 'ready immediately');
  assert.equal(hint(), '');
  assert.equal(laneStrip.hidden, false);
  assert.equal(visCanvas.hidden, true, 'cover canvas hidden again for the video file');

  // A saved visVideo: false keeps video files off (6.2).
  visToggle.click();
  assert.equal(savedSettings().visVideo, false);
  assert.equal(readVisSettings(savedSettings()).visVideo, false, 'a reload reads the saved false');
  openFromLibrary('song.mp3');
  openFromLibrary('other.mp4');
  assert.equal(visToggle.getAttribute('aria-pressed'), 'false', 'still off');
  assert.equal(laneStrip.hidden, true);
  visToggle.click();
  assert.equal(laneStrip.hidden, false);

  openFromLibrary('song.mp3');
  assert.equal(laneStrip.hidden, true, 'audio-only: no Lane_Strip');
  assert.ok(visReady());
  assert.ok(visShown());
  await tick(30);
  assert.equal(visWorkers.length, n, 'no Worker created');
});

test('audio-only chooser with Vis_Data ready: WAV, 可视化视频 and 取消, no 导出视频', async () => {
  stemBtn('drums').click();
  $('#exportBtn').click();
  assert.equal($('#exportSheet').hidden, false, 'chooser instead of a direct WAV (9.2)');
  assert.equal(option('video').hidden, true);
  assert.equal(option('visvideo').hidden, false);
  assert.equal(option('visvideo').textContent, '可视化视频');
  assert.equal(option('wav').hidden, false);
  assert.equal(option('cancel').hidden, false);
  const before = downloads.length;
  option('wav').click();
  await waitFor(() => downloads.length > before, 'WAV download');
  assert.equal(downloads.at(-1).name, 'song-鼓.wav');
});

test('可视化视频 (audio-only): standalone upload with visBytes, downloads <name>-<音轨>-可视化.mp4', async () => {
  const s = doneServer();
  server = s;
  const file = makeFile('song.mp3', 'audio/mpeg'); // same bytes as the opened file
  const before = downloads.length;
  chooseExport('visvideo');
  await waitFor(() => downloads.length > before, 'MP4 download');
  assert.equal(downloads.at(-1).name, 'song-鼓-可视化.mp4');
  assert.equal(await urlBlobs.get(downloads.at(-1).href).text(), 'MP4DATA');
  const vis = await checkVisUpload(s, { urls: snapshots['song.mp3'], stemId: 'drums', file, layout: 'standalone' });
  assert.ok(vis.duration < 0.15, `song.mp3 data (${vis.duration})`);
  assert.ok(deletes().some((r) => r.url === '/api/export/job-vis'));
  await waitFor(() => exportText() === '已导出：song-鼓-可视化.mp4', 'done notice');
});

test('导出视频（带可视化）(video): stacked upload carries the new file\'s Vis_Data (11.1)', async () => {
  openFromLibrary('other.mp4');
  stemBtn('vocal').click();
  const s = doneServer();
  server = s;
  const file = makeFile('other.mp4', 'video/mp4');
  const before = downloads.length;
  chooseExport('visvideo');
  await waitFor(() => downloads.length > before, 'MP4 download');
  assert.equal(downloads.at(-1).name, 'other-人声-可视化.mp4');
  const vis = await checkVisUpload(s, { urls: snapshots['other.mp4'], stemId: 'vocal', file, layout: 'stacked' });
  assert.ok(vis.duration > 0.15, `other.mp4 data, not song.mp3's (${vis.duration})`);
});

test('server unavailable: records the composited canvas and downloads -可视化.webm', async () => {
  stemBtn('bass').click();
  server = { exportStatus: null };
  const postsBefore = posts().length;
  const canvasBefore = canvases.length;
  const n = recorders.length;
  const before = downloads.length;
  option('visvideo').hidden = true; // reset; opening the chooser must show it again
  chooseExport('visvideo');
  const rec = await waitForRecording(n);

  assert.equal(posts().length, postsBefore, 'no upload');
  assert.equal(canvases.length, canvasBefore + 1, 'one recording canvas');
  const canvas = canvases.at(-1);
  assert.equal(canvas.streams.length, 1);
  assert.deepEqual(rec.stream.getTracks().map((t) => `${t.kind}:${t.from}`), ['video:canvas', 'audio:dest']);
  assert.ok(canvas.ctx.calls.includes('drawImage'), 'video picture drawn under the visualization');
  assert.equal(player.activeId, 'bass');
  assert.equal(player.rate, 1);
  assert.equal(player.currentTime, 0);
  assert.ok(exportText().includes('浏览器录制中 0%'), exportText());
  assert.ok(['#playBtn', '#ctlPlay', '#speedBtn', '#loopBtn'].every((sel) => $(sel).disabled), 'controls locked');
  const drawn = canvas.ctx.calls.length;
  flushFrames();
  assert.ok(canvas.ctx.calls.length > drawn, 'a frame per animation frame');

  $('#video').dispatchEvent(new Event('ended'));
  await waitFor(() => downloads.length > before, 'WEBM download');
  assert.equal(downloads.at(-1).name, 'other-贝斯-可视化.webm');
  assert.equal(urlBlobs.get(downloads.at(-1).href).type, 'video/webm');
  await waitFor(() => exportText() === '已导出：other-贝斯-可视化.webm', 'done notice');
  assert.equal(canvas.width, 0, 'recording canvas released');
  assert.ok(canvas.streams[0].getTracks().every((t) => t.stopped));
  assert.ok(audioContexts.at(-1).closed);
});

test('server job failed (audio-only): shows the reason, falls back to recording on a #0b0d14 canvas', async () => {
  openFromLibrary('song.mp3');
  stemBtn('vocal').click();
  server = {
    exportStatus: AVAILABLE,
    post: () => json({ id: 'job-f' }, 202),
    poll: () => json({ status: 'failed', error: 'Conversion failed!' }),
  };
  const n = recorders.length;
  const before = downloads.length;
  chooseExport('visvideo');
  const rec = await waitForRecording(n);
  assert.ok(exportText().includes('Conversion failed!'), exportText());
  assert.ok(exportText().includes('改用浏览器录制'), exportText());
  assert.ok(deletes().some((r) => r.url === '/api/export/job-f'));
  const canvas = canvases.at(-1);
  assert.equal(rec.stream.getVideoTracks()[0], canvas.streams[0].getVideoTracks()[0]);
  assert.equal(canvas.width, 1280);
  assert.equal(canvas.height, 720);
  assert.ok(!canvas.ctx.calls.includes('drawImage'), 'no picture for an audio-only file');
  assert.ok(canvas.ctx.calls.includes('fillRect'));

  $('#masterAudio').dispatchEvent(new Event('ended'));
  await waitFor(() => downloads.length > before, 'WEBM download');
  assert.equal(downloads.at(-1).name, 'song-人声-可视化.webm');
});

test('canvas recording unsupported: UNSUPPORTED_TEXT and a WAV button', async () => {
  delete canvasProto.captureStream;
  try {
    server = { exportStatus: null };
    const n = recorders.length;
    chooseExport('visvideo');
    await waitFor(() => exportText() === UNSUPPORTED_TEXT, 'unsupported text');
    assert.equal(recorders.length, n, 'no recording');
    assert.equal($('#exportWavFallback').hidden, false);
    const before = downloads.length;
    $('#exportWavFallback').click();
    await waitFor(() => downloads.length > before, 'WAV download');
    assert.equal(downloads.at(-1).name, 'song-人声.wav');
  } finally {
    canvasProto.captureStream = realCaptureStream;
  }
});

test('取消导出 while the server renders: 渲染可视化视频 N%, DELETE, 已取消导出, no recording', async () => {
  server = {
    exportStatus: AVAILABLE,
    post: () => json({ id: 'job-c' }, 202),
    poll: () => json({ status: 'running', progress: 40 }),
  };
  const n = recorders.length;
  const before = downloads.length;
  chooseExport('visvideo');
  await waitFor(() => exportText().includes('渲染可视化视频 40%'), 'rendering progress');
  assert.equal($('#cancelExport').hidden, false);
  $('#cancelExport').click();
  await waitFor(() => deletes().some((r) => r.url === '/api/export/job-c' && r.keepalive), 'DELETE');
  await waitFor(() => exportText() === '已取消导出', 'cancelled notice');
  await tick(30);
  assert.equal(recorders.length, n);
  assert.equal(downloads.length, before);
});

test('entry.cache.urls are unchanged after all of the above (2.8, 15.2)', () => {
  assert.deepEqual(stemUrls(), snapshots['song.mp3']);
  openFromLibrary('other.mp4');
  assert.deepEqual(stemUrls(), snapshots['other.mp4']);
  for (const urls of Object.values(snapshots)) {
    assert.ok(Object.values(urls).every((u) => !revoked.has(u) && urlBlobs.has(u)), 'no cached URL revoked');
  }
});

test('Vis_Data failure: 可视化数据生成失败, playback and export still work', async () => {
  visMode = 'fail';
  await openReady('bad.wav', 'audio/wav');
  await waitFor(() => hint() === '可视化数据生成失败', 'failure hint');
  assert.equal(visToggle.disabled, true);
  assert.equal(visCanvas.hidden, true);
  assert.equal($('#audioArt').hidden, false);

  stemBtn('vocal').click();
  const before = downloads.length;
  $('#exportBtn').click();
  assert.equal($('#exportSheet').hidden, true, 'audio-only without Vis_Data: direct WAV');
  await waitFor(() => downloads.length > before, 'WAV download');
  assert.equal(downloads.at(-1).name, 'bad-人声.wav');
  $('#ctlPlay').click();
  assert.equal(player.paused, false);
  $('#ctlPlay').click();

  await openReady('broken.mp4', 'video/mp4');
  await waitFor(() => hint() === '可视化数据生成失败', 'failure hint (video)');
  assert.equal(laneStrip.hidden, true, 'failed Vis_Data: Lane_Strip takes no space (6.5)');
  assert.equal(laneLabels.children.length, 0);
  assert.equal(visCanvas.hidden, true);
  stemBtn('drums').click();
  $('#exportBtn').click();
  assert.equal($('#exportSheet').hidden, false);
  assert.equal(option('video').hidden, false);
  assert.equal(option('visvideo').hidden, true, 'no vis option without Vis_Data');
  option('cancel').click();
  visMode = 'ok';
});
