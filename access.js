// Access password for sharing 拆拍 beyond this computer (other devices on the
// Wi-Fi, or the internet through a tunnel such as Cloudflare Tunnel).
//
// Off unless a password is configured: the environment variable
// CHAIPAI_PASSWORD, or the first line of access-password.txt next to server.js.
// With a password set, every request needs the login cookie, except requests
// made on this computer itself (http://localhost), which never ask.
//
// A tunnel also connects from this computer, so "on this computer" means a
// loopback connection that carries none of the headers a proxy adds.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COOKIE_NAME = 'chaipai_access';
export const LOGIN_PATH = '/api/login';
export const PASSWORD_FILE = 'access-password.txt';
const COOKIE_MAX_AGE = 30 * 24 * 3600;
const MAX_LOGIN_BODY = 2048;
const PROXY_HEADERS = ['x-forwarded-for', 'cf-connecting-ip', 'forwarded', 'x-real-ip', 'cf-ray'];

/** The configured password ('' when sharing protection is off). */
export function readPassword(env = process.env, dir = path.dirname(fileURLToPath(import.meta.url))) {
  const fromEnv = typeof env.CHAIPAI_PASSWORD === 'string' ? env.CHAIPAI_PASSWORD.trim() : '';
  if (fromEnv) return fromEnv;
  try {
    return fs.readFileSync(path.join(dir, PASSWORD_FILE), 'utf8').replace(/^﻿/, '').split(/\r?\n/)[0].trim();
  } catch {
    return '';
  }
}

const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

/** True for a request typed into a browser on this computer; false for LAN and tunnelled requests. */
export function isLocalRequest(req) {
  if (!isLoopback(req.socket && req.socket.remoteAddress)) return false;
  return !PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
}

/** Who to count failed logins against: the visitor's address as the tunnel reports it, else the socket's. */
function clientKey(req) {
  const addr = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!isLoopback(addr)) return addr; // these headers are only trusted from a local proxy
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim().slice(0, 64);
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim().slice(0, 64);
  return addr;
}

function cookieValue(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== 'string') return '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return '';
}

const sha = (text) => crypto.createHash('sha256').update(String(text)).digest();
const sameText = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>拆拍 · 请输入访问密码</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fff5f7; color: #3a2a30;
    font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  form { width: min(86vw, 320px); padding: 28px 24px; background: #fff; border-radius: 20px; box-shadow: 0 8px 30px rgba(224, 108, 132, .18); }
  h1 { margin: 0 0 6px; font-size: 22px; }
  p { margin: 0 0 18px; font-size: 14px; color: #8a6f78; }
  input, button { box-sizing: border-box; width: 100%; font: inherit; font-size: 16px; padding: 12px 14px; border-radius: 12px; }
  input { border: 1px solid #f0c9d2; margin-bottom: 12px; }
  button { border: 0; background: #e06c84; color: #fff; font-weight: 600; }
  button:disabled { opacity: .6; }
  #msg { min-height: 20px; margin: 12px 0 0; color: #c0392b; }
</style>
</head>
<body>
<form id="f">
  <h1>拆拍 · 音乐练习</h1>
  <p>这个地址需要访问密码，请向分享给你的人索取。</p>
  <input id="p" type="password" autocomplete="current-password" placeholder="访问密码" required autofocus>
  <button id="b" type="submit">进入</button>
  <p id="msg" role="alert"></p>
</form>
<script>
  const f = document.getElementById('f'), p = document.getElementById('p'), b = document.getElementById('b'), msg = document.getElementById('msg');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    b.disabled = true; msg.textContent = '';
    try {
      const r = await fetch('${LOGIN_PATH}', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: p.value }) });
      if (r.ok) { location.reload(); return; }
      msg.textContent = r.status === 429 ? '试的次数太多了，请过几分钟再试。' : '密码不对。';
    } catch { msg.textContent = '连接不上，请稍后再试。'; }
    b.disabled = false; p.select();
  });
</script>
</body>
</html>
`;

/**
 * @param {{password?: string, now?: () => number, maxFailures?: number, windowMs?: number}} [opts]
 * @returns {{enabled: boolean, token: string, handle(req, res): boolean}}
 *   handle answers the request itself (login, or refusal) and returns true;
 *   false means the request may go on.
 */
export function createAccess({ password = '', now = Date.now, maxFailures = 8, windowMs = 10 * 60 * 1000 } = {}) {
  const enabled = typeof password === 'string' && password.length > 0;
  // The cookie holds a value derived from the password, so logins survive a
  // restart and changing the password signs everyone out.
  const token = enabled ? crypto.createHmac('sha256', password).update('chaipai-access-v1').digest('hex') : '';
  const failures = new Map(); // client -> { count, since }

  const blocked = (key) => {
    const f = failures.get(key);
    if (!f) return false;
    if (now() - f.since >= windowMs) { failures.delete(key); return false; }
    return f.count >= maxFailures;
  };
  const noteFailure = (key) => {
    const t = now();
    if (failures.size > 5000) for (const [k, f] of failures) if (t - f.since >= windowMs) failures.delete(k);
    const f = failures.get(key);
    if (!f || t - f.since >= windowMs) failures.set(key, { count: 1, since: t });
    else f.count += 1;
  };

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };

  function login(req, res) {
    if (req.method !== 'POST') { json(res, 405, { error: 'Method Not Allowed' }, { Allow: 'POST' }); return; }
    const key = clientKey(req);
    if (blocked(key)) { json(res, 429, { error: '尝试次数过多，请稍后再试' }); return; }
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_LOGIN_BODY) over = true;
      else chunks.push(c);
    });
    req.on('error', () => {});
    req.on('end', () => {
      let given = '';
      if (!over) {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (body && typeof body.password === 'string') given = body.password;
        } catch { /* treated as a wrong password */ }
      }
      if (!given || !sameText(given, password)) {
        noteFailure(key);
        json(res, 401, { error: '密码不对' });
        return;
      }
      failures.delete(key);
      const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? '; Secure' : '';
      res.writeHead(204, {
        'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`,
        'Cache-Control': 'no-store',
      });
      res.end();
    });
  }

  function handle(req, res) {
    if (!enabled) return false;
    const pathname = String(req.url || '/').split(/[?#]/)[0];
    if (pathname === LOGIN_PATH) { login(req, res); return true; }
    if (isLocalRequest(req)) return false;
    const cookie = cookieValue(req, COOKIE_NAME);
    if (cookie && sameText(cookie, token)) return false;

    // An upload that is refused must not leave the connection half read.
    req.resume();
    const wantsPage = req.method === 'GET' && !pathname.startsWith('/api/') && String(req.headers.accept || '').includes('text/html');
    if (wantsPage) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(LOGIN_PAGE);
    } else {
      json(res, 401, { error: '需要访问密码' });
    }
    return true;
  }

  return { enabled, token, handle };
}
