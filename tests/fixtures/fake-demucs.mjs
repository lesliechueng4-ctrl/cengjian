#!/usr/bin/env node
// 假 Demucs_Command（design.md 1.8 节），仅用于测试。
// 行为由环境变量 FAKE_DEMUCS_MODE 控制：ok（默认）、fail、hang、slow、nohelp、probehang。
// 只使用 Node 内置模块。
import fs from 'node:fs';
import path from 'node:path';

const MODE = process.env.FAKE_DEMUCS_MODE || 'ok';
const argv = process.argv.slice(2);

const SAMPLE_RATE = 44100;
const DURATION_S = 0.5;

const STEMS = {
  htdemucs: ['vocals', 'drums', 'bass', 'other'],
  htdemucs_6s: ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'],
};

// 每条 stem 的正弦频率（Hz），互不相同，便于断言。
const FREQS = {
  vocals: 440,
  drums: 110,
  bass: 55,
  other: 660,
  guitar: 330,
  piano: 880,
};

const hangForever = () => setInterval(() => {}, 1 << 30);

if (argv.includes('--help') || argv.includes('-h')) {
  if (MODE === 'nohelp') {
    process.stderr.write('demucs: error: unrecognized arguments: --help\n');
    process.exit(2);
  }
  if (MODE === 'probehang') {
    hangForever();
  } else {
    process.stdout.write(
      'usage: demucs [-h] [-n NAME] [-o OUT] [--filename FILENAME] tracks [tracks ...]\n'
    );
    process.exit(0);
  }
} else {
  runSeparation();
}

function parseArgs(args) {
  const opts = { model: 'htdemucs', out: 'separated', filename: '{track}/{stem}.{ext}', inputs: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-n' || a === '--name') opts.model = args[++i];
    else if (a === '-o' || a === '--out') opts.out = args[++i];
    else if (a === '--filename') opts.filename = args[++i];
    else if (a.startsWith('-')) {
      // 未知选项：若下一个参数不像选项，则视为该选项的值。
      if (i + 1 < args.length - 1 && !args[i + 1].startsWith('-')) i++;
    } else opts.inputs.push(a);
  }
  return opts;
}

function progressLine(step, total) {
  const pct = Math.round((step / total) * 100);
  const bar = '█'.repeat(Math.round((step / total) * 10)).padEnd(10, ' ');
  return `${String(pct).padStart(3, ' ')}%|${bar}| ${step}/${total} [00:00<00:00, 10.00seconds/s]\r\n`;
}

function sineWav(freq) {
  const frames = Math.round(SAMPLE_RATE * DURATION_S);
  const channels = 2;
  const dataBytes = frames * channels * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  let off = 44;
  for (let n = 0; n < frames; n++) {
    const v = Math.round(0.5 * Math.sin((2 * Math.PI * freq * n) / SAMPLE_RATE) * 32767);
    buf.writeInt16LE(v, off);
    buf.writeInt16LE(v, off + 2);
    off += 4;
  }
  return buf;
}

function writeOutputs(opts) {
  const input = opts.inputs[0];
  const track = path.basename(input, path.extname(input));
  const stems = STEMS[opts.model] || STEMS.htdemucs;
  stems.forEach((stem, i) => {
    const rel = opts.filename
      .replaceAll('{track}', track)
      .replaceAll('{trackext}', path.extname(input).slice(1))
      .replaceAll('{stem}', stem)
      .replaceAll('{ext}', 'wav');
    const file = path.join(opts.out, opts.model, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, sineWav(FREQS[stem] ?? 200 + 100 * i));
  });
}

function runSeparation() {
  const opts = parseArgs(argv);

  if (MODE === 'fail') {
    process.stderr.write('Traceback (most recent call last):\nRuntimeError: fake failure\n');
    process.exit(1);
  }

  if (MODE === 'hang') {
    process.stderr.write('  5%|▌         | 1/20 [00:00<00:10, 2.00seconds/s]\r\n');
    hangForever();
    return;
  }

  if (opts.inputs.length === 0) {
    process.stderr.write('demucs: error: the following arguments are required: tracks\n');
    process.exit(2);
  }
  if (!fs.existsSync(opts.inputs[0])) {
    process.stderr.write(`FileNotFoundError: ${opts.inputs[0]}\n`);
    process.exit(1);
  }

  const finish = () => {
    try {
      writeOutputs(opts);
    } catch (err) {
      process.stderr.write(`RuntimeError: ${err.message}\n`);
      process.exit(1);
    }
    process.exit(0);
  };

  if (MODE === 'slow') {
    // 每 100 ms 写一次进度，共 20 次，约 2 秒后成功。
    const total = 20;
    let step = 0;
    const timer = setInterval(() => {
      step++;
      process.stderr.write(progressLine(step, total));
      if (step >= total) {
        clearInterval(timer);
        finish();
      }
    }, 100);
    return;
  }

  // ok（以及其他模式在分离调用时的默认行为）
  const total = 10;
  for (let step = 1; step <= total; step++) process.stderr.write(progressLine(step, total));
  finish();
}
