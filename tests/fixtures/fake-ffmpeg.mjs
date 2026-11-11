#!/usr/bin/env node
// 假 FFmpeg（design.md 第 4 节 Fake_FFmpeg 夹具），仅用于测试。
// 用法：FFMPEG_CMD = JSON.stringify([process.execPath, <本文件路径>])
// 行为由环境变量 FAKE_FFMPEG_MODE 控制：
//   ok（默认）、probefail、probehang、inspecthang、slow、fail、hang、nooutput、
//   slowstdin（读标准输入时每 64 KB 暂停 20 ms）、stdinexit（读完 1 帧后报错退出 1）。
// 源文件首行：`FAKEVIDEO codec=… duration=… [attached=1] [size=<W>x<H>] [rotate=90]`。
// 合成参数含 `-i pipe:0` 时读取标准输入的原始帧（`-s WxH -pix_fmt rgb24`），
// 结果 JSON 增加 `stdin: { bytes, frames, remainder, size, sha256 }`。
// 只使用 Node 内置模块。
import fs from 'node:fs';
import crypto from 'node:crypto';

const MODE = process.env.FAKE_FFMPEG_MODE || 'ok';
const argv = process.argv.slice(2);

const hangForever = () => setInterval(() => {}, 1 << 30);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- 调用类型识别 ----------

/** 所有 `-i` 的值（按出现顺序）及其参数下标。 */
function collectInputs(args) {
  const inputs = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-i') {
      inputs.push({ index: i + 1, path: args[i + 1] });
      i++;
    }
  }
  return inputs;
}

// ---------- -version ----------

function runVersion() {
  if (MODE === 'probehang') {
    hangForever();
    return;
  }
  if (MODE === 'probefail') {
    process.stderr.write('ffmpeg: error while loading shared libraries: libavdevice.so.60\n');
    process.exit(1);
  }
  process.stdout.write(
    'ffmpeg version 6.1-fake Copyright (c) 2000-2023 the FFmpeg developers\n' +
      'built with fake-ffmpeg.mjs\n' +
      'configuration: --enable-gpl --enable-libx264\n'
  );
  process.exit(0);
}

// ---------- 探测 ----------

/** 读取文件开头（最多 4 KB）的第一行，失败返回 null。 */
function readFirstLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('latin1').split(/\r?\n/)[0];
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * 解析 `FAKEVIDEO codec=… duration=… [attached=1]`。
 * 返回 { codec, duration（原始字符串）, durationSec（秒或 null）, attached } 或 null。
 */
function parseFakeVideo(line) {
  if (!line || !line.startsWith('FAKEVIDEO')) return null;
  const opts = {};
  for (const tok of line.slice('FAKEVIDEO'.length).trim().split(/\s+/)) {
    const eq = tok.indexOf('=');
    if (eq > 0) opts[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  const codec = (opts.codec || 'h264').toLowerCase();
  const duration = opts.duration || 'N/A';
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(duration);
  const durationSec = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
  const size = /^\d+x\d+$/.test(opts.size || '') ? opts.size : null;
  return {
    codec,
    duration: m ? duration : 'N/A',
    durationSec,
    attached: opts.attached === '1',
    size,
    rotate: opts.rotate === '90',
  };
}

const VIDEO_STREAM_DESC = {
  h264: 'h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 4500 kb/s, 30 fps, 30 tbr, 15360 tbn (default)',
  hevc: 'hevc (Main) (hev1 / 0x31766568), yuv420p(tv, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 3000 kb/s, 30 fps, 30 tbr, 15360 tbn (default)',
  vp9: 'vp9 (Profile 0), yuv420p(tv, progressive), 1920x1080, SAR 1:1 DAR 16:9, 30 fps, 30 tbr, 1k tbn (default)',
};

function probeText(file, info) {
  const lines = [];
  const container = info.codec === 'vp9' ? 'matroska,webm' : 'mov,mp4,m4a,3gp,3g2,mj2';
  lines.push(`Input #0, ${container}, from '${file}':`);
  lines.push('  Metadata:');
  lines.push('    major_brand     : isom');
  lines.push('    encoder         : Lavf60.16.100');
  lines.push(`  Duration: ${info.duration}, start: 0.000000, bitrate: 4650 kb/s`);
  let idx = 0;
  if (info.attached && info.codec !== 'none') {
    lines.push(
      `  Stream #0:${idx}[0x${(idx + 1).toString(16)}](und): Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 600x600 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn (attached pic)`
    );
    idx++;
  }
  if (info.codec !== 'none') {
    let desc = VIDEO_STREAM_DESC[info.codec] || `${info.codec}, yuv420p, 1280x720, 25 fps, 25 tbr, 12800 tbn (default)`;
    // size=<W>x<H>：替换描述中的默认尺寸（保持 `, <W>x<H>` 后跟空格或逗号的格式）
    if (info.size) desc = desc.replace(/, \d+x\d+(?=[ ,])/, `, ${info.size}`);
    lines.push(`  Stream #0:${idx}[0x${(idx + 1).toString(16)}](und): Video: ${desc}`);
    lines.push('      Metadata:');
    lines.push('        handler_name    : VideoHandler');
    if (info.rotate) {
      lines.push('      Side data:');
      lines.push('        displaymatrix: rotation of -90.00 degrees');
    }
    idx++;
  }
  lines.push(
    `  Stream #0:${idx}[0x${(idx + 1).toString(16)}](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s (default)`
  );
  lines.push('      Metadata:');
  lines.push('        handler_name    : SoundHandler');
  lines.push('At least one output file must be specified');
  return lines.join('\n') + '\n';
}

function runProbe(file) {
  if (MODE === 'inspecthang') {
    hangForever();
    return;
  }
  if (!fs.existsSync(file)) {
    process.stderr.write(`${file}: No such file or directory\n`);
    process.exit(1);
  }
  const info = parseFakeVideo(readFirstLine(file));
  if (!info) {
    process.stderr.write(`${file}: Invalid data found when processing input\n`);
    process.exit(1);
  }
  process.stderr.write(probeText(file, info));
  process.exit(1);
}

// ---------- 合成 ----------

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 16);
  let bytes = 0;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      bytes += n;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { bytes, sha256: hash.digest('hex') };
}

function formatOutTime(us) {
  const totalSec = Math.floor(us / 1e6);
  const frac = String(us % 1e6).padStart(6, '0');
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${h}:${m}:${s}.${frac}`;
}

function progressBlock(us, frame, end) {
  return (
    `frame=${frame}\n` +
    'fps=30.00\n' +
    'stream_0_0_q=-1.0\n' +
    'bitrate=4600.0kbits/s\n' +
    `total_size=${frame * 19200}\n` +
    `out_time_us=${us}\n` +
    `out_time_ms=${us}\n` +
    `out_time=${formatOutTime(us)}\n` +
    'dup_frames=0\n' +
    'drop_frames=0\n' +
    'speed=10.0x\n' +
    `progress=${end ? 'end' : 'continue'}\n`
  );
}

/** 把一个进度块故意拆成多次 write（在行中间切开），覆盖跨 chunk 的半行。 */
async function writeSplit(text) {
  const cuts = [Math.floor(text.length / 3), Math.floor((text.length * 2) / 3), text.length];
  let prev = 0;
  for (const cut of cuts) {
    process.stdout.write(text.slice(prev, cut));
    prev = cut;
    await sleep(5);
  }
}

/** 输出时长（秒）：优先 `-t` 的值，其次第一个输入的 FAKEVIDEO 时长，最后 1 秒。 */
function targetDurationSec(firstInput) {
  const t = argv.indexOf('-t');
  if (t >= 0 && Number(argv[t + 1]) > 0) return Number(argv[t + 1]);
  const info = parseFakeVideo(readFirstLine(firstInput));
  if (info && info.durationSec) return info.durationSec;
  return 1;
}

/** 每像素字节数：rgb24 为 3，rgba 类为 4，其他按 3。 */
function bytesPerPixel(pixFmt) {
  if (/^(rgba|bgra|argb|abgr)$/.test(pixFmt || '')) return 4;
  return 3;
}

/**
 * 读取标准输入的原始帧（`-i pipe:0`）。每读满一秒（30 帧）输出一个进度块，
 * `out_time_us` 按已读帧数 / 30 计算。
 * slowstdin：每读 64 KB 暂停 20 ms；stdinexit：读完 1 帧后报错退出。
 */
async function readStdinFrames() {
  const sIdx = argv.indexOf('-s');
  const size = sIdx >= 0 ? argv[sIdx + 1] : null;
  const pIdx = argv.indexOf('-pix_fmt');
  const pixFmt = pIdx >= 0 ? argv[pIdx + 1] : 'rgb24';
  const m = /^(\d+)x(\d+)$/.exec(size || '');
  const frameBytes = m ? Number(m[1]) * Number(m[2]) * bytesPerPixel(pixFmt) : 0;

  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let reportedSec = 0;
  let pausedAt = 0; // slowstdin：上次暂停时的字节数
  const framesRead = () => (frameBytes > 0 ? Math.floor(bytes / frameBytes) : 0);

  for await (const chunk of process.stdin) {
    hash.update(chunk);
    bytes += chunk.length;

    if (MODE === 'stdinexit' && frameBytes > 0 && bytes >= frameBytes) {
      process.stderr.write('Error while decoding stream\n');
      process.exit(1);
    }

    const frames = framesRead();
    while (Math.floor(frames / 30) > reportedSec) {
      reportedSec++;
      process.stdout.write(progressBlock(reportedSec * 1e6, reportedSec * 30, false));
      if (MODE === 'slow') await sleep(100);
    }

    if (MODE === 'slowstdin') {
      while (bytes - pausedAt >= 65536) {
        pausedAt += 65536;
        await sleep(20);
      }
    }
  }

  if (MODE === 'stdinexit') {
    // 不足一帧就结束了输入，同样按解码错误处理
    process.stderr.write('Error while decoding stream\n');
    process.exit(1);
  }

  const frames = framesRead();
  return {
    bytes,
    frames,
    remainder: frameBytes > 0 ? bytes % frameBytes : bytes,
    size,
    sha256: hash.digest('hex'),
  };
}

/** 带标准输入原始帧的合成：读到 EOF 后写结果文件，进度按帧数计算。 */
async function runStdinMux(inputPaths, output) {
  if (MODE === 'hang') {
    await writeSplit(progressBlock(0, 0, false));
    hangForever();
    return;
  }
  const stdin = await readStdinFrames();
  if (MODE !== 'nooutput') {
    const record = { argv, inputs: inputPaths.map(sha256File), stdin };
    fs.writeFileSync(output, 'FAKEMP4 ' + JSON.stringify(record) + '\n');
  }
  const endUs = Math.round((stdin.frames / 30) * 1e6);
  await writeSplit(progressBlock(endUs, stdin.frames, true));
  process.exit(0);
}

async function runMux(inputPaths, output, usesStdin = false) {
  if (MODE === 'fail') {
    process.stderr.write('Error while opening encoder\nConversion failed!\n');
    process.exit(1);
  }
  for (const p of inputPaths) {
    if (!fs.existsSync(p)) {
      process.stderr.write(`${p}: No such file or directory\n`);
      process.exit(1);
    }
  }

  if (usesStdin) return runStdinMux(inputPaths, output);

  const totalUs = Math.round(targetDurationSec(inputPaths[0]) * 1e6);
  const blocks = MODE === 'slow' ? 10 : 3;
  const usAt = (i) => Math.round((totalUs * i) / blocks);

  if (MODE === 'hang') {
    await writeSplit(progressBlock(usAt(1), 30, false));
    hangForever();
    return;
  }

  for (let i = 1; i < blocks; i++) {
    await writeSplit(progressBlock(usAt(i), 30 * i, false));
    if (MODE === 'slow') await sleep(100);
  }

  if (MODE !== 'nooutput') {
    const record = { argv, inputs: inputPaths.map(sha256File) };
    fs.writeFileSync(output, 'FAKEMP4 ' + JSON.stringify(record) + '\n');
  }
  await writeSplit(progressBlock(usAt(blocks), 30 * blocks, true));
  process.exit(0);
}

// ---------- 入口（放在末尾，保证上面的常量都已初始化） ----------
// -version → 版本检测；恰好一个 -i 且它的值是最后一个参数 → 探测；否则 → 合成。

const inputs = collectInputs(argv);

if (argv.includes('-version')) {
  runVersion();
} else if (inputs.length === 1 && inputs[0].index === argv.length - 1) {
  runProbe(inputs[0].path);
} else if (inputs.length === 0) {
  process.stderr.write("ffmpeg: no input specified\nUse -h to get full help or, even better, run 'man ffmpeg'\n");
  process.exit(1);
} else {
  const usesStdin = inputs.some((x) => x.path === 'pipe:0');
  const filePaths = inputs.filter((x) => x.path !== 'pipe:0').map((x) => x.path);
  runMux(filePaths, argv[argv.length - 1], usesStdin).catch((err) => {
    process.stderr.write(`${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
}
