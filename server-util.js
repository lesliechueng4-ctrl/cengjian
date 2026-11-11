// Shared HTTP / process helpers for demucs-service.js and export-service.js.
// Node >= 18 built-ins only. Lives outside public/ so it is never served statically.

export const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function sendJson(res, code, body, extraHeaders = {}) {
  if (res.headersSent || res.destroyed) return;
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(code, {
    ...JSON_HEADERS,
    'Content-Length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

export function sendError(res, code, message, extraHeaders) {
  sendJson(res, code, { error: message }, extraHeaders);
}

/** A string of digits that is a safe integer > 0, otherwise fallback. */
export function positiveInt(value, fallback) {
  if (typeof value !== 'string' || !/^\s*\d+\s*$/.test(value)) return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** A non-empty string that parses to a finite number > 0, otherwise fallback. */
export function positiveNumber(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Truncate to at most max code points. */
export function truncate(text, max = 200) {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

/**
 * Last non-empty (trimmed) line of text, truncated to 200 code points, or ''.
 * Lines matching the optional `ignore` regex are skipped.
 */
export function lastStderrLine(text, { ignore } = {}) {
  const lines = String(text || '').split(/[\r\n]+/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (ignore) {
      ignore.lastIndex = 0;
      if (ignore.test(line)) continue;
    }
    return truncate(line);
  }
  return '';
}

/**
 * Rejects uploads whose body has not been fully read (413 over limit, 500 write error, ...).
 * Destroying the socket while request bytes are still arriving makes the OS send a RST,
 * and the client then sees ECONNRESET instead of the response. So the full response is
 * written at once (Content-Length known, the client can parse it), the rest of the body
 * is read and discarded (never stored), and the response is ended only after the request
 * ends. A client that keeps sending more than max(maxExtraBytes, its Content-Length) extra bytes or for longer
 * than drainMs has its socket destroyed. killAll() destroys every request still draining.
 */
export function createRejectDrainer({ maxExtraBytes, drainMs = 10_000 } = {}) {
  /** Requests rejected mid-body that are still draining. */
  const draining = new Set();

  function reject(req, res, code, message) {
    if (res.headersSent || res.destroyed) {
      req.destroy();
      return;
    }
    const text = JSON.stringify({ error: message });
    res.writeHead(code, {
      ...JSON_HEADERS,
      'Content-Length': Buffer.byteLength(text),
      Connection: 'close',
    });
    if (req.readableEnded) {
      res.end(text);
      return;
    }
    res.write(text);
    // A request with Content-Length cannot deliver more body than it declared (Node's parser
    // enforces it), so an honest client finishing its declared body is never cut off, even
    // when the body was rejected before any of it was read (413 on the declared size).
    // drainMs still bounds how long that may take.
    const declared = req.headers['content-length'];
    const declaredBytes = declared !== undefined && /^\d+$/.test(declared) ? Number(declared) : 0;
    const budget = Math.max(maxExtraBytes, Number.isSafeInteger(declaredBytes) ? declaredBytes : 0);
    let extra = 0;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      draining.delete(entry);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('close', onClose);
    };
    const kill = () => {
      cleanup();
      req.destroy();
    };
    const onData = (chunk) => {
      extra += chunk.length;
      if (extra > budget) kill();
    };
    const onEnd = () => {
      cleanup();
      if (!res.writableEnded && !res.destroyed) res.end();
    };
    const onClose = () => {
      cleanup();
      if (!res.writableEnded && !res.destroyed) res.destroy();
    };
    const entry = { kill };
    draining.add(entry);
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('close', onClose);
    timer = setTimeout(kill, drainMs);
    if (typeof timer.unref === 'function') timer.unref();
    req.resume();
  }

  function killAll() {
    for (const entry of [...draining]) entry.kill();
  }

  return { reject, killAll };
}
