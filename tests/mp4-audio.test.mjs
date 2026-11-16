import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAacAudio, parseMoov, adtsParams, writeAdtsHeader } from '../public/js/mp4-audio.js';

// --- a tiny MOV / MP4 writer, just enough for these tests ---
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const u32 = (...v) => { const b = new Uint8Array(v.length * 4); const dv = new DataView(b.buffer); v.forEach((x, i) => dv.setUint32(i * 4, x >>> 0)); return b; };
const str = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const atom = (type, ...payload) => { const body = cat(...payload); return cat(u32(body.length + 8), str(type), body); };

const ASC_LC_48K_STEREO = [0x11, 0x90]; // AAC LC, 48 kHz, 2 channels
function esds(asc = ASC_LC_48K_STEREO) {
  const dsi = [0x05, asc.length, ...asc];
  const dcd = [0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...dsi];
  const es = [0x03, 3 + dcd.length, 0, 1, 0, ...dcd];
  return atom('esds', u32(0), Uint8Array.from(es));
}
/** A sound sample entry; `quicktime` nests esds in a 'wave' atom like a phone .mov does. */
function mp4a({ quicktime = false, asc } = {}) {
  const head = cat(new Uint8Array(6), Uint8Array.from([0, 1]), Uint8Array.from([0, quicktime ? 1 : 0, 0, 0]), u32(0), Uint8Array.from([0, 2, 0, 16, 0, 0, 0, 0]), u32(48000 * 65536));
  return quicktime
    ? atom('mp4a', head, u32(1024, 0, 0, 2), atom('wave', atom('frma', str('mp4a')), esds(asc)))
    : atom('mp4a', head, esds(asc));
}
function soundTrack({ sizes, chunkOffsets, perChunk, quicktime, asc, primingSamples = 0, handler = 'soun', co64 = false, format }) {
  const stsd = atom('stsd', u32(0, 1), format ? atom(format, new Uint8Array(28)) : mp4a({ quicktime, asc }));
  const stsz = atom('stsz', u32(0, 0, sizes.length, ...sizes));
  const stsc = atom('stsc', u32(0, perChunk.length, ...perChunk.flatMap(([first, n]) => [first, n, 1])));
  const stco = co64 ? atom('co64', u32(0, chunkOffsets.length, ...chunkOffsets.flatMap((o) => [0, o]))) : atom('stco', u32(0, chunkOffsets.length, ...chunkOffsets));
  const mdia = atom('mdia',
    atom('mdhd', u32(0, 0, 0, 48000, 0, 0)),
    atom('hdlr', u32(0, 0), str(handler), new Uint8Array(12)),
    atom('minf', atom('stbl', stsd, stsz, stsc, stco)));
  const edts = primingSamples ? [atom('edts', atom('elst', u32(0, 1, 1000, primingSamples, 65536)))] : [];
  return atom('trak', ...edts, mdia);
}
const videoTrack = () => soundTrack({ sizes: [5], chunkOffsets: [0], perChunk: [[1, 1]], handler: 'vide' });

/** A whole file: ftyp, mdat (video bytes mixed with the sound samples), moov at the end like a phone recording. */
function movFile(samples, opts = {}) {
  const ftyp = atom('ftyp', str('qt  '), u32(0));
  const mdatStart = ftyp.length + 8;
  const parts = [];
  const chunkOffsets = [];
  let at = mdatStart;
  for (let i = 0; i < samples.length; i += 2) { // two samples per chunk, video filler between chunks
    const filler = new Uint8Array(13).fill(0xee);
    parts.push(filler);
    at += filler.length;
    chunkOffsets.push(at);
    for (const s of samples.slice(i, i + 2)) { parts.push(s); at += s.length; }
  }
  const mdat = atom('mdat', ...parts);
  const moov = atom('moov', atom('mvhd', new Uint8Array(100)), videoTrack(),
    soundTrack({ sizes: samples.map((s) => s.length), chunkOffsets, perChunk: [[1, 2]], ...opts }), ...(opts.extra || []));
  return new Blob([ftyp, mdat, moov]);
}

const SAMPLES = [3, 5, 4, 7, 6].map((n, i) => new Uint8Array(n).fill(i + 1));

function readAdts(data) {
  const frames = [];
  for (let at = 0; at < data.length;) {
    assert.equal(data[at], 0xff);
    assert.equal(data[at + 1], 0xf1);
    const len = ((data[at + 3] & 3) << 11) | (data[at + 4] << 3) | (data[at + 5] >> 5);
    frames.push({
      profile: data[at + 2] >> 6,
      freqIndex: (data[at + 2] >> 2) & 15,
      channels: ((data[at + 2] & 1) << 2) | (data[at + 3] >> 6),
      body: data.slice(at + 7, at + len),
    });
    at += len;
  }
  return frames;
}

test('adtsParams reads AAC LC and HE-AAC configs and refuses what ADTS cannot carry', () => {
  assert.deepEqual(adtsParams(Uint8Array.from([0x11, 0x90])), { profile: 1, freqIndex: 3, channels: 2 });
  assert.deepEqual(adtsParams(Uint8Array.from([0x12, 0x08])), { profile: 1, freqIndex: 4, channels: 1 });
  // AOT 5 (SBR), core 24 kHz stereo, extension 48 kHz, then AOT 2
  assert.deepEqual(adtsParams(Uint8Array.from([0x2b, 0x11, 0x88, 0x00])), { profile: 1, freqIndex: 6, channels: 2 });
  assert.equal(adtsParams(Uint8Array.from([0x17, 0x90])), null, 'explicit sample rate');
  assert.equal(adtsParams(Uint8Array.from([0x11, 0x80])), null, 'channel layout given by a PCE');
  assert.equal(adtsParams(Uint8Array.from([0x11])), null);
  assert.equal(adtsParams(null), null);
});

test('writeAdtsHeader: frame length covers the header and spans three bytes', () => {
  const out = new Uint8Array(7);
  writeAdtsHeader(out, 0, 2000, { profile: 1, freqIndex: 3, channels: 2 });
  assert.deepEqual([...out], [0xff, 0xf1, 0x4c, 0x80, 0xfa, 0xff, 0xfc]);
});

test('a phone-style .mov (moov at the end, esds inside wave): every sound sample comes out in order with an ADTS header', async () => {
  const out = await extractAacAudio(movFile(SAMPLES, { quicktime: true }));
  assert.ok(out);
  const frames = readAdts(out.data);
  assert.equal(frames.length, SAMPLES.length);
  frames.forEach((f, i) => {
    assert.deepEqual([f.profile, f.freqIndex, f.channels], [1, 3, 2]);
    assert.deepEqual([...f.body], [...SAMPLES[i]]);
  });
  assert.equal(out.trimSec, 0);
});

test('an .mp4 with 64-bit chunk offsets and an edit list: same samples, and the priming to trim is reported in seconds', async () => {
  const out = await extractAacAudio(movFile(SAMPLES, { co64: true, primingSamples: 1024 }));
  assert.deepEqual(readAdts(out.data).map((f) => [...f.body]), SAMPLES.map((s) => [...s]));
  assert.ok(Math.abs(out.trimSec - 1024 / 48000) < 1e-9);
});

test('files this module does not handle resolve to null instead of throwing', async () => {
  assert.equal(await extractAacAudio(new Blob([str('ID3'), new Uint8Array(500)])), null, 'an mp3');
  assert.equal(await extractAacAudio(new Blob([])), null, 'an empty file');
  assert.equal(await extractAacAudio(movFile(SAMPLES, { format: 'lpcm' })), null, 'uncompressed sound');
  assert.equal(await extractAacAudio(movFile(SAMPLES, { extra: [atom('mvex', new Uint8Array(8))] })), null, 'fragmented');
  assert.equal(await extractAacAudio(movFile(SAMPLES, { asc: [0x17, 0x90] })), null, 'a config ADTS cannot carry');
  const whole = new Uint8Array(await movFile(SAMPLES).arrayBuffer());
  assert.equal(await extractAacAudio(new Blob([whole.slice(0, whole.length - 40)])), null, 'cut off in the middle of moov');
  assert.equal(parseMoov(new Uint8Array(0)), null);
  assert.equal(parseMoov(videoTrack()), null, 'video only');
});

test('a cancelled read stops and resolves to null', async () => {
  const abort = new AbortController();
  abort.abort();
  assert.equal(await extractAacAudio(movFile(SAMPLES), { signal: abort.signal }), null);
});
