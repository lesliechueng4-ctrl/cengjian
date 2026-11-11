// 导出服务纯函数的属性测试：配置读取、上传分帧、上传参数 / WAV 头校验、临时路径。
// 运行：node --test tests/export-props.test.mjs（PROP_SEED=<种子> 复现失败序列）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { forAll, gen } from './helpers/prop.mjs';
import {
  readExportConfig,
  parseExportQuery,
  isRiffWave,
  createBodySplitter,
  exportJobPaths,
  parseProbeOutput,
  buildProbeArgs,
  buildMuxArgs,
  formatSeconds,
  createProgressParser,
  progressPercent,
  X264_ARGS,
} from '../export-service.js';
import { UPLOAD_EXTS } from '../demucs-service.js';

const RUNS = 200;
const MB = 1048576;
const DEFAULT_MAX_UPLOAD_BYTES = 10240 * MB;
const DEFAULT_TIMEOUT_MS = 30 * 60000;

const pickFrom = (list) => (rng) => list[Math.floor(rng() * list.length)];
const bool = (p = 0.5) => (rng) => rng() < p;

/** 随机空白包裹，用于检验数值配置的首尾空白处理。 */
const pad = (rng, s) => {
  const ws = ['', '', ' ', '  ', '\t'];
  return pickFrom(ws)(rng) + s + pickFrom(ws)(rng);
};

// ---------------------------------------------------------------------------
// Property 6
// ---------------------------------------------------------------------------

// EXPORT_MAX_UPLOAD_MB 候选值：{ raw, expected }，expected 为期望的 maxUploadBytes。
const maxUploadCase = gen.oneOf(
  (rng) => { const n = gen.int(1, 10_000_000)(rng); return { raw: pad(rng, String(n)), expected: n * MB }; },
  (rng) => ({ raw: pickFrom([undefined, '', '   ', '0', '00', '-1', '-100', '+5', '1.5', '2.0', '1e3', '0x10',
    'abc', '12abc', 'NaN', 'Infinity', '99999999999999999999', '9007199254740993'])(rng),
  expected: DEFAULT_MAX_UPLOAD_BYTES }),
  (rng) => { const n = gen.float(0.01, 1000)(rng); return { raw: `-${n}`, expected: DEFAULT_MAX_UPLOAD_BYTES }; },
  (rng) => {
    const raw = gen.string({ maxLength: 8 })(rng);
    const t = raw.trim();
    const n = Number(t);
    const ok = /^[0-9]+$/.test(t) && Number.isSafeInteger(n) && n > 0;
    return { raw, expected: ok ? n * MB : DEFAULT_MAX_UPLOAD_BYTES };
  },
);

// EXPORT_TIMEOUT_MIN 候选值：{ raw, expected }，expected 为期望的 timeoutMs。
const timeoutCase = gen.oneOf(
  (rng) => { const n = gen.int(1, 100_000)(rng); return { raw: pad(rng, String(n)), expected: n * 60000 }; },
  (rng) => { const n = gen.float(0.001, 10_000)(rng); return { raw: pad(rng, String(n)), expected: Math.round(n * 60000) }; },
  (rng) => ({ raw: pickFrom([undefined, '', '   ', '0', '0.0', '-0', '-1', '-0.5', 'abc', '5min', 'NaN',
    'Infinity', '-Infinity', '1e400'])(rng),
  expected: DEFAULT_TIMEOUT_MS }),
  (rng) => {
    const raw = gen.string({ maxLength: 8 })(rng);
    const n = Number(raw);
    const ok = raw.trim() !== '' && Number.isFinite(n) && n > 0;
    return { raw, expected: ok ? Math.round(n * 60000) : DEFAULT_TIMEOUT_MS };
  },
);

// Feature: stem-video-export, Property 6: 配置读取回退默认值
// **Validates: Requirements 6.5**
test('Property 6: invalid EXPORT_MAX_UPLOAD_MB / EXPORT_TIMEOUT_MIN fall back to 10240 MB / 30 min', async () => {
  const caseGen = (rng) => ({ upload: maxUploadCase(rng), timeout: timeoutCase(rng) });
  await forAll(caseGen, ({ upload, timeout }) => {
    const env = {};
    if (upload.raw !== undefined) env.EXPORT_MAX_UPLOAD_MB = upload.raw;
    if (timeout.raw !== undefined) env.EXPORT_TIMEOUT_MIN = timeout.raw;
    const cfg = readExportConfig(env);
    assert.equal(cfg.maxUploadBytes, upload.expected, `EXPORT_MAX_UPLOAD_MB=${JSON.stringify(upload.raw)}`);
    assert.equal(cfg.timeoutMs, timeout.expected, `EXPORT_TIMEOUT_MIN=${JSON.stringify(timeout.raw)}`);
  }, { runs: RUNS });
});

// ---------------------------------------------------------------------------
// Property 7
// ---------------------------------------------------------------------------

const bytes = (min, max) => (rng) => {
  const n = gen.int(min, max)(rng);
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(rng() * 256);
  return b;
};

// 拼接后的任意切分：随机切点（可重复，产生空 chunk）。
const framingCase = (rng) => {
  const wav = bytes(12, 400)(rng);
  const source = bytes(1, 400)(rng);
  const total = wav.length + source.length;
  const cuts = gen.array(gen.int(0, total), { maxLength: 12 })(rng);
  if (bool(0.3)(rng)) cuts.push(wav.length); // 切点恰好落在边界
  cuts.sort((a, b) => a - b);
  return { wav, source, cuts };
};

// Feature: stem-video-export, Property 7: 上传分帧往返
// **Validates: Requirements 7.1**
test('Property 7: createBodySplitter reassembles wav and source parts for any chunking', async () => {
  await forAll(framingCase, ({ wav, source, cuts }) => {
    const body = Buffer.concat([wav, source]);
    const bounds = [0, ...cuts, body.length];
    const splitter = createBodySplitter(wav.length);
    const wavParts = [];
    const sourceParts = [];
    let sawSource = false;
    for (let i = 0; i + 1 < bounds.length; i++) {
      for (const seg of splitter.feed(body.subarray(bounds[i], bounds[i + 1]))) {
        if (seg.part === 'wav') {
          assert.equal(sawSource, false, 'wav segment after a source segment');
          wavParts.push(seg.data);
        } else {
          assert.equal(seg.part, 'source');
          sawSource = true;
          sourceParts.push(seg.data);
        }
      }
      assert.equal(splitter.received(), bounds[i + 1]);
    }
    assert.ok(Buffer.concat(wavParts).equals(wav), 'wav parts differ from original WAV');
    assert.ok(Buffer.concat(sourceParts).equals(source), 'source parts differ from original file');
    assert.equal(splitter.received(), body.length);
  }, { runs: RUNS });
});

// ---------------------------------------------------------------------------
// Property 8
// ---------------------------------------------------------------------------

const randomCase = (rng, s) => Array.from(s, (c) => (rng() < 0.5 ? c.toUpperCase() : c)).join('');

const extRaw = gen.oneOf(
  pickFrom(UPLOAD_EXTS),
  (rng) => randomCase(rng, pickFrom(UPLOAD_EXTS)(rng)),
  (rng) => '.' + randomCase(rng, pickFrom(UPLOAD_EXTS)(rng)),
  (rng) => '..' + pickFrom(UPLOAD_EXTS)(rng),
  (rng) => pickFrom(UPLOAD_EXTS)(rng) + pickFrom([' ', '.', 'x', '/', '\0'])(rng),
  pickFrom([null, '', '.', 'bin', 'exe', 'mp5', 'mp4/../x', 'avi', 'MP4 ']),
  gen.string({ maxLength: 6 }),
);

const wavRaw = (max) => gen.oneOf(
  (rng) => String(gen.int(12, Math.min(max, Number.MAX_SAFE_INTEGER))(rng)),
  (rng) => String(gen.int(0, 11)(rng)),
  pickFrom([null, '', '12', '11', String(max), String(max + 1), '0012', '+12', '-12', '12.0', ' 12',
    '12 ', '1e3', '0x20', 'abc', '99999999999999999999999']),
  (rng) => String(max + gen.int(1, 1000)(rng)),
  gen.string({ maxLength: 6 }),
);

const queryCase = (rng) => {
  const max = gen.oneOf(gen.int(12, 4096), gen.int(4096, 10240 * MB))(rng);
  return { max, ext: extRaw(rng), wavBytes: wavRaw(max)(rng) };
};

// Feature: stem-video-export, Property 8: 上传参数与 WAV 头校验
// **Validates: Requirements 7.4**
test('Property 8a: parseExportQuery accepts exactly whitelisted ext and 12 <= wavBytes <= max', async () => {
  await forAll(queryCase, ({ max, ext, wavBytes }) => {
    const params = new URLSearchParams();
    if (ext !== null) params.set('ext', ext);
    if (wavBytes !== null) params.set('wavBytes', wavBytes);
    const r = parseExportQuery(params, max);

    const normExt = typeof ext === 'string' ? ext.replace(/^\./, '').toLowerCase() : null;
    const extOk = normExt !== null && UPLOAD_EXTS.includes(normExt);
    const wavOk = typeof wavBytes === 'string' && /^[0-9]+$/.test(wavBytes) &&
      Number(wavBytes) >= 12 && Number(wavBytes) <= max;

    assert.equal(r.ok, extOk && wavOk, `result ${JSON.stringify(r)}`);
    if (r.ok) {
      assert.equal(r.ext, normExt);
      assert.equal(r.wavBytes, Number(wavBytes));
    } else {
      assert.equal(typeof r.error, 'string');
      assert.ok(r.error.length > 0);
    }
  }, { runs: RUNS });
});

const headerCase = (rng) => {
  const b = bytes(0, 40)(rng);
  if (bool(0.6)(rng) && b.length >= 4) b.write('RIFF', 0, 'latin1');
  if (bool(0.6)(rng) && b.length >= 12) b.write('WAVE', 8, 'latin1');
  if (bool(0.3)(rng) && b.length > 0) {
    const i = gen.int(0, Math.min(11, b.length - 1))(rng); // 在头部随机改一个字节
    b[i] = Math.floor(rng() * 256);
  }
  if (bool(0.1)(rng) && b.length >= 12) b.write('riff', 0, 'latin1');
  return b;
};

// Feature: stem-video-export, Property 8: 上传参数与 WAV 头校验
// **Validates: Requirements 7.4**
test('Property 8b: isRiffWave is true iff length >= 12 and bytes 0-3 = RIFF, 8-11 = WAVE', async () => {
  await forAll(headerCase, (buf) => {
    const expected = buf.length >= 12 &&
      buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE';
    assert.equal(isRiffWave(buf), expected);
    assert.equal(isRiffWave(new Uint8Array(buf)), expected);
  }, { runs: RUNS });
});

// ---------------------------------------------------------------------------
// Property 13
// ---------------------------------------------------------------------------

const HEX = '0123456789abcdef';
const jobId = (rng) => {
  let s = '';
  for (let i = 0; i < 32; i++) s += HEX[Math.floor(rng() * 16)];
  return s;
};

const tempRootGen = gen.oneOf(
  (rng) => path.join(os.tmpdir(), 'cengjian-export', jobId(rng).slice(0, 8)),
  (rng) => path.resolve('export-tmp', jobId(rng).slice(0, 6)),
  () => path.join(os.tmpdir(), 'cengjian-export'),
);

const invalidId = gen.oneOf(
  (rng) => jobId(rng).toUpperCase(),
  (rng) => jobId(rng).slice(0, 31),
  (rng) => jobId(rng) + pickFrom(['0', '/', '/..', '\0', ' '])(rng),
  (rng) => '../' + jobId(rng).slice(3),
  (rng) => jobId(rng).slice(0, 16) + '/' + jobId(rng).slice(0, 15),
  pickFrom(['', '..', '.', null, undefined, 123]),
  gen.string({ maxLength: 40 }),
);

const invalidExt = gen.oneOf(
  (rng) => pickFrom(UPLOAD_EXTS)(rng).toUpperCase(),
  (rng) => '.' + pickFrom(UPLOAD_EXTS)(rng),
  (rng) => pickFrom(UPLOAD_EXTS)(rng) + pickFrom(['/../x', '\0', ' ', '.exe'])(rng),
  pickFrom(['', 'bin', 'exe', 'sh', null, undefined, 4]),
  gen.string({ maxLength: 8 }),
);

const pathsCase = (rng) => {
  const kind = gen.int(0, 2)(rng); // 0 合法，1 非法 id，2 非法扩展名
  return {
    tempRoot: tempRootGen(rng),
    id: kind === 1 ? invalidId(rng) : jobId(rng),
    ext: kind === 2 ? invalidExt(rng) : pickFrom(UPLOAD_EXTS)(rng),
  };
};

const isJobIdModel = (id) => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);

// Feature: stem-video-export, Property 13: 临时路径只由服务器值组成
// **Validates: Requirements 10.2**
test('Property 13: exportJobPaths stays under tempRoot/id and rejects invalid id or ext', async () => {
  await forAll(pathsCase, ({ tempRoot, id, ext }) => {
    const valid = isJobIdModel(id) && UPLOAD_EXTS.includes(ext);
    if (!valid) {
      assert.throws(() => exportJobPaths(tempRoot, id, ext));
      return;
    }
    const p = exportJobPaths(tempRoot, id, ext);
    const dir = path.join(tempRoot, id);
    assert.equal(p.dir, dir);
    const expected = { audio: 'audio.wav', input: `input.${ext}`, output: 'output.mp4' };
    for (const [key, name] of Object.entries(expected)) {
      assert.equal(p[key], path.join(dir, name), key);
      assert.equal(path.dirname(p[key]), dir, `${key} not directly under job dir`);
      assert.equal(path.basename(p[key]), name, key);
      const rel = path.relative(dir, p[key]);
      assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), `${key} escapes job dir`);
    }
  }, { runs: RUNS });
});

// ---------------------------------------------------------------------------
// Property 9
// ---------------------------------------------------------------------------

const two = (n) => String(n).padStart(2, '0');
const VIDEO_CODECS = ['h264', 'hevc', 'vp9', 'av1', 'mpeg4', 'mjpeg', 'png', 'prores', 'H264', 'HEVC', 'VP8', 'msmpeg4v3'];
const streamTag = pickFrom(['', '[0x1]', '[0x1e0]', '(und)', '(eng)', '[0x2](und)', '[0x101](jpn)']);
const CONTAINERS = ['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm', 'avi', 'mpegts', 'flv', 'mp3', 'wav'];

/** 一条随机流：{ kind, codec?, attached?, line(index) }。 */
const streamGen = (rng) => {
  const kind = pickFrom(['Video', 'Video', 'Audio', 'Subtitle', 'Data'])(rng);
  const tag = streamTag(rng);
  if (kind === 'Video') {
    const codec = pickFrom(VIDEO_CODECS)(rng);
    const attached = bool(0.3)(rng);
    const detail = pickFrom([' (High) (avc1 / 0x31637661)', ' (Main)', '', ' (Baseline)'])(rng);
    const tail = pickFrom([', yuv420p, 1920x1080, 30 fps, 30 tbr', ', yuvj420p(pc), 600x600, 90k tbn', ', rgb24, 320x240'])(rng);
    const disp = attached ? ' (attached pic)' : pickFrom(['', ' (default)'])(rng);
    return { kind, codec, attached, line: (i) => `  Stream #0:${i}${tag}: Video: ${codec}${detail}${tail}${disp}` };
  }
  if (kind === 'Audio') {
    const codec = pickFrom(['aac (LC) (mp4a / 0x6134706D)', 'mp3', 'opus', 'pcm_s16le'])(rng);
    return { kind, line: (i) => `  Stream #0:${i}${tag}: Audio: ${codec}, 44100 Hz, stereo, fltp, 128 kb/s` };
  }
  if (kind === 'Subtitle') return { kind, line: (i) => `  Stream #0:${i}${tag}: Subtitle: mov_text (tx3g / 0x67337874)` };
  return { kind, line: (i) => `  Stream #0:${i}${tag}: Data: none (rtp  / 0x20707472)` };
};

const probeCase = (rng) => {
  const hundredths = bool(0.2)(rng) ? null : gen.int(1, 99 * 3600 * 100)(rng);
  const streams = gen.array(streamGen, { maxLength: 7 })(rng);
  const container = pickFrom(CONTAINERS)(rng);
  const crlf = bool(0.3)(rng);
  return { hundredths, streams, container, crlf };
};

const renderProbe = ({ hundredths, streams, container, crlf }) => {
  let dur = 'N/A';
  if (hundredths !== null) {
    const s = Math.floor(hundredths / 100);
    dur = `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}.${two(hundredths % 100)}`;
  }
  const lines = [
    `Input #0, ${container}, from 'input.mp4':`,
    '  Metadata:',
    '    major_brand     : isom',
    '    encoder         : Lavf60.3.100',
    `  Duration: ${dur}, start: 0.000000, bitrate: ${dur === 'N/A' ? 'N/A' : '1234 kb/s'}`,
    ...streams.map((s, i) => s.line(i)),
    'At least one output file must be specified',
  ];
  return lines.join(crlf ? '\r\n' : '\n') + (crlf ? '\r\n' : '\n');
};

// Feature: stem-video-export, Property 9: 探测输出解析
// **Validates: Requirements 8.2, 8.3, 8.8, 9.3**
test('Property 9: parseProbeOutput finds first non-attached video stream, its ordinal and the duration', async () => {
  await forAll(probeCase, (c) => {
    const r = parseProbeOutput(renderProbe(c));
    assert.equal(r.hasInput, true);

    const videos = c.streams.filter((s) => s.kind === 'Video');
    const idx = videos.findIndex((s) => !s.attached);
    if (idx < 0) {
      assert.equal(r.video, null);
    } else {
      assert.deepEqual(r.video, { codec: videos[idx].codec.toLowerCase(), ordinal: idx });
    }

    if (c.hundredths === null) assert.equal(r.durationSec, null);
    else assert.ok(Math.abs(r.durationSec - c.hundredths / 100) < 0.01, `durationSec ${r.durationSec}`);
  }, { runs: RUNS });
});

// ---------------------------------------------------------------------------
// Property 10
// ---------------------------------------------------------------------------

const muxCase = (rng) => {
  const root = pickFrom(['/tmp/cengjian-export', 'C:\\Temp\\cengjian-export', '/var/tmp/x y'])(rng);
  const id = jobId(rng);
  const ext = pickFrom(UPLOAD_EXTS)(rng);
  return {
    fixed: gen.array(pickFrom(['-loglevel', 'error', '-threads', '2', '--', 'x']), { maxLength: 3 })(rng),
    video: { codec: pickFrom(['h264', 'hevc', 'vp9', 'av1', 'mpeg4', 'mjpeg', 'prores', 'png'])(rng), ordinal: gen.int(0, 6)(rng) },
    durationSec: gen.oneOf(() => null, gen.float(0.001, 36000), (rng) => gen.int(1, 3600)(rng))(rng),
    paths: {
      dir: path.join(root, id),
      input: path.join(root, id, `input.${ext}`),
      audio: path.join(root, id, 'audio.wav'),
      output: path.join(root, id, 'output.mp4'),
    },
  };
};

/** args 中是否连续出现 seq。 */
const hasSeq = (args, seq) => {
  for (let i = 0; i + seq.length <= args.length; i++) {
    if (seq.every((v, j) => args[i + j] === v)) return true;
  }
  return false;
};

// Feature: stem-video-export, Property 10: 合成参数规则
// **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7**
test('Property 10: buildMuxArgs maps video + stem only, copies h264/hevc, pads audio and cuts to duration', async () => {
  await forAll(muxCase, ({ fixed, video, durationSec, paths }) => {
    const args = buildMuxArgs(fixed, video, durationSec, paths);
    const body = args.slice(fixed.length);
    assert.deepEqual(args.slice(0, fixed.length), fixed, 'fixed args first');

    // 映射：只有原视频的第 ordinal 个视频流和音轨 WAV 的音频
    assert.ok(hasSeq(body, ['-map', `0:v:${video.ordinal}`]));
    assert.ok(hasSeq(body, ['-map', '1:a:0']));
    const maps = body.filter((_, i) => body[i - 1] === '-map');
    assert.deepEqual(maps, [`0:v:${video.ordinal}`, '1:a:0']);
    assert.ok(!body.some((a) => /^0:a/.test(a)), 'original audio must not be mapped');

    // 视频编码
    const copy = video.codec === 'h264' || video.codec === 'hevc';
    if (copy) {
      assert.ok(hasSeq(body, ['-c:v', 'copy']));
      assert.ok(!body.includes('libx264'));
    } else {
      assert.ok(hasSeq(body, X264_ARGS), 'full X264_ARGS');
      assert.ok(!hasSeq(body, ['-c:v', 'copy']));
    }
    assert.equal(hasSeq(body, ['-tag:v', 'hvc1']), video.codec === 'hevc');

    // 音频与容器
    assert.ok(hasSeq(body, ['-c:a', 'aac', '-b:a', '192k']));
    assert.ok(hasSeq(body, ['-af', 'apad']));
    assert.ok(hasSeq(body, ['-movflags', '+faststart']));
    assert.ok(hasSeq(body, ['-progress', 'pipe:1', '-nostats']));

    // 时长
    if (durationSec !== null) {
      const t = formatSeconds(durationSec);
      assert.ok(hasSeq(body, ['-t', t]));
      assert.ok(Math.abs(Number(t) - durationSec) <= 0.0005 + 1e-9, `-t ${t} vs ${durationSec}`);
      assert.ok(!body.includes('-shortest'));
    } else {
      assert.ok(body.includes('-shortest'));
      assert.ok(!body.includes('-t'));
    }

    // 路径参数全部来自 paths
    assert.equal(args[args.length - 1], paths.output);
    const inputs = body.filter((_, i) => body[i - 1] === '-i');
    assert.deepEqual(inputs, [paths.input, paths.audio]);
    const pathValues = new Set([paths.input, paths.audio, paths.output]);
    for (const a of body) {
      if (a.includes(paths.dir)) assert.ok(pathValues.has(a), `unexpected path arg ${a}`);
    }

    // 探测命令：只有输入，没有输出文件
    const probe = buildProbeArgs(fixed, paths);
    assert.deepEqual(probe, [...fixed, '-hide_banner', '-nostdin', '-i', paths.input]);
  }, { runs: RUNS });
});

// ---------------------------------------------------------------------------
// Property 11
// ---------------------------------------------------------------------------

const outTimeVal = gen.oneOf(gen.int(0, 4_000_000_000), gen.int(0, 1000), () => 'N/A');

const progressCase = (rng) => {
  const nl = bool(0.3)(rng) ? '\r\n' : '\n';
  const blocks = gen.array((r) => ({
    key: pickFrom(['out_time_us', 'out_time_ms', 'both', 'none'])(r),
    us: outTimeVal(r),
    ms: outTimeVal(r),
  }), { minLength: 0, maxLength: 8 })(rng);
  const durationSec = gen.oneOf(() => null, gen.float(0.01, 4000), gen.int(1, 600))(rng);
  let text = '';
  let lastUs = 0;
  blocks.forEach((b, i) => {
    const lines = [`frame=${i * 30}`, 'fps=30.0', 'bitrate=1000.0kbits/s'];
    if (b.key === 'out_time_us' || b.key === 'both') lines.push(`out_time_us=${b.us}`);
    if (b.key === 'out_time_ms' || b.key === 'both') lines.push(`out_time_ms=${b.ms}`);
    lines.push('out_time=00:00:01.000000', 'speed=1.0x', `progress=${i === blocks.length - 1 ? 'end' : 'continue'}`);
    for (const l of lines) {
      const m = /^out_time_(us|ms)=(\d+)$/.exec(l);
      if (m) lastUs = Number(m[2]);
    }
    text += lines.join(nl) + nl;
  });
  const cuts = gen.array(gen.int(0, text.length), { maxLength: 15 })(rng).sort((a, b) => a - b);
  return { text, cuts, durationSec, lastUs };
};

// Feature: stem-video-export, Property 11: 进度解析与切分无关
// **Validates: Requirements 9.2, 9.3**
test('Property 11: createProgressParser result depends only on the last valid out_time, not on chunking', async () => {
  await forAll(progressCase, ({ text, cuts, durationSec, lastUs }) => {
    const expected = durationSec === null
      ? null
      : Math.min(100, Math.max(0, Math.round(lastUs / 1e6 / durationSec * 100)));

    const chunked = createProgressParser(durationSec);
    const bounds = [0, ...cuts, text.length];
    for (let i = 0; i + 1 < bounds.length; i++) chunked.feed(text.slice(bounds[i], bounds[i + 1]));
    const whole = createProgressParser(durationSec);
    whole.feed(text);

    assert.equal(chunked.progress(), expected);
    assert.equal(whole.progress(), expected);
  }, { runs: RUNS });
});

// ---------------------------------------------------------------------------
// Property 16
// ---------------------------------------------------------------------------

const tVal = gen.oneOf(gen.float(-100, 100), gen.float(0, 10000), gen.float(-1e12, 1e12), pickFrom([0, -0, 1e-300]));
const percentCase = (rng) => {
  const validD = bool(0.8)(rng);
  const d = validD
    ? gen.oneOf(gen.float(1e-6, 1), gen.float(1, 10000), pickFrom([Number.MIN_VALUE, 1e300]))(rng)
    : pickFrom([0, -0, -1, -1e-9, NaN, Infinity, -Infinity, null, undefined, '10'])(rng);
  const a = tVal(rng);
  const b = tVal(rng);
  return { d, validD, t1: Math.min(a, b), t2: Math.max(a, b) };
};

// Feature: stem-video-export, Property 16: 进度百分比
// **Validates: Requirements 9.2, 12.5**
test('Property 16: progressPercent is a clamped rounded integer, monotone in t, null for invalid d', async () => {
  await forAll(percentCase, ({ d, validD, t1, t2 }) => {
    const p1 = progressPercent(t1, d);
    const p2 = progressPercent(t2, d);
    if (!validD) {
      assert.equal(p1, null);
      assert.equal(p2, null);
      return;
    }
    for (const [t, p] of [[t1, p1], [t2, p2]]) {
      assert.ok(Number.isInteger(p) && p >= 0 && p <= 100, `p=${p}`);
      assert.equal(p, Math.min(100, Math.max(0, Math.round(t / d * 100))));
    }
    assert.ok(p1 <= p2, `not monotone: ${p1} > ${p2}`);
  }, { runs: RUNS });
});
