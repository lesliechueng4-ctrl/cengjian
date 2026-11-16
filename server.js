// Zero-dependency static server for 拆拍 · 音乐练习.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDemucsService, readConfig, defaultTempRoot } from './demucs-service.js';
import { createAccess, readPassword, isLocalRequest } from './access.js';
import { createExportService, readExportConfig, defaultExportTempRoot } from './export-service.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

/** Map a raw request URL to a file inside ROOT, or return an HTTP status on failure. */
export function resolvePath(rawUrl, root = ROOT) {
  const rawPath = String(rawUrl || '/').split(/[?#]/)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { status: 400 };
  }
  if (decoded.includes('\0')) return { status: 400 };
  // Reject any parent-directory segment outright, including encoded forms.
  if (decoded.split(/[\\/]+/).includes('..')) return { status: 403 };
  let rel = decoded.replace(/^[\\/]+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  // Normalise the root too, so the containment check compares like with like
  // (e.g. a POSIX-style root on Windows resolves to a drive-qualified path).
  const base = path.resolve(root);
  const file = path.resolve(base, rel);
  if (file !== base && !file.startsWith(base + path.sep)) return { status: 403 };
  return { file };
}

export function createServer(root = ROOT, { demucs, exporter, access, requestLog } = {}) {
  return http.createServer((req, res) => {
    // One line per API request and page load, for finding out why a visitor's separation went wrong.
    if (requestLog) {
      const pathname = String(req.url || '/').split('?')[0];
      if (pathname === '/' || pathname.startsWith('/api/')) {
        const started = Date.now();
        res.on('finish', () => requestLog({
          method: req.method, url: req.url, status: res.statusCode, ms: Date.now() - started,
          remote: !isLocalRequest(req), bytes: Number(req.headers['content-length']) || 0,
          agent: String(req.headers['user-agent'] || '').slice(0, 120),
        }));
      }
    }
    // With an access password set, everything except this computer's own browser needs the login cookie.
    if (access && access.handle(req, res)) return;
    // Demucs_Service only claims /api/separate and Export_Service only /api/export;
    // everything else is static.
    if (demucs && demucs.handle(req, res)) return;
    if (exporter && exporter.handle(req, res)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
      return;
    }
    const { file, status } = resolvePath(req.url, root);
    if (status) {
      send(res, status, status === 403 ? 'Forbidden' : 'Bad Request');
      return;
    }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        send(res, 404, 'Not Found');
        return;
      }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        // no-store, not no-cache: phones (and a tunnel's cache in between) kept running an
        // old script after the file changed. The files are small and local, so always resend.
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      fs.createReadStream(file).pipe(res);
    });
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const port = Number(process.env.PORT) || 5173;
  const host = process.env.HOST || '0.0.0.0';
  const demucs = createDemucsService({ ...readConfig(), tempRoot: defaultTempRoot() });
  const exporter = createExportService({ ...readExportConfig(), tempRoot: defaultExportTempRoot() });
  const access = createAccess({ password: readPassword() });
  // Request log: a small text file in the temp folder, started afresh on every launch.
  const logFile = path.join(os.tmpdir(), 'chaipai-requests.log');
  try { fs.writeFileSync(logFile, ''); } catch { /* logging is optional */ }
  // Lines the services print about jobs go to the same file.
  for (const name of ['log', 'error', 'warn']) {
    const original = console[name].bind(console);
    console[name] = (...args) => {
      original(...args);
      const text = args.join(' ');
      if (text.startsWith('[')) fs.appendFile(logFile, `${new Date().toISOString()} ${text}
`, () => {});
    };
  }
  const requestLog = (r) => {
    const line = `${new Date().toISOString()} ${r.remote ? 'remote' : 'local '} ${r.method} ${r.url} -> ${r.status} ${r.ms}ms ${r.bytes}B ${r.agent}
`;
    fs.appendFile(logFile, line, () => {});
  };
  createServer(ROOT, { demucs, exporter, access, requestLog }).listen(port, host, () => {
    console.log('拆拍 · 音乐练习 已启动');
    console.log(`  电脑访问:  http://localhost:${port}`);
    for (const ip of lanAddresses()) console.log(`  手机访问:  http://${ip}:${port}  (同一 Wi-Fi 下)`);
    console.log(access.enabled
      ? '  访问密码:  已开启（这台电脑上用 localhost 打开不需要密码，其他设备需要）'
      : '  访问密码:  未设置（只适合在自己家里的 Wi-Fi 下用；要分享到外网请先设置，见 README）');
    // Clears the temp dir and probes Demucs; prints one "AI 分离" line after the banner.
    demucs.init();
    // Clears the cengjian-export temp dir and probes FFmpeg; prints one "视频导出" line.
    exporter.init();
  });
}
