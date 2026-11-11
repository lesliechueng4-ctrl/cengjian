import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createServer, resolvePath } from '../server.js';
import { createDemucsService } from '../demucs-service.js';

function request(port, rawPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    // http.request keeps the raw path, so traversal attempts reach the server unnormalised.
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('static server', async (t) => {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  t.after(() => server.close());

  await t.test('GET / returns index.html', async () => {
    const res = await request(port, '/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.ok(res.body.includes('层间'));
    for (const s of ['音乐练习', '上传视频或音频', '练习室', '真实分析', '暂停', '+ 上传视频',
      '画面与音乐同步 · 变速保持音高', '首页', '音乐台', '我的']) {
      assert.ok(res.body.includes(s), `missing ${s}`);
    }
  });

  await t.test('stem buttons appear in screenshot order', async () => {
    const res = await request(port, '/index.html');
    const labels = ['原曲', '纯伴奏', '人声', '鼓', '贝斯', '和声伴奏', '额外打击乐', '效果音', '其他音效'];
    const found = [...res.body.matchAll(/class="stem-btn[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1]);
    assert.deepEqual(found, labels);
  });

  await t.test('JS modules are served as text/javascript', async () => {
    for (const p of ['/js/app.js', '/js/dsp.js', '/js/separator.worker.js']) {
      const res = await request(port, p);
      assert.equal(res.status, 200, p);
      assert.match(res.headers['content-type'], /^text\/javascript/);
    }
  });

  await t.test('CSS, manifest and icon have proper types', async () => {
    assert.match((await request(port, '/css/style.css')).headers['content-type'], /^text\/css/);
    assert.match((await request(port, '/manifest.webmanifest')).headers['content-type'], /^application\/manifest\+json/);
    assert.match((await request(port, '/icon.svg')).headers['content-type'], /^image\/svg\+xml/);
  });

  await t.test('path traversal is rejected', async () => {
    for (const p of ['/../server.js', '/js/../../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/..\\server.js']) {
      const res = await request(port, p);
      assert.equal(res.status, 403, p);
      assert.ok(!res.body.includes('createServer'));
    }
  });

  await t.test('unknown path returns 404', async () => {
    assert.equal((await request(port, '/nope.js')).status, 404);
    assert.equal((await request(port, '/js/')).status, 404);
  });

  await t.test('HEAD works and other methods are refused', async () => {
    const head = await request(port, '/', 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal((await request(port, '/', 'POST')).status, 405);
  });

  await t.test('malformed encoding returns 400', async () => {
    assert.equal((await request(port, '/%E0%A4%A')).status, 400);
  });
});

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

test('passing demucs leaves static behaviour unchanged', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cengjian-server-test-'));
  const demucs = createDemucsService({ command: null, tempRoot, log: () => {} });
  await demucs.init();
  const plain = createServer();
  const withDemucs = createServer(undefined, { demucs });
  const plainPort = await listen(plain);
  const demucsPort = await listen(withDemucs);
  t.after(async () => {
    await new Promise((r) => plain.close(r));
    await new Promise((r) => withDemucs.close(r));
    await demucs.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const cases = [
    ['GET', '/'],
    ['GET', '/index.html'],
    ['GET', '/js/app.js'],
    ['GET', '/js/separator.worker.js'],
    ['GET', '/css/style.css'],
    ['GET', '/manifest.webmanifest'],
    ['GET', '/icon.svg'],
    ['GET', '/../server.js'],
    ['GET', '/js/../../server.js'],
    ['GET', '/%2e%2e/server.js'],
    ['GET', '/..%2fserver.js'],
    ['GET', '/nope.js'],
    ['GET', '/js/'],
    ['GET', '/api/separatex'],
    ['GET', '/%E0%A4%A'],
    ['HEAD', '/'],
    ['HEAD', '/js/app.js'],
    ['POST', '/'],
    ['POST', '/index.html'],
  ];
  for (const [method, p] of cases) {
    const a = await request(plainPort, p, method);
    const b = await request(demucsPort, p, method);
    const key = `${method} ${p}`;
    assert.equal(b.status, a.status, key);
    assert.equal(b.headers['content-type'], a.headers['content-type'], key);
    assert.equal(b.headers.allow, a.headers.allow, key);
    assert.equal(b.body, a.body, key);
  }
  // Sanity: the comparison covered the expected statuses.
  assert.equal((await request(demucsPort, '/../server.js')).status, 403);
  assert.equal((await request(demucsPort, '/nope.js')).status, 404);
  assert.equal((await request(demucsPort, '/', 'POST')).status, 405);
  const head = await request(demucsPort, '/', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');

  // /api/separate/status belongs to the service only when it is passed.
  const st = await request(demucsPort, '/api/separate/status');
  assert.equal(st.status, 200);
  assert.match(st.headers['content-type'], /^application\/json/);
  const json = JSON.parse(st.body);
  assert.equal(json.available, false);
  assert.equal(json.checking, false);
  assert.equal((await request(plainPort, '/api/separate/status')).status, 404);
});

test('exporter without FFmpeg leaves static files and /api/separate untouched', async (t) => {
  const { createExportService } = await import('../export-service.js');
  const { listenFetchable } = await import('./helpers/listen.mjs');
  const demucsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cengjian-server-demucs-'));
  const exportRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cengjian-server-export-'));
  const demucs = createDemucsService({ command: null, tempRoot: demucsRoot, log: () => {} });
  const exporter = createExportService({ command: null, tempRoot: exportRoot, log: () => {} });
  await demucs.init();
  await exporter.init();
  const plain = createServer();
  const full = createServer(undefined, { demucs, exporter });
  const plainPort = await listenFetchable(plain);
  const fullPort = await listenFetchable(full);
  t.after(async () => {
    await new Promise((r) => plain.close(r));
    await new Promise((r) => full.close(r));
    await exporter.close();
    await demucs.close();
    await fs.rm(demucsRoot, { recursive: true, force: true });
    await fs.rm(exportRoot, { recursive: true, force: true });
  });

  // Server-side modules live outside public/ and must never be served (10.7).
  for (const p of ['/export-service.js', '/server-util.js', '/demucs-service.js', '/server.js']) {
    for (const port of [plainPort, fullPort]) {
      const res = await request(port, p);
      assert.equal(res.status, 404, p);
      assert.ok(!res.body.includes('createExportService'), p);
      assert.ok(!res.body.includes('createRejectDrainer'), p);
    }
  }

  // FFmpeg unavailable: static files behave exactly as without the exporter (6.7).
  const cases = [
    ['GET', '/'],
    ['GET', '/index.html'],
    ['GET', '/js/app.js'],
    ['GET', '/js/separator.worker.js'],
    ['GET', '/css/style.css'],
    ['GET', '/manifest.webmanifest'],
    ['GET', '/icon.svg'],
    ['GET', '/../export-service.js'],
    ['GET', '/js/../../server-util.js'],
    ['GET', '/nope.js'],
    ['GET', '/api/exportx'],
    ['HEAD', '/'],
    ['POST', '/'],
  ];
  for (const [method, p] of cases) {
    const a = await request(plainPort, p, method);
    const b = await request(fullPort, p, method);
    const key = `${method} ${p}`;
    assert.equal(b.status, a.status, key);
    assert.equal(b.headers['content-type'], a.headers['content-type'], key);
    assert.equal(b.body, a.body, key);
  }
  const index = await request(fullPort, '/index.html');
  assert.equal(index.status, 200);
  assert.ok(index.body.includes('class="stem-btn'));

  // /api/separate/status still answers from the Demucs service.
  const st = await request(fullPort, '/api/separate/status');
  assert.equal(st.status, 200);
  assert.match(st.headers['content-type'], /^application\/json/);
  const json = JSON.parse(st.body);
  assert.equal(json.available, false);
  assert.equal(json.checking, false);

  // The exporter itself reports unavailable rather than breaking the server.
  const ex = await request(fullPort, '/api/export/status');
  assert.equal(ex.status, 200);
  assert.equal(JSON.parse(ex.body).available, false);
});

test('package.json declares no dependencies', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

test('resolvePath keeps files inside the root', () => {
  const root = path.resolve('/srv/public');
  assert.equal(resolvePath('/', root).file, path.join(root, 'index.html'));
  assert.equal(resolvePath('/js/app.js?v=1', root).file, path.join(root, 'js', 'app.js'));
  assert.equal(resolvePath('/../etc/passwd', root).status, 403);
  assert.equal(resolvePath('/a%00b', root).status, 400);
});
