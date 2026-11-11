// 带可视化导出的 Server 端纯函数属性测试：查询参数、三段分帧、尺寸解析、帧计划、合成参数、帧泵背压。
// 运行：node --test tests/vis-export-props.test.mjs（PROP_SEED=<种子> 复现失败序列）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { forAll, gen } from './helpers/prop.mjs';
import {
  parseVisQuery,
  createPartSplitter,
  parseProbeVideoSize,
  fitEven,
  visRenderPlan,
  buildVisMuxArgs,
  pumpFrames,
  formatSeconds,
  X264_ARGS,
  VIS_FPS,
  VIS_LAYOUTS,
} from '../export-service.js';
import { stackedLayout } from '../public/js/vis-lanes.js';

const RUNS = 150;
const VIS_MAX = 16777216;

const pickFrom = (list) => (rng) => list[Math.floor(rng() * list.length)];
const bool = (p = 0.5) => (rng) => rng() < p;

/** haystack 中是否有连续子序列 needle。 */
function hasSeq(haystack, needle) {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** fitEven 结果与原尺寸的宽高比相对误差。 */
const ratioError = (r, w, h) => Math.abs((r.w * h) / (r.h * w) - 1);

/**
 * 按比例放进框内（不放大）的精确短边。小于 2 时 fitEven 必须把它抬到 2，
 * 宽高比误差界 2 / min(结果宽, 结果高) 在这种极端比例下不可能成立，因此只在 ≥ 2 时检查。
 */
const exactMinSide = (w, h, bw, bh) => {
  const s = Math.min(1, bw / w, bh / h);
  return Math.min(w * s, h * s);
};

// ---------------------------------------------------------------------------
// Property 19
// ---------------------------------------------------------------------------

const visBytesGen = gen.oneOf(
  () => null,
  () => null,
  (rng) => String(gen.int(2, VIS_MAX)(rng)),
  (rng) => String(gen.int(0, 4000)(rng)),
  pickFrom(['', '0', '1', '2', '3', '16777215', '16777216', '16777217', '0002', '00000000016777216',
    '-1', '-5', '+5', '1.5', '2.0', '1e3', ' 5', '5 ', '\t7', '0x10', '0X1F', 'abc', '12abc',
    'NaN', 'Infinity', '99999999999999999999', '9007199254740993', '１２', '٣']),
  (rng) => `-${gen.int(1, VIS_MAX)(rng)}`,
  (rng) => `${gen.int(2, 1000)(rng)}.${gen.int(0, 99)(rng)}`,
  (rng) => ` ${gen.int(2, 1000)(rng)}`,
  (rng) => `0x${gen.int(2, 1000)(rng).toString(16)}`,
  (rng) => String(gen.int(VIS_MAX + 1, 2 ** 40)(rng)),
  gen.string({ maxLength: 6 }),
);

const layoutGen = gen.oneOf(
  () => null,
  () => null,
  pickFrom(['stacked', 'standalone']),
  pickFrom(['stacked', 'standalone']),
  () => 'overlay',
  pickFrom(['', 'Stacked', 'STACKED', 'Standalone', 'STANDALONE', ' stacked', 'stacked ', 'standalone\n',
    'Overlay', 'overlay ', 'stack', 'stand-alone', 'both', 'none', 'stacked,standalone']),
  gen.string({ maxLength: 8 }),
);

// Feature: stem-lanes, Property 16: 布局参数校验
// **Validates: Requirements 11.2**
test('Property 16 (stem-lanes): parseVisQuery accepts only both-missing or a valid visBytes + stacked/standalone', async () => {
  assert.deepEqual([...VIS_LAYOUTS], ['stacked', 'standalone']);
  const caseGen = (rng) => ({ visBytes: visBytesGen(rng), layout: layoutGen(rng), ext: bool()(rng) });
  await forAll(caseGen, ({ visBytes, layout, ext }) => {
    const sp = new URLSearchParams();
    if (ext) {
      sp.set('ext', 'mp4');
      sp.set('wavBytes', '1000');
    }
    if (visBytes !== null) sp.set('visBytes', visBytes);
    if (layout !== null) sp.set('layout', layout);
    const r = parseVisQuery(sp);
    if (visBytes === null && layout === null) {
      assert.deepEqual(r, { ok: true, vis: null });
      return;
    }
    const n = Number(visBytes);
    const valid = visBytes !== null && layout !== null &&
      /^\d+$/.test(visBytes) && n >= 2 && n <= VIS_MAX && (layout === 'stacked' || layout === 'standalone');
    if (layout === 'overlay') assert.equal(r.ok, false, 'overlay is rejected');
    if (valid) {
      assert.deepEqual(r, { ok: true, vis: { visBytes: n, layout } });
    } else {
      assert.equal(r.ok, false);
      assert.equal(typeof r.error, 'string');
      assert.ok(r.error.length > 0);
    }
  }, { runs: 400 });
});

// ---------------------------------------------------------------------------
// Property 20
// ---------------------------------------------------------------------------

const bytes = (min, max) => (rng) => {
  const n = gen.int(min, max)(rng);
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.floor(rng() * 256);
  return b;
};

// Feature: stem-visualizer, Property 20: 三段分帧往返
// **Validates: Requirements 10.1, 10.7**
test('Property 20: createPartSplitter([wav, payload]) reassembles WAV, payload and source for any chunking', async () => {
  const caseGen = (rng) => {
    const wav = bytes(12, 300)(rng);
    const payload = bytes(2, 300)(rng);
    const source = bytes(1, 300)(rng);
    const total = wav.length + payload.length + source.length;
    const cuts = gen.array(gen.int(0, total), { maxLength: 12 })(rng).sort((a, b) => a - b);
    return { wav, payload, source, cuts };
  };
  await forAll(caseGen, ({ wav, payload, source, cuts }) => {
    const all = Buffer.concat([wav, payload, source]);
    const splitter = createPartSplitter([wav.length, payload.length]);
    const parts = [[], [], []];
    let lastPart = 0;
    let prev = 0;
    for (const end of [...cuts, all.length]) {
      for (const { part, data } of splitter.feed(all.subarray(prev, end))) {
        assert.ok(part >= 0 && part <= 2, `part index ${part}`);
        assert.ok(part >= lastPart, 'parts arrive in order');
        assert.ok(data.length > 0, 'no empty pieces');
        lastPart = part;
        parts[part].push(data);
      }
      prev = end;
    }
    assert.deepEqual(Buffer.concat(parts[0]), Buffer.from(wav));
    assert.deepEqual(Buffer.concat(parts[1]), Buffer.from(payload));
    assert.deepEqual(Buffer.concat(parts[2]), Buffer.from(source));
    assert.equal(splitter.received(), all.length);
  }, { runs: RUNS });
});

// ---------------------------------------------------------------------------
// Property 21
// ---------------------------------------------------------------------------

const VIDEO_CODECS = [
  'h264 (High) (avc1 / 0x31637661)',
  'hevc (Main) (hvc1 / 0x31637668)',
  'vp9 (Profile 0)',
  'mjpeg (Baseline)',
  'mpeg4 (Simple Profile) (mp4v / 0x7634706D)',
];
const STREAM_TAGS = ['', '[0x1](und)', '(eng)', '[0x101]'];

/** 按 FFmpeg 探测输出格式生成的文本，以及每条 Video 流的期望显示尺寸。 */
const probeGen = (rng) => {
  const count = gen.int(1, 5)(rng);
  const kinds = Array.from({ length: count }, () => (bool(0.6)(rng) ? 'video' : 'audio'));
  if (!kinds.includes('video')) kinds[gen.int(0, count - 1)(rng)] = 'video';
  const lines = [
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'in.mp4':",
    '  Metadata:',
    '    major_brand     : isom',
    '    encoder         : Lavf60.3.100',
    `  Duration: 00:0${gen.int(0, 9)(rng)}:12.34, start: 0.000000, bitrate: 2345 kb/s`,
  ];
  const expected = [];
  kinds.forEach((kind, idx) => {
    const tag = pickFrom(STREAM_TAGS)(rng);
    if (kind === 'audio') {
      lines.push(`  Stream #0:${idx}${tag}: Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)`);
      lines.push('    Metadata:', '      handler_name    : SoundHandler');
      return;
    }
    const width = gen.int(16, 7680)(rng);
    const height = gen.int(16, 7680)(rng);
    const attached = bool(0.25)(rng);
    const rotation = pickFrom([null, null, 90, -90, 180, -180])(rng);
    lines.push(
      `  Stream #0:${idx}${tag}: Video: ${pickFrom(VIDEO_CODECS)(rng)}, yuv420p(tv, bt709, progressive), ` +
      `${width}x${height} [SAR 1:1 DAR 16:9], 2000 kb/s, 30 fps, 30 tbr, 15360 tbn${attached ? ' (attached pic)' : ' (default)'}`,
    );
    lines.push('    Metadata:', '      handler_name    : VideoHandler');
    if (rotation !== null) lines.push('    Side data:', `      displaymatrix: rotation of ${rotation.toFixed(2)} degrees`);
    const swap = rotation === 90 || rotation === -90;
    expected.push(swap ? { width: height, height: width } : { width, height });
  });
  lines.push('At least one output file must be specified');
  const eol = bool(0.2)(rng) ? '\r\n' : '\n';
  return { text: lines.join(eol), expected, ordinal: gen.int(0, expected.length - 1)(rng) };
};

// Feature: stem-visualizer, Property 21: 尺寸解析与渲染分辨率
// **Validates: Requirements 11.1, 11.5**
test('Property 21a: parseProbeVideoSize returns the ordinal-th Video stream size, swapped for ±90° rotation', async () => {
  await forAll(probeGen, ({ text, expected, ordinal }) => {
    assert.deepEqual(parseProbeVideoSize(text, ordinal), expected[ordinal]);
  }, { runs: RUNS });
});

// Feature: stem-visualizer, Property 21: 尺寸解析与渲染分辨率
// **Validates: Requirements 11.1, 11.5**
test('Property 21b: fitEven yields even sizes ≥ 2 inside the box and the source, keeping the aspect ratio', async () => {
  const side = gen.oneOf(gen.int(2, 64), gen.int(2, 8000));
  const boxGen = gen.oneOf(
    pickFrom([[640, 360], [1920, 1080], [1280, 720]]),
    (rng) => [side(rng), side(rng)],
  );
  const caseGen = (rng) => {
    const [boxW, boxH] = boxGen(rng);
    return { width: side(rng), height: side(rng), boxW, boxH };
  };
  await forAll(caseGen, ({ width, height, boxW, boxH }) => {
    const r = fitEven(width, height, boxW, boxH);
    assert.ok(r, 'result');
    for (const v of [r.w, r.h]) {
      assert.ok(Number.isInteger(v) && v >= 2 && v % 2 === 0, `even ≥ 2: ${v}`);
    }
    const evenDown = (n) => Math.max(2, n - (n % 2));
    assert.ok(r.w <= boxW && r.h <= boxH, 'inside box');
    assert.ok(r.w <= evenDown(width) && r.h <= evenDown(height), 'no upscaling');
    if (exactMinSide(width, height, boxW, boxH) >= 2) {
      const err = ratioError(r, width, height);
      assert.ok(err <= 2 / Math.min(r.w, r.h) + 1e-12, `aspect error ${err} for ${r.w}x${r.h}`);
    }
  }, { runs: 400 });
});

// ---------------------------------------------------------------------------
// Property 22
// ---------------------------------------------------------------------------

const planInputGen = (rng) => ({
  layout: pickFrom(['stacked', 'standalone'])(rng),
  probeDuration: bool(0.3)(rng) ? null : gen.oneOf(gen.float(0.01, 10), gen.float(0.01, 4000))(rng),
  payloadDuration: gen.oneOf(gen.float(0.01, 10), gen.float(0.01, 3600))(rng),
  videoSize: bool(0.25)(rng)
    ? null
    : gen.oneOf(
      (r) => ({ width: gen.int(16, 7680)(r), height: gen.int(16, 7680)(r) }),
      (r) => ({ width: gen.int(1, 64)(r), height: gen.int(1, 8192)(r) }),
      (r) => ({ width: gen.int(1, 8192)(r), height: gen.int(1, 64)(r) }),
    )(rng),
});

const even = (n) => n - (n % 2);

// Feature: stem-lanes, Property 14: 叠放渲染计划
// **Validates: Requirements 12.3, 12.4, 12.5**
test('Property 14 (stem-lanes): visRenderPlan picks D, frames = ceil(D × 30) and the stacked / standalone sizes', async () => {
  await forAll(planInputGen, (input) => {
    const plan = visRenderPlan(input);
    const D = input.probeDuration !== null ? input.probeDuration : input.payloadDuration;
    assert.equal(plan.layout, input.layout);
    assert.equal(plan.D, D);
    assert.equal(plan.frames, Math.ceil(D * VIS_FPS));
    assert.equal(VIS_FPS, 30);
    const { render, output } = plan;
    for (const v of [render.w, render.h, output.w, output.h]) {
      assert.ok(Number.isInteger(v) && v >= 2 && v % 2 === 0, `even ≥ 2: ${v}`);
    }
    if (input.layout === 'standalone') {
      assert.deepEqual(render, { w: 640, h: 360 });
      assert.deepEqual(output, { w: 1280, h: 720 });
      return;
    }
    const [w, h] = input.videoSize ? [input.videoSize.width, input.videoSize.height] : [1280, 720];
    const s = stackedLayout(w, h, 1920, 1920);
    assert.deepEqual(plan.picture, { w: s.width, h: s.pictureHeight });
    assert.deepEqual(plan.strip, { w: s.width, h: s.stripHeight });
    assert.deepEqual(output, { w: s.width, h: s.pictureHeight + s.stripHeight });
    assert.equal(output.h, plan.picture.h + plan.strip.h);
    assert.ok(output.w <= 1920 && output.h <= 1920, `output ${output.w}x${output.h}`);
    assert.equal(render.w, even(Math.min(output.w, 960)));
    assert.equal(render.h, Math.max(2, even(Math.round((plan.strip.h * render.w) / output.w))));
    assert.ok(render.w <= plan.strip.w && render.h <= plan.strip.h, `render ${render.w}x${render.h}`);
  }, { runs: 300 });
});

// ---------------------------------------------------------------------------
// Property 23
// ---------------------------------------------------------------------------

const segment = (rng) => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789-_ 层音';
  const n = gen.int(1, 10)(rng);
  let s = '';
  for (let i = 0; i < n; i++) s += chars[Math.floor(rng() * chars.length)];
  return s;
};

const muxCaseGen = (rng) => {
  const root = pickFrom(['/tmp/cengjian-export', 'C:\\Temp\\cengjian export', '/var/tmp/导出'])(rng);
  const id = segment(rng);
  const sep = root.includes('\\') ? '\\' : '/';
  return {
    fixedArgs: pickFrom([[], ['-threads', '2'], ['-loglevel', 'info'], ['-hwaccel', 'none', '-threads', '1']])(rng),
    plan: visRenderPlan(planInputGen(rng)),
    video: { codec: pickFrom(['h264', 'hevc', 'vp9', 'mpeg4', 'prores'])(rng), ordinal: gen.int(0, 4)(rng) },
    paths: {
      input: `${root}${sep}${id}${sep}input.${pickFrom(['mp4', 'mov', 'mkv', 'webm', 'mp3'])(rng)}`,
      audio: `${root}${sep}${id}${sep}audio.wav`,
      output: `${root}${sep}${id}${sep}output.mp4`,
    },
  };
};

// Feature: stem-lanes, Property 15: 叠放合成参数
// **Validates: Requirements 12.6, 12.7**
test('Property 15 (stem-lanes): buildVisMuxArgs builds the rawvideo + WAV mux with the required filters and flags', async () => {
  await forAll(muxCaseGen, ({ fixedArgs, plan, video, paths }) => {
    const args = buildVisMuxArgs(fixedArgs, plan, video, paths);
    assert.ok(args.every((a) => typeof a === 'string'), 'all args are strings');
    assert.deepEqual(args.slice(0, fixedArgs.length), fixedArgs);
    const { w: RW, h: RH } = plan.render;
    const { w: OW, h: OH } = plan.output;
    assert.ok(hasSeq(args, ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${RW}x${RH}`, '-r', '30', '-i', 'pipe:0']),
      'rawvideo input');
    assert.ok(hasSeq(args, X264_ARGS), 'X264_ARGS');
    assert.ok(!hasSeq(args, ['-c:v', 'copy']), 'no -c:v copy');
    assert.ok(hasSeq(args, ['-c:a', 'aac', '-b:a', '192k']), 'aac 192k');
    assert.ok(hasSeq(args, ['-t', formatSeconds(plan.D)]), '-t D');
    assert.ok(hasSeq(args, ['-movflags', '+faststart']), 'faststart');
    assert.ok(hasSeq(args, ['-progress', 'pipe:1', '-nostats']), 'progress');
    assert.ok(!args.includes('-shortest'), 'no -shortest');
    assert.ok(!args.includes('-nostdin'), 'no -nostdin');
    assert.ok(args.includes(paths.audio), 'stem WAV is an input');

    const fc = args.indexOf('-filter_complex');
    assert.ok(fc >= 0, '-filter_complex');
    const graph = args[fc + 1];
    assert.ok(graph.includes('apad'), 'apad');
    for (const banned of ['blend', 'overlay', 'gbrp']) assert.ok(!graph.includes(banned), `no ${banned}`);

    const firstInput = args[args.indexOf('-i') + 1];
    if (plan.layout === 'stacked') {
      const PH = plan.picture.h;
      const SH = plan.strip.h;
      assert.equal(OH, PH + SH);
      assert.ok(graph.includes(`0:v:${video.ordinal}`), 'references 0:v:<ordinal>');
      assert.ok(graph.includes(`scale=${OW}:${PH}:force_original_aspect_ratio=decrease`), 'picture scale');
      assert.ok(graph.includes(`pad=${OW}:${PH}`), 'picture pad');
      assert.ok(graph.includes(`scale=${OW}:${SH}`), 'strip scale');
      assert.ok(graph.includes('vstack=inputs=2'), 'vstack');
      assert.equal(firstInput, paths.input);
    } else {
      assert.ok(graph.includes(`scale=${OW}:${OH}`), `scale=${OW}:${OH}`);
      assert.ok(!args.includes(paths.input), 'standalone does not read the source');
      assert.ok(!args.some((a) => a.includes(paths.input)), 'source path absent');
    }
    // 不映射原文件音频：任何参数（含滤镜图）里都不出现 0:a。
    const own = args.slice(fixedArgs.length).filter((a) => !Object.values(paths).includes(a));
    assert.ok(!own.some((a) => /(^|[^0-9])0:a/.test(a)), 'no 0:a');
    assert.equal(args[args.length - 1], paths.output);
  }, { runs: 300 });
});

// ---------------------------------------------------------------------------
// Property 24
// ---------------------------------------------------------------------------

/** 等待 n 个 setImmediate 周期。 */
async function ticks(n) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

const pumpCaseGen = (rng) => {
  const frames = gen.oneOf(gen.int(0, 8), gen.int(0, 200))(rng);
  const pFalse = pickFrom([0, 0.2, 0.5, 0.9])(rng);
  const interrupt = bool(0.5)(rng)
    ? null
    : {
      kind: pickFrom(['error', 'close', 'abort'])(rng),
      when: pickFrom(['pre', 'inRender', 'inWrite', 'afterWrite'])(rng),
      at: gen.int(0, frames)(rng),
      delay: gen.int(0, 3)(rng),
    };
  return {
    frames,
    poolSize: gen.int(1, 4)(rng),
    frameBytes: gen.int(1, 16)(rng),
    writeResults: Array.from({ length: frames }, () => rng() >= pFalse),
    cbDelays: Array.from({ length: frames }, () => gen.int(0, 4)(rng)),
    drainDelays: Array.from({ length: frames }, () => gen.int(0, 4)(rng)),
    yieldDelays: Array.from({ length: frames }, () => gen.int(0, 2)(rng)),
    interrupt,
  };
};

async function runPump(c) {
  const stdin = new EventEmitter();
  stdin.destroyed = false;
  const ac = new AbortController();
  const violations = [];
  const inFlight = new Set();
  const seenBuffers = new Set();
  const rendered = [];
  const written = [];
  let yields = 0;
  let awaitingDrain = false;
  let interrupted = false;
  let endCalls = 0;
  let endBeforeInterrupt = false;

  const fire = () => {
    if (interrupted) return;
    interrupted = true;
    if (endCalls > 0) endBeforeInterrupt = true;
    const { kind } = c.interrupt;
    if (kind === 'abort') ac.abort();
    else if (kind === 'error') {
      // 帧泵返回后已移除监听；真实服务另有吞掉 stdin 错误的监听，这里不再抛出。
      if (stdin.listenerCount('error') > 0) {
        stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      }
    }
    else stdin.emit('close');
  };
  const maybeFire = (when, index) => {
    const it = c.interrupt;
    if (!it || it.when !== when || it.at !== index) return;
    if (it.delay === 0) fire();
    else ticks(it.delay).then(fire);
  };

  stdin.write = (buf, cb) => {
    const k = written.length;
    if (interrupted) violations.push(`write after interrupt (frame ${k})`);
    if (awaitingDrain) violations.push(`write before drain (frame ${k})`);
    if (rendered.length !== k + 1) violations.push(`write ${k} without matching renderInto`);
    if (!(buf instanceof Uint8Array) || buf.length !== c.frameBytes) violations.push(`bad buffer at frame ${k}`);
    else if (buf[0] !== (k & 255) || (buf.length > 1 && buf[buf.length - 1] !== ((k * 7) & 255))) {
      violations.push(`frame ${k} content changed`);
    }
    if (inFlight.has(buf)) violations.push(`buffer written twice in flight (frame ${k})`);
    written.push(k);
    inFlight.add(buf);
    ticks(c.cbDelays[k]).then(() => {
      inFlight.delete(buf);
      cb();
    });
    const ok = c.writeResults[k];
    if (!ok) {
      awaitingDrain = true;
      ticks(c.drainDelays[k]).then(() => {
        awaitingDrain = false;
        stdin.emit('drain');
      });
    }
    maybeFire('inWrite', k);
    if (c.interrupt && c.interrupt.when === 'afterWrite' && c.interrupt.at === k) {
      ticks(c.interrupt.delay + 1).then(fire);
    }
    return ok;
  };
  stdin.end = () => {
    endCalls++;
  };

  const renderInto = (k, buf) => {
    if (interrupted) violations.push(`renderInto after interrupt (frame ${k})`);
    if (k !== rendered.length) violations.push(`renderInto out of order: ${k} after ${rendered.length}`);
    if (yields !== k) violations.push(`yieldFn called ${yields} times before frame ${k}`);
    if (inFlight.has(buf)) violations.push(`buffer reused before its write callback (frame ${k})`);
    seenBuffers.add(buf);
    rendered.push(k);
    buf.fill(0);
    if (buf.length > 1) buf[buf.length - 1] = (k * 7) & 255;
    buf[0] = k & 255;
    maybeFire('inRender', k);
  };
  const yieldFn = async () => {
    yields++;
    await ticks(c.yieldDelays[yields - 1] ?? 0);
  };

  if (c.interrupt && c.interrupt.when === 'pre') {
    interrupted = true;
    if (c.interrupt.kind === 'abort') ac.abort();
    else stdin.destroyed = true; // 已出错 / 已关闭的流
  }

  let timer;
  const result = await Promise.race([
    pumpFrames({
      frames: c.frames, frameBytes: c.frameBytes, renderInto, stdin, signal: ac.signal,
      poolSize: c.poolSize, yieldFn,
    }),
    new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 5000); }),
  ]);
  clearTimeout(timer);
  // 让挂起的延迟中断和写回调跑完，以检查返回后不再有调用。
  await ticks(8);
  return { result, violations, rendered, written, yields, endCalls, interrupted, endBeforeInterrupt, seenBuffers, stdin };
}

// Feature: stem-visualizer, Property 24: 帧泵背压
// **Validates: Requirements 11.7, 11.12, 11.13, 11.14**
test('Property 24: pumpFrames honours backpressure, buffer reuse, yielding and stop signals', async () => {
  await forAll(pumpCaseGen, async (c) => {
    const r = await runPump(c);
    assert.notEqual(r.result, 'timeout', 'pumpFrames did not settle');
    assert.deepEqual(r.violations, []);
    assert.ok(r.seenBuffers.size <= c.poolSize, `${r.seenBuffers.size} buffers > pool ${c.poolSize}`);
    assert.ok(r.written.length <= r.rendered.length);
    assert.ok(r.yields <= r.written.length);
    for (const ev of ['error', 'close', 'drain']) assert.equal(r.stdin.listenerCount(ev), 0, `${ev} listener left`);
    const stoppedEarly = r.interrupted && !r.endBeforeInterrupt;
    if (stoppedEarly) {
      assert.equal(r.result, 'stopped');
      assert.equal(r.endCalls, 0, 'end() not called when stopped');
    } else {
      assert.equal(r.result, 'done');
      assert.deepEqual(r.written, Array.from({ length: c.frames }, (_, k) => k));
      assert.equal(r.yields, c.frames);
      assert.equal(r.endCalls, 1);
    }
  }, { runs: RUNS });
});
