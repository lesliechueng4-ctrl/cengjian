// Export_Service: muxes a separated stem (WAV) with the original video into an MP4 via FFmpeg.
// Node >= 18 built-ins only, ES module. Lives outside public/ so it is never served statically
// (Requirement 10.7).

import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseDemucsCmd, createJobQueue, isJobId, UPLOAD_EXTS } from './demucs-service.js';
import {
  sendJson,
  sendError,
  positiveInt,
  positiveNumber,
  truncate,
  lastStderrLine,
  createRejectDrainer,
} from './server-util.js';
// Isomorphic modules shared with the browser (stem-visualizer design 11.1). They only use
// ECMAScript built-ins and have no import-time side effects.
import { decodeVisPayload, VIS_MAX_BYTES } from './public/js/vis-data.js';
import { createRasterizer } from './public/js/vis-raster.js';
import { sceneAt } from './public/js/vis-scene.js';
import { lanesAt, stackedLayout, LANE_BACKGROUND } from './public/js/vis-lanes.js';

// ---------------------------------------------------------------------------
// 2.1 Constants and configuration
// ---------------------------------------------------------------------------

export const EXPORT_API_PREFIX = '/api/export';
export const COPYABLE_VIDEO_CODECS = ['h264', 'hevc'];
export const AAC_BITRATE = '192k';
export const X264_ARGS = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];

const DEFAULT_CMD = 'ffmpeg';
const DEFAULT_MAX_UPLOAD_MB = 10240; // 10 GB, original video + stem WAV combined
const DEFAULT_TIMEOUT_MIN = 30; // covers probe + mux
const MB = 1024 * 1024;

/** Size of the RIFF/WAVE header check ("RIFF" <size:4> "WAVE"). */
const RIFF_HEADER_BYTES = 12;

/**
 * Reads FFMPEG_CMD, EXPORT_MAX_UPLOAD_MB and EXPORT_TIMEOUT_MIN.
 * command is null when FFMPEG_CMD is set but unparseable (treated as unavailable, 6.3).
 * Invalid numeric values fall back to the defaults (6.5).
 */
export function readExportConfig(env = process.env) {
  const raw = env.FFMPEG_CMD;
  const command = parseDemucsCmd(raw == null || String(raw).trim() === '' ? DEFAULT_CMD : raw);
  return {
    command,
    commandError: command ? '' : 'FFMPEG_CMD 无法解析',
    maxUploadBytes: positiveInt(env.EXPORT_MAX_UPLOAD_MB, DEFAULT_MAX_UPLOAD_MB) * MB,
    timeoutMs: Math.round(positiveNumber(env.EXPORT_TIMEOUT_MIN, DEFAULT_TIMEOUT_MIN) * 60_000),
  };
}

export function defaultExportTempRoot() {
  return path.join(os.tmpdir(), 'cengjian-export');
}

// ---------------------------------------------------------------------------
// 2.2 Paths (Requirement 10.2)
// ---------------------------------------------------------------------------

/**
 * Built only from tempRoot, the server-generated Job_ID and a whitelisted extension.
 * Throws when id is not a Job_ID or ext is not in UPLOAD_EXTS (callers validate first).
 */
export function exportJobPaths(tempRoot, id, ext) {
  if (!isJobId(id)) throw new Error('invalid job id');
  if (typeof ext !== 'string' || !UPLOAD_EXTS.includes(ext)) throw new Error('invalid ext');
  const dir = path.join(tempRoot, id);
  return {
    dir,
    audio: path.join(dir, 'audio.wav'),
    input: path.join(dir, `input.${ext}`),
    output: path.join(dir, 'output.mp4'),
  };
}

// ---------------------------------------------------------------------------
// 2.3 Upload query and body framing (Requirement 7.1, 7.4)
// ---------------------------------------------------------------------------

/**
 * Parses ?ext=&wavBytes=. ext must be in UPLOAD_EXTS (compared lower-cased, leading dot
 * stripped); wavBytes must be a decimal positive integer, >= 12 (RIFF header) and
 * <= maxUploadBytes.
 * @param {URLSearchParams} searchParams
 * @param {number} maxUploadBytes
 * @returns {{ ok: true, ext: string, wavBytes: number } | { ok: false, error: string }}
 */
export function parseExportQuery(searchParams, maxUploadBytes) {
  const rawExt = searchParams && typeof searchParams.get === 'function' ? searchParams.get('ext') : null;
  if (rawExt == null || rawExt === '') return { ok: false, error: '缺少文件扩展名参数' };
  const ext = rawExt.replace(/^\./, '').toLowerCase();
  if (!UPLOAD_EXTS.includes(ext)) return { ok: false, error: '不支持的文件格式' };

  const rawWav = searchParams.get('wavBytes');
  if (rawWav == null || rawWav === '') return { ok: false, error: '缺少音轨大小参数' };
  if (!/^\d+$/.test(rawWav)) return { ok: false, error: '音轨大小参数无效' };
  const wavBytes = Number(rawWav);
  if (!Number.isSafeInteger(wavBytes) || wavBytes < RIFF_HEADER_BYTES) {
    return { ok: false, error: '音轨大小参数无效' };
  }
  if (!(wavBytes <= maxUploadBytes)) return { ok: false, error: '音轨大小参数无效' };
  return { ok: true, ext, wavBytes };
}

/** True when the first 12 bytes of buf are "RIFF" <4 bytes> "WAVE". */
export function isRiffWave(buf) {
  if (!buf || typeof buf.length !== 'number' || buf.length < RIFF_HEADER_BYTES) return false;
  return (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // RIFF
    buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45 // WAVE
  );
}

/**
 * Stateful splitter: cuts arbitrarily chunked request body data into the WAV part
 * (first wavBytes bytes) and the source-file part (everything after).
 * feed(chunk) returns [{ part: 'wav' | 'source', data: Buffer }] in arrival order;
 * data are slices of chunk (no copy). Empty chunks yield []. received() is the total
 * number of bytes fed so far.
 */
export function createBodySplitter(wavBytes) {
  let seen = 0;
  return {
    feed(chunk) {
      const out = [];
      if (!chunk || chunk.length === 0) return out;
      if (seen < wavBytes) {
        const take = Math.min(chunk.length, wavBytes - seen);
        out.push({ part: 'wav', data: chunk.subarray(0, take) });
        if (take < chunk.length) out.push({ part: 'source', data: chunk.subarray(take) });
      } else {
        out.push({ part: 'source', data: chunk });
      }
      seen += chunk.length;
      return out;
    },
    received: () => seen,
  };
}

// ---------------------------------------------------------------------------
// 2.4 Probe parsing (Requirement 8.2, 8.3, 8.8, 9.3)
// ---------------------------------------------------------------------------

/**
 * Parses the stderr of `ffmpeg -hide_banner -nostdin -i input` (no output file; FFmpeg
 * exits 1 after printing the input info, which is expected).
 * - hasInput: whether "Input #0" appears (otherwise the probe failed)
 * - durationSec: first "Duration: HH:MM:SS(.ff)" in seconds; null for "N/A", missing or 0
 * - video: first "Video:" stream of input 0 that is not "(attached pic)";
 *   { codec: lower-cased codec name, ordinal: its index among all Video streams of input 0 },
 *   or null when there is none
 * @param {string} stderr
 * @returns {{ hasInput: boolean, durationSec: number|null, video: { codec: string, ordinal: number }|null }}
 */
export function parseProbeOutput(stderr) {
  const text = stderr == null ? '' : String(stderr);
  const hasInput = /^Input #0\b/m.test(text);
  const d = /^\s*Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/m.exec(text);
  const durationSec = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null;
  let ordinal = 0;
  let video = null;
  for (const line of text.split(/\r?\n/)) {
    // [^:]* absorbs optional parts such as "[0x1](und)" or "(eng)".
    const m = /^\s*Stream #0:\d+[^:]*:\s*Video:\s*([A-Za-z0-9_]+)/.exec(line);
    if (!m) continue;
    if (!video && !line.includes('(attached pic)')) video = { codec: m[1].toLowerCase(), ordinal };
    ordinal++;
  }
  return {
    hasInput,
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
    video,
  };
}

// ---------------------------------------------------------------------------
// 2.5 Argument building (Requirement 8.1–8.7)
// ---------------------------------------------------------------------------

/** Decimal seconds with at most 3 fractional digits, e.g. 201.45 → "201.45", 3 → "3". */
export function formatSeconds(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return '0';
  const ms = Math.round(n * 1000);
  const whole = Math.floor(ms / 1000);
  const frac = String(ms % 1000).padStart(3, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/** Probe command: only one input, so only "#0:" streams appear. */
export function buildProbeArgs(fixedArgs, paths) {
  return [...(fixedArgs || []), '-hide_banner', '-nostdin', '-i', paths.input];
}

/**
 * Mux command. The original audio (0:a) is never mapped (8.1). H.264 / HEVC video is
 * copied, anything else is re-encoded with libx264; HEVC gets the hvc1 tag. The stem
 * audio is padded with silence (apad) and the output cut to the source duration with -t;
 * when the duration is unknown, -shortest stops at the end of the video (8.5).
 * @param {string[]} fixedArgs  arguments of FFMPEG_CMD after the executable
 * @param {{ codec: string, ordinal: number }} video
 * @param {number|null} durationSec
 * @param {{ input: string, audio: string, output: string }} paths
 * @returns {string[]}
 */
export function buildMuxArgs(fixedArgs, video, durationSec, paths) {
  const copy = COPYABLE_VIDEO_CODECS.includes(video.codec);
  const hasDuration = Number.isFinite(durationSec) && durationSec > 0;
  return [
    ...(fixedArgs || []),
    '-hide_banner', '-nostdin', '-y',
    '-i', paths.input,
    '-i', paths.audio,
    '-map', `0:v:${video.ordinal}`,
    '-map', '1:a:0',
    ...(copy ? ['-c:v', 'copy'] : X264_ARGS),
    ...(video.codec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
    '-af', 'apad',
    '-c:a', 'aac', '-b:a', AAC_BITRATE,
    ...(hasDuration ? ['-t', formatSeconds(durationSec)] : ['-shortest']),
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    '-f', 'mp4',
    paths.output,
  ];
}

// ---------------------------------------------------------------------------
// 2.6 Progress parsing (Requirement 9.2, 9.3)
// ---------------------------------------------------------------------------

/**
 * Incremental parser for `-progress pipe:1` output; handles lines split across chunks.
 * out_time_us and out_time_ms are both microseconds in FFmpeg (out_time_ms is a legacy
 * misnomer); "N/A" and negative values are ignored. progress() returns an integer 0–100,
 * or null when durationSec is unknown.
 * @param {number|null} durationSec
 */
export function createProgressParser(durationSec) {
  let pending = '';
  let lastUs = 0;
  return {
    feed(chunk) {
      const lines = (pending + (chunk == null ? '' : String(chunk))).split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const m = /^out_time_(us|ms)=(\d+)$/.exec(line.trim());
        if (m) lastUs = Number(m[2]);
      }
    },
    progress() {
      if (!(Number.isFinite(durationSec) && durationSec > 0)) return null;
      return progressPercent(lastUs / 1e6, durationSec);
    },
  };
}

/** Math.round(t / d * 100) clamped to 0..100; null when d is not a positive finite number. */
export function progressPercent(t, d) {
  if (!(Number.isFinite(d) && d > 0)) return null;
  const pct = Math.round((Number.isFinite(t) ? t : 0) / d * 100);
  return Math.min(100, Math.max(0, pct));
}

// ---------------------------------------------------------------------------
// Visualizer export: constants and pure helpers (stem-visualizer, Requirements 10, 11)
// ---------------------------------------------------------------------------

export const VIS_FPS = 30;
export const VIS_RENDER_BOX = Object.freeze([640, 360]); // standalone render size
export const VIS_STANDALONE_OUTPUT = Object.freeze([1280, 720]);
export const VIS_BACKGROUND = Object.freeze([11, 13, 20]); // #0b0d14
export const VIS_LAYOUTS = Object.freeze(['stacked', 'standalone']); // stem-lanes 11.2
/** Stacked_Layout box: output width ≤ 1920 and picture + Lane_Strip height ≤ 1920 (stem-lanes 12.2). */
export const VIS_STACK_BOX = 1920;
/** Strip_Render_Size width cap; FFmpeg upscales the strip to OW×SH (stem-lanes 12.4). */
export const VIS_STRIP_RENDER_MAX_W = 960;
/** Picture size assumed when the display size cannot be read (stem-lanes 12.3). */
export const VIS_DEFAULT_PICTURE = Object.freeze([1280, 720]);

/** Smallest valid Vis_Payload ("{}" is 2 bytes; it is then rejected by decodeVisPayload). */
const VIS_MIN_BYTES = 2;

/**
 * Visualizer query parameters (10.4). Both missing → { ok: true, vis: null } (original path,
 * 10.3); only one present → 400; visBytes must match ^\d+$ and lie in 2..VIS_MAX_BYTES;
 * layout must be exactly one of VIS_LAYOUTS (case-sensitive).
 * @param {URLSearchParams} searchParams
 * @returns {{ ok: true, vis: null | { visBytes: number, layout: string } } | { ok: false, error: string }}
 */
export function parseVisQuery(searchParams) {
  const get = (k) => (searchParams && typeof searchParams.get === 'function' ? searchParams.get(k) : null);
  const rawBytes = get('visBytes');
  const rawLayout = get('layout');
  if (rawBytes == null && rawLayout == null) return { ok: true, vis: null };
  if (rawBytes == null || rawLayout == null) return { ok: false, error: '可视化参数不完整' };
  if (!/^\d+$/.test(rawBytes)) return { ok: false, error: '可视化数据大小参数无效' };
  const visBytes = Number(rawBytes);
  if (!Number.isSafeInteger(visBytes) || visBytes < VIS_MIN_BYTES || visBytes > VIS_MAX_BYTES) {
    return { ok: false, error: '可视化数据大小参数无效' };
  }
  if (!VIS_LAYOUTS.includes(rawLayout)) return { ok: false, error: '可视化布局参数无效' };
  return { ok: true, vis: { visBytes, layout: rawLayout } };
}

/**
 * Generic body splitter: sizes = [n0, n1, …]; feed(chunk) returns
 * [{ part: 0 … sizes.length, data }] in arrival order, where the last part index
 * (sizes.length) receives everything after the fixed-size parts. data are slices of chunk
 * (no copy); empty chunks yield []. received() is the total number of bytes fed so far.
 * @param {number[]} sizes
 */
export function createPartSplitter(sizes) {
  const ends = [];
  let acc = 0;
  for (const s of sizes) {
    acc += s;
    ends.push(acc);
  }
  let seen = 0;
  return {
    feed(chunk) {
      const out = [];
      if (!chunk || chunk.length === 0) return out;
      let off = 0;
      while (off < chunk.length) {
        const pos = seen + off;
        let part = 0;
        while (part < ends.length && pos >= ends[part]) part++;
        const take = part < ends.length ? Math.min(chunk.length - off, ends[part] - pos) : chunk.length - off;
        out.push({ part, data: chunk.subarray(off, off + take) });
        off += take;
      }
      seen += chunk.length;
      return out;
    },
    received: () => seen,
  };
}

const STREAM_VIDEO_RE = /^\s*Stream #0:\d+[^:]*:\s*Video:/;
// "640x360" preceded by start/space/comma and followed by space/comma/end; hex such as
// "0x31637661" cannot match because a single leading digit is not enough.
const VIDEO_SIZE_RE = /(?:^|[\s,])(\d{2,5})x(\d{2,5})(?=[\s,]|$)/;
const ROTATION_RE = /rotation of\s+(-?\d+(?:\.\d+)?)\s*degrees/i;

/**
 * Display size of the ordinal-th Video stream of input 0 (counting every Video stream, as
 * parseProbeOutput does). Takes the first "<W>x<H>" on the stream line; when the stream's
 * following block (until the next Stream line or a non-indented line) reports a rotation of
 * ±90 / ±270 degrees, width and height are swapped. Returns null when nothing can be read.
 * @param {string} stderr
 * @param {number} ordinal
 * @returns {{ width: number, height: number } | null}
 */
export function parseProbeVideoSize(stderr, ordinal) {
  const lines = (stderr == null ? '' : String(stderr)).split(/\r?\n/);
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!STREAM_VIDEO_RE.test(lines[i])) continue;
    if (seen++ !== ordinal) continue;
    const m = VIDEO_SIZE_RE.exec(lines[i]);
    if (!m) return null;
    let width = Number(m[1]);
    let height = Number(m[2]);
    if (!(width > 0 && height > 0)) return null;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^\s*Stream #/.test(line) || /^\S/.test(line)) break;
      const r = ROTATION_RE.exec(line);
      if (r) {
        const deg = ((Math.round(Number(r[1])) % 360) + 360) % 360;
        if (deg === 90 || deg === 270) [width, height] = [height, width];
        break;
      }
    }
    return { width, height };
  }
  return null;
}

/**
 * Fits width×height into boxW×boxH keeping the aspect ratio, never upscaling; both sides
 * are rounded down to even numbers and are at least 2. Returns null for invalid input.
 * @returns {{ w: number, h: number } | null}
 */
export function fitEven(width, height, boxW, boxH) {
  const w = Math.floor(Number(width));
  const h = Math.floor(Number(height));
  const bw = Math.floor(Number(boxW));
  const bh = Math.floor(Number(boxH));
  if (!(w >= 1 && h >= 1 && bw >= 1 && bh >= 1)) return null;
  if (![w, h, bw, bh].every(Number.isSafeInteger)) return null;
  let rw;
  let rh;
  if (w <= bw && h <= bh) {
    rw = w;
    rh = h;
  } else if (w * bh >= h * bw) {
    // width-limited
    rw = bw;
    rh = Math.floor((h * bw) / w);
  } else {
    rh = bh;
    rw = Math.floor((w * bh) / h);
  }
  const even = (n) => Math.max(2, n - (n % 2));
  return { w: even(rw), h: even(rh) };
}

/**
 * Render plan (11.3–11.5, 11.8, 11.9):
 * D = probe duration when known, otherwise the payload duration; frames = ceil(D × 30).
 * stacked (stem-lanes 12.2–12.5): s = stackedLayout(videoSize ?? 1280×720, 1920, 1920);
 *          picture = OW×PH, strip = OW×SH, output = OW×(PH + SH), and the Lane_Strip is
 *          rendered at render = even(min(OW, 960)) × max(2, even(round(SH × render.w / OW))).
 * standalone: render 640×360, output 1280×720.
 * @param {{ layout: string, probeDuration: number|null, payloadDuration: number,
 *           videoSize: { width: number, height: number } | null }} opts
 * @returns {{ layout: string, D: number, frames: number, render: { w: number, h: number },
 *             output: { w: number, h: number }, picture?: { w: number, h: number },
 *             strip?: { w: number, h: number } }}
 */
export function visRenderPlan({ layout, probeDuration, payloadDuration, videoSize }) {
  const D = Number.isFinite(probeDuration) && probeDuration > 0 ? probeDuration : payloadDuration;
  const frames = Math.ceil(D * VIS_FPS);
  if (layout === 'stacked') {
    const [w, h] = videoSize ? [videoSize.width, videoSize.height] : VIS_DEFAULT_PICTURE;
    const s = stackedLayout(w, h, VIS_STACK_BOX, VIS_STACK_BOX);
    const OW = s.width;
    const SH = s.stripHeight;
    const rw = Math.max(2, evenDown(Math.min(OW, VIS_STRIP_RENDER_MAX_W)));
    const rh = Math.max(2, evenDown(Math.round((SH * rw) / OW)));
    return {
      layout, D, frames,
      picture: { w: OW, h: s.pictureHeight },
      strip: { w: OW, h: SH },
      output: { w: OW, h: s.pictureHeight + SH },
      render: { w: rw, h: rh },
    };
  }
  const box = { w: VIS_RENDER_BOX[0], h: VIS_RENDER_BOX[1] };
  const standaloneOut = { w: VIS_STANDALONE_OUTPUT[0], h: VIS_STANDALONE_OUTPUT[1] };
  return { layout, D, frames, render: box, output: standaloneOut };
}

const evenDown = (n) => n - (n % 2);

/**
 * Mux arguments of a Vis_Export_Job (11.6, 11.8–11.10; design decision 5). The visualizer
 * frames arrive as rgb24 rawvideo on stdin. No -nostdin (stdin carries the frames), no
 * -shortest (the output is cut with -t D) and apad lives inside the filter graph.
 * stacked inputs: 0 = source, 1 = pipe:0 (Lane_Strip frames), 2 = stem WAV; standalone:
 * 0 = pipe:0, 1 = WAV (the source file is not passed to FFmpeg).
 * @param {string[]} fixedArgs
 * @param {ReturnType<typeof visRenderPlan>} plan
 * @param {{ codec: string, ordinal: number } | null} video  required for stacked
 * @param {{ input: string, audio: string, output: string }} paths
 * @returns {string[]}
 */
export function buildVisMuxArgs(fixedArgs, plan, video, paths) {
  const { w: RW, h: RH } = plan.render;
  const { w: OW, h: OH } = plan.output;
  const rawInput = [
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${RW}x${RH}`, '-r', String(VIS_FPS), '-i', 'pipe:0',
  ];
  let inputs;
  let graph;
  if (plan.layout === 'stacked') {
    // stem-lanes decision 9: picture on top, Lane_Strip below, joined with vstack (no blending).
    const ordinal = video && Number.isInteger(video.ordinal) ? video.ordinal : 0;
    const { w: PW, h: PH } = plan.picture;
    const { w: SW, h: SH } = plan.strip;
    inputs = ['-i', paths.input, ...rawInput, '-i', paths.audio];
    graph = [
      `[0:v:${ordinal}]fps=${VIS_FPS},scale=${PW}:${PH}:force_original_aspect_ratio=decrease,` +
        `pad=${PW}:${PH}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[top]`,
      `[1:v]scale=${SW}:${SH}:flags=bicubic,setsar=1,format=yuv420p[strip]`,
      '[top][strip]vstack=inputs=2[v]',
      '[2:a:0]apad[a]',
    ].join(';');
  } else {
    inputs = [...rawInput, '-i', paths.audio];
    graph = [
      `[0:v]scale=${OW}:${OH}:flags=bicubic,setsar=1,format=yuv420p[v]`,
      '[1:a:0]apad[a]',
    ].join(';');
  }
  return [
    ...(fixedArgs || []),
    '-hide_banner', '-y',
    ...inputs,
    '-filter_complex', graph,
    '-map', '[v]', '-map', '[a]',
    ...X264_ARGS, '-r', String(VIS_FPS),
    '-c:a', 'aac', '-b:a', AAC_BITRATE,
    '-t', formatSeconds(plan.D),
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    '-f', 'mp4',
    paths.output,
  ];
}

const defaultYield = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Frame pump (11.7, 11.12, 11.14). For k = 0 … frames−1: take a free buffer from a pool of
 * poolSize (a buffer only returns to the pool once its write callback has fired) →
 * renderInto(k, buf) → stdin.write(buf, cb); when write returns false wait for 'drain';
 * then await yieldFn(). Stops immediately on stdin 'error' / 'close' or signal abort and
 * returns 'stopped'; after the last frame calls stdin.end() and returns 'done'.
 * @param {{ frames: number, frameBytes: number, renderInto: (k: number, buf: Uint8Array) => void,
 *           stdin: import('node:stream').Writable, signal?: AbortSignal, poolSize?: number,
 *           yieldFn?: () => Promise<void> }} opts
 * @returns {Promise<'done' | 'stopped'>}
 */
export async function pumpFrames({ frames, frameBytes, renderInto, stdin, signal, poolSize = 3, yieldFn = defaultYield }) {
  const size = Math.max(1, Math.floor(poolSize) || 1);
  let stopped = false;
  let draining = false;
  let wake = null;
  const wakeUp = () => {
    const w = wake;
    wake = null;
    if (w) w();
  };
  const stop = () => {
    stopped = true;
    wakeUp();
  };
  const onDrain = () => {
    draining = false;
    wakeUp();
  };
  const sleep = () => new Promise((resolve) => {
    wake = resolve;
  });

  stdin.on('error', stop);
  stdin.on('close', stop);
  stdin.on('drain', onDrain);
  if (signal) signal.addEventListener('abort', stop);
  if ((signal && signal.aborted) || stdin.destroyed) stopped = true;

  const free = [];
  let created = 0;
  try {
    for (let k = 0; k < frames; k++) {
      while (!stopped && free.length === 0 && created >= size) await sleep();
      if (stopped) return 'stopped';
      let buf;
      if (free.length > 0) {
        buf = free.pop();
      } else {
        buf = new Uint8Array(frameBytes);
        created++;
      }
      renderInto(k, buf);
      if (stopped) return 'stopped';
      const ok = stdin.write(buf, () => {
        free.push(buf);
        wakeUp();
      });
      if (ok === false) {
        draining = true;
        while (!stopped && draining) await sleep();
      }
      if (stopped) return 'stopped';
      await yieldFn();
    }
    if (stopped) return 'stopped';
    stdin.end();
    return 'done';
  } finally {
    stdin.removeListener('error', stop);
    stdin.removeListener('close', stop);
    stdin.removeListener('drain', onDrain);
    if (signal) signal.removeEventListener('abort', stop);
  }
}

// ---------------------------------------------------------------------------
// 2.7 Service factory / 2.8 HTTP interface
// ---------------------------------------------------------------------------

/** How long a rejected upload may keep sending its (discarded) body before the socket is destroyed. */
const REJECT_DRAIN_MS = 10_000;
/** Only the last 64 KB of the mux stderr are kept (for the error message). */
const STDERR_TAIL_BYTES = 64 * 1024;
const PROBE_MAX_BUFFER = 4 * 1024 * 1024;
const PROBE_IGNORE_RE = /At least one output file must be specified/;

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

/**
 * Export_Service (design.md 2.7–2.8). Owns tempRoot, checks the FFmpeg command, accepts
 * uploads (WAV + source file in one body, framed by wavBytes) and runs one FFmpeg job at
 * a time through createJobQueue.
 *
 * @param {object} options
 * @param {{file: string, args: string[]} | null} options.command  null -> unavailable
 * @param {string} [options.commandError]  reason logged when command is null
 * @param {number} options.maxUploadBytes
 * @param {number} options.timeoutMs  covers probe + mux (9.4)
 * @param {string} options.tempRoot
 * @param {number} [options.retentionMs=30 min]
 * @param {number} [options.tombstoneMs=5 min]
 * @param {number} [options.maxUnfinished=4]
 * @param {number} [options.probeTimeoutMs=10_000]  startup -version check
 * @param {object} [options.env]  environment for the FFmpeg child processes
 * @param {(msg: string) => void} [options.log=console.log]
 * @param {typeof childProcess.execFile} [options.execFile]
 * @param {typeof childProcess.spawn} [options.spawn]
 */
export function createExportService(options = {}) {
  const {
    command = null,
    commandError = '',
    maxUploadBytes = DEFAULT_MAX_UPLOAD_MB * MB,
    timeoutMs = DEFAULT_TIMEOUT_MIN * 60_000,
    tempRoot = defaultExportTempRoot(),
    retentionMs = 30 * 60 * 1000,
    tombstoneMs = 5 * 60 * 1000,
    maxUnfinished = 4,
    probeTimeoutMs = 10_000,
    env,
    log = console.log,
    execFile = childProcess.execFile,
    spawn = childProcess.spawn,
  } = options;

  /** @type {Map<string, object>} id -> Export_Job (design Data Models) */
  const jobs = new Map();
  let available = false;
  let checking = false;
  let initPromise = null;
  let closed = false;
  let versionChild = null;
  /** Total number of visualizer frames rendered by this service (exposed for tests). */
  let renderedFrames = 0;

  const queue = createJobQueue({ runner: runJob, maxUnfinished });
  const drainer = createRejectDrainer({ maxExtraBytes: maxUploadBytes, drainMs: REJECT_DRAIN_MS });

  function warn(msg) {
    console.warn(`[export] ${msg}`);
  }

  function errCode(err) {
    return err && err.code ? err.code : err;
  }

  async function removeDir(dir, id) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch (err) {
      warn(`删除任务 ${id} 的临时目录失败：${errCode(err)}`);
    }
  }

  function childOptions(extra) {
    const opts = { windowsHide: true, ...extra };
    if (env) opts.env = env;
    return opts;
  }

  // ---------------------------------------------------------------- init / check (6.1–6.3, 10.1)

  /** Runs `<cmd> -version`; resolves '' when FFmpeg is usable, otherwise the reason. */
  function checkCommand() {
    return new Promise((resolve) => {
      if (!command || typeof command.file !== 'string' || !command.file) {
        resolve(commandError || 'FFMPEG_CMD 无法解析');
        return;
      }
      try {
        versionChild = execFile(
          command.file,
          [...(command.args || []), '-version'],
          childOptions({ timeout: probeTimeoutMs }),
          (err) => {
            versionChild = null;
            if (!err) resolve('');
            else if (err.code === 'ENOENT') resolve('命令不存在（ENOENT）');
            else if (err.killed) resolve('检测超时');
            else if (typeof err.code === 'number') resolve(`退出码 ${err.code}`);
            else resolve(`无法运行（${err.code || err.signal || err.message || err}）`);
          },
        );
      } catch (err) {
        versionChild = null;
        resolve(`无法运行（${errCode(err)}）`);
      }
    });
  }

  function init() {
    if (initPromise) return initPromise;
    checking = true;
    available = false;
    initPromise = (async () => {
      let reason = '';
      try {
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
      } catch (err) {
        warn(`清理临时目录失败：${errCode(err)}`);
      }
      try {
        await fs.promises.mkdir(tempRoot, { recursive: true });
      } catch (err) {
        reason = `无法创建临时目录（${errCode(err)}）`;
      }
      if (!reason) reason = await checkCommand();
      if (closed) return;
      available = !reason;
      checking = false;
      log(available
        ? '  视频导出: 已启用 FFmpeg'
        : `  视频导出: 未检测到 FFmpeg（${reason}），将使用浏览器录制`);
    })();
    return initPromise;
  }

  function status() {
    return {
      available: available && !checking,
      checking,
      maxUploadBytes,
      queueLength: queue.unfinished(),
    };
  }

  // ---------------------------------------------------------------- expiry / failure

  function clearJobTimers(job) {
    if (job.timer) clearTimeout(job.timer);
    if (job.expireTimer) clearTimeout(job.expireTimer);
    job.timer = null;
    job.expireTimer = null;
  }

  /** Drop the record (if it is still this job) after ms; a done job's directory goes with it. */
  function scheduleExpire(job, ms) {
    if (job.expireTimer) clearTimeout(job.expireTimer);
    job.expireTimer = null;
    if (closed) return;
    const t = setTimeout(() => {
      job.expireTimer = null;
      if (jobs.get(job.id) === job) jobs.delete(job.id);
      if (job.status === 'done') removeDir(job.paths.dir, job.id);
    }, ms);
    if (typeof t.unref === 'function') t.unref();
    job.expireTimer = t;
  }

  function timeoutMessage() {
    const min = timeoutMs / 60000;
    const n = Number.isInteger(min) ? min : Number(min.toPrecision(2));
    return `合成视频超过 ${n} 分钟未完成，已终止`;
  }

  /** Stops the frame pump of a Vis_Export_Job (no-op for other jobs). */
  function stopPump(job) {
    if (job.abort) job.abort.abort();
  }

  function killChild(child) {
    if (!child) return;
    try {
      child.kill();
    } catch {
      // already gone
    }
  }

  /**
   * Ends the running phase: clears the job timeout, forgets the child process, stops the
   * frame pump and releases the Vis_Data (10.8).
   */
  function endRun(job) {
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    job.child = null;
    stopPump(job);
    job.abort = null;
    job.vis = null;
  }

  function failJob(job, done, message) {
    endRun(job);
    job.status = 'failed';
    job.error = truncate(message || '合成视频失败');
    console.error(`[export] 任务 ${job.id} 失败：${job.error}`);
    removeDir(job.paths.dir, job.id);
    scheduleExpire(job, tombstoneMs);
    done('failed');
  }

  /** The canceller already set the status; the directory is removed once no process holds it. */
  function finishCancelled(job, done) {
    endRun(job);
    removeDir(job.paths.dir, job.id);
    done('cancelled');
  }

  // ---------------------------------------------------------------- runner (8.x, 9.x, 10.3)

  /** Successful end: keep only the output, drop the uploaded files, expire after retentionMs. */
  function finishDone(job, done) {
    endRun(job);
    job.status = 'done';
    job.progress = 100;
    for (const file of [job.paths.audio, job.paths.input]) {
      fs.promises.rm(file, { force: true }).catch((e) => {
        warn(`删除任务 ${job.id} 的上传文件失败：${errCode(e)}`);
      });
    }
    scheduleExpire(job, retentionMs);
    done('done');
  }

  /** Enters 'running' and starts the single timeout over probe + mux (+ rendering). */
  function startRunning(job) {
    job.status = 'running';
    job.progress = 0;
    job.error = '';
    job.timedOut = false;

    const t = setTimeout(() => {
      job.timer = null;
      job.timedOut = true;
      stopPump(job); // stop rendering first, then terminate FFmpeg (11.13)
      killChild(job.child);
    }, timeoutMs);
    if (typeof t.unref === 'function') t.unref();
    job.timer = t;
  }

  /**
   * Runs the probe command; on a usable result calls onInfo(info, stderr). Cancellation,
   * timeout, start errors and unreadable input end the job here.
   */
  function runProbe(job, done, onInfo) {
    let probe;
    try {
      probe = execFile(
        command.file,
        buildProbeArgs(command.args || [], job.paths),
        childOptions({ maxBuffer: PROBE_MAX_BUFFER }),
        (err, _stdout, stderr) => onProbeExit(err, String(stderr || '')),
      );
    } catch (err) {
      failJob(job, done, `无法启动 FFmpeg：${errCode(err)}`);
      return;
    }
    job.child = probe;

    function onProbeExit(err, stderr) {
      job.child = null;
      if (job.cancelled) {
        finishCancelled(job, done);
        return;
      }
      if (job.timedOut) {
        failJob(job, done, timeoutMessage());
        return;
      }
      // Exit code 1 ("At least one output file must be specified") is the normal outcome;
      // only start errors (ENOENT, EACCES, ...) count as failures here.
      if (err && typeof err.code === 'string') {
        failJob(job, done, '无法启动 FFmpeg');
        return;
      }
      const info = parseProbeOutput(stderr);
      if (!info.hasInput) {
        failJob(job, done, lastStderrLine(stderr, { ignore: PROBE_IGNORE_RE }) || '无法读取原文件');
        return;
      }
      onInfo(info, stderr);
    }
  }

  /** spawn wrapper: returns the child, or null after failing the job when spawn throws. */
  function spawnMux(job, done, args, stdio) {
    try {
      return spawn(command.file, args, childOptions({ stdio }));
    } catch (err) {
      failJob(job, done, `无法启动 FFmpeg：${errCode(err)}`);
      return null;
    }
  }

  /**
   * Tracks a mux process: progress from stdout, the last 64 KB of stderr, then on exit
   * cancelled → timeout → hooks.failure() → exit code → output file → hooks.incomplete()
   * → done. hooks are only used by Vis_Export_Jobs.
   * @param {{ failure?: () => string, incomplete?: () => Promise<string> }} [hooks]
   */
  function watchMux(job, done, child, parser, hooks = {}) {
    job.child = child;
    let stderrTail = Buffer.alloc(0);
    let exited = false;

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        parser.feed(chunk);
        if (job.status === 'running') job.progress = parser.progress();
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        stderrTail = Buffer.concat([stderrTail, buf]);
        if (stderrTail.length > STDERR_TAIL_BYTES) stderrTail = stderrTail.subarray(-STDERR_TAIL_BYTES);
      });
    }
    child.once('error', (err) => {
      if (exited) return;
      exited = true;
      stopPump(job);
      if (job.cancelled) {
        finishCancelled(job, done);
        return;
      }
      failJob(job, done, job.timedOut ? timeoutMessage() : `无法启动 FFmpeg：${errCode(err)}`);
    });
    child.once('close', (code, signal) => {
      if (exited) return;
      exited = true;
      job.child = null;
      if (job.cancelled) {
        finishCancelled(job, done);
        return;
      }
      if (job.timedOut) {
        failJob(job, done, timeoutMessage());
        return;
      }
      const hookError = hooks.failure ? hooks.failure() : '';
      if (hookError) {
        failJob(job, done, hookError);
        return;
      }
      if (code !== 0) {
        const detail = code != null ? code : (signal || '未知');
        failJob(job, done, lastStderrLine(stderrTail.toString('utf8')) || `FFmpeg 退出码 ${detail}`);
        return;
      }
      fs.promises.stat(job.paths.output).then((st) => st.isFile() && st.size > 0, () => false).then((ok) => {
        if (job.cancelled) {
          finishCancelled(job, done);
          return;
        }
        if (!ok) {
          failJob(job, done, 'FFmpeg 没有生成视频文件');
          return;
        }
        if (!hooks.incomplete) {
          finishDone(job, done);
          return;
        }
        hooks.incomplete().then((msg) => {
          if (job.cancelled) {
            finishCancelled(job, done);
            return;
          }
          if (msg) {
            failJob(job, done, msg);
            return;
          }
          finishDone(job, done);
        });
      });
    });
  }

  /**
   * Called by the Job_Queue when a job starts: probes the source, runs the mux, tracks
   * progress, enforces one timeout over probe + mux, then calls done(status).
   */
  function runJob(job, done) {
    if (closed || job.cancelled || jobs.get(job.id) !== job) {
      job.vis = null;
      done('cancelled');
      return;
    }
    if (job.vis) {
      runVisJob(job, done);
      return;
    }
    startRunning(job);
    runProbe(job, done, (info) => {
      if (!info.video) {
        failJob(job, done, '文件里没有画面');
        return;
      }
      job.durationSec = info.durationSec;
      job.video = info.video;
      const parser = createProgressParser(job.durationSec);
      job.progress = parser.progress();
      const child = spawnMux(
        job,
        done,
        buildMuxArgs(command.args || [], job.video, job.durationSec, job.paths),
        ['ignore', 'pipe', 'pipe'],
      );
      if (child) watchMux(job, done, child, parser);
    });
  }

  /**
   * Vis_Export_Job (design 11.3): probe → render plan → spawn FFmpeg with rawvideo on
   * stdin → pump ceil(D × 30) rendered frames → judge the exit.
   */
  function runVisJob(job, done) {
    const { visData, selected, layout } = job.vis;
    const abort = new AbortController();
    job.abort = abort;
    job.renderedFrames = 0;
    startRunning(job);
    runProbe(job, done, (info, stderr) => {
      const stacked = layout === 'stacked';
      if (stacked && !info.video) {
        failJob(job, done, '文件里没有画面');
        return;
      }
      job.durationSec = info.durationSec;
      job.video = info.video;
      const videoSize = stacked ? parseProbeVideoSize(stderr, info.video.ordinal) : null;
      const plan = visRenderPlan({
        layout,
        probeDuration: info.durationSec,
        payloadDuration: visData.duration,
        videoSize,
      });
      job.plan = { D: plan.D, frames: plan.frames, fps: VIS_FPS, render: plan.render, output: plan.output };
      let raster;
      try {
        raster = createRasterizer(plan.render.w, plan.render.h);
      } catch (err) {
        failJob(job, done, `渲染可视化失败：${errCode(err)}`);
        return;
      }
      // stacked: only the Lane_Strip is rendered (stem-lanes 12.5); standalone: full scene.
      const background = stacked ? LANE_BACKGROUND : VIS_BACKGROUND;
      const frameShapes = stacked ? lanesAt : sceneAt;
      const parser = createProgressParser(plan.D);
      job.progress = parser.progress();

      const child = spawnMux(
        job,
        done,
        buildVisMuxArgs(command.args || [], plan, info.video, job.paths),
        ['pipe', 'pipe', 'pipe'],
      );
      if (!child) return;
      // EPIPE / write errors after FFmpeg exits are judged by the exit code (11.12);
      // pumpFrames removes its own listeners, so this one stays for the stream's lifetime.
      if (child.stdin) child.stdin.on('error', () => {});

      const sceneOpts = { selected, width: plan.render.w, height: plan.render.h, reducedMotion: false };
      let pumpState = null; // 'done' | 'stopped' | 'error'
      let renderError = null;
      const pumpPromise = pumpFrames({
        frames: plan.frames,
        frameBytes: raster.frameBytes,
        stdin: child.stdin,
        signal: abort.signal,
        yieldFn: () => new Promise((resolve) => setImmediate(resolve)),
        renderInto: (k, buf) => {
          raster.render(frameShapes(k / VIS_FPS, visData, sceneOpts), background, buf);
          renderedFrames++;
          job.renderedFrames++;
        },
      }).then((r) => {
        pumpState = r;
      }, (err) => {
        pumpState = 'error';
        renderError = err;
        console.error(`[export] 任务 ${job.id} 渲染失败：`, err);
        abort.abort();
        killChild(job.child);
      });

      watchMux(job, done, child, parser, {
        failure: () => (renderError ? truncate(`渲染可视化失败：${renderError.message || renderError}`) : ''),
        incomplete: async () => {
          if (pumpState === null) {
            abort.abort();
            await pumpPromise;
          }
          if (renderError) return truncate(`渲染可视化失败：${renderError.message || renderError}`);
          return pumpState === 'done' ? '' : 'FFmpeg 提前结束';
        },
      });
    });
  }

  // ---------------------------------------------------------------- upload (7.1–7.8, 7.13)

  function newJobId() {
    let id;
    do id = crypto.randomBytes(16).toString('hex');
    while (jobs.has(id));
    return id;
  }

  /**
   * Drops an upload that did not complete (400 / 413 / 500, client gone, DELETE, close):
   * removes the record, frees the queue slot, closes both write streams and then deletes
   * the directory (Windows cannot delete files that are still open). Safe to call twice.
   */
  function abortUpload(job) {
    const up = job.upload;
    if (!up || up.settled) return;
    up.settled = true;
    if (up.onData) up.req.removeListener('data', up.onData);
    up.req.pause();
    up.visParts = null;
    job.vis = null;
    if (jobs.get(job.id) === job) jobs.delete(job.id);
    queue.finish(job.id, 'cancelled');
    const rm = () => removeDir(job.paths.dir, job.id);
    if (up.mkdirPending) {
      up.afterMkdir = rm; // the directory may appear after this point; remove it once it does
      return;
    }
    const open = [up.wavStream, up.sourceStream].filter((s) => s && !s.closed);
    if (open.length === 0) {
      rm();
      return;
    }
    let left = open.length;
    for (const s of open) {
      s.once('close', () => {
        if (--left === 0) rm();
      });
      s.destroy();
    }
  }

  function handleUpload(req, res, url) {
    // 1. unavailable -> 503, discard body, no files (7.3)
    if (!available || checking) {
      req.resume();
      sendError(res, 503, '视频导出不可用');
      return;
    }
    // 2. query parameters (7.4)
    const q = parseExportQuery(url.searchParams, maxUploadBytes);
    if (!q.ok) {
      req.resume();
      sendError(res, 400, q.error);
      return;
    }
    // 2b. visualizer parameters (stem-visualizer 10.3, 10.4); vis === null keeps the original flow
    const vq = parseVisQuery(url.searchParams);
    if (!vq.ok) {
      req.resume();
      sendError(res, 400, vq.error);
      return;
    }
    const vis = vq.vis;
    /** Bytes that precede the source file: WAV, plus the Vis_Payload when present. */
    const headBytes = vis ? q.wavBytes + vis.visBytes : q.wavBytes;
    // 3. unfinished cap, uploads included (7.6)
    if (queue.unfinished() >= maxUnfinished) {
      req.resume();
      sendError(res, 429, '导出任务过多，请稍后再试');
      return;
    }
    // 4. declared size (7.5 / 7.4)
    const declared = req.headers['content-length'];
    if (declared !== undefined && /^\d+$/.test(declared)) {
      const n = Number(declared);
      if (n > maxUploadBytes) {
        drainer.reject(req, res, 413, '文件超过视频导出的大小上限');
        return;
      }
      if (n <= headBytes) {
        drainer.reject(req, res, 400, '缺少原文件');
        return;
      }
    }

    // 5. reserve a slot as 'uploading', then stream into tempRoot/<id>/
    const id = newJobId();
    const job = {
      id,
      ext: q.ext,
      wavBytes: q.wavBytes,
      status: 'uploading',
      progress: 0,
      error: '',
      paths: exportJobPaths(tempRoot, id, q.ext),
      durationSec: null,
      video: null,
      child: null,
      timer: null,
      expireTimer: null,
      timedOut: false,
      cancelled: false,
      upload: null,
      createdAt: Date.now(),
      // Vis_Export_Job fields (stem-visualizer); vis stays null for plain Export_Jobs
      vis: null,
      plan: null,
      abort: null,
      renderedFrames: 0,
    };
    if (!queue.submit(job, { uploading: true })) {
      req.resume();
      sendError(res, 429, '导出任务过多，请稍后再试');
      return;
    }
    jobs.set(id, job);

    // Plain uploads keep createBodySplitter ('wav' / 'source'); visualizer uploads use three
    // parts: 0 = WAV, 1 = Vis_Payload (memory only, 10.8), 2 = source file.
    const VIS_PART_NAMES = ['wav', 'vis', 'source'];
    const splitter = vis ? createPartSplitter([q.wavBytes, vis.visBytes]) : createBodySplitter(q.wavBytes);
    const partName = vis ? (p) => VIS_PART_NAMES[p] : (p) => p;
    const up = {
      req,
      wavStream: null,
      sourceStream: null,
      splitter,
      settled: false,
      mkdirPending: true,
      afterMkdir: null,
      onData: null,
      header: Buffer.alloc(0),
      headerChecked: false,
      waitingDrain: new Set(),
      visParts: vis ? [] : null,
      visReceived: 0,
    };
    job.upload = up;

    // 9. client disconnects before the body is complete (7.8)
    const onGone = () => {
      if (!up.settled && !req.complete) abortUpload(job);
    };
    req.on('aborted', onGone);
    req.on('close', onGone);
    req.on('error', onGone);

    // 10. write failure (mkdir, ENOSPC, ...) -> 500 (7.13)
    const fail = (err) => {
      if (up.settled) return;
      console.error(`[export] 任务 ${id} 上传失败：${errCode(err)}`);
      abortUpload(job);
      drainer.reject(req, res, 500, '服务器无法保存上传文件');
    };

    const rejectBad = (code, message) => {
      abortUpload(job);
      drainer.reject(req, res, code, message);
    };

    // 6–7. byte counting, framing, backpressure, RIFF check
    up.onData = (chunk) => {
      if (up.settled) return;
      if (splitter.received() + chunk.length > maxUploadBytes) {
        rejectBad(413, '文件超过视频导出的大小上限');
        return;
      }
      for (const piece of splitter.feed(chunk)) {
        const part = partName(piece.part);
        const { data } = piece;
        let stream;
        if (part === 'vis') {
          // Kept in memory only; validated as soon as all visBytes have arrived (10.5).
          up.visParts.push(Buffer.from(data));
          up.visReceived += data.length;
          if (up.visReceived === vis.visBytes) {
            let decoded;
            try {
              decoded = decodeVisPayload(Buffer.concat(up.visParts));
            } catch {
              decoded = null;
            }
            up.visParts = null;
            if (!decoded) {
              rejectBad(400, '可视化数据无效');
              return;
            }
            job.vis = { visData: decoded.visData, selected: decoded.selected, layout: vis.layout };
          }
          continue;
        }
        if (part === 'wav') {
          if (!up.headerChecked) {
            const need = RIFF_HEADER_BYTES - up.header.length;
            up.header = Buffer.concat([up.header, data.subarray(0, need)]);
            if (up.header.length >= RIFF_HEADER_BYTES) {
              up.headerChecked = true;
              if (!isRiffWave(up.header)) {
                rejectBad(400, '音轨不是 WAV 格式');
                return;
              }
            }
          }
          stream = up.wavStream;
        } else {
          stream = up.sourceStream;
        }
        if (!stream.write(data)) {
          up.waitingDrain.add(stream);
          req.pause();
        }
      }
    };

    // 8. body finished: completeness checks, then wait for both files -> 202
    const onEnd = () => {
      if (up.settled) return;
      const received = splitter.received();
      if (received < q.wavBytes) {
        rejectBad(400, '音轨 WAV 不完整');
        return;
      }
      if (vis && received < headBytes) {
        rejectBad(400, '可视化数据不完整');
        return;
      }
      if (received === headBytes) {
        rejectBad(400, '缺少原文件');
        return;
      }
      let left = 2;
      const onFinish = () => {
        if (--left > 0 || up.settled) return;
        if (res.destroyed) {
          abortUpload(job);
          return;
        }
        up.settled = true;
        req.removeListener('aborted', onGone);
        req.removeListener('close', onGone);
        req.removeListener('error', onGone);
        job.upload = null;
        if (closed) return;
        let position = 1;
        for (const other of jobs.values()) if (queue.state(other.id) === 'queued') position++;
        job.status = 'queued';
        sendJson(res, 202, { id, status: 'queued', position });
        queue.enqueue(id); // pumps; runJob may start this job right away
      };
      up.wavStream.once('finish', onFinish);
      up.sourceStream.once('finish', onFinish);
      up.wavStream.end();
      up.sourceStream.end();
    };

    fs.promises.mkdir(job.paths.dir, { recursive: true }).then(() => {
      up.mkdirPending = false;
      if (up.settled) {
        if (up.afterMkdir) up.afterMkdir();
        return;
      }
      const open = (file) => {
        const ws = fs.createWriteStream(file);
        ws.on('error', fail);
        ws.on('drain', () => {
          up.waitingDrain.delete(ws);
          if (!up.settled && up.waitingDrain.size === 0) req.resume();
        });
        return ws;
      };
      up.wavStream = open(job.paths.audio);
      up.sourceStream = open(job.paths.input);
      req.on('data', up.onData);
      req.on('end', onEnd);
    }, (err) => {
      up.mkdirPending = false;
      fail(err);
    });
  }

  // ---------------------------------------------------------------- job routes (7.7, 7.9–7.12)

  function jobJson(job) {
    const out = { id: job.id };
    if (job.status === 'uploading' || job.status === 'queued') {
      out.status = 'queued';
      const pos = queue.position(job.id);
      if (pos != null) out.position = pos;
    } else {
      out.status = job.status;
    }
    if (job.status === 'running') {
      out.progress = job.progress == null ? null : Math.min(100, Math.max(0, Math.round(job.progress)));
    }
    if (job.status === 'failed') out.error = job.error || '合成视频失败';
    return out;
  }

  /** DELETE in any state. The record stays as a 'cancelled' tombstone for tombstoneMs. */
  function cancelJob(job) {
    if (job.status === 'failed' || job.status === 'cancelled') return; // already final
    const prev = job.status;
    job.cancelled = true;
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    if (prev === 'uploading') {
      abortUpload(job); // removes record, frees slot, deletes the directory
      queue.finish(job.id, 'cancelled'); // no-op unless the upload had already settled
      jobs.set(job.id, job);
    } else if (prev === 'running') {
      const child = job.child;
      stopPump(job); // stop rendering before terminating FFmpeg (11.13)
      queue.cancel(job.id); // frees the slot and pumps the next job
      if (child) {
        try {
          child.kill();
        } catch {
          // already gone; the exit handler still removes the directory
        }
      } else {
        removeDir(job.paths.dir, job.id); // between processes / during the result check
      }
    } else {
      queue.cancel(job.id); // 'queued' leaves the FIFO; no-op for 'done'
      removeDir(job.paths.dir, job.id);
      job.vis = null;
    }
    job.status = 'cancelled';
    job.progress = 0;
    scheduleExpire(job, tombstoneMs);
  }

  function sendResult(req, res, job) {
    if (job.status !== 'done') {
      sendError(res, 404, '未找到');
      return;
    }
    const file = job.paths.output;
    fs.promises.stat(file).then((st) => {
      if (!st.isFile() || job.status !== 'done' || jobs.get(job.id) !== job) {
        sendError(res, 404, '未找到');
        return;
      }
      const stream = fs.createReadStream(file);
      stream.once('open', () => {
        if (res.headersSent || res.destroyed) {
          stream.destroy();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': st.size,
          ...NO_STORE_HEADERS,
        });
        stream.pipe(res);
      });
      stream.once('error', () => {
        if (!res.headersSent) sendError(res, 404, '未找到');
        else res.destroy();
      });
      res.once('close', () => stream.destroy());
    }, () => sendError(res, 404, '未找到'));
  }

  function methodNotAllowed(req, res, allow) {
    req.resume();
    sendError(res, 405, '不支持的请求方法', { Allow: allow });
  }

  /** GET /<id>, GET /<id>/result.mp4, DELETE /<id>; 405 for other methods; 404 otherwise. */
  function handleJobRoute(req, res, rest) {
    const parts = rest.split('/');
    if (parts.length > 2 || (parts.length === 2 && parts[1] !== 'result.mp4')) {
      req.resume();
      sendError(res, 404, '未找到');
      return;
    }
    const isResult = parts.length === 2;
    if (req.method !== 'GET' && !(!isResult && req.method === 'DELETE')) {
      methodNotAllowed(req, res, isResult ? 'GET' : 'GET, DELETE');
      return;
    }
    req.resume();
    const id = parts[0];
    const job = isJobId(id) ? jobs.get(id) : undefined;
    if (!job) {
      sendError(res, 404, '未找到');
      return;
    }
    if (isResult) {
      sendResult(req, res, job);
      return;
    }
    if (req.method === 'DELETE') {
      cancelJob(job);
      res.writeHead(204, NO_STORE_HEADERS);
      res.end();
      return;
    }
    sendJson(res, 200, jobJson(job));
  }

  // ---------------------------------------------------------------- dispatch

  function handle(req, res) {
    const rawPath = (req.url || '').split('?')[0];
    if (rawPath !== EXPORT_API_PREFIX && !rawPath.startsWith(`${EXPORT_API_PREFIX}/`)) return false;
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      req.resume();
      sendError(res, 404, '未找到');
      return true;
    }
    const pathname = url.pathname;
    if (pathname === EXPORT_API_PREFIX) {
      if (req.method === 'POST') handleUpload(req, res, url);
      else methodNotAllowed(req, res, 'POST');
      return true;
    }
    if (pathname === `${EXPORT_API_PREFIX}/status`) {
      if (req.method === 'GET') {
        req.resume();
        sendJson(res, 200, status());
      } else {
        methodNotAllowed(req, res, 'GET');
      }
      return true;
    }
    handleJobRoute(req, res, pathname.slice(EXPORT_API_PREFIX.length + 1));
    return true;
  }

  // ---------------------------------------------------------------- close

  /** Stops every FFmpeg process and clears all timers. Resolves once the children exited. */
  async function close() {
    closed = true;
    available = false;
    checking = false;
    const exits = [];
    const waitExit = (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        exits.push(new Promise((resolve) => {
          child.once('close', resolve);
          child.once('error', resolve);
        }));
      }
      try {
        child.kill();
      } catch {
        // already gone
      }
    };
    if (versionChild) waitExit(versionChild);
    const all = [...jobs.values()];
    // Drop waiting jobs first so killing the running one does not start another process.
    for (const job of all) {
      if (queue.state(job.id) === 'queued') {
        job.cancelled = true;
        queue.cancel(job.id);
      }
    }
    for (const job of all) {
      if (job.upload) abortUpload(job);
      clearJobTimers(job);
      const child = job.child;
      if (child) {
        job.cancelled = true;
        stopPump(job);
        waitExit(child);
      }
    }
    if (exits.length) {
      let cap;
      await Promise.race([
        Promise.all(exits),
        new Promise((resolve) => {
          cap = setTimeout(resolve, 5000);
          if (typeof cap.unref === 'function') cap.unref();
        }),
      ]);
      clearTimeout(cap);
    }
    for (const job of jobs.values()) clearJobTimers(job);
    drainer.killAll();
  }

  return {
    init,
    status,
    handle,
    close,
    // Internals for tests; not part of the HTTP API.
    _internal: {
      jobs,
      queue,
      abortUpload,
      cancelJob,
      removeDir,
      renderedFrames: () => renderedFrames,
      options: { command, timeoutMs, retentionMs, tombstoneMs, maxUnfinished, tempRoot, env },
    },
  };
}
