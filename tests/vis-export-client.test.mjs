// stem-visualizer 导出客户端测试（tasks 7.3–7.7）：可视化文件名、可视化上传请求、
// 画布录制能力检测、带 frameSource 的浏览器录制和录制画布合成器。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fileNameFor, visFileLabel, UNSAFE_FILE_NAME_RE, MAX_FILE_BODY,
  exportProgressText, runServerMux, sourceExt, ExportError, EXPORT_API,
  RECORDER_TYPES, pickRecorderMime, runBrowserRecording,
} from '../public/js/export-client.js';
import { canBrowserVisRecord, createVisCompositor, VIS_BACKGROUND, RECORD_BOX, RECORD_STACK_BOX } from '../public/js/vis-record.js';
import { lanesAt, LANE_BACKGROUND } from '../public/js/vis-lanes.js';
import { createVisData, encodeVisPayload, VIS_STEM_IDS, ONSET_STEM_IDS } from '../public/js/vis-data.js';
import { sceneAt } from '../public/js/vis-scene.js';
import { STEMS } from '../public/js/separator.js';
import { SPEEDS } from '../public/js/player.js';
import { forAll, gen } from './helpers/prop.mjs';

const STEM_IDS = STEMS.map((s) => s.id);
const DERIVED_IDS = STEM_IDS.filter((id) => id !== 'original');
const EXPORT_LABELS = STEMS.filter((s) => s.id !== 'original').map((s) => s.label);
const UNSAFE_ONE = new RegExp(UNSAFE_FILE_NAME_RE.source);
const cps = (s) => Array.from(s).length;
const pick = (list) => (rng) => list[Math.floor(rng() * list.length)];

// ---------------------------------------------------------------------------
// Property 17
// ---------------------------------------------------------------------------

const sourceNameGen = gen.oneOf(
  gen.string({ maxLength: 24 }),
  gen.string({ minLength: 40, maxLength: 120 }),
  (rng) => ' .'.repeat(gen.int(0, 3)(rng)) + gen.string({ maxLength: 10 })(rng) + '. '.repeat(gen.int(0, 3)(rng)),
  (rng) => `${gen.string({ maxLength: 12 })(rng)}.${gen.string({ maxLength: 4 })(rng)}.${gen.oneOf('mp4', 'mov', 'mp3')(rng)}`,
  (rng) => '层'.repeat(gen.int(60, 200)(rng)) + '.mp4',
  (rng) => '😀'.repeat(gen.int(60, 120)(rng)),
  '', '.', '...', ' ', '.mp4', '..mp4',
);

// Feature: stem-visualizer, Property 17: 可视化导出文件名
test('Feature: stem-visualizer, Property 17: 可视化导出文件名', async () => {
  // **Validates: Requirements 9.5**
  const g = (rng) => ({ name: sourceNameGen(rng), label: pick(EXPORT_LABELS)(rng), ext: pick(['mp4', 'webm'])(rng) });
  await forAll(g, ({ name, label, ext }) => {
    const out = fileNameFor(name, visFileLabel(label), ext);
    const tail = `-${label}-可视化.${ext}`;
    assert.ok(out.endsWith(tail), `ends with ${tail}: ${JSON.stringify(out)}`);
    const body = out.slice(0, -(ext.length + 1));
    assert.ok(cps(body) <= MAX_FILE_BODY, `body ≤ ${MAX_FILE_BODY} code points: ${cps(body)}`);
    assert.ok(!UNSAFE_ONE.test(body), `no unsafe char: ${JSON.stringify(body)}`);
    assert.ok(!/^[ .]/.test(body) && !/[ .]$/.test(body), `body edges: ${JSON.stringify(body)}`);
    const base = body.slice(0, -(tail.length - ext.length - 1));
    assert.ok(cps(base) >= 1, 'base keeps at least one character');
  }, { runs: 300 });
});

test('visFileLabel / fileNameFor examples', () => {
  assert.equal(visFileLabel('人声'), '人声-可视化');
  assert.equal(fileNameFor('练习 v2.final.mp4', visFileLabel('人声'), 'mp4'), '练习 v2.final-人声-可视化.mp4');
  assert.equal(fileNameFor('song.mp3', visFileLabel('鼓'), 'webm'), 'song-鼓-可视化.webm');
});

// ---------------------------------------------------------------------------
// Property 18
// ---------------------------------------------------------------------------

const jsonRes = (status, body) => ({
  status, ok: status >= 200 && status < 300,
  json: async () => body,
  blob: async () => new Blob([JSON.stringify(body)]),
});
const mp4Res = () => ({
  status: 200, ok: true,
  json: async () => { throw new Error('not json'); },
  blob: async () => new Blob(['MP4DATA'], { type: 'video/mp4' }),
});

/** Fake Server answering POST / polls / result.mp4 / DELETE from fixed sequences; records every call. */
function fakeServer({ upload, polls = [], download = mp4Res() }) {
  const calls = [];
  let i = 0;
  const answer = (r) => (r === 'neterr' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(r));
  const fetch = (url, init = {}) => {
    calls.push({ url, init });
    const method = init.method || 'GET';
    if (method === 'POST') return answer(upload);
    if (method === 'DELETE') return Promise.resolve(jsonRes(204, {}));
    if (url.endsWith('/result.mp4')) return answer(download);
    return answer(i < polls.length ? polls[i++] : jsonRes(200, { status: 'done' }));
  };
  return { fetch, calls };
}

const noSleep = async () => {};
const MARKERS = ['层', '间', '音乐', 'Ж', '😀', 'é'];
const muxNameGen = (rng) => {
  const a = gen.string({ minLength: 0, maxLength: 12 })(rng);
  const b = gen.string({ minLength: 1, maxLength: 12 })(rng);
  const m = pick(MARKERS)(rng);
  const ext = gen.oneOf('mp4', 'MOV', 'mkv', 'mp3', 'wav', 'avi', '')(rng);
  return ext ? `${a}${m}${b}.${ext}` : `${a}${m}${b}`;
};
const bytesGen = (min, max) => (rng) => Uint8Array.from({ length: gen.int(min, max)(rng) }, () => Math.floor(rng() * 256));
const uploadGen = gen.oneOf(
  () => jsonRes(202, { id: 'a1b2c3', status: 'queued', position: 1 }),
  () => jsonRes(202, { id: 'a1b2c3', status: 'queued', position: 1 }),
  () => jsonRes(413, { error: '上传的文件太大' }),
  () => jsonRes(400, { error: '可视化数据无效' }),
  () => jsonRes(503, { error: '视频导出不可用' }),
  () => 'neterr',
);
const pollGen = gen.oneOf(
  () => jsonRes(200, { status: 'queued', position: 2 }),
  () => jsonRes(200, { status: 'running', progress: 42 }),
  () => jsonRes(200, { status: 'running', progress: null }),
  () => jsonRes(200, { status: 'done' }),
  () => jsonRes(200, { status: 'failed', error: 'ffmpeg 退出码 1' }),
  () => jsonRes(404, { error: '任务不存在' }),
  () => 'neterr',
);

/** A Vis_Payload built from random Vis_Data with encodeVisPayload. */
const payloadGen = (rng) => {
  const frames = gen.int(1, 300)(rng);
  const results = {};
  for (const id of VIS_STEM_IDS) {
    if (rng() < 0.3) continue;
    const env = bytesGen(frames, frames)(rng);
    let onsets = null;
    if (ONSET_STEM_IDS.includes(id)) {
      onsets = [];
      for (let f = gen.int(0, 10)(rng); f < frames; f += gen.int(5, 40)(rng)) onsets.push(f);
    }
    results[id] = { env, onsets, duration: frames / 100 };
  }
  if (!Object.keys(results).length) results.vocal = { env: new Uint8Array(frames), onsets: null, duration: frames / 100 };
  return encodeVisPayload(createVisData(results), pick(STEM_IDS)(rng));
};

function headerValues(headers) {
  if (!headers) return [];
  if (typeof headers.entries === 'function') return [...headers.entries()].flat();
  return Object.entries(headers).flat().map(String);
}

async function blobBytes(b) { return new Uint8Array(await b.arrayBuffer()); }
function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function runMux(c, vis) {
  const { fetch, calls } = fakeServer(c);
  const file = new File([c.fileBytes], c.name, { type: c.type });
  const wav = new Blob([c.wavBytes]);
  const phases = [];
  let error = null;
  try {
    await runServerMux(file, wav, { fetch, sleep: noSleep, pollMs: 1, onPhase: (p) => phases.push(p), vis });
  } catch (err) { error = err; }
  return { calls, phases, error, file, wav };
}

// Feature: stem-visualizer, Property 18: 可视化上传请求
test('Feature: stem-visualizer, Property 18: 可视化上传请求', async () => {
  // **Validates: Requirements 10.1, 10.2, 10.9, 9.8**
  const g = (rng) => ({
    name: muxNameGen(rng),
    type: gen.oneOf('video/mp4', 'audio/mpeg', '', 'video/webm')(rng),
    fileBytes: bytesGen(1, 64)(rng),
    wavBytes: bytesGen(0, 96)(rng),
    payload: payloadGen(rng),
    layout: gen.oneOf('stacked', 'standalone')(rng),
    upload: uploadGen(rng),
    polls: gen.array(pollGen, { minLength: 0, maxLength: 6 })(rng),
    download: gen.oneOf(() => mp4Res(), () => jsonRes(404, { error: '结果不存在' }), () => 'neterr')(rng),
  });
  await forAll(g, async (c) => {
    const payload = new Blob([c.payload]);
    const withVis = await runMux(c, { payload, layout: c.layout });
    if (withVis.error) assert.ok(withVis.error instanceof ExportError, `unexpected ${withVis.error}`);

    const post = withVis.calls.find((x) => x.init.method === 'POST');
    assert.ok(post, 'one POST');
    assert.equal(withVis.calls.filter((x) => x.init.method === 'POST').length, 1);
    assert.ok(post.url.startsWith(`${EXPORT_API}?`), `relative /api/export?: ${post.url}`);
    assert.ok(!post.url.includes('//'));
    const q = new URL(post.url, 'http://localhost').searchParams;
    assert.deepEqual([...q.keys()].sort(), ['ext', 'layout', 'visBytes', 'wavBytes']);
    assert.equal(q.get('ext'), sourceExt(withVis.file));
    assert.equal(q.get('wavBytes'), String(c.wavBytes.length));
    assert.equal(q.get('visBytes'), String(payload.size));
    assert.equal(q.get('layout'), c.layout);

    // Body: WAV, Vis_Payload, Source_File, in that order.
    const expected = concatBytes(c.wavBytes, await blobBytes(payload), c.fileBytes);
    assert.deepEqual(await blobBytes(post.init.body), expected);

    // No Source_File name in URLs, headers or the payload.
    const dot = c.name.lastIndexOf('.');
    const base = dot > 0 ? c.name.slice(0, dot) : c.name;
    const enc = (s) => { try { return encodeURIComponent(s); } catch { return s; } };
    const needles = [c.name, enc(c.name)];
    if (cps(base) >= 3) needles.push(base, enc(base));
    for (const { url, init } of withVis.calls) {
      for (const h of [url, ...headerValues(init.headers)]) {
        for (const n of needles) assert.ok(!h.includes(n), `file name leaked into ${JSON.stringify(h)}`);
      }
    }
    if (cps(base) >= 3) {
      for (const n of [base, JSON.stringify(base).slice(1, -1)]) assert.ok(!c.payload.includes(n), 'file name in payload');
    }

    // Without vis: the request is the same as before this feature.
    const plain = await runMux(c, undefined);
    const plainPost = plain.calls.find((x) => x.init.method === 'POST');
    assert.equal(plainPost.url, `${EXPORT_API}?ext=${encodeURIComponent(sourceExt(plain.file))}&wavBytes=${c.wavBytes.length}`);
    assert.deepEqual(await blobBytes(plainPost.init.body), concatBytes(c.wavBytes, c.fileBytes));
    assert.deepEqual(plainPost.init.headers, post.init.headers);
    assert.ok(!plain.phases.some((p) => p.stage === 'rendering'));
    // Same server answers → same sequence of calls and phases, 'running' ↔ 'rendering'.
    assert.deepEqual(plain.calls.map((x) => [x.url.split('?')[0], x.init.method || 'GET']),
      withVis.calls.map((x) => [x.url.split('?')[0], x.init.method || 'GET']));
    assert.ok(!withVis.phases.some((p) => p.stage === 'running'));
    assert.deepEqual(withVis.phases.map((p) => (p.stage === 'rendering' ? { ...p, stage: 'running' } : p)), plain.phases);
    assert.equal(plain.error && plain.error.stage, withVis.error && withVis.error.stage);
  }, { runs: 150 });
});

// ---------------------------------------------------------------------------
// Property 27
// ---------------------------------------------------------------------------

const OTHER_TYPES = ['video/mp4', 'video/webm;codecs=h264', 'audio/webm'];

// Feature: stem-visualizer, Property 27: 画布录制能力检测
test('Feature: stem-visualizer, Property 27: 画布录制能力检测', async () => {
  // **Validates: Requirements 14.5**
  const bool = (rng) => rng() < 0.5;
  const g = (rng) => ({
    canvas: gen.oneOf('none', 'noProto', 'noCapture', 'capture')(rng),
    mediaCapture: bool(rng), // HTMLMediaElement.prototype.captureStream must not matter
    recorder: gen.oneOf('none', 'noIsType', 'class')(rng),
    supported: [...RECORDER_TYPES, ...OTHER_TYPES].filter(() => rng() < 0.4),
    audioContext: bool(rng),
    webkitAudioContext: bool(rng),
  });
  await forAll(g, (c) => {
    const env = {};
    if (c.canvas === 'noProto') env.HTMLCanvasElement = {};
    if (c.canvas === 'noCapture') env.HTMLCanvasElement = class {};
    if (c.canvas === 'capture') env.HTMLCanvasElement = class { captureStream() {} };
    if (c.mediaCapture) env.HTMLMediaElement = class { captureStream() {} };
    const set = new Set(c.supported);
    if (c.recorder === 'noIsType') env.MediaRecorder = class {};
    if (c.recorder === 'class') env.MediaRecorder = class { static isTypeSupported(t) { return set.has(t); } };
    if (c.audioContext) env.AudioContext = class {};
    if (c.webkitAudioContext) env.webkitAudioContext = class {};

    const mime = c.recorder === 'none' ? null : pickRecorderMime(env.MediaRecorder);
    const expected = c.canvas === 'capture' && c.recorder !== 'none' && mime !== null
      && (c.audioContext || c.webkitAudioContext);
    assert.equal(canBrowserVisRecord(env), expected);
  }, { runs: 300 });
  assert.equal(canBrowserVisRecord(null), false);
});

// ---------------------------------------------------------------------------
// Property 28: fake browser environment for runBrowserRecording
// ---------------------------------------------------------------------------

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
 * outcome: 'ended' | 'cancel' | 'recorderError' | 'mediaError' | 'autoplay', triggered right
 * after the Player's first play(). `video` may be an audio element (no captureStream).
 */
function makeRecordingEnv({ outcome, mediaErrorOn = 'video', autoplayVia = 'player', videoKind = 'video' }) {
  const log = { audios: [], recorders: [], captureCalls: 0 };
  const ctrl = new AbortController();

  class FakeAudio extends FakeTarget {
    constructor() {
      super();
      this.readyState = 0; this._src = ''; this.currentTime = 0; this.paused = true; this.error = null;
      log.audios.push(this);
    }
    get src() { return this._src; }
    set src(v) { this._src = v; }
    load() { if (this._src) setTimeout(() => { this.readyState = 1; this.dispatch('loadedmetadata'); }, 0); }
    removeAttribute(name) { if (name === 'src') this._src = ''; }
    play() {
      if (outcome === 'autoplay' && autoplayVia === 'recAudio') return Promise.reject(new DOMException('blocked', 'NotAllowedError'));
      this.paused = false;
      return Promise.resolve();
    }
    pause() { this.paused = true; }
  }

  class FakeAudioContext {
    constructor() { this.destination = { name: 'speakers' }; }
    createMediaStreamDestination() { return { stream: new FakeStream([fakeTrack('audio', 'dest')]) }; }
    createMediaElementSource() { return { connect() {} }; }
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
  }

  class FakeMediaRecorder {
    static isTypeSupported(t) { return t === 'video/webm'; }
    constructor(stream, opts) {
      this.stream = stream; this.opts = opts; this.state = 'inactive';
      this.ondataavailable = null; this.onerror = null; this.onstop = null;
      log.recorders.push(this);
    }
    start() { this.state = 'recording'; }
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
  if (videoKind === 'video') {
    video.captureStream = () => {
      log.captureCalls += 1;
      return new FakeStream([fakeTrack('video', 'source-picture'), fakeTrack('audio', 'source-audio')]);
    };
  }

  const trigger = (player) => {
    const rec = log.recorders[0];
    if (outcome === 'ended') {
      if (rec && rec.ondataavailable) rec.ondataavailable({ data: new Blob(['CHUNK']) });
      video.currentTime = player.duration;
      video.dispatch('timeupdate');
      video.dispatch('ended');
    } else if (outcome === 'cancel') {
      ctrl.abort();
    } else if (outcome === 'recorderError') {
      rec.onerror({ error: new Error('encoder died') });
    } else if (outcome === 'mediaError') {
      const el = mediaErrorOn === 'video' ? video : log.audios[0];
      el.error = { message: 'decode error' };
      el.dispatch('error');
    }
  };

  const env = { Audio: FakeAudio, AudioContext: FakeAudioContext, MediaRecorder: FakeMediaRecorder, MediaStream: FakeStream };
  return { env, video, log, ctrl, trigger, blockFirstPlay: outcome === 'autoplay' && autoplayVia === 'player' };
}

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
      if (first && blockFirstPlay) return;
      this.paused = false;
      if (first && onFirstPlay) setTimeout(() => onFirstPlay(p), 0);
    },
  };
  return p;
}

function makeFrameSource(player) {
  const tracks = [fakeTrack('video', 'canvas-1'), fakeTrack('video', 'canvas-2')];
  const fs = {
    stream: new FakeStream(tracks),
    startCalls: 0, stopCalls: 0, playsAtStart: null,
    start() { this.startCalls += 1; this.playsAtStart = player.plays.length; },
    stop() { this.stopCalls += 1; },
  };
  return fs;
}

function setupVisRecording(s) {
  const r = makeRecordingEnv(s);
  const player = makeFakePlayer(s, { onFirstPlay: r.trigger, blockFirstPlay: r.blockFirstPlay });
  const frameSource = makeFrameSource(player);
  const opts = {
    player, video: r.video, stemId: s.stemId, stemUrl: `blob:test/${s.stemId}`,
    selected: s.selected, signal: r.ctrl.signal, env: r.env, frameSource,
  };
  return { ...r, player, frameSource, opts };
}

const recordingCaseGen = (rng) => {
  const duration = gen.float(0.5, 600)(rng);
  return {
    duration,
    time: gen.float(0, duration)(rng),
    rate: pick(SPEEDS)(rng),
    playing: rng() < 0.5,
    loop: rng() < 0.5,
    selected: pick(STEM_IDS)(rng),
    stemId: pick(DERIVED_IDS)(rng),
    outcome: gen.oneOf('ended', 'cancel', 'recorderError', 'mediaError', 'autoplay')(rng),
    mediaErrorOn: gen.oneOf('video', 'recAudio')(rng),
    autoplayVia: gen.oneOf('player', 'recAudio')(rng),
    videoKind: gen.oneOf('video', 'audio')(rng),
  };
};

// Feature: stem-visualizer, Property 28: 可视化录制后恢复 Playback_State
test('Feature: stem-visualizer, Property 28: 可视化录制后恢复 Playback_State', async () => {
  // **Validates: Requirements 14.2, 14.4, 14.7**
  await forAll(recordingCaseGen, async (s) => {
    const { player, video, log, frameSource, opts } = setupVisRecording(s);
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

    // During recording: Export_Stem, from 0, 1x, no loop.
    assert.ok(player.plays.length >= 1);
    assert.deepEqual(player.plays[0], { selected: s.stemId, currentTime: 0, rate: 1, loop: false });

    // frameSource: start once (before player.play), stop once; picture tracks only from it.
    assert.equal(frameSource.startCalls, 1);
    assert.equal(frameSource.stopCalls, 1);
    assert.equal(frameSource.playsAtStart, 0, 'start() before player.play()');
    assert.equal(log.captureCalls, 0, 'video.captureStream never called');
    assert.equal(log.recorders.length, 1);
    const pictures = log.recorders[0].stream.getVideoTracks();
    const own = frameSource.stream.getVideoTracks();
    assert.ok(pictures.length > 0);
    for (const t of pictures) assert.ok(own.includes(t), `foreign picture track ${t.label}`);
    assert.deepEqual(log.recorders[0].stream.getAudioTracks().map((t) => t.label), ['dest']);

    // After: back to the snapshot.
    assert.equal(player.currentTime, s.time);
    assert.equal(player.rate, s.rate);
    assert.equal(player.paused, !s.playing);
    assert.equal(player.loop, s.loop);
    assert.equal(player.selected, s.selected);
    assert.equal(video.listenerCount(), 0, 'video listeners removed');
  }, { runs: 150 });
});

// ---------------------------------------------------------------------------
// Examples (task 7.7)
// ---------------------------------------------------------------------------

test('exportProgressText rendering texts', () => {
  assert.equal(exportProgressText({ stage: 'rendering', progress: 37 }), '渲染可视化视频 37%');
  assert.equal(exportProgressText({ stage: 'rendering', progress: null }), '渲染可视化视频中…');
  assert.equal(exportProgressText({ stage: 'rendering' }), '渲染可视化视频中…');
});

/** Fake document whose canvas logs every 2D call into `ops`. */
function fakeCanvasEnv() {
  const ops = [];
  const streamTracks = [fakeTrack('video', 'canvas')];
  let canvas = null;
  const ctx = {
    globalCompositeOperation: 'source-over', globalAlpha: 1, fillStyle: '#000',
    fillRect(x, y, w, h) { ops.push({ op: 'fillRect', fillStyle: this.fillStyle, args: [x, y, w, h] }); },
    drawImage(img, x, y, w, h) { ops.push({ op: 'drawImage', img, args: [x, y, w, h] }); },
    save() { ops.push({ op: 'save' }); },
    restore() { ops.push({ op: 'restore' }); },
    translate(x, y) { ops.push({ op: 'translate', args: [x, y] }); },
    beginPath() { ops.push({ op: 'beginPath' }); },
    rect(x, y, w, h) { ops.push({ op: 'rect', args: [x, y, w, h] }); },
    clip() { ops.push({ op: 'clip' }); },
  };
  const document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      canvas = {
        width: 300, height: 150, fps: null,
        getContext: (kind) => { assert.equal(kind, '2d'); return ctx; },
        captureStream(fps) { this.fps = fps; return new FakeStream(streamTracks); },
      };
      return canvas;
    },
  };
  const frames = [];
  const cancelled = [];
  let nextId = 1;
  const raf = (cb) => { const id = nextId++; frames.push({ id, cb }); return id; };
  const cancelRaf = (id) => cancelled.push(id);
  const runFrame = () => { const f = frames.shift(); if (f) f.cb(); return !!f; };
  return { ops, ctx, document, raf, cancelRaf, frames, cancelled, runFrame, streamTracks, getCanvas: () => canvas };
}

const exampleVisData = () => createVisData({
  vocal: { env: Uint8Array.from({ length: 200 }, (_, i) => (i * 7) % 256), onsets: null, duration: 2 },
  drums: { env: Uint8Array.from({ length: 200 }, () => 200), onsets: [10, 60, 120], duration: 2 },
});

const parseRgb = (s) => {
  const m = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/.exec(s) || /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
  assert.ok(m, `colour ${s}`);
  return s.startsWith('#') ? m.slice(1).map((h) => parseInt(h, 16)) : m.slice(1).map(Number);
};

test('createVisCompositor stacks the video picture above the Lane_Strip every frame', () => {
  const f = fakeCanvasEnv();
  const video = { videoWidth: 1920, videoHeight: 1080 };
  const visData = exampleVisData();
  const laneCalls = [];
  let t = 0.5;
  const comp = createVisCompositor({
    document: f.document, video, visData, stemId: 'drums', getTime: () => t,
    raf: f.raf, cancelRaf: f.cancelRaf,
    sceneAt: () => { throw new Error('sceneAt must not be used for Video_Source'); },
    lanesAt: (time, data, opts) => { laneCalls.push({ time, data, opts }); return lanesAt(time, data, opts); },
    drawSceneToCanvas: (ctx, shapes, opts) => f.ops.push({ op: 'lanes', ctx, shapes, opts }),
  });
  assert.equal(RECORD_STACK_BOX, 1280);
  assert.equal(comp.canvas.width, 1280);
  assert.equal(comp.canvas.height, 976);
  assert.equal(comp.canvas.fps, 30);
  assert.deepEqual(comp.stream.getVideoTracks(), f.streamTracks);

  comp.start();
  t = 1.25;
  assert.ok(f.runFrame());
  t = 1.5;
  assert.ok(f.runFrame());

  const perFrame = ['fillRect', 'fillRect', 'drawImage', 'save', 'translate', 'beginPath', 'rect', 'clip', 'lanes', 'restore'];
  assert.deepEqual(f.ops.map((o) => o.op), [...perFrame, ...perFrame, ...perFrame]);
  for (let i = 0; i < 3; i++) {
    const ops = f.ops.slice(i * perFrame.length, (i + 1) * perFrame.length);
    // Picture area black, strip area LANE_BACKGROUND.
    assert.deepEqual(parseRgb(ops[0].fillStyle === '#000' ? '#000000' : ops[0].fillStyle), [0, 0, 0]);
    assert.deepEqual(ops[0].args, [0, 0, 1280, 720]);
    assert.deepEqual(parseRgb(ops[1].fillStyle), [...LANE_BACKGROUND]);
    assert.deepEqual(ops[1].args, [0, 720, 1280, 256]);
    // Video contained inside the picture area.
    const [x, y, w, h] = ops[2].args;
    assert.equal(ops[2].img, video);
    assert.ok(x >= 0 && y >= 0 && x + w <= 1280 && y + h <= 720, `drawImage rect ${ops[2].args}`);
    assert.ok(Math.abs(w / h - 1920 / 1080) < 1e-9);
    // Strip: translate to PH, clip to the strip, lane draw without clearing.
    assert.deepEqual(ops[4].args, [0, 720]);
    assert.deepEqual(ops[6].args, [0, 0, 1280, 256]);
    assert.equal(ops[8].ctx, f.ctx);
    assert.equal(ops[8].opts.clear, false);
  }
  assert.deepEqual(laneCalls.map((c) => c.time), [0.5, 1.25, 1.5]);
  for (const c of laneCalls) {
    assert.equal(c.data, visData);
    assert.deepEqual(c.opts, { selected: 'drums', width: 1280, height: 256, reducedMotion: false });
  }
  comp.stop();
});

test('createVisCompositor keeps the picture black when drawImage throws, and falls back to 1280×720 for invalid video sizes', () => {
  const f = fakeCanvasEnv();
  f.ctx.drawImage = () => { throw new Error('not ready'); };
  const comp = createVisCompositor({
    document: f.document, video: { videoWidth: 0, videoHeight: NaN }, visData: exampleVisData(), stemId: 'vocal',
    getTime: () => 0, raf: f.raf, cancelRaf: f.cancelRaf,
    drawSceneToCanvas: (ctx, shapes, opts) => f.ops.push({ op: 'lanes', opts }),
  });
  // stackedLayout's 1280×720 fallback inside the 1280×1280 box.
  assert.deepEqual([comp.canvas.width, comp.canvas.height], [1280, 976]);
  comp.start();
  assert.deepEqual(f.ops.map((o) => o.op), ['fillRect', 'fillRect', 'save', 'translate', 'beginPath', 'rect', 'clip', 'lanes', 'restore']);
  comp.stop();
});

test('createVisCompositor fills #0b0d14 for audio-only sources and stops requesting frames after stop()', () => {
  const f = fakeCanvasEnv();
  const comp = createVisCompositor({
    document: f.document, video: null, visData: exampleVisData(), stemId: 'vocal', getTime: () => 1,
    raf: f.raf, cancelRaf: f.cancelRaf,
    drawSceneToCanvas: (ctx, shapes, opts) => f.ops.push({ op: 'scene', opts }),
  });
  assert.deepEqual([comp.canvas.width, comp.canvas.height], [...RECORD_BOX]);
  comp.start();
  f.runFrame();
  assert.ok(!f.ops.some((o) => o.op === 'drawImage'));
  assert.equal(f.ops[0].op, 'fillRect');
  assert.deepEqual(parseRgb(f.ops[0].fillStyle), [0x0b, 0x0d, 0x14]);
  assert.deepEqual([...VIS_BACKGROUND], [0x0b, 0x0d, 0x14]);
  assert.deepEqual(f.ops[0].args, [0, 0, 1280, 720]);
  // Each frame: background fill, then scene.
  const seq = f.ops.map((o) => o.op);
  assert.deepEqual(seq, ['fillRect', 'scene', 'fillRect', 'scene']);

  assert.equal(f.frames.length, 1, 'one pending frame');
  const pending = f.frames[0];
  comp.stop();
  assert.deepEqual(f.cancelled, [pending.id]);
  assert.ok(f.streamTracks.every((t) => t.stopped), 'tracks stopped');
  assert.equal(comp.canvas.width, 0);
  assert.equal(comp.canvas.height, 0);
  // Even if the cancelled callback still fires, nothing is drawn or requested.
  const opsBefore = f.ops.length;
  f.runFrame();
  assert.equal(f.ops.length, opsBefore);
  assert.equal(f.frames.length, 0, 'no new animation frame after stop()');
  comp.start();
  assert.equal(f.frames.length, 0, 'start() after stop() does nothing');
});

test("runBrowserRecording recorder error → ExportError('record') and frameSource.stop()", async () => {
  const s = {
    duration: 30, time: 12.5, rate: 1.25, playing: true, loop: true, selected: 'original',
    stemId: 'vocal', outcome: 'recorderError', videoKind: 'audio',
  };
  const { player, frameSource, opts } = setupVisRecording(s);
  await assert.rejects(runBrowserRecording(opts), (err) => err instanceof ExportError && err.stage === 'record');
  assert.equal(frameSource.startCalls, 1);
  assert.equal(frameSource.stopCalls, 1);
  assert.equal(player.selected, 'original');
  assert.equal(player.currentTime, 12.5);
});
