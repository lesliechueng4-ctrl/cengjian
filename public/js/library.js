// 音乐台 bookkeeping that does not need the DOM: the per-entry stem cache and
// reading a file's duration from its media element before any decoding.
// Kept separate from app.js so it can be tested in Node.

/**
 * How many entries may hold separated stems at once, counting the entry being
 * opened. A 3 minute song holds about 250 MB of WAV blobs and separation peaks
 * at about 800 MB, so phones keep only one other song.
 */
export const STEM_CACHE_LIMITS = { mobile: 2, desktop: 3 };

/**
 * Drop stem caches so that, once `current` gets its own cache, at most
 * `STEM_CACHE_LIMITS[mobile ? 'mobile' : 'desktop']` entries hold one. The
 * least recently used entries (smallest `lastUsed`) go first. Call this before
 * starting a separation so freed blobs are not alive during its memory peak.
 *
 * @param {Array<{cache: ?{urls: Object<string,string>}, lastUsed: number}>} entries
 * @param {object} current entry being opened; its cache is never dropped
 * @param {{mobile: boolean, revoke: (url: string) => void}} opts
 * @returns {object[]} entries whose cache was dropped
 */
export function evictStemCaches(entries, current, { mobile, revoke }) {
  const limit = mobile ? STEM_CACHE_LIMITS.mobile : STEM_CACHE_LIMITS.desktop;
  const others = entries
    .filter((e) => e.cache && e !== current)
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  const evicted = others.slice(Math.max(0, limit - 1));
  for (const e of evicted) {
    for (const u of Object.values(e.cache.urls)) revoke(u);
    e.cache = null;
  }
  return evicted;
}

/**
 * Resolve with the media element's duration in seconds once metadata is
 * loaded, or 0 if it stays unknown (error, timeout, or a container that
 * reports Infinity/NaN). Never rejects.
 *
 * @param {{duration: number, addEventListener: Function, removeEventListener: Function}} media
 * @param {{timeout?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<number>}
 */
export function waitForDuration(media, { timeout = 3000, signal } = {}) {
  const known = () => {
    const d = media ? media.duration : NaN;
    return Number.isFinite(d) && d > 0 ? d : 0;
  };
  if (!media || known() || (signal && signal.aborted)) return Promise.resolve(known());
  return new Promise((resolve) => {
    let timer = null;
    const events = ['loadedmetadata', 'durationchange', 'error'];
    const finish = () => {
      clearTimeout(timer);
      for (const ev of events) media.removeEventListener(ev, onEvent);
      if (signal) signal.removeEventListener('abort', finish);
      resolve(known());
    };
    const onEvent = (e) => {
      if (e.type === 'error' || known()) finish();
    };
    for (const ev of events) media.addEventListener(ev, onEvent);
    if (signal) signal.addEventListener('abort', finish);
    timer = setTimeout(finish, timeout);
  });
}
