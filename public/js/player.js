// Keeps the picture (or original audio) and the selected stem in sync.
//
// The original media element (video, or audio for audio-only uploads) is the
// master clock and also plays the 原曲 stem. Every other stem is its own
// <audio> element with preservesPitch enabled. Only the selected stem plays;
// it follows the master's position, rate, play and pause, and a
// requestAnimationFrame loop corrects drift.

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];
// Drift handling: small drift is pulled back by nudging the stem's playbackRate
// (pitch is preserved, so this is inaudible); only large drift hard-seeks, since
// every seek on an <audio> element causes a short gap.
export const DRIFT = {
  seekLimit: 0.25, // seconds; above this the stem is re-seeked
  nudgeStart: 0.04, // start nudging above this drift
  nudgeStop: 0.01, // back to the exact rate below this drift
  nudge: 0.05, // relative rate change while nudging (5%)
  seekCooldownMs: 400,
  // A seek is not instant: on phones the stem comes back a few tenths of a second late,
  // which is past seekLimit again, so re-seeking never ends and each seek is a gap of
  // silence (measured on an iPhone: about two seeks a second, forever). After stormSeeks
  // seeks that each came within stormMs of the one before, the player goes gentle for
  // good (iPhones and iPads start that way): the stem is the clock, nothing touches it
  // while it plays, and the muted picture follows it instead. Changing the stem's rate
  // is no way out there either (measured: every rate change stalls the sound for about
  // 0.7 s). What the muted picture can do, also measured on an iPhone: playing slower
  // works, playing faster does not (asked for 1.25x, it ran at 1.01x). So a picture that
  // is ahead waits. A jump of the picture is a visible freeze, so it is the last resort:
  // only for a picture clearly behind (or far ahead), aimed a little ahead of the sound
  // because it lands late, and never twice within gentleCooldownMs. (An earlier version
  // jumped for small gaps and aimed further each time; on the phone that became a jump
  // every three seconds.)
  stormMs: 1500,
  stormSeeks: 3,
  gentleCooldownMs: 6000, // between two jumps of the picture
  followStart: 0.08, // seconds the picture is ahead before it starts waiting
  followStop: 0.05, // ... and where it stops; the change of rate itself costs it a few hundredths
  followSlow: 0.08, // the picture runs this much slower for a small gap
  followFast: 0.25, // ... and this much for a gap above seekLimit
  pictureBehind: 0.3, // seconds; a picture later than this jumps (a smaller lag is left alone)
  pictureAhead: 2, // seconds; a picture further ahead than this jumps back instead of waiting
  pictureLead: 0.3, // seconds ahead of the sound a jump aims for
};

function isAppleTouch() {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent || '')
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPad asking for desktop sites
}
const SEEK_SYNC_LIMIT = 0.08;
// A-B range loop: shortest allowed range, and how far before the natural end B may sit
// (the same margin the whole-song loop uses, so the stem never runs out first).
export const RANGE_MIN_SEC = 0.2;
const END_MARGIN = 0.06;

function keepPitch(el) {
  el.preservesPitch = true;
  el.mozPreservesPitch = true;
  el.webkitPreservesPitch = true;
}

export class SyncPlayer {
  /**
   * @param {{video: HTMLVideoElement, audio: HTMLAudioElement, onUpdate?: () => void, gentle?: boolean}} opts
   */
  constructor({ video, audio, onUpdate, gentle = isAppleTouch() }) {
    this.video = video;
    this.audio = audio;
    this.onUpdate = onUpdate || (() => {});
    this.master = null;
    this.stems = {};
    this.activeId = 'original';
    this.rate = 1;
    this.loop = false;
    this.range = null; // { a, b } in seconds while an A-B range loops
    this.url = null;
    this.lastCorrection = -Infinity;
    this.gentle = !!gentle; // see DRIFT.stormMs
    this.follow = 0; // gentle mode: relative rate change applied to the master (0 = exact rate)
    this.storm = 0; // hard seeks in a row that came soon after the previous one
    this.switchToken = 0;
    this.nudge = 0; // -1 slowing the stem, 0 exact rate, 1 speeding it up
    [video, audio].forEach((el) => {
      keepPitch(el);
      el.addEventListener('play', () => this.handleMasterPlay(el));
      el.addEventListener('pause', () => this.handleMasterPause(el));
      el.addEventListener('ended', () => this.handleEnded(el));
      el.addEventListener('seeked', () => this.handleSeeked(el));
      el.addEventListener('loadedmetadata', () => this.onUpdate());
      // Also checks the A-B range here: timeupdate keeps firing in a background tab, where
      // requestAnimationFrame (tick) is paused.
      el.addEventListener('timeupdate', () => { if (el === this.master && !el.paused) this.wrapRange(); this.onUpdate(); });
      el.addEventListener('ratechange', () => this.onUpdate());
    });
    this.tick = this.tick.bind(this);
    requestAnimationFrame(this.tick);
  }

  /** Load a File (video or audio). Stems are added later with setStems(). */
  load(file, kind) {
    this.clearStems();
    if (this.master) {
      this.master.pause();
      this.master.removeAttribute('src');
      this.master.load();
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(file);
    this.master = kind === 'video' ? this.video : this.audio;
    this.master.muted = false;
    this.master.loop = false;
    this.master.src = this.url;
    this.master.playbackRate = this.rate;
    this.master.defaultPlaybackRate = this.rate;
    keepPitch(this.master);
    this.master.load();
    this.activeId = 'original';
    this.range = null;
    this.onUpdate();
  }

  /** @param {Record<string,string>} urls stem id to Blob URL */
  setStems(urls) {
    this.clearStems();
    for (const [id, url] of Object.entries(urls)) {
      const el = new Audio();
      el.preload = 'auto';
      keepPitch(el);
      el.src = url;
      el.muted = true;
      el.playbackRate = this.rate;
      el.defaultPlaybackRate = this.rate;
      el.load();
      this.stems[id] = el;
    }
  }

  /** Detach stem elements. Blob URLs belong to the caller (app.js caches them per file). */
  clearStems() {
    for (const el of Object.values(this.stems)) {
      el.pause();
      el.removeAttribute('src');
      el.load();
    }
    this.nudge = 0;
    this.setFollow(this.master, 0);
    this.stems = {};
    if (this.master) this.master.muted = false;
    this.activeId = 'original';
  }

  get hasStems() { return Object.keys(this.stems).length > 0; }
  get paused() { return !this.master || this.master.paused; }
  get currentTime() { return this.master ? this.master.currentTime || 0 : 0; }
  get duration() {
    const d = this.master ? this.master.duration : NaN;
    return Number.isFinite(d) ? d : 0;
  }

  activeStem() {
    return this.activeId === 'original' ? null : this.stems[this.activeId] || null;
  }

  /** Switch the audible stem without moving the playback position. */
  select(id) {
    if (!this.master) return;
    if (id !== 'original' && !this.stems[id]) return;
    const prev = this.activeStem();
    this.activeId = id;
    const token = ++this.switchToken;
    const next = this.activeStem();
    if (prev && this.nudge) prev.playbackRate = this.rate;
    this.nudge = 0;
    this.setFollow(this.master, 0);
    if (!next) {
      this.master.muted = false;
      if (prev) { prev.muted = true; prev.pause(); }
      this.onUpdate();
      return;
    }
    next.playbackRate = this.rate;
    // Gentle mode: the stem that was sounding is the clock, the picture may be a little off it.
    next.currentTime = (this.gentle && prev && !prev.paused ? prev : this.master).currentTime;
    next.muted = false;
    // Keep the previous sound until the new stem is actually playing, so switching is gapless.
    const finish = () => {
      if (token !== this.switchToken) return;
      if (prev && prev !== next) { prev.muted = true; prev.pause(); }
      this.master.muted = true;
    };
    if (this.master.paused) {
      finish();
    } else {
      const p = next.play();
      if (p && p.then) p.then(finish, finish); else finish();
    }
    this.onUpdate();
  }

  async play() {
    if (!this.master) return;
    const stem = this.activeStem();
    if (stem) this.alignStem(stem);
    const jobs = [this.master.play()];
    if (stem) jobs.push(stem.play());
    try { await Promise.all(jobs); } catch { /* autoplay refusal: wait for the next tap */ }
    this.onUpdate();
  }

  pause() {
    if (!this.master) return;
    this.master.pause();
    const stem = this.activeStem();
    if (stem) stem.pause();
    this.onUpdate();
  }

  /** Before starting: put the stem where the master is. Gentle mode skips a small gap (a seek is a hiccup there). */
  alignStem(stem) {
    const t = this.master.currentTime;
    if (!this.gentle || Math.abs(stem.currentTime - t) > DRIFT.seekLimit) stem.currentTime = t;
  }

  /** The position that counts for looping: the sound's, where the picture only follows it. */
  clock() {
    const stem = this.activeStem();
    if (this.gentle && stem && !stem.paused && !stem.seeking && !stem.ended) return stem.currentTime;
    return this.master.currentTime;
  }

  toggle() {
    if (this.paused) return this.play();
    this.pause();
    return Promise.resolve();
  }

  seek(t) {
    if (!this.master) return;
    const d = this.duration;
    const time = Math.max(0, d ? Math.min(t, d - 0.01) : t);
    this.master.currentTime = time;
    const stem = this.activeStem();
    if (stem) stem.currentTime = time;
    this.onUpdate();
  }

  setRate(rate) {
    this.rate = rate;
    this.nudge = 0;
    this.follow = 0;
    const els = [this.video, this.audio, ...Object.values(this.stems)];
    for (const el of els) { el.playbackRate = rate; el.defaultPlaybackRate = rate; keepPitch(el); }
    this.onUpdate();
  }

  setLoop(on) {
    this.loop = !!on;
    this.onUpdate();
  }

  /**
   * Loop between two times (either order). setRange(null) clears it. The range
   * loops whether or not whole-song loop is on. Returns false, changing nothing,
   * when the range is shorter than RANGE_MIN_SEC or a time is not a number.
   */
  setRange(a, b) {
    if (a == null) {
      this.range = null;
      this.onUpdate();
      return true;
    }
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    const d = this.duration;
    const top = d ? Math.max(0, d - END_MARGIN) : Infinity;
    const lo = Math.max(0, Math.min(a, b, top));
    const hi = Math.min(Math.max(a, b), top);
    if (hi - lo < RANGE_MIN_SEC) return false;
    this.range = { a: lo, b: hi };
    this.onUpdate();
    return true;
  }

  /** Jumps back to A once playback has reached B. Returns true if it jumped. */
  wrapRange() {
    const r = this.range;
    if (!r || !this.master || this.clock() < r.b) return false;
    this.seek(r.a);
    return true;
  }

  handleMasterPlay(el) {
    if (el !== this.master) return;
    const stem = this.activeStem();
    if (stem && stem.paused) {
      this.alignStem(stem);
      stem.play().catch(() => {});
    }
    this.onUpdate();
  }

  handleMasterPause(el) {
    if (el !== this.master) return;
    const stem = this.activeStem();
    if (stem && !stem.paused) stem.pause();
    this.onUpdate();
  }

  handleSeeked(el) {
    if (el !== this.master) return;
    // Gentle mode, playing: seek() has already moved the stem, and a jump of the picture
    // alone (followStem) must not drag the sound along.
    if (this.gentle && !el.paused) return;
    const stem = this.activeStem();
    if (stem && Math.abs(stem.currentTime - el.currentTime) > SEEK_SYNC_LIMIT) stem.currentTime = el.currentTime;
  }

  handleEnded(el) {
    if (el !== this.master) return;
    if (this.range || this.loop) {
      this.seek(this.range ? this.range.a : 0);
      this.play();
    } else {
      const stem = this.activeStem();
      if (stem) stem.pause();
      this.onUpdate();
    }
  }

  tick(now) {
    requestAnimationFrame(this.tick);
    const m = this.master;
    if (!m || m.paused) return;
    const d = this.duration;
    if (this.wrapRange()) return;
    // Loop slightly before the natural end so the stem never runs out first.
    if (this.loop && d && this.clock() >= d - 0.06) {
      this.seek(0);
      return;
    }
    const stem = this.activeStem();
    if (stem && !stem.seeking) {
      const drift = stem.currentTime - m.currentTime; // > 0: stem is ahead
      const abs = Math.abs(drift);
      if (this.gentle) {
        this.followStem(m, stem, drift, now);
      } else if (abs > DRIFT.seekLimit) {
        if (now - this.lastCorrection > DRIFT.seekCooldownMs) {
          this.setNudge(stem, 0);
          if (now - this.lastCorrection < DRIFT.stormMs) {
            if (++this.storm >= DRIFT.stormSeeks) this.gentle = true;
          } else {
            this.storm = 0;
          }
          stem.currentTime = m.currentTime;
          this.lastCorrection = now;
        }
      } else if (abs > DRIFT.nudgeStart) {
        this.setNudge(stem, drift > 0 ? -1 : 1);
      } else if (abs < DRIFT.nudgeStop) {
        this.setNudge(stem, 0);
      }
      if (stem.paused && !stem.ended) stem.play().catch(() => {});
    }
    this.onUpdate();
  }

  /** Gentle mode: the stem plays untouched; the muted picture is brought to it. drift > 0: the picture is behind. */
  followStem(m, stem, drift, now) {
    if (m.seeking) return;
    if (drift > DRIFT.pictureBehind || drift < -DRIFT.pictureAhead) {
      this.setFollow(m, 0);
      if (now - this.lastCorrection < DRIFT.gentleCooldownMs) return;
      const d = this.duration;
      const target = stem.currentTime + DRIFT.pictureLead;
      m.currentTime = d ? Math.max(0, Math.min(target, d - 0.1)) : target;
      this.lastCorrection = now;
    } else if (drift < -DRIFT.seekLimit) {
      this.setFollow(m, -DRIFT.followFast);
    } else if (drift < -DRIFT.followStart) {
      // Coming down from the fast rate, stay on it until followStop: one change of rate fewer.
      if (!this.follow) this.setFollow(m, -DRIFT.followSlow);
    } else if (drift > -DRIFT.followStop) {
      this.setFollow(m, 0);
    }
  }

  setNudge(stem, dir) {
    if (dir === this.nudge) return;
    this.nudge = dir;
    stem.playbackRate = this.rate * (1 + dir * DRIFT.nudge);
    keepPitch(stem);
  }

  /** Gentle mode: run the (muted) master a little faster or slower so it meets the stem. */
  setFollow(master, f) {
    if (f === this.follow || !master) return;
    this.follow = f;
    master.playbackRate = this.rate * (1 + f);
    keepPitch(master);
  }
}
