import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';

import {
  positiveInt,
  positiveNumber,
  truncate,
  lastStderrLine,
  createRejectDrainer,
} from '../server-util.js';
import { gen, forAll } from './helpers/prop.mjs';
import { listenFetchable } from './helpers/listen.mjs';

// ---------- 纯函数示例 ----------

test('positiveInt: 只接受正的安全整数字符串', () => {
  assert.equal(positiveInt('5', 9), 5);
  assert.equal(positiveInt(' 42 ', 9), 42);
  assert.equal(positiveInt('0', 9), 9);
  assert.equal(positiveInt('-3', 9), 9);
  assert.equal(positiveInt('1.5', 9), 9);
  assert.equal(positiveInt('1e3', 9), 9);
  assert.equal(positiveInt('', 9), 9);
  assert.equal(positiveInt('abc', 9), 9);
  assert.equal(positiveInt('99999999999999999999', 9), 9);
  assert.equal(positiveInt(undefined, 9), 9);
  assert.equal(positiveInt(7, 9), 9);
});

test('positiveNumber: 只接受有限且 > 0 的数字字符串', () => {
  assert.equal(positiveNumber('1.5', 9), 1.5);
  assert.equal(positiveNumber('1e3', 9), 1000);
  assert.equal(positiveNumber(' 2 ', 9), 2);
  assert.equal(positiveNumber('0', 9), 9);
  assert.equal(positiveNumber('-1', 9), 9);
  assert.equal(positiveNumber('', 9), 9);
  assert.equal(positiveNumber('   ', 9), 9);
  assert.equal(positiveNumber('Infinity', 9), 9);
  assert.equal(positiveNumber('NaN', 9), 9);
  assert.equal(positiveNumber('abc', 9), 9);
  assert.equal(positiveNumber(undefined, 9), 9);
});

test('truncate: 按码点截断，不拆开代理对', () => {
  assert.equal(truncate('abc'), 'abc');
  assert.equal(truncate('a'.repeat(200)), 'a'.repeat(200));
  assert.equal(truncate('a'.repeat(201)), 'a'.repeat(200));
  assert.equal(truncate('😀'.repeat(250)), '😀'.repeat(200));
  assert.equal(truncate('😀abc', 2), '😀a');
  assert.equal(truncate(''), '');
});

test('lastStderrLine: 示例', () => {
  assert.equal(lastStderrLine('Error while opening encoder\nConversion failed!\n'), 'Conversion failed!');
  assert.equal(lastStderrLine('a\r\n  b  \r\n\r\n   \r\n'), 'b');
  assert.equal(lastStderrLine(''), '');
  assert.equal(lastStderrLine(undefined), '');
  assert.equal(lastStderrLine('\n \n\t\n'), '');
  assert.equal(
    lastStderrLine('x.mp4: Invalid data\nAt least one output file must be specified\n', {
      ignore: /At least one output file must be specified/,
    }),
    'x.mp4: Invalid data',
  );
});

// ---------- Property 12 ----------

// 行内片段：不含 \r / \n（换行由分隔符单独生成）
const LINE_CHARS = [
  'a', 'Z', '0', ':', '.', '[', ']', '/', '\\', '%', '\t', ' ', ' ',
  '层', 'é', 'Ж', '\u0301', '\u200b', '\ufeff', '\u00a0', '😀', '🎵', '𝄞', '\ud800',
];
const MARK = 'IGNOREME';

function lineGen(rng) {
  const r = rng();
  if (r < 0.15) return ''; // 空行
  if (r < 0.25) return [' ', '\t', '  \t ', '\u00a0'][Math.floor(rng() * 4)]; // 只有空白
  if (r < 0.4) {
    // 超过 200 码点的长行（含非 BMP 字符）
    const n = 190 + Math.floor(rng() * 120);
    let s = '';
    for (let i = 0; i < n; i++) s += LINE_CHARS[Math.floor(rng() * LINE_CHARS.length)];
    return s;
  }
  if (r < 0.5) return `  ${MARK} ${gen.string({ maxLength: 6 })(rng).replace(/[\r\n]/g, '')}`;
  return gen.string({ minLength: 0, maxLength: 30 })(rng).replace(/[\r\n]/g, '')
    + (rng() < 0.3 ? LINE_CHARS[Math.floor(rng() * LINE_CHARS.length)] : '');
}

const SEPARATORS = ['\n', '\r\n', '\r', '\n\n', '\r\n\r\n'];

const stderrGen = (rng) => {
  const lines = gen.array(lineGen, { minLength: 0, maxLength: 12 })(rng);
  const seps = lines.map(() => SEPARATORS[Math.floor(rng() * SEPARATORS.length)]);
  let text = '';
  lines.forEach((l, i) => {
    text += l;
    if (i < lines.length - 1 || rng() < 0.5) text += seps[i];
  });
  return { lines, text, useIgnore: rng() < 0.5 };
};

test('Feature: stem-video-export, Property 12: 错误信息取 stderr 最后一行', async () => {
  // 全局正则：验证实现每次重置 lastIndex
  const ignore = new RegExp(MARK, 'g');
  await forAll(stderrGen, ({ lines, text, useIgnore }) => {
    let expected = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (!t) continue;
      if (useIgnore && t.includes(MARK)) continue;
      expected = Array.from(t).slice(0, 200).join('');
      break;
    }
    const actual = useIgnore ? lastStderrLine(text, { ignore }) : lastStderrLine(text);
    assert.equal(actual, expected);
    assert.ok(Array.from(actual).length <= 200);
    // 同一个全局正则重复使用，结果不受 lastIndex 影响
    if (useIgnore) assert.equal(lastStderrLine(text, { ignore }), actual);
  }, { runs: 200 });
});

// ---------- createRejectDrainer ----------

async function startServer(t, handler) {
  const server = http.createServer(handler);
  const port = await listenFetchable(server);
  t.after(() => {
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
  });
  return port;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * 原始 TCP 上传客户端：声明 Content-Length 后按需发送请求体，并一直读响应。
 * 不用 http.request，因为它在收到完整的 Connection: close 响应后会自行关闭连接，
 * 无法模拟「继续发送」的客户端。
 */
function rawUpload(t, port, contentLength) {
  const socket = net.connect(port, '127.0.0.1');
  t.after(() => socket.destroy());
  const state = { errors: [], closed: false, received: Buffer.alloc(0) };
  socket.on('error', (e) => state.errors.push(e));
  socket.on('data', (d) => { state.received = Buffer.concat([state.received, d]); });
  const closed = new Promise((resolve) => socket.on('close', () => { state.closed = true; resolve(); }));
  const connected = once(socket, 'connect').then(() => {
    socket.write(
      'POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
      `Content-Type: application/octet-stream\r\nContent-Length: ${contentLength}\r\n\r\n`,
    );
  });
  return { socket, state, closed, connected };
}

function parseResponse(buf) {
  const sep = buf.indexOf('\r\n\r\n');
  assert.ok(sep > 0, 'response head received');
  const [statusLine, ...headerLines] = buf.subarray(0, sep).toString('latin1').split('\r\n');
  const headers = {};
  for (const l of headerLines) {
    const i = l.indexOf(':');
    headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return { status: Number(statusLine.split(' ')[1]), headers, body: buf.subarray(sep + 4) };
}

test('createRejectDrainer: 大请求体被拒时客户端仍收到完整的 413 响应', async (t) => {
  const drainer = createRejectDrainer({ maxExtraBytes: 64 * 1024 * 1024, drainMs: 10_000 });
  t.after(() => drainer.killAll());
  let serverBytes = 0;
  const port = await startServer(t, (req, res) => {
    req.on('data', (c) => { serverBytes += c.length; });
    drainer.reject(req, res, 413, '文件太大');
  });

  const total = 6 * 1024 * 1024;
  const { socket, state, closed, connected } = rawUpload(t, port, total);
  await connected;
  const chunk = Buffer.alloc(64 * 1024, 7);
  for (let sent = 0; sent < total; sent += chunk.length) {
    if (!socket.write(chunk)) await withTimeout(once(socket, 'drain'), 10_000, 'drain');
  }

  await withTimeout(closed, 10_000, 'server closes after response');
  assert.deepEqual(state.errors.map((e) => e.code), []);
  assert.equal(serverBytes, total);
  const res = parseResponse(state.received);
  assert.equal(res.status, 413);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.headers.connection, 'close');
  assert.equal(Number(res.headers['content-length']), res.body.length);
  assert.deepEqual(JSON.parse(res.body.toString('utf8')), { error: '文件太大' });
});

test('createRejectDrainer: 请求体已读完时直接结束响应', async (t) => {
  const drainer = createRejectDrainer({ maxExtraBytes: 1024 });
  const port = await startServer(t, (req, res) => {
    req.resume();
    req.on('end', () => drainer.reject(req, res, 500, '服务器无法保存上传文件'));
  });
  const res = await fetch(`http://127.0.0.1:${port}/upload`, { method: 'POST', body: 'small' });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: '服务器无法保存上传文件' });
});

test('createRejectDrainer: 持续发送超过 maxExtraBytes 的连接被销毁', async (t) => {
  const maxExtraBytes = 256 * 1024;
  const drainer = createRejectDrainer({ maxExtraBytes, drainMs: 30_000 });
  t.after(() => drainer.killAll());
  let serverReq;
  let serverSocketClosed;
  const socketClosed = new Promise((r) => { serverSocketClosed = r; });
  const port = await startServer(t, (req, res) => {
    serverReq = req;
    req.socket.once('close', serverSocketClosed);
    drainer.reject(req, res, 413, '文件太大');
  });

  const { socket, state, closed, connected } = rawUpload(t, port, 1024 * 1024 * 1024);
  await connected;
  const chunk = Buffer.alloc(64 * 1024, 1);
  let sent = 0;
  const pump = () => {
    if (state.closed || socket.destroyed) return;
    sent += chunk.length;
    if (socket.write(chunk)) setImmediate(pump);
    else socket.once('drain', pump);
  };
  pump();

  await withTimeout(socketClosed, 10_000, 'server socket close');
  await withTimeout(closed, 10_000, 'client close');
  assert.equal(serverReq.destroyed, true);
  assert.ok(sent > maxExtraBytes, `sent ${sent} bytes`);
});

test('createRejectDrainer: killAll() 销毁仍在排空的连接', async (t) => {
  const drainer = createRejectDrainer({ maxExtraBytes: 64 * 1024 * 1024, drainMs: 60_000 });
  let rejected;
  const rejectedP = new Promise((r) => { rejected = r; });
  const port = await startServer(t, (req, res) => {
    drainer.reject(req, res, 413, '文件太大');
    rejected(req);
  });

  const { socket, state, closed, connected } = rawUpload(t, port, 10 * 1024 * 1024);
  await connected;
  socket.write(Buffer.alloc(1024, 2)); // 请求体远未发完，连接保持在排空状态
  const serverReq = await withTimeout(rejectedP, 5_000, 'reject called');
  const serverSocketClosed = once(serverReq.socket, 'close');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(serverReq.destroyed, false);
  assert.equal(state.closed, false);
  assert.equal(parseResponse(state.received).status, 413); // 响应已先行写出

  drainer.killAll();
  await withTimeout(serverSocketClosed, 5_000, 'server socket close');
  assert.equal(serverReq.destroyed, true);
  await withTimeout(closed, 5_000, 'client close');
  drainer.killAll(); // 再次调用无副作用
});
