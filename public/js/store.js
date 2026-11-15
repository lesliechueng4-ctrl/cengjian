// Keeps 音乐台 across page reloads: the uploaded files and the separated stems
// live in the browser's IndexedDB on this device. Nothing here touches the DOM
// or the network. Every call is best effort: callers treat a rejection (no
// IndexedDB, private mode, quota exceeded) as "not saved".
//
// Two object stores, both keyed by the entry's `key` string:
//   files: { key, name, kind, duration, file: Blob, usedAt, range? }
//   stems: { key, blobs: { stemId: Blob }, analysis, vis }

export const DB_NAME = 'cengjian';
export const DB_VERSION = 1;
/** How many files 音乐台 remembers (the least recently used go first). */
export const STORED_FILE_LIMIT = 12;
/** How many files keep their separated stems on disk (about 250 MB per 3 minute song). */
export const STORED_STEM_LIMITS = { mobile: 2, desktop: 5 };

const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
});

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
  tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
});

/** A key that sorts by creation time and does not collide within one device. */
export function newKey(now = Date.now(), random = Math.random()) {
  return `${String(Math.floor(now)).padStart(14, '0')}-${Math.floor(random * 1e9).toString(36)}`;
}

/**
 * Which stored entries to drop so that at most `limit` remain: the least
 * recently used (smallest `usedAt`), never `keep`.
 * @param {Array<{key: string, usedAt?: number}>} items
 * @param {number} limit
 * @param {string} [keep] key that is never dropped
 * @returns {string[]} keys to drop
 */
export function keysToPrune(items, limit, keep) {
  const sorted = [...items].sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
  const kept = sorted.filter((it) => it.key === keep);
  const out = [];
  for (const it of sorted) {
    if (it.key === keep) continue;
    if (kept.length < limit) kept.push(it);
    else out.push(it.key);
  }
  return out;
}

/**
 * Opens the database. Resolves to null when IndexedDB is missing or refuses to
 * open, so callers can simply skip saving.
 * @param {IDBFactory} [idb]
 */
export async function openStore(idb = globalThis.indexedDB) {
  if (!idb || typeof idb.open !== 'function') return null;
  let db;
  try {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'key' });
      if (!d.objectStoreNames.contains('stems')) d.createObjectStore('stems', { keyPath: 'key' });
    };
    db = await request(req);
  } catch {
    return null;
  }

  const write = async (names, fn) => {
    const tx = db.transaction(names, 'readwrite');
    const finished = done(tx);
    fn(tx);
    await finished;
  };
  const read = (name, fn) => request(fn(db.transaction(name, 'readonly').objectStore(name)));
  /** Read-modify-write inside one transaction; a missing record stays missing. */
  const patch = (name, key, changes) => write(name, (tx) => {
    const os = tx.objectStore(name);
    const get = os.get(key);
    get.onsuccess = () => { if (get.result) os.put({ ...get.result, ...changes }); };
  });

  return {
    /** All remembered files, most recently used first. */
    async listFiles() {
      const all = await read('files', (os) => os.getAll());
      return all.sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
    },
    /** Keys of the files whose stems are stored. */
    stemKeys: () => read('stems', (os) => os.getAllKeys()),
    putFile: (record) => write('files', (tx) => { tx.objectStore('files').put(record); }),
    patchFile: (key, changes) => patch('files', key, changes),
    /** Removes a file together with its stems. */
    deleteFile: (key) => write(['files', 'stems'], (tx) => {
      tx.objectStore('files').delete(key);
      tx.objectStore('stems').delete(key);
    }),
    getStems: (key) => read('stems', (os) => os.get(key)),
    putStems: (record) => write('stems', (tx) => { tx.objectStore('stems').put(record); }),
    patchStems: (key, changes) => patch('stems', key, changes),
    deleteStems: (key) => write('stems', (tx) => { tx.objectStore('stems').delete(key); }),
  };
}
