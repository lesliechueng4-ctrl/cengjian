import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createAccess, readPassword, isLocalRequest, COOKIE_NAME, LOGIN_PATH, PASSWORD_FILE } from '../access.js';
import { createServer } from '../server.js';

const PASSWORD = 'test-only-password';

/** A server on a random port; requests come from this machine, so "remote" ones carry a proxy header like a tunnel adds. */
async function start(access) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chaipai-access-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<title>app</title>');
  fs.mkdirSync(path.join(root, 'js'));
  fs.writeFileSync(path.join(root, 'js', 'app.js'), '// app');
  const server = createServer(root, { access });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const request = (p, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const close = async () => {
    await new Promise((r) => server.close(r));
    await fs.promises.rm(root, { recursive: true, force: true });
  };
  return { request, close };
}

const REMOTE = { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-proto': 'https' };
const HTML = { accept: 'text/html,application/xhtml+xml' };
const login = (s, password, headers = REMOTE) => s.request(LOGIN_PATH, {
  method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ password }),
});

test('without a password nothing changes: every request goes through', async () => {
  const access = createAccess({ password: '' });
  assert.equal(access.enabled, false);
  const s = await start(access);
  try {
    assert.equal((await s.request('/', { headers: REMOTE })).status, 200);
    assert.equal((await s.request('/js/app.js', { headers: REMOTE })).status, 200);
  } finally { await s.close(); }
});

test('with a password: this computer needs none, a tunnelled visitor gets the login page and no files', async () => {
  const s = await start(createAccess({ password: PASSWORD }));
  try {
    assert.equal((await s.request('/')).text, '<title>app</title>', 'local browser');

    const page = await s.request('/', { headers: { ...REMOTE, ...HTML } });
    assert.equal(page.status, 401);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.ok(page.text.includes('访问密码') && !page.text.includes('<title>app</title>'));
    assert.ok(!page.text.includes(PASSWORD));

    const script = await s.request('/js/app.js', { headers: REMOTE });
    assert.equal(script.status, 401);
    assert.ok(!script.text.includes('// app'));
    const api = await s.request('/api/separate/status', { headers: { ...REMOTE, ...HTML } });
    assert.equal(api.status, 401);
    assert.match(api.headers['content-type'], /json/);
    const upload = await s.request('/api/separate?model=htdemucs', { method: 'POST', headers: REMOTE, body: Buffer.alloc(100000) });
    assert.equal(upload.status, 401);
  } finally { await s.close(); }
});

test('login: wrong password is refused, the right one sets a cookie that opens the app', async () => {
  const s = await start(createAccess({ password: PASSWORD }));
  try {
    assert.equal((await login(s, 'nope')).status, 401);
    assert.equal((await login(s, '')).status, 401);
    assert.equal((await s.request(LOGIN_PATH, { method: 'POST', headers: REMOTE, body: 'not json' })).status, 401);
    assert.equal((await s.request(LOGIN_PATH, { headers: REMOTE })).status, 405);

    const ok = await login(s, PASSWORD);
    assert.equal(ok.status, 204);
    const setCookie = ok.headers['set-cookie'][0];
    assert.match(setCookie, new RegExp(`^${COOKIE_NAME}=[0-9a-f]{64}; Path=/; Max-Age=\\d+; HttpOnly; SameSite=Lax; Secure$`));
    assert.ok(!setCookie.includes(PASSWORD));
    const cookie = setCookie.split(';')[0];

    assert.equal((await s.request('/', { headers: { ...REMOTE, ...HTML, cookie } })).text, '<title>app</title>');
    assert.equal((await s.request('/js/app.js', { headers: { ...REMOTE, cookie: `other=1; ${cookie}` } })).status, 200);
    assert.equal((await s.request('/', { headers: { ...REMOTE, cookie: `${COOKIE_NAME}=${'0'.repeat(64)}` } })).status, 401);
  } finally { await s.close(); }
});

test('a cookie from one password does not work after the password changes; plain http gets no Secure flag', async () => {
  const a = await start(createAccess({ password: PASSWORD }));
  const b = await start(createAccess({ password: `${PASSWORD}-2` }));
  try {
    const res = await login(a, PASSWORD, { 'x-forwarded-for': '198.51.100.2' });
    assert.ok(!res.headers['set-cookie'][0].includes('Secure'));
    const cookie = res.headers['set-cookie'][0].split(';')[0];
    assert.equal((await b.request('/', { headers: { ...REMOTE, cookie } })).status, 401);
  } finally { await a.close(); await b.close(); }
});

test('too many wrong passwords from one visitor are blocked for a while, others are not affected', async () => {
  let t = 1_000_000;
  const s = await start(createAccess({ password: PASSWORD, now: () => t, maxFailures: 3, windowMs: 60_000 }));
  try {
    for (let i = 0; i < 3; i++) assert.equal((await login(s, 'guess')).status, 401);
    assert.equal((await login(s, PASSWORD)).status, 429, 'even the right password while blocked');
    assert.equal((await login(s, PASSWORD, { 'cf-connecting-ip': '203.0.113.99' })).status, 204, 'another visitor');
    t += 60_000;
    assert.equal((await login(s, PASSWORD)).status, 204, 'after the wait');
  } finally { await s.close(); }
});

test('isLocalRequest: loopback without proxy headers only', () => {
  const req = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers });
  assert.equal(isLocalRequest(req('127.0.0.1')), true);
  assert.equal(isLocalRequest(req('::1')), true);
  assert.equal(isLocalRequest(req('::ffff:127.0.0.1')), true);
  assert.equal(isLocalRequest(req('192.168.1.20')), false);
  assert.equal(isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' })), false);
  assert.equal(isLocalRequest(req('127.0.0.1', { 'cf-connecting-ip': '1.2.3.4' })), false);
  assert.equal(isLocalRequest(req('127.0.0.1', { 'cf-ray': 'abc' })), false);
});

test('readPassword: environment first, then the first line of the file, else off', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chaipai-pw-'));
  try {
    assert.equal(readPassword({}, dir), '');
    fs.writeFileSync(path.join(dir, PASSWORD_FILE), '﻿  from-file  \r\nsecond line\r\n');
    assert.equal(readPassword({}, dir), 'from-file');
    assert.equal(readPassword({ CHAIPAI_PASSWORD: ' from-env ' }, dir), 'from-env');
    assert.equal(readPassword({ CHAIPAI_PASSWORD: '   ' }, dir), 'from-file');
  } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
});
