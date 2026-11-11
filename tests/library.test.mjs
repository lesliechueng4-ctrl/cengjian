import test from 'node:test';
import assert from 'node:assert/strict';
import { evictStemCaches, waitForDuration, STEM_CACHE_LIMITS } from '../public/js/library.js';
import { separationLimitMessage, SEPARATION_LIMITS } from '../public/js/separator.js';

function entry(name, lastUsed, cached = true) {
  return { name, lastUsed, cache: cached ? { urls: { drums: `blob:${name}-drums`, bass: `blob:${name}-bass` } } : null };
}

test('evictStemCaches keeps the most recently used entries on desktop', () => {
  const a = entry('a', 1), b = entry('b', 2), c = entry('c', 3), d = entry('d', 4, false);
  const revoked = [];
  const evicted = evictStemCaches([d, c, b, a], d, { mobile: false, revoke: (u) => revoked.push(u) });
  // desktop keeps 3 including the one being opened, so 2 others: c and b
  assert.equal(STEM_CACHE_LIMITS.desktop, 3);
  assert.deepEqual(evicted.map((e) => e.name), ['a']);
  assert.equal(a.cache, null);
  assert.ok(b.cache && c.cache);
  assert.deepEqual(revoked.sort(), ['blob:a-bass', 'blob:a-drums']);
});

test('evictStemCaches keeps only one other entry on phones', () => {
  const a = entry('a', 1), b = entry('b', 5), c = entry('c', 3), d = entry('d', 6, false);
  const revoked = [];
  const evicted = evictStemCaches([a, b, c, d], d, { mobile: true, revoke: (u) => revoked.push(u) });
  assert.equal(STEM_CACHE_LIMITS.mobile, 2);
  assert.deepEqual(evicted.map((e) => e.name), ['c', 'a']);
  assert.ok(b.cache);
  assert.equal(revoked.length, 4);
});

test('evictStemCaches never drops the current entry and is a no-op under the limit', () => {
  const cur = entry('cur', 1), b = entry('b', 2);
  const revoked = [];
  assert.deepEqual(evictStemCaches([cur, b], cur, { mobile: true, revoke: (u) => revoked.push(u) }), []);
  assert.ok(cur.cache && b.cache);
  assert.equal(revoked.length, 0);
});

class FakeMedia extends EventTarget {
  constructor(duration = NaN) { super(); this.duration = duration; }
  fire(type) { this.dispatchEvent(new Event(type)); }
}

test('waitForDuration resolves immediately when the duration is known', async () => {
  assert.equal(await waitForDuration(new FakeMedia(42)), 42);
});

test('waitForDuration waits for loadedmetadata', async () => {
  const m = new FakeMedia();
  const p = waitForDuration(m, { timeout: 1000 });
  m.duration = Infinity;
  m.fire('durationchange'); // still unknown, keep waiting
  m.duration = 600;
  m.fire('loadedmetadata');
  assert.equal(await p, 600);
});

test('waitForDuration resolves 0 on error, timeout and abort', async () => {
  const m1 = new FakeMedia();
  const p1 = waitForDuration(m1, { timeout: 1000 });
  m1.fire('error');
  assert.equal(await p1, 0);

  assert.equal(await waitForDuration(new FakeMedia(), { timeout: 10 }), 0);

  const ac = new AbortController();
  const p3 = waitForDuration(new FakeMedia(), { timeout: 1000, signal: ac.signal });
  ac.abort();
  assert.equal(await p3, 0);
});

test('metadata duration over the phone limit is refused before reading the file', () => {
  // 10 minute phone video under the byte limit: refused by duration alone
  const bytes = 400 * 1024 * 1024;
  assert.equal(separationLimitMessage({ bytes, mobile: true }), '');
  assert.match(separationLimitMessage({ duration: 600, mobile: true }), /6 分钟/);
  // unknown metadata duration (0 passed as null) does not block; the post-decode check covers it
  assert.equal(separationLimitMessage({ duration: null, mobile: true }), '');
  assert.equal(separationLimitMessage({ duration: SEPARATION_LIMITS.mobile.seconds, mobile: true }), '');
});
