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

function setup(kind = 'video', opts = {}) {
  const video = new FakeMedia();
  const audio = new FakeMedia();
  const player = new SyncPlayer({ video, audio, ...opts });
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

test('a device whose seeks land late stops being re-seeked: the muted picture follows the stem instead', async () => {
  const { video, player, tick } = setup();
  player.select('drums');
  await player.play();
  const stem = player.stems.drums;
  const DELAY = 0.3; // every seek on this device comes back 0.3 s late
  let seeks = 0;
  let last = stem.currentTime;
  const step = () => {
    tick(DRIFT.seekCooldownMs + 50);
    if (stem.currentTime !== last) { seeks++; stem.currentTime -= DELAY; }
    last = stem.currentTime;
  };
  video.currentTime = 50;
  stem.currentTime = 49;
  last = 49;
  for (let i = 0; i < 20; i++) step();
  assert.ok(seeks <= DRIFT.stormSeeks + 1, `seeked ${seeks} times`);
  assert.equal(player.gentle, true);
  assert.equal(stem.playbackRate, 1, 'the sound is left alone');
  assert.ok(Math.abs(video.playbackRate - (1 - DRIFT.followFast)) < 1e-9, 'the picture waits for the late stem');

  // Closing in: it stays on that rate (no extra change) until the two have met.
  stem.currentTime = video.currentTime - 0.1;
  tick();
  assert.ok(Math.abs(video.playbackRate - (1 - DRIFT.followFast)) < 1e-9);

  // Met: back to the exact rate. Still no change to the stem.
  stem.currentTime = video.currentTime;
  tick();
  assert.equal(video.playbackRate, 1);
  assert.equal(stem.playbackRate, 1);

  // A small gap from the exact rate: a small change.
  stem.currentTime = video.currentTime - 0.1;
  tick();
  assert.ok(Math.abs(video.playbackRate - (1 - DRIFT.followSlow)) < 1e-9, 'small gap: small change');
  stem.currentTime = video.currentTime;
  tick();
  assert.equal(video.playbackRate, 1);

  // The picture a little late is left alone: it is never sped up.
  stem.currentTime = video.currentTime + 0.1;
  tick(DRIFT.gentleCooldownMs + 1);
  assert.equal(video.playbackRate, 1);
  assert.equal(video.currentTime, stem.currentTime - 0.1);

  // Back to 原曲 while following: the master plays at the exact rate again.
  stem.currentTime = video.currentTime - 0.1;
  tick();
  assert.notEqual(video.playbackRate, 1);
  player.select('original');
  assert.equal(video.playbackRate, 1);
  player.select('drums');
  await flush();
  stem.currentTime = video.currentTime;

  // A really large gap: the picture jumps to the sound, the sound stays where it is.
  stem.currentTime = video.currentTime - 5;
  const at = stem.currentTime;
  tick(DRIFT.gentleCooldownMs + 1);
  assert.equal(stem.currentTime, at);
  assert.ok(Math.abs(video.currentTime - (at + DRIFT.pictureLead)) < 1e-9);
});

test('gentle from the start (iPhone): the sound is never seeked or re-timed while it plays', async () => {
  const { video, player, tick } = setup('video', { gentle: true });
  player.select('drums');
  await player.play();
  const stem = player.stems.drums;
  video.currentTime = 50;
  stem.currentTime = 49.7; // came back late from the first seek
  tick();
  assert.equal(stem.currentTime, 49.7);
  assert.equal(stem.playbackRate, 1);
  assert.ok(Math.abs(video.playbackRate - (1 - DRIFT.followFast)) < 1e-9, 'the picture waits');

  // The picture is late: it jumps to a little ahead of the sound, then waits for it.
  stem.currentTime = 60;
  video.currentTime = 59.5;
  tick();
  assert.equal(stem.currentTime, 60);
  assert.ok(Math.abs(video.currentTime - (60 + DRIFT.pictureLead)) < 1e-9);
  assert.equal(video.playbackRate, 1);
  video.dispatchEvent(new Event('seeked'));
  assert.equal(stem.currentTime, 60, 'a jump of the picture does not drag the sound along');
  tick();
  assert.ok(video.playbackRate < 1);

  // It landed late and is behind again: no second jump inside the cooldown, then the same jump.
  video.currentTime = 59.5;
  tick(100);
  assert.equal(video.currentTime, 59.5);
  assert.equal(video.playbackRate, 1);
  tick(DRIFT.gentleCooldownMs);
  assert.ok(Math.abs(video.currentTime - (60 + DRIFT.pictureLead)) < 1e-9);

  // A picture a little late is left alone for good.
  video.currentTime = 60 - DRIFT.pictureBehind + 0.05;
  tick(DRIFT.gentleCooldownMs * 2);
  assert.equal(video.currentTime, 60 - DRIFT.pictureBehind + 0.05);
  assert.equal(video.playbackRate, 1);

  // Pause and play again with a small gap: the sound is not seeked.
  player.pause();
  video.currentTime = 70;
  stem.currentTime = 69.9;
  await player.play();
  assert.equal(stem.currentTime, 69.9);
  // Switching stems starts the new one from the sound's position.
  player.select('bass');
  assert.equal(player.stems.bass.currentTime, 69.9);
});

test('gentle: the A-B range wraps on the position of the sound', async () => {
  const { video, player, tick } = setup('video', { gentle: true });
  player.select('drums');
  await player.play();
  const stem = player.stems.drums;
  assert.equal(player.setRange(10, 20), true);
  video.currentTime = 20.1; // the picture is ahead, the sound has not reached B yet
  stem.currentTime = 19.9;
  tick();
  assert.equal(stem.currentTime, 19.9);
  stem.currentTime = 20.01;
  tick();
  assert.equal(stem.currentTime, 10);
  assert.equal(video.currentTime, 10);
});

test('seeks far apart never switch a normal device to gentle mode', async () => {
  const { video, player, tick } = setup();
  player.select('drums');
  await player.play();
  const stem = player.stems.drums;
  video.currentTime = 50;
  for (let i = 0; i < 10; i++) {
    stem.currentTime = 49;
    tick(DRIFT.stormMs + 1);
    assert.equal(stem.currentTime, 50);
  }
  assert.equal(player.gentle, false);
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

test('A-B range: playback jumps back to A at B, with or without whole-song loop', async () => {
  const { video, player, tick } = setup();
  player.select('vocal');
  assert.equal(player.setRange(30, 20), true, 'either order');
  assert.deepEqual(player.range, { a: 20, b: 30 });
  await player.play();
  video.currentTime = 25;
  player.stems.vocal.currentTime = 25;
  tick();
  assert.equal(video.currentTime, 25, 'inside the range nothing happens');
  video.currentTime = 30.01;
  tick();
  assert.equal(video.currentTime, 20);
  assert.equal(player.stems.vocal.currentTime, 20);

  video.currentTime = 10; // before A: plays into the range
  tick();
  assert.equal(video.currentTime, 10);

  player.setLoop(true);
  video.currentTime = 31;
  tick();
  assert.equal(video.currentTime, 20, 'the range wins over the whole-song loop');
});

test('A-B range: too short or invalid ranges are refused; B is kept away from the very end', () => {
  const { player } = setup();
  assert.equal(player.setRange(10, 10.1), false);
  assert.equal(player.setRange(NaN, 5), false);
  assert.equal(player.range, null);
  assert.equal(player.setRange(100, 500), true);
  assert.ok(player.range.b < 120 && player.range.b > 119.9);
  assert.equal(player.range.a, 100);
});

test('A-B range: cleared by setRange(null) and by loading another file; ended restarts at A', async () => {
  const { video, player, tick } = setup();
  player.setRange(20, 30);
  await player.play();
  video.dispatchEvent(new Event('ended'));
  assert.equal(video.currentTime, 20);

  player.setRange(null);
  assert.equal(player.range, null);
  video.currentTime = 40;
  tick();
  assert.equal(video.currentTime, 40);

  player.setRange(20, 30);
  player.load(new Blob(['y']), 'video');
  assert.equal(player.range, null);
});

test('A-B range: a timeupdate event also wraps at B (background tabs get no animation frames)', async () => {
  const { video, player } = setup();
  player.setRange(20, 30);
  await player.play();
  video.currentTime = 30.2;
  video.dispatchEvent(new Event('timeupdate'));
  assert.equal(video.currentTime, 20);

  player.pause();
  video.currentTime = 40; // paused past B (e.g. scrubbed there): stays until playback resumes
  video.dispatchEvent(new Event('timeupdate'));
  assert.equal(video.currentTime, 40);
});
