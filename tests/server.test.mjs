import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, resolvePath } from '../server.js';

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

test('resolvePath keeps files inside the root', () => {
  const root = '/srv/public';
  assert.equal(resolvePath('/', root).file, '/srv/public/index.html');
  assert.equal(resolvePath('/js/app.js?v=1', root).file, '/srv/public/js/app.js');
  assert.equal(resolvePath('/../etc/passwd', root).status, 403);
  assert.equal(resolvePath('/a%00b', root).status, 400);
});
