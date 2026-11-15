import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openStore, newKey, keysToPrune, DB_NAME, DB_VERSION, STORED_FILE_LIMIT, STORED_STEM_LIMITS,
} from '../public/js/store.js';

// A small in-memory stand-in for the parts of IndexedDB that store.js uses:
// open + onupgradeneeded, transactions over object stores with a keyPath, and
// get / getAll / getAllKeys / put / delete requests that answer asynchronously.
function fakeIndexedDB({ failOpen = false, failPut = false } = {}) {
  const databases = new Map();
  const later = (fn) => setTimeout(fn, 0);
  function makeDb() {
    const stores = new Map();
    return {
      stores,
      objectStoreNames: { contains: (n) => stores.has(n) },
      createObjectStore(name, { keyPath }) { stores.set(name, { keyPath, rows: new Map() }); },
      transaction(names) {
        const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
        let pending = 0;
        let failed = false;
        const settle = () => later(() => {
          if (pending || failed) return;
          if (tx.oncomplete) tx.oncomplete();
        });
        const req = (run) => {
          const r = { onsuccess: null, onerror: null, result: undefined, error: null };
          pending++;
          later(() => {
            try {
              r.result = run();
              if (r.onsuccess) r.onsuccess();
            } catch (err) {
              failed = true;
              r.error = err;
              tx.error = err;
              if (r.onerror) r.onerror();
              if (tx.onabort) tx.onabort();
            }
            pending--;
            settle();
          });
          return r;
        };
        for (const n of [].concat(names)) assert.ok(stores.has(n), `unknown store ${n}`);
        tx.objectStore = (name) => {
          const os = stores.get(name);
          return {
            get: (key) => req(() => structuredClone(os.rows.get(key))),
            getAll: () => req(() => [...os.rows.values()].map((v) => structuredClone(v))),
            getAllKeys: () => req(() => [...os.rows.keys()]),
            put: (value) => req(() => {
              if (failPut) throw new Error('QuotaExceededError');
              os.rows.set(value[os.keyPath], structuredClone(value));
            }),
            delete: (key) => req(() => { os.rows.delete(key); }),
          };
        };
        settle();
        return tx;
      },
    };
  }
  return {
    databases,
    open(name, version) {
      const r = { onsuccess: null, onerror: null, onupgradeneeded: null, result: undefined, error: null };
      later(() => {
        if (failOpen) { r.error = new Error('blocked'); if (r.onerror) r.onerror(); return; }
        const fresh = !databases.has(name);
        if (fresh) databases.set(name, { db: makeDb(), version });
        r.result = databases.get(name).db;
        if (fresh && r.onupgradeneeded) r.onupgradeneeded();
        if (r.onsuccess) r.onsuccess();
      });
      return r;
    },
  };
}

const file = (key, usedAt, extra = {}) => ({ key, name: `${key}.mp3`, kind: 'audio', duration: 10, file: new Uint8Array([1, 2, 3]), usedAt, ...extra });

test('openStore: no IndexedDB, or one that refuses to open, gives null', async () => {
  assert.equal(await openStore(undefined), null);
  assert.equal(await openStore({}), null);
  assert.equal(await openStore(fakeIndexedDB({ failOpen: true })), null);
});

test('openStore creates the two object stores under the documented name and version', async () => {
  const idb = fakeIndexedDB();
  await openStore(idb);
  const rec = idb.databases.get(DB_NAME);
  assert.equal(rec.version, DB_VERSION);
  assert.deepEqual([...rec.db.stores.keys()].sort(), ['files', 'stems']);
});

test('files: listed most recently used first; patch changes only the named fields; patching a missing file adds nothing', async () => {
  const s = await openStore(fakeIndexedDB());
  await s.putFile(file('a', 100));
  await s.putFile(file('b', 300));
  await s.putFile(file('c', 200));
  assert.deepEqual((await s.listFiles()).map((f) => f.key), ['b', 'c', 'a']);

  await s.patchFile('a', { usedAt: 999, range: { a: 1, b: 2 } });
  const [first] = await s.listFiles();
  assert.equal(first.key, 'a');
  assert.deepEqual(first.range, { a: 1, b: 2 });
  assert.equal(first.name, 'a.mp3');
  assert.deepEqual([...first.file], [1, 2, 3]);

  await s.patchFile('nope', { usedAt: 1 });
  assert.equal((await s.listFiles()).length, 3);
});

test('stems: stored, read back, patched with Vis_Data, and removed together with their file', async () => {
  const s = await openStore(fakeIndexedDB());
  await s.putFile(file('a', 1));
  await s.putFile(file('b', 2));
  const analysis = { duration: 10, sampleRate: 44100, channels: 2, bpm: 112, engine: 'dsp' };
  await s.putStems({ key: 'a', blobs: { vocal: new Uint8Array([9]), drums: new Uint8Array([8]) }, analysis, vis: null });
  await s.putStems({ key: 'b', blobs: { vocal: new Uint8Array([7]) }, analysis, vis: null });
  assert.deepEqual((await s.stemKeys()).sort(), ['a', 'b']);

  const vis = { version: 2, frames: 3, stems: { vocal: { env: new Uint8Array([1, 2, 3]), onsets: null } }, beat: { period: 0.5, phase: 0.25 } };
  await s.patchStems('a', { vis });
  const got = await s.getStems('a');
  assert.deepEqual(Object.keys(got.blobs).sort(), ['drums', 'vocal']);
  assert.deepEqual(got.analysis, analysis);
  assert.deepEqual(got.vis.beat, { period: 0.5, phase: 0.25 });
  assert.ok(got.vis.stems.vocal.env instanceof Uint8Array, 'typed arrays survive');

  await s.patchStems('missing', { vis });
  assert.equal(await s.getStems('missing'), undefined);

  await s.deleteStems('b');
  assert.deepEqual(await s.stemKeys(), ['a']);
  assert.equal((await s.listFiles()).length, 2, 'deleting stems keeps the file');

  await s.deleteFile('a');
  assert.deepEqual(await s.stemKeys(), []);
  assert.deepEqual((await s.listFiles()).map((f) => f.key), ['b']);
});

test('a failed write rejects, so the caller can tell nothing was saved', async () => {
  const s = await openStore(fakeIndexedDB({ failPut: true }));
  await assert.rejects(s.putFile(file('a', 1)));
  assert.deepEqual(await s.listFiles(), []);
});

test('keysToPrune drops the least recently used beyond the limit and never the kept key', () => {
  const items = [{ key: 'a', usedAt: 1 }, { key: 'b', usedAt: 5 }, { key: 'c', usedAt: 3 }, { key: 'd' }];
  assert.deepEqual(keysToPrune(items, 4), []);
  assert.deepEqual(keysToPrune(items, 2), ['a', 'd']);
  assert.deepEqual(keysToPrune(items, 2, 'd'), ['c', 'a']);
  assert.deepEqual(keysToPrune(items, 1, 'a'), ['b', 'c', 'd']);
  assert.deepEqual(keysToPrune([], 3, 'x'), []);
  assert.deepEqual(items.map((i) => i.key), ['a', 'b', 'c', 'd'], 'input order untouched');
});

test('keysToPrune (property): the result plus what is kept is the input, the kept ones are the most recent', () => {
  let seed = 12345;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let run = 0; run < 200; run++) {
    const n = Math.floor(rng() * 12);
    const items = Array.from({ length: n }, (_, i) => ({ key: `k${i}`, usedAt: Math.floor(rng() * 50) }));
    const limit = 1 + Math.floor(rng() * 6);
    const keep = n && rng() < 0.5 ? items[Math.floor(rng() * n)].key : undefined;
    const dropped = keysToPrune(items, limit, keep);
    const kept = items.filter((i) => !dropped.includes(i.key));
    assert.equal(new Set(dropped).size, dropped.length);
    assert.equal(kept.length, Math.min(n, limit));
    if (keep) assert.ok(!dropped.includes(keep));
    const oldestKept = Math.min(...kept.filter((i) => i.key !== keep).map((i) => i.usedAt), Infinity);
    for (const key of dropped) assert.ok(items.find((i) => i.key === key).usedAt <= oldestKept);
  }
});

test('newKey sorts by time and differs for the same instant; limits are sane', () => {
  assert.ok(newKey(1000, 0.1) < newKey(2000, 0.1));
  assert.notEqual(newKey(1000, 0.1), newKey(1000, 0.2));
  assert.match(newKey(), /^\d{14}-[0-9a-z]+$/);
  assert.ok(STORED_FILE_LIMIT >= STORED_STEM_LIMITS.desktop);
  assert.ok(STORED_STEM_LIMITS.desktop >= STORED_STEM_LIMITS.mobile && STORED_STEM_LIMITS.mobile >= 1);
});
