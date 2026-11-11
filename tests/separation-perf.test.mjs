// Performance budget vs. the baseline separator (Requirements 8.3, 8.4).
// Opt-in: runs only when BENCH_PERF=1 (timing and memory depend on the machine).
//   PowerShell: $env:BENCH_PERF='1'; node --test tests/separation-perf.test.mjs; Remove-Item Env:BENCH_PERF
// Each separator runs in its own child process (tests/helpers/perf-run.mjs) on
// a 3-minute 44.1 kHz stereo track, twice; the smaller ms and peak are kept.
// peakBytes = peak(heapUsed + arrayBuffers) - value at start (after gc()).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(new URL('./helpers/perf-run.mjs', import.meta.url));
const RUNS = 2;
const BUDGETS = { fast: { time: 1.1, mem: 1.1 }, high: { time: 3.0, mem: 1.5 } };

function runOnce(which) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--expose-gc', RUNNER, which],
      { timeout: 15 * 60 * 1000, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${which}: ${err.message}\n${stderr}`));
        const line = stdout.trim().split('\n').pop();
        resolve(JSON.parse(line));
      });
  });
}

async function measure(which) {
  let ms = Infinity, peakBytes = Infinity;
  for (let i = 0; i < RUNS; i++) {
    const r = await runOnce(which);
    ms = Math.min(ms, r.ms);
    peakBytes = Math.min(peakBytes, r.peakBytes);
  }
  return { ms, peakBytes };
}

test('separation time and peak memory stay within budget vs. baseline (BENCH_PERF=1)',
  { skip: !process.env.BENCH_PERF, timeout: 60 * 60 * 1000 }, async (t) => {
    const res = {};
    for (const which of ['baseline', 'fast', 'high']) res[which] = await measure(which);
    const base = res.baseline;
    const mb = (b) => (b / 1048576).toFixed(1);
    const rows = ['separator   ms        time%    peakMB    mem%'];
    for (const [which, r] of Object.entries(res)) {
      rows.push(`${which.padEnd(10)}  ${String(r.ms).padEnd(8)}  ${((100 * r.ms) / base.ms).toFixed(0).padStart(5)}%  `
        + `${mb(r.peakBytes).padStart(7)}  ${((100 * r.peakBytes) / base.peakBytes).toFixed(0).padStart(5)}%`);
    }
    t.diagnostic('\n' + rows.join('\n'));
    for (const [which, b] of Object.entries(BUDGETS)) {
      const r = res[which];
      assert.ok(r.ms <= b.time * base.ms,
        `${which} time ${r.ms} ms > ${b.time * 100}% of baseline ${base.ms} ms`);
      assert.ok(r.peakBytes <= b.mem * base.peakBytes,
        `${which} peak ${mb(r.peakBytes)} MB > ${b.mem * 100}% of baseline ${mb(base.peakBytes)} MB`);
    }
  });
