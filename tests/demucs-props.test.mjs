// Demucs_Service 属性测试（design.md「Correctness Properties」）。
// 使用 tests/helpers/prop.mjs：每个属性至少 100 轮，失败时报告种子，PROP_SEED=<种子> 可复现。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import childProcess from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDemucsService,
  createJobQueue,
  safeExt,
  jobPaths,
  buildDemucsArgs,
  isJobId,
  isAllowedModel,
  JOB_ID_RE,
  DEMUCS_MODELS,
  MODEL_STEMS,
  UPLOAD_EXTS,
  parseProgress,
} from '../demucs-service.js';
import { createServer } from '../server.js';
import { forAll, gen } from './helpers/prop.mjs';
import { listenFetchable } from './helpers/listen.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-demucs.mjs', import.meta.url));
const FAKE_CMD = { file: process.execPath, args: [FIXTURE] };

const HEX = '0123456789abcdef';
/** 服务器风格的任务 ID：32 个小写十六进制字符。 */
const jobId = (rng) => {
  let s = '';
  for (let i = 0; i < 32; i++) s += HEX[Math.floor(rng() * 16)];
  return s;
};

/** 带大小写、点和空白变体的白名单扩展名（这些应被规范化为白名单值）。 */
const whitelistVariant = (rng) => {
  const e = UPLOAD_EXTS[Math.floor(rng() * UPLOAD_EXTS.length)];
  const upper = rng() < 0.5 ? e.toUpperCase() : e;
  const dot = rng() < 0.3 ? '.' : '';
  const pad = rng() < 0.3 ? ' ' : '';
  return `${pad}${dot}${upper}${pad}`;
};

/** 客户端提供的 ext / 文件名：多数是敌意字符串，也混入白名单变体与 ext 前后夹带穿越片段。 */
const clientExt = gen.oneOf(
  gen.string({ minLength: 0, maxLength: 24 }),
  gen.string({ minLength: 1, maxLength: 8 }),
  whitelistVariant,
  (rng) => `${gen.string({ maxLength: 6 })(rng)}${whitelistVariant(rng)}`,
  (rng) => `${whitelistVariant(rng)}/../${gen.string({ maxLength: 6 })(rng)}`,
  undefined,
  null,
);

const FIXED_ARGS = [[], ['-m', 'demucs'], ['-d', 'cpu'], ['-m', 'demucs', '-d', 'cpu', '--shifts', '1']];

const tempRootGen = gen.oneOf(
  () => path.join(os.tmpdir(), 'cengjian-demucs'),
  () => path.resolve('some', 'root'),
  () => path.join(os.tmpdir(), 'with space', '层见'),
);

/** p 位于 dir 之内（或等于 dir）。 */
function inside(dir, p) {
  const rel = path.relative(dir, p);
  return !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..');
}

test('Feature: separation-accuracy, Property 2: 任务文件路径只由服务器值组成', async () => {
  const sample = (rng) => ({
    tempRoot: tempRootGen(rng),
    id: jobId(rng),
    ext: clientExt(rng),
    model: DEMUCS_MODELS[Math.floor(rng() * DEMUCS_MODELS.length)],
    badModel: gen.oneOf(gen.string({ maxLength: 16 }), (r) => `../${DEMUCS_MODELS[Math.floor(r() * 2)]}`, 'HTDEMUCS', '')(rng),
    badId: gen.oneOf(
      gen.string({ maxLength: 40 }),
      (r) => `${jobId(r)}/../x`,
      (r) => jobId(r).toUpperCase().replace(/^[0-9]/, 'A'),
      (r) => jobId(r).slice(0, 31),
      (r) => `../${jobId(r)}`,
    )(rng),
    fixedArgs: FIXED_ARGS[Math.floor(rng() * FIXED_ARGS.length)],
  });

  await forAll(sample, ({ tempRoot, id, ext, model, badModel, badId, fixedArgs }) => {
    assert.ok(isJobId(id) && JOB_ID_RE.test(id));
    const dir = path.join(tempRoot, id);
    const p = jobPaths(tempRoot, id, ext);
    const e = safeExt(ext);

    // 扩展名只取白名单值或 'bin'；非 'bin' 时它必须恰是客户端值规范化后的白名单项。
    assert.ok(e === 'bin' || UPLOAD_EXTS.includes(e), `ext ${e}`);
    if (e !== 'bin') assert.equal(String(ext).trim().replace(/^\./, '').toLowerCase(), e);

    // 每个路径都在 tempRoot/<id>/ 内，且相对路径只由固定名称组成（敌意字符串不会出现）。
    const resultDir = p.resultDir(model);
    assert.equal(p.dir, dir);
    for (const q of [p.dir, p.input, p.outDir, resultDir]) assert.ok(inside(dir, q), `${q} escapes ${dir}`);
    assert.equal(path.relative(dir, p.input), `input.${e}`);
    assert.equal(path.basename(p.input), `input.${e}`);
    assert.equal(path.relative(dir, p.outDir), 'out');
    assert.equal(path.relative(dir, resultDir), path.join('out', model));

    // Demucs 参数只包含固定参数、允许的模型名和这些路径。
    const args = buildDemucsArgs(fixedArgs, model, p);
    assert.deepEqual(args, [...fixedArgs, '-n', model, '-o', p.outDir, '--filename', '{stem}.{ext}', p.input]);
    assert.ok(DEMUCS_MODELS.includes(args[fixedArgs.length + 1]));

    // 非法 ID 与非法模型被拒绝。
    if (!JOB_ID_RE.test(badId)) assert.throws(() => jobPaths(tempRoot, badId, ext));
    if (!DEMUCS_MODELS.includes(badModel)) assert.throws(() => p.resultDir(badModel));
  }, { runs: 200 });
});

test('Feature: separation-accuracy, Property 2: 任务文件路径只由服务器值组成（真实上传）', async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cengjian-demucs-props-'));
  const svc = createDemucsService({
    command: FAKE_CMD,
    maxUploadBytes: 64 * 1024,
    timeoutMs: 20_000,
    tempRoot,
    retentionMs: 60_000,
    tombstoneMs: 60_000,
    probeTimeoutMs: 8000,
    maxUnfinished: 100,
    env: { ...process.env, FAKE_DEMUCS_MODE: 'hang' },
    log: () => {},
  });
  const server = createServer(undefined, { demucs: svc });
  await listenFetchable(server);
  t.after(async () => {
    await svc.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.promises.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await svc.init();
  const api = `http://127.0.0.1:${server.address().port}/api/separate`;

  // 只生成能放进查询字符串的值（URLSearchParams 无法携带孤立代理项）。
  const extGen = (rng) => {
    const v = clientExt(rng);
    return typeof v === 'string' ? v.replace(/[\ud800-\udfff]/g, '') : '';
  };

  await forAll(extGen, async (ext) => {
    const qs = new URLSearchParams({ model: 'htdemucs', ext });
    const res = await fetch(`${api}?${qs}`, { method: 'POST', body: Buffer.alloc(256, 7) });
    const body = await res.json();
    assert.equal(res.status, 202, JSON.stringify(body));
    assert.ok(isJobId(body.id), body.id);
    // tempRoot 下只有服务器生成的任务目录，目录内的上传文件名为 input.<白名单扩展名或 bin>。
    for (const name of fs.readdirSync(tempRoot)) assert.ok(isJobId(name), name);
    const files = fs.readdirSync(path.join(tempRoot, body.id));
    assert.ok(files.includes(`input.${safeExt(ext)}`), files.join(','));
    for (const f of files) assert.ok(f === 'out' || /^input\.[a-z0-9]+$/.test(f), f);
    await fetch(`${api}/${body.id}`, { method: 'DELETE' });
  }, { runs: 12 });
});

// ---------------------------------------------------------------- Property 3

/** 轮询直到 check() 为真；超时抛错。 */
async function waitFor(check, { timeoutMs = 3000, intervalMs = 10, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * 用原始 http.request 上传 body：带 Content-Length 时一次写完，否则用分块编码分 chunks 次写入。
 * 服务器回 413 后可能关闭连接，客户端写入出错时只要已收到状态码就不算失败。
 */
function rawUpload(url, body, { contentLength, chunks = 1 }) {
  return new Promise((resolve, reject) => {
    const headers = contentLength
      ? { 'Content-Length': String(body.length) }
      : { 'Transfer-Encoding': 'chunked' };
    let status = null;
    let text = '';
    let done = false;
    const finish = (err) => {
      if (done) return;
      if (status !== null) {
        done = true;
        resolve({ status, text });
      } else if (err) {
        done = true;
        reject(err);
      }
    };
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      status = res.statusCode;
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => finish());
      res.on('error', () => finish());
      res.on('close', () => finish(new Error('response closed')));
    });
    req.on('error', (err) => {
      // 状态码可能稍后才到（响应已在途），给一点时间。
      setTimeout(() => finish(err), 200);
    });
    req.on('close', () => setTimeout(() => finish(new Error('socket closed without response')), 200));
    if (contentLength) {
      req.end(body);
      return;
    }
    const step = Math.ceil(body.length / chunks) || 1;
    for (let off = 0; off < body.length; off += step) {
      if (req.destroyed) return;
      req.write(body.subarray(off, off + step));
    }
    if (!req.destroyed) req.end();
  });
}

function httpDelete(url) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'DELETE' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('Feature: separation-accuracy, Property 3: 超限上传被拒且不留文件', async (t) => {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cengjian-demucs-p3-'));
  t.after(() => fs.promises.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  // --help 探测立即成功（避免每轮启动进程）；真正的分离仍用 fake-demucs（hang 模式，DELETE 时被终止）。
  const execFile = (file, args, opts, cb) => {
    if (args[args.length - 1] === '--help') {
      setImmediate(() => cb(null, '', ''));
      return null;
    }
    return childProcess.execFile(file, args, opts, cb);
  };

  const sample = (rng) => {
    const limit = gen.int(1024, 64 * 1024)(rng);
    const delta = gen.oneOf(gen.int(-512, -1), 0, gen.int(1, 512), gen.int(1, 4))(rng);
    return {
      limit,
      size: limit + delta,
      contentLength: rng() < 0.5,
      chunks: gen.int(1, 6)(rng),
      fill: gen.int(0, 255)(rng),
    };
  };

  let runNo = 0;
  await forAll(sample, async ({ limit, size, contentLength, chunks, fill }) => {
    const tempRoot = path.join(base, String(runNo++));
    const svc = createDemucsService({
      command: FAKE_CMD,
      maxUploadBytes: limit,
      timeoutMs: 20_000,
      tempRoot,
      retentionMs: 60_000,
      tombstoneMs: 60_000,
      probeTimeoutMs: 8000,
      maxUnfinished: 4,
      env: { ...process.env, FAKE_DEMUCS_MODE: 'hang' },
      execFile,
      log: () => {},
    });
    const server = createServer(undefined, { demucs: svc });
    await listenFetchable(server);
    try {
      await svc.init();
      assert.equal(svc.status().available, true);
      const api = `http://127.0.0.1:${server.address().port}/api/separate`;
      const body = Buffer.alloc(size, fill);
      for (let i = 0; i < Math.min(size, 64); i++) body[i] = (fill + i * 31) & 0xff;

      const res = await rawUpload(`${api}?model=htdemucs&ext=wav`, body, { contentLength, chunks });
      if (size > limit) {
        assert.equal(res.status, 413, res.text);
        await waitFor(() => fs.readdirSync(tempRoot).length === 0, { what: `tempRoot empty: ${fs.readdirSync(tempRoot)}` });
        assert.equal(svc._internal.jobs.size, 0);
        assert.equal(svc.status().queueLength, 0);
      } else {
        assert.equal(res.status, 202, res.text);
        const { id } = JSON.parse(res.text);
        assert.ok(isJobId(id), id);
        const input = path.join(tempRoot, id, 'input.wav');
        assert.ok(fs.readFileSync(input).equals(body), 'uploaded bytes differ');
        assert.equal(fs.statSync(input).size, size);
        await httpDelete(`${api}/${id}`);
      }
    } finally {
      await svc.close();
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }, { runs: 100 });
});

// ---------------------------------------------------------------- Property 4

test('Feature: separation-accuracy, Property 4: 非法模型被拒', async (t) => {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cengjian-demucs-p4-'));
  const execFile = (file, args, opts, cb) => {
    if (args[args.length - 1] === '--help') {
      setImmediate(() => cb(null, '', ''));
      return null;
    }
    return childProcess.execFile(file, args, opts, cb);
  };
  const svc = createDemucsService({
    command: FAKE_CMD,
    maxUploadBytes: 64 * 1024,
    timeoutMs: 20_000,
    tempRoot,
    retentionMs: 60_000,
    tombstoneMs: 60_000,
    probeTimeoutMs: 8000,
    maxUnfinished: 4,
    env: { ...process.env, FAKE_DEMUCS_MODE: 'hang' },
    execFile,
    log: () => {},
  });
  const server = createServer(undefined, { demucs: svc });
  await listenFetchable(server);
  t.after(async () => {
    await svc.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.promises.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await svc.init();
  assert.equal(svc.status().available, true);
  const api = `http://127.0.0.1:${server.address().port}/api/separate`;
  const before = fs.readdirSync(tempRoot).sort();
  const jobsBefore = svc._internal.jobs.size;

  // 查询字符串放不下孤立代理项，先去掉。
  const str = (opts) => (rng) => gen.string(opts)(rng).replace(/[\ud800-\udfff]/g, '');
  const pick = (rng) => DEMUCS_MODELS[Math.floor(rng() * DEMUCS_MODELS.length)];
  const nearMiss = gen.oneOf(
    (rng) => pick(rng).toUpperCase(),
    (rng) => `${pick(rng)} `,
    (rng) => ` ${pick(rng)}`,
    (rng) => `${pick(rng)}/../x`,
    (rng) => `../${pick(rng)}`,
    (rng) => `${pick(rng)}\0`,
    (rng) => pick(rng).slice(0, -1),
    (rng) => `${pick(rng)}_`,
    'htdemucs_6S',
    'demucs',
    'mdx_extra',
    '',
  );
  const badModel = (rng) => {
    for (;;) {
      const m = gen.oneOf(str({ minLength: 0, maxLength: 24 }), nearMiss)(rng);
      if (!DEMUCS_MODELS.includes(m)) return m;
    }
  };

  // 每个样本：查询字符串 + 服务器实际读到的模型值（URLSearchParams.get 取第一个 model）。
  const sample = gen.oneOf(
    (rng) => { const m = badModel(rng); return { query: `model=${encodeURIComponent(m)}&ext=wav`, first: m }; },
    () => ({ query: 'ext=wav', first: null }), // 缺少 model
    () => ({ query: 'model&ext=wav', first: '' }), // 无值
    (rng) => {
      // 重复参数：第一个非法、后面合法 → 仍按第一个判定，返回 400。
      const m = badModel(rng);
      return { query: `model=${encodeURIComponent(m)}&model=${pick(rng)}&ext=wav`, first: m };
    },
  );

  await forAll(sample, async ({ query, first }) => {
    assert.equal(new URLSearchParams(query).get('model'), first);
    assert.equal(isAllowedModel(first), false);
    const res = await fetch(`${api}?${query}`, { method: 'POST', body: Buffer.alloc(256, 7) });
    const text = await res.text();
    assert.equal(res.status, 400, `${query} -> ${res.status} ${text}`);
    assert.deepEqual(fs.readdirSync(tempRoot).sort(), before);
    assert.equal(svc._internal.jobs.size, jobsBefore);
    assert.equal(svc.status().queueLength, 0);
  }, { runs: 150 });

  // 对照：第一个 model 合法时（即使后面跟着非法值）请求被接受，说明判定确实只看第一个值。
  const res = await fetch(`${api}?model=htdemucs&model=bogus&ext=wav`, { method: 'POST', body: Buffer.alloc(256, 7) });
  const body = await res.json();
  assert.equal(res.status, 202, JSON.stringify(body));
  await httpDelete(`${api}/${body.id}`);
});

// ---------------------------------------------------------------- Property 5

/** 原始 http.request（路径不经客户端规范化），返回状态码并丢弃响应体。 */
function rawRequest(port, method, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 去掉孤立代理项后做百分号编码，使任意字符串能放进请求行。 */
const urlSafe = (s) => encodeURIComponent(String(s).replace(/[\ud800-\udfff]/g, ''));

/** 近似但非法的任务 ID。 */
const nearMissId = gen.oneOf(
  gen.string({ minLength: 0, maxLength: 40 }),
  (rng) => jobId(rng).slice(0, 31),
  (rng) => `${jobId(rng)}${HEX[Math.floor(rng() * 16)]}`,
  (rng) => jobId(rng).toUpperCase().replace(/^[0-9]/, 'A'),
  (rng) => {
    const id = jobId(rng);
    const i = Math.floor(rng() * 32);
    const c = 'ghxyzG-_. '[Math.floor(rng() * 10)];
    return id.slice(0, i) + c + id.slice(i + 1);
  },
  (rng) => `${jobId(rng)}/x`,
  (rng) => `../${jobId(rng)}`,
  (rng) => `${jobId(rng)}/..`,
  (rng) => `%2e%2e/${jobId(rng)}`,
  (rng) => ` ${jobId(rng)}`,
  '',
);

test('Feature: separation-accuracy, Property 5: 非法任务 ID 与音轨名返回 404', async (t) => {
  // 纯函数部分：近似 ID 一律被 isJobId 拒绝，合法格式 ID 被接受。
  await forAll((rng) => ({ bad: nearMissId(rng), good: jobId(rng) }), ({ bad, good }) => {
    assert.equal(isJobId(good), true, good);
    assert.equal(JOB_ID_RE.test(bad), false, `generator produced a valid id: ${bad}`);
    assert.equal(isJobId(bad), false, bad);
  }, { runs: 200 });

  // HTTP 部分：一个已完成的 htdemucs 任务。
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cengjian-demucs-p5-'));
  const svc = createDemucsService({
    command: FAKE_CMD,
    maxUploadBytes: 64 * 1024,
    timeoutMs: 20_000,
    tempRoot,
    retentionMs: 60_000,
    tombstoneMs: 60_000,
    probeTimeoutMs: 8000,
    maxUnfinished: 4,
    env: { ...process.env, FAKE_DEMUCS_MODE: 'ok' },
    log: () => {},
  });
  const server = createServer(undefined, { demucs: svc });
  await listenFetchable(server);
  const port = server.address().port;
  const api = `http://127.0.0.1:${port}/api/separate`;
  let doneId = null;
  t.after(async () => {
    if (doneId) await httpDelete(`${api}/${doneId}`).catch(() => {});
    await svc.close();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.promises.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await svc.init();
  assert.equal(svc.status().available, true);

  const model = 'htdemucs';
  const up = await fetch(`${api}?model=${model}&ext=wav`, { method: 'POST', body: Buffer.alloc(256, 7) });
  const upBody = await up.json();
  assert.equal(up.status, 202, JSON.stringify(upBody));
  doneId = upBody.id;
  await waitFor(async () => {
    const r = await fetch(`${api}/${doneId}`);
    const j = await r.json();
    if (j.status === 'error') throw new Error(`job failed: ${JSON.stringify(j)}`);
    return j.status === 'done';
  }, { timeoutMs: 15_000, intervalMs: 50, what: 'job done' });

  const stems = MODEL_STEMS[model];
  const otherStems = MODEL_STEMS.htdemucs_6s.filter((s) => !stems.includes(s));
  const pickStem = (rng) => stems[Math.floor(rng() * stems.length)];
  const randomName = (rng) => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789_';
    for (;;) {
      let s = '';
      const n = gen.int(1, 12)(rng);
      for (let i = 0; i < n; i++) s += chars[Math.floor(rng() * chars.length)];
      if (!stems.includes(s)) return s;
    }
  };
  // 已完成任务下的非法音轨路径段（原样拼进请求行）。
  const badStem = gen.oneOf(
    (rng) => `${otherStems[Math.floor(rng() * otherStems.length)]}.wav`,
    (rng) => `${randomName(rng)}.wav`,
    (rng) => `${pickStem(rng)}.mp3`,
    (rng) => `${pickStem(rng)}.WAV`,
    (rng) => `${pickStem(rng).toUpperCase()}.wav`,
    (rng) => pickStem(rng),
    (rng) => `${pickStem(rng)}.wav.wav`,
    (rng) => `../${pickStem(rng)}.wav`,
    (rng) => `%2e%2e/${pickStem(rng)}.wav`,
    (rng) => `..%2f${pickStem(rng)}.wav`,
    (rng) => `${pickStem(rng)}%2ewav`,
    (rng) => `${pickStem(rng)}.wav/x`,
    (rng) => `x/${pickStem(rng)}.wav`,
    (rng) => urlSafe(gen.string({ minLength: 0, maxLength: 16 })(rng)),
    '',
  );
  const unknownId = (rng) => {
    for (;;) {
      const id = jobId(rng);
      if (id !== doneId) return id;
    }
  };
  // 近似 ID：随机字符串需编码；结构化的穿越片段原样保留。
  const badIdPath = (rng) => {
    const id = nearMissId(rng);
    return /^[\x21-\x7e]*$/.test(id) && !/[?#]/.test(id) ? id : urlSafe(id);
  };

  const sample = gen.oneOf(
    (rng) => ({ method: 'GET', p: `/api/separate/${badIdPath(rng)}` }),
    // DELETE 只针对单段路径（两段路径是音轨路由，只允许 GET，按设计返回 405）。
    (rng) => ({ method: 'DELETE', p: `/api/separate/${urlSafe(nearMissId(rng))}` }),
    (rng) => ({ method: 'GET', p: `/api/separate/${unknownId(rng)}` }),
    (rng) => ({ method: 'DELETE', p: `/api/separate/${unknownId(rng)}` }),
    (rng) => ({ method: 'GET', p: `/api/separate/${unknownId(rng)}/${pickStem(rng)}.wav` }),
    (rng) => ({ method: 'GET', p: `/api/separate/${doneId}/${badStem(rng)}` }),
  );

  await forAll(sample, async ({ method, p }) => {
    // 规范化后不能恰好落到 status 端点或已完成任务本身（那些本应返回 200）。
    const norm = new URL(p, 'http://localhost').pathname;
    if (norm === '/api/separate/status' || norm === `/api/separate/${doneId}`) return;
    const status = await rawRequest(port, method, p);
    assert.equal(status, 404, `${method} ${p} -> ${status}`);
  }, { runs: 40 });

  // 对照：任务仍存在，模型的每个输出名都返回 200。
  assert.equal(await rawRequest(port, 'GET', `/api/separate/${doneId}`), 200);
  for (const s of stems) {
    assert.equal(await rawRequest(port, 'GET', `/api/separate/${doneId}/${s}.wav`), 200, s);
  }
});

// ---------------------------------------------------------------- Property 6

test('Feature: separation-accuracy, Property 6: 队列先进先出、单进程、未完成上限 4', async () => {
  const MAX = 4;
  const POOL = ['a', 'b', 'c', 'd', 'e', 'f'];
  const GHOST = 'ghost'; // 从不提交的 ID
  const pickId = (rng) => POOL[Math.floor(rng() * POOL.length)];
  const anyId = (rng) => (rng() < 0.15 ? GHOST : pickId(rng));

  // 抽象操作序列；late done 的目标在执行时从已失效的 done 回调中按 pick 选取。
  const op = gen.oneOf(
    (rng) => ({ op: 'submit', id: pickId(rng), uploading: false, syncDone: rng() < 0.25 }),
    (rng) => ({ op: 'submit', id: pickId(rng), uploading: false, syncDone: rng() < 0.25 }),
    (rng) => ({ op: 'submit', id: pickId(rng), uploading: true, syncDone: rng() < 0.25 }),
    (rng) => ({ op: 'enqueue', id: anyId(rng) }),
    (rng) => ({ op: 'doneRunning', status: rng() < 0.5 ? 'done' : 'failed' }),
    (rng) => ({ op: 'doneRunning', status: rng() < 0.5 ? 'done' : 'failed' }),
    (rng) => ({ op: 'finish', id: anyId(rng) }),
    (rng) => ({ op: 'cancel', id: anyId(rng) }),
    (rng) => ({ op: 'lateDone', pick: rng() }),
  );
  const sample = gen.array(op, { minLength: 20, maxLength: 60 });

  await forAll(sample, (ops) => {
    // ---- 被测对象
    const actualStarts = []; // runner 被调用的 job 对象，按调用顺序
    const dones = []; // { job, done }
    const q = createJobQueue({
      maxUnfinished: MAX,
      runner(job, done) {
        // 开始时它必须是唯一在运行的任务。
        assert.equal(q.runningId(), job.id);
        assert.equal(q.state(job.id), 'running');
        assert.equal(q.position(job.id), null);
        actualStarts.push(job);
        dones.push({ job, done });
        if (job.syncDone) done('done');
      },
    });

    // ---- 参考模型
    const model = new Map(); // id -> { job, state }
    const waiting = []; // job 对象，FIFO
    let running = null; // job 对象
    const modelStarts = [];
    const enqueueOrder = []; // 进入等待队列的 job 对象，按进入顺序

    const mRemove = (id) => {
      const e = model.get(id);
      if (!e) return null;
      model.delete(id);
      const i = waiting.indexOf(e.job);
      if (i >= 0) waiting.splice(i, 1);
      if (running === e.job) running = null;
      return e.state;
    };
    const mPump = () => {
      while (running === null && waiting.length > 0) {
        const job = waiting.shift();
        model.get(job.id).state = 'running';
        running = job;
        modelStarts.push(job);
        if (job.syncDone) mRemove(job.id);
      }
    };
    const mEnqueue = (id) => {
      const e = model.get(id);
      if (!e || e.state !== 'uploading') return false;
      e.state = 'queued';
      waiting.push(e.job);
      enqueueOrder.push(e.job);
      mPump();
      return true;
    };

    const check = (step) => {
      const where = `after op #${step} ${JSON.stringify(ops[step])}`;
      // 单进程：至多一个 running，且与 runningId 一致。
      const runningIds = [...POOL, GHOST].filter((id) => q.state(id) === 'running');
      assert.ok(runningIds.length <= 1, `${where}: running ${runningIds}`);
      assert.equal(q.runningId(), running ? running.id : null, where);
      assert.deepEqual(runningIds, running ? [running.id] : [], where);
      // 未完成上限。
      assert.ok(q.unfinished() <= MAX, `${where}: unfinished ${q.unfinished()}`);
      assert.equal(q.unfinished(), model.size, where);
      // 状态与排队位置。
      for (const id of [...POOL, GHOST]) {
        const e = model.get(id);
        assert.equal(q.state(id), e ? e.state : null, `${where}: state(${id})`);
        const i = waiting.findIndex((j) => j.id === id);
        assert.equal(q.position(id), i >= 0 ? i + 1 : null, `${where}: position(${id})`);
      }
      // FIFO：开始顺序等于模型，且等于实际运行过的任务的入队顺序。
      assert.deepEqual(actualStarts, modelStarts, `${where}: start order`);
      const ran = new Set(actualStarts);
      assert.deepEqual(actualStarts, enqueueOrder.filter((j) => ran.has(j)), `${where}: FIFO`);
    };

    let serial = 0;
    ops.forEach((o, step) => {
      switch (o.op) {
        case 'submit': {
          const job = { id: o.id, syncDone: o.syncDone, n: serial++ };
          const expected = !model.has(o.id) && model.size < MAX;
          if (expected) model.set(o.id, { job, state: 'uploading' });
          const got = q.submit(job, { uploading: o.uploading });
          // 模型在实际调用之后推进（runner 内的断言读取的是队列本身）。
          if (expected && !o.uploading) mEnqueue(o.id);
          assert.equal(got, expected, `submit(${o.id}) with ${model.size} unfinished`);
          break;
        }
        case 'enqueue': {
          const got = q.enqueue(o.id);
          assert.equal(got, mEnqueue(o.id), `enqueue(${o.id})`);
          break;
        }
        case 'doneRunning': {
          if (!running) break;
          const entry = dones.find((d) => d.job === running);
          assert.ok(entry, 'running job has a captured done');
          const job = running;
          mRemove(job.id);
          mPump();
          entry.done(o.status);
          break;
        }
        case 'finish': {
          const prev = mRemove(o.id);
          if (prev === 'running') mPump();
          assert.equal(q.finish(o.id, 'failed'), prev !== null, `finish(${o.id})`);
          break;
        }
        case 'cancel': {
          const prev = mRemove(o.id);
          if (prev === 'running') mPump();
          assert.equal(q.cancel(o.id), prev, `cancel(${o.id})`);
          break;
        }
        case 'lateDone': {
          const stale = dones.filter((d) => d.job !== running);
          if (stale.length === 0) break;
          stale[Math.floor(o.pick * stale.length)].done('done'); // 必须被忽略
          break;
        }
        default:
          throw new Error(`unknown op ${o.op}`);
      }
      check(step);
    });
  }, { runs: 200 });
});

// ---------------------------------------------------------------- Property 7

test('Feature: separation-accuracy, Property 7: 进度解析取最后一个值', async () => {
  const BAR = ['█', '▏', '▎', '▍', '▌', '▋', '▊', '▉', ' '];
  const SEPS = ['\r', '\n', '\r\n'];
  const TOKEN = /\d%\|/; // 进度标记的必要条件：数字紧跟 "%|"

  /** 百分比文本：0–100 的整数、一位或两位小数，偶尔超过 100（测试夹紧）。 */
  const pct = gen.oneOf(
    (rng) => String(gen.int(0, 100)(rng)),
    (rng) => (gen.int(0, 1000)(rng) / 10).toFixed(1),
    (rng) => (gen.int(0, 10000)(rng) / 100).toFixed(2),
    (rng) => (gen.int(1001, 9999)(rng) / 10).toFixed(1), // 100.1–999.9
    (rng) => String(gen.int(101, 999)(rng)),
  );
  const progressLine = (rng) => {
    const p = pct(rng);
    let bar = '';
    for (let i = gen.int(0, 20)(rng); i > 0; i--) bar += BAR[Math.floor(rng() * BAR.length)];
    const b = gen.int(1, 500)(rng);
    const a = gen.int(0, b)(rng);
    return { p, text: `${p}%|${bar}| ${a}/${b} [00:0${gen.int(0, 9)(rng)}<00:12, ${gen.int(1, 99)(rng)}.5seconds/s]` };
  };
  const noiseText = gen.oneOf(
    gen.string({ minLength: 0, maxLength: 30 }),
    'Downloading: "https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th"',
    (rng) => `Separated tracks will be stored in ${gen.string({ maxLength: 12 })(rng)}`,
    (rng) => `${gen.int(0, 100)(rng)}% done`,
    (rng) => `${gen.int(0, 100)(rng)}%`,
    (rng) => `Selected model is a bag of ${gen.int(1, 4)(rng)} models.`,
    '',
  );
  const noiseLine = (rng) => {
    for (;;) {
      const s = noiseText(rng);
      if (!TOKEN.test(s)) return { p: null, text: s };
    }
  };
  const line = gen.oneOf(progressLine, progressLine, noiseLine, noiseLine, noiseLine);

  const sample = (rng) => {
    const lines = gen.array(line, { minLength: 0, maxLength: 12 })(rng);
    let text = '';
    let lastP = null;
    let lastStart = -1; // 最后一个进度标记的起始下标
    let lastEnd = -1; // 最后一个进度标记 "%|" 之后的下标
    lines.forEach((l, i) => {
      if (i > 0) text += SEPS[Math.floor(rng() * SEPS.length)];
      if (l.p !== null) {
        lastP = l.p;
        lastStart = text.length;
        lastEnd = text.length + l.p.length + 2;
      }
      text += l.text;
    });
    if (rng() < 0.5) text += SEPS[Math.floor(rng() * SEPS.length)];
    // 任意切分成若干块（模拟 stderr 的 data 事件）。
    const cuts = gen.array(gen.int(0, text.length), { minLength: 0, maxLength: 4 })(rng).sort((x, y) => x - y);
    return { text, lastP, lastStart, lastEnd, cuts };
  };

  await forAll(sample, ({ text, lastP, lastStart, lastEnd, cuts }) => {
    const expected = lastP === null ? null : Math.min(100, Math.max(0, Math.round(Number(lastP))));
    assert.equal(parseProgress(text), expected);
    if (expected !== null) assert.ok(Number.isInteger(expected) && expected >= 0 && expected <= 100);

    const bounds = [0, ...cuts, text.length];
    const chunks = [];
    for (let i = 0; i + 1 < bounds.length; i++) chunks.push(text.slice(bounds[i], bounds[i + 1]));
    assert.equal(chunks.join(''), text);
    const lastCut = bounds[bounds.length - 2];
    const lastChunk = chunks[chunks.length - 1];
    if (lastP === null || lastCut >= lastEnd) {
      // 最后一块不含进度标记。
      assert.equal(parseProgress(lastChunk), null);
    } else if (lastCut <= lastStart) {
      // 最后一块完整包含最后一个进度标记。
      assert.equal(parseProgress(lastChunk), expected);
    }
    // 切分落在标记内部时不作断言（tqdm 实际按整行写出）。
  }, { runs: 300 });

  // 具体例子。
  assert.equal(parseProgress('no progress here\n50% done'), null);
  assert.equal(parseProgress(' 10%|█| 1/10\r 42.6%|███| 4/10\r'), 43);
  assert.equal(parseProgress('120.5%|██| 9/9'), 100);
  assert.equal(parseProgress(''), null);
});
