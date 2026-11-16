// Pulls the AAC sound track out of a MOV / MP4 / M4A file without decoding or
// loading the video: the container is parsed, only the audio samples are read
// from the file, and each one gets an ADTS header. The result is a plain .aac
// stream that decodeAudioData accepts.
//
// Why: phone recordings are .mov files. Some browsers (Safari on iPhone) do
// not decode a .mov with decodeAudioData, and reading a few hundred MB of
// video into memory just to get its sound can crash a phone tab.
//
// Handles AAC ('mp4a') tracks in ordinary (non-fragmented) files. Anything
// else resolves to null and the caller falls back to decoding the whole file.

const MAX_MOOV_BYTES = 64 * 1024 * 1024;
const MAX_TOP_LEVEL_ATOMS = 4096;
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts']);
const TOP_LEVEL = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'uuid', 'pnot', 'meta', 'moof', 'mfra', 'sidx', 'styp', 'junk', 'prfl']);

const fourcc = (dv, at) => String.fromCharCode(dv.getUint8(at), dv.getUint8(at + 1), dv.getUint8(at + 2), dv.getUint8(at + 3));
const u64 = (dv, at) => dv.getUint32(at) * 4294967296 + dv.getUint32(at + 4);

/** Child atoms of the range [start, end) as {type, start (payload), end}. */
function children(dv, start, end) {
  const out = [];
  let at = start;
  while (at + 8 <= end) {
    let size = dv.getUint32(at);
    const type = fourcc(dv, at + 4);
    let head = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      size = u64(dv, at + 8);
      head = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < head || at + size > end) break;
    out.push({ type, start: at + head, end: at + size });
    at += size;
  }
  return out;
}

function tree(dv, start, end) {
  const node = {};
  for (const c of children(dv, start, end)) {
    if (CONTAINERS.has(c.type)) c.kids = tree(dv, c.start, c.end);
    (node[c.type] = node[c.type] || []).push(c);
  }
  return node;
}

const one = (node, type) => (node && node[type] ? node[type][0] : null);

/** AudioSpecificConfig from an 'esds' atom payload, or null. */
function decoderConfig(dv, start, end) {
  let at = start + 4; // version and flags
  const readLen = () => {
    let len = 0;
    for (let i = 0; i < 4 && at < end; i++) {
      const b = dv.getUint8(at++);
      len = (len << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return len;
  };
  if (at >= end || dv.getUint8(at++) !== 0x03) return null; // ES_Descriptor
  readLen();
  if (at + 3 > end) return null;
  const flags = dv.getUint8(at + 2);
  at += 3;
  if (flags & 0x80) at += 2;
  if (flags & 0x40) at += 1 + (at < end ? dv.getUint8(at) : 0);
  if (flags & 0x20) at += 2;
  if (at >= end || dv.getUint8(at++) !== 0x04) return null; // DecoderConfigDescriptor
  readLen();
  if (at + 13 > end) return null;
  const objectType = dv.getUint8(at);
  at += 13;
  if (objectType !== 0x40 && objectType !== 0x67) return null; // MPEG-4 AAC, MPEG-2 AAC LC
  if (at >= end || dv.getUint8(at++) !== 0x05) return null; // DecoderSpecificInfo
  const len = readLen();
  if (len < 2 || at + len > end) return null;
  return new Uint8Array(dv.buffer, dv.byteOffset + at, len);
}

/** {profile, freqIndex, channels} for the ADTS header from an AudioSpecificConfig, or null. */
export function adtsParams(asc) {
  if (!asc || asc.length < 2) return null;
  let pos = 0;
  const bits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) {
      const byte = asc[pos >> 3];
      if (byte === undefined) return -1;
      v = (v << 1) | ((byte >> (7 - (pos & 7))) & 1);
    }
    return v;
  };
  let aot = bits(5);
  const freqIndex = bits(4);
  if (freqIndex < 0 || freqIndex > 12) return null; // 15 = explicit rate, not expressible in ADTS
  const channels = bits(4);
  if (aot === 5 || aot === 29) { // HE-AAC signalled explicitly: the core layer follows
    const ext = bits(4);
    if (ext === 15) bits(24);
    aot = bits(5);
  }
  if (aot < 1 || aot > 4 || channels < 1 || channels > 7) return null;
  return { profile: aot - 1, freqIndex, channels };
}

/** Writes the 7 byte ADTS header for a sample of `size` bytes at `out[at]`. */
export function writeAdtsHeader(out, at, size, { profile, freqIndex, channels }) {
  const len = size + 7;
  out[at] = 0xff;
  out[at + 1] = 0xf1;
  out[at + 2] = (profile << 6) | (freqIndex << 2) | (channels >> 2);
  out[at + 3] = ((channels & 3) << 6) | (len >> 11);
  out[at + 4] = (len >> 3) & 0xff;
  out[at + 5] = ((len & 7) << 5) | 0x1f;
  out[at + 6] = 0xfc;
}

/**
 * Reads the sample tables of the first AAC track in a 'moov' atom payload.
 * @param {ArrayBuffer|Uint8Array} moov
 * @returns {?{params: object, sizes: number[], chunks: {offset: number, first: number, count: number}[], trimSec: number}}
 */
export function parseMoov(moov) {
  const bytes = moov instanceof Uint8Array ? moov : new Uint8Array(moov);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const root = tree(dv, 0, dv.byteLength);
  if (root.mvex) return null; // fragmented: samples are described elsewhere
  for (const trak of root.trak || []) {
    try {
      const track = parseTrack(dv, trak.kids);
      if (track) return track;
    } catch {
      // a damaged table: try the next track
    }
  }
  return null;
}

function parseTrack(dv, trak) {
  const mdia = one(trak, 'mdia');
  const hdlr = mdia && one(mdia.kids, 'hdlr');
  if (!hdlr || fourcc(dv, hdlr.start + 8) !== 'soun') return null;
  const stbl = one(one(mdia.kids, 'minf')?.kids, 'stbl')?.kids;
  const stsd = one(stbl, 'stsd');
  const stsz = one(stbl, 'stsz');
  const stsc = one(stbl, 'stsc');
  const stco = one(stbl, 'stco');
  const co64 = one(stbl, 'co64');
  if (!stsd || !stsz || !stsc || !(stco || co64)) return null;
  if (fourcc(dv, stsd.start + 12) !== 'mp4a') return null;

  // The 'esds' atom sits at a different depth in MP4 and in the QuickTime
  // sound description versions, so it is located by its name.
  let params = null;
  for (let at = stsd.start + 16; at + 8 <= stsd.end; at++) {
    if (dv.getUint8(at) !== 0x65 || fourcc(dv, at) !== 'esds') continue;
    const size = dv.getUint32(at - 4);
    if (size < 12 || at - 4 + size > stsd.end) continue;
    params = adtsParams(decoderConfig(dv, at + 4, at - 4 + size));
    if (params) break;
  }
  if (!params) return null;

  const fixed = dv.getUint32(stsz.start + 4);
  const total = dv.getUint32(stsz.start + 8);
  if (!total || (!fixed && stsz.start + 12 + total * 4 > stsz.end)) return null;
  const sizes = new Array(total);
  for (let i = 0; i < total; i++) {
    const s = fixed || dv.getUint32(stsz.start + 12 + i * 4);
    if (s > 8184) return null; // does not fit an ADTS frame
    sizes[i] = s;
  }

  const offsets = [];
  const table = stco || co64;
  const n = dv.getUint32(table.start + 4);
  if (table.start + 8 + n * (stco ? 4 : 8) > table.end) return null;
  for (let i = 0; i < n; i++) offsets.push(stco ? dv.getUint32(table.start + 8 + i * 4) : u64(dv, table.start + 8 + i * 8));

  const runs = [];
  const runCount = dv.getUint32(stsc.start + 4);
  if (!runCount || stsc.start + 8 + runCount * 12 > stsc.end) return null;
  for (let i = 0; i < runCount; i++) {
    runs.push({ firstChunk: dv.getUint32(stsc.start + 8 + i * 12), perChunk: dv.getUint32(stsc.start + 12 + i * 12) });
  }

  const chunks = [];
  let sample = 0;
  let run = 0;
  for (let c = 0; c < offsets.length && sample < total; c++) {
    while (run + 1 < runs.length && c + 1 >= runs[run + 1].firstChunk) run++;
    const count = Math.min(runs[run].perChunk, total - sample);
    if (count > 0) chunks.push({ offset: offsets[c], first: sample, count });
    sample += count;
  }
  if (sample !== total) return null;

  // Samples to drop from the start (encoder priming), from the edit list.
  let trimSec = 0;
  const mdhd = one(mdia.kids, 'mdhd');
  const elst = one(one(trak, 'edts')?.kids, 'elst');
  if (mdhd && elst) {
    const timescale = dv.getUint32(mdhd.start + (dv.getUint8(mdhd.start) === 1 ? 20 : 12));
    const v1 = dv.getUint8(elst.start) === 1;
    const entries = dv.getUint32(elst.start + 4);
    const step = v1 ? 20 : 12;
    for (let i = 0; i < entries && elst.start + 8 + (i + 1) * step <= elst.end; i++) {
      const at = elst.start + 8 + i * step;
      const mediaTime = v1 ? (dv.getInt32(at + 8) < 0 ? -1 : u64(dv, at + 8)) : dv.getInt32(at + 4);
      if (mediaTime < 0) continue; // an empty edit
      if (timescale > 0) trimSec = Math.min(0.25, mediaTime / timescale);
      break;
    }
  }
  return { params, sizes, chunks, trimSec };
}

/** Finds the 'moov' atom of a file and returns its payload, or null. */
async function readMoov(file) {
  let at = 0;
  for (let i = 0; i < MAX_TOP_LEVEL_ATOMS && at + 8 <= file.size; i++) {
    const head = new DataView(await file.slice(at, at + 16).arrayBuffer());
    if (head.byteLength < 8) return null;
    let size = head.getUint32(0);
    const type = fourcc(head, 4);
    let skip = 8;
    if (!TOP_LEVEL.has(type)) return null; // not a MOV / MP4 file
    if (size === 1) {
      if (head.byteLength < 16) return null;
      size = u64(head, 8);
      skip = 16;
    } else if (size === 0) {
      size = file.size - at;
    }
    if (size < skip) return null;
    if (type === 'moov') {
      if (size > MAX_MOOV_BYTES || at + size > file.size) return null;
      return file.slice(at + skip, at + size).arrayBuffer();
    }
    at += size;
  }
  return null;
}

/**
 * @param {Blob} file a MOV / MP4 / M4A file
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<?{data: Uint8Array, trimSec: number}>} the sound track as
 *   ADTS AAC and how many seconds to drop from its start once decoded, or null
 *   when the file is not one this module handles
 */
export async function extractAacAudio(file, { signal } = {}) {
  try {
    const moov = await readMoov(file);
    if (!moov) return null;
    const track = parseMoov(moov);
    if (!track) return null;
    const { params, sizes, chunks, trimSec } = track;
    let bytes = 0;
    for (const s of sizes) bytes += s + 7;
    const out = new Uint8Array(bytes);
    let pos = 0;
    for (const chunk of chunks) {
      if (signal && signal.aborted) return null;
      let len = 0;
      for (let i = 0; i < chunk.count; i++) len += sizes[chunk.first + i];
      if (chunk.offset + len > file.size) return null;
      const data = new Uint8Array(await file.slice(chunk.offset, chunk.offset + len).arrayBuffer());
      let from = 0;
      for (let i = 0; i < chunk.count; i++) {
        const size = sizes[chunk.first + i];
        writeAdtsHeader(out, pos, size, params);
        out.set(data.subarray(from, from + size), pos + 7);
        pos += size + 7;
        from += size;
      }
    }
    return { data: out, trimSec };
  } catch {
    return null;
  }
}
