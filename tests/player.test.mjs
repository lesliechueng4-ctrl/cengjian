import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal stand-ins for the browser globals SyncPlayer touches.
class FakeMedia extends EventTarget {
  constructor() {
    super();
    this.currentTime = 0;
    this.duration = NaN;
    this.paused = true;
    this.muted = false;
    this.ended = false;
    this.seeking = false;
    this.playbackRate = 1;
    this.defaultPlaybackRate = 1;
    this.src = '';
    this.loop = false;
    this.playCalls = 0;
    this.pendingPlay = null; // set to a function to control when play() resolves
  }
  play() {
    this.playCalls++;
    const start = () => {
      const was = this.paused;
      this.paused = false;
      if (was) this.dispatchEvent(new Event('play'));
    };
    if (this.pendingPlay) {
      return new Promise((resolve) => { this.pendingPlay(() => { start(); resolve(); }); });
    }
    start();
    return Promise.resolve();
  }
  pause() {
    const was = this.paused;
    this.paused = true;
    if (!was) this.dispatchEvent(new Event('pause'));
  }
  load() {}
  removeAttribute(name) { if (name === 'src') this.src = ''; }
}

let frame = null;
globalThis.requestAnimationFrame = (cb) => { frame = cb; return 1; };
globalThis.Audio = FakeMedia;

const { SyncPlayer, DRIFT } = await import('../public/js/player.js');

const flush = () => new Promise((r) => setTimeout(r, 0));
const STEM_URLS = { vocal: 'blob:vocal', drums: 'blob:drums', bass: 'blob:bass' };

function setup(kind = 'video') {
  const video = new FakeMedia();
  const audio = new FakeMedia();
  const player = new SyncPlayer({ video, audio });
  player.load(new Blob(['x']), kind);
  player.master.duration = 120;
  player.setStems(STEM_URLS);
  let now = 1000;
  const tick = (ms = 16) => { now += ms; frame(now); };
  return { video, audio, player, tick };
}

test('video uploads use the video element as master; audio-only uses the audio element', () => {
  const v = setup('video');
  assert.equal(v.player.master, v.video);
  const a = setup('audio');
  assert.equal(a.player.master, a.audio);
  assert.equal(a.audio.muted, false);
});

test('switching stems while playing keeps position and is gapless', async () => {
  const { video, player } = setup();
  await player.play();
  video.currentTime = 42.5;
  const vocal = player.stems.vocal;
  let release;
  vocal.pendingPlay = (go) => { release = go; };
  player.select('vocal');
  assert.equal(vocal.currentTime, 42.5);
  assert.equal(vocal.muted, false);
  // the original keeps sounding until the stem actually plays
  assert.equal(video.muted, false);
  release();
  await flush();
  assert.equal(video.muted, true);
  assert.equal(vocal.paused, false);
  assert.equal(video.paused, false, 'picture keeps playing');

  player.select('drums');
  await flush();
  assert.equal(player.stems.drums.paused, false);
  assert.equal(vocal.paused, true);
  assert.equal(vocal.muted, true);

  player.select('original');
  assert.equal(video.muted, false);
  assert.equal(player.stems.drums.paused, true);
});

test('a stale switch finishing late does not mute the newer selection', async () => {
  const { video, player } = setup();
  await player.play();
  const vocal = player.stems.vocal;
  let release;
  vocal.pendingPlay = (go) => { release = go; };
  player.select('vocal');
  player.select('original');
  release();
  await flush();
  assert.equal(player.activeId, 'original');
  assert.equal(video.muted, false);
});

test('selecting while paused mutes the master right away and plays both on play()', async () => {
  const { video, player } = setup();
  video.currentTime = 10;
  player.select('bass');
  assert.equal(video.muted, true);
  assert.equal(player.stems.bass.paused, true);
  await player.play();
  assert.equal(video.paused, false);
  assert.equal(player.stems.bass.paused, false);
  assert.equal(player.stems.bass.currentTime, 10);
  player.pause();
  assert.equal(video.paused, true);
  assert.equal(player.stems.bass.paused, true);
});

test('seek moves master and stem together', async () => {
  const { video, player } = setup();
  player.select('vocal');
  player.seek(30);
  assert.equal(video.currentTime, 30);
  assert.equal(player.stems.vocal.currentTime, 30);
  player.seek(500);
  assert.ok(video.currentTime < 120 && video.currentTime > 119.9);
});

test('setRate applies to every element with pitch preserved', () => {
  const { video, audio, player } = setup();
  player.setRate(0.75);
  for (const el of [video, audio, ...Object.values(player.stems)]) {
    assert.equal(el.playbackRate, 0.75);
    assert.equal(el.defaultPlaybackRate, 0.75);
    assert.equal(el.preservesPitch, true);
    assert.equal(el.webkitPreservesPitch, true);
  }
});

test('small drift is corrected by nudging the stem rate, not by seeking', async () => {
  const { video, player, tick } = setup();
  player.setRate(0.5);
  player.select('vocal');
  await player.play();
  const stem = player.stems.vocal;
  video.currentTime = 20;
  stem.currentTime = 20 - 0.1; // stem behind by 100 ms
  tick();
  assert.equal(stem.currentTime, 19.9, 'no hard seek');
  assert.ok(Math.abs(stem.playbackRate - 0.5 * (1 + DRIFT.nudge)) < 1e-9, 'stem sped up');
  assert.equal(video.playbackRate, 0.5, 'master rate untouched');

  stem.currentTime = 20 + 0.1; // now ahead
  tick();
  assert.ok(Math.abs(stem.playbackRate - 0.5 * (1 - DRIFT.nudge)) < 1e-9, 'stem slowed down');

  stem.currentTime = 20.005; // back in sync
  tick();
  assert.equal(stem.playbackRate, 0.5);
});

test('large drift hard-seeks the stem at most once per cooldown', async () => {
  const { video, player, tick } = setup();
  player.select('drums');
  await player.play();
  const stem = player.stems.drums;
  video.currentTime = 50;
  stem.currentTime = 49;
  tick();
  assert.equal(stem.currentTime, 50);
  stem.currentTime = 49;
  tick(100);
  assert.equal(stem.currentTime, 49, 'still cooling down');
  tick(DRIFT.seekCooldownMs);
  assert.equal(stem.currentTime, 50);
});

test('switching stems clears an active nudge', async () => {
  const { video, player, tick } = setup();
  player.select('vocal');
  await player.play();
  video.currentTime = 20;
  player.stems.vocal.currentTime = 19.9;
  tick();
  assert.notEqual(player.stems.vocal.playbackRate, 1);
  player.select('drums');
  await flush();
  assert.equal(player.stems.vocal.playbackRate, 1);
  assert.equal(player.stems.drums.playbackRate, 1);
});

test('loop restarts just before the end; without loop the stem stops at the end', async () => {
  const { video, player, tick } = setup();
  player.select('vocal');
  player.setLoop(true);
  await player.play();
  video.currentTime = 119.97;
  player.stems.vocal.currentTime = 119.97;
  tick();
  assert.equal(video.currentTime, 0);
  assert.equal(player.stems.vocal.currentTime, 0);

  player.setLoop(false);
  video.paused = true;
  video.dispatchEvent(new Event('ended'));
  assert.equal(player.stems.vocal.paused, true);
});

test('loading a new file detaches stems without revoking caller-owned URLs', () => {
  const revoked = [];
  const orig = URL.revokeObjectURL;
  URL.revokeObjectURL = (u) => { revoked.push(u); };
  try {
    const { player } = setup();
    const vocal = player.stems.vocal;
    player.load(new Blob(['y']), 'video');
    assert.equal(player.hasStems, false);
    assert.equal(vocal.src, '');
    assert.ok(!revoked.some((u) => Object.values(STEM_URLS).includes(u)));
  } finally {
    URL.revokeObjectURL = orig;
  }
});
