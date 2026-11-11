// Keeps the picture (or original audio) and the selected stem in sync.
//
// The original media element (video, or audio for audio-only uploads) is the
// master clock and also plays the 原曲 stem. Every other stem is its own
// <audio> element with preservesPitch enabled. Only the selected stem plays;
// it follows the master's position, rate, play and pause, and a
// requestAnimationFrame loop corrects drift.

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];
const DRIFT_LIMIT = 0.08;
const DRIFT_COOLDOWN_MS = 400;

function keepPitch(el) {
  el.preservesPitch = true;
  el.mozPreservesPitch = true;
  el.webkitPreservesPitch = true;
}

export class SyncPlayer {
  /**
   * @param {{video: HTMLVideoElement, audio: HTMLAudioElement, onUpdate?: () => void}} opts
   */
  constructor({ video, audio, onUpdate }) {
    this.video = video;
    this.audio = audio;
    this.onUpdate = onUpdate || (() => {});
    this.master = null;
    this.stems = {};
    this.activeId = 'original';
    this.rate = 1;
    this.loop = false;
    this.url = null;
    this.lastCorrection = 0;
    this.switchToken = 0;
    [video, audio].forEach((el) => {
      keepPitch(el);
      el.addEventListener('play', () => this.handleMasterPlay(el));
      el.addEventListener('pause', () => this.handleMasterPause(el));
      el.addEventListener('ended', () => this.handleEnded(el));
      el.addEventListener('seeked', () => this.handleSeeked(el));
      el.addEventListener('loadedmetadata', () => this.onUpdate());
      el.addEventListener('timeupdate', () => this.onUpdate());
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

  clearStems() {
    for (const el of Object.values(this.stems)) {
      el.pause();
      URL.revokeObjectURL(el.src);
      el.removeAttribute('src');
      el.load();
    }
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
    if (!next) {
      this.master.muted = false;
      if (prev) { prev.muted = true; prev.pause(); }
      this.onUpdate();
      return;
    }
    next.playbackRate = this.rate;
    next.currentTime = this.master.currentTime;
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
    if (stem) stem.currentTime = this.master.currentTime;
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
    const els = [this.video, this.audio, ...Object.values(this.stems)];
    for (const el of els) { el.playbackRate = rate; el.defaultPlaybackRate = rate; keepPitch(el); }
    this.onUpdate();
  }

  setLoop(on) {
    this.loop = !!on;
    this.onUpdate();
  }

  handleMasterPlay(el) {
    if (el !== this.master) return;
    const stem = this.activeStem();
    if (stem && stem.paused) {
      stem.currentTime = el.currentTime;
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
    const stem = this.activeStem();
    if (stem && Math.abs(stem.currentTime - el.currentTime) > DRIFT_LIMIT) stem.currentTime = el.currentTime;
  }

  handleEnded(el) {
    if (el !== this.master) return;
    if (this.loop) {
      this.seek(0);
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
    // Loop slightly before the natural end so the stem never runs out first.
    if (this.loop && d && m.currentTime >= d - 0.06) {
      this.seek(0);
      return;
    }
    const stem = this.activeStem();
    if (stem && !stem.seeking && now - this.lastCorrection > DRIFT_COOLDOWN_MS) {
      if (Math.abs(stem.currentTime - m.currentTime) > DRIFT_LIMIT) {
        stem.currentTime = m.currentTime;
        this.lastCorrection = now;
      }
      if (stem.paused && !stem.ended) stem.play().catch(() => {});
    }
    this.onUpdate();
  }
}
