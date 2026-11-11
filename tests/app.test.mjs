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
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => null, setItem() {} },
});
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
