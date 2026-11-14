import http from 'node:http';
import { createReadStream, createWriteStream, renameSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { Store } from './store.js';
import { sniff, typeAllowed, narrowTypes } from './sniff.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const token = (prefix) => prefix + randomBytes(24).toString('base64url');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const STATIC = {
  '/widget.js': ['widget.js', 'text/javascript; charset=utf-8'],
  '/v1/widget.js': ['widget.js', 'text/javascript; charset=utf-8'],
  '/p': ['phone.html', 'text/html; charset=utf-8'],
  '/phone.js': ['phone.js', 'text/javascript; charset=utf-8'],
  '/demo.js': ['demo.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

/** Cleans a client-supplied file name for display and download headers. */
function cleanName(raw) {
  let name = 'file';
  try {
    name = decodeURIComponent(String(raw || 'file'));
  } catch {
    name = String(raw || 'file');
  }
  name = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').replace(/^\.+/, '').trim();
  return (name || 'file').slice(0, 200);
}

export function createApp(config) {
  const store = new Store(config.dataDir);

  // ---------- Domain ----------

  /** What the browser (widget and phone) may see about a file. */
  const publicFile = (f) => ({
    id: f.id, name: f.name, size: f.size, mime: f.mime, status: f.status,
    reason: f.reason || null, source: f.source, createdAt: f.createdAt,
  });
  /** What your backend sees, with its secret key. */
  const serverFile = (f) => ({
    ...publicFile(f), sessionId: f.sessionId, externalReference: f.externalReference ?? null,
    sha256: f.sha256 || null, deleteAt: new Date(f.deleteAt).toISOString(),
  });
  const limits = (s) => ({ allowedTypes: s.allowedTypes, maxFileSize: s.maxFileSize, maxFiles: s.maxFiles });

  function createSession(input = {}) {
    const allowedTypes = narrowTypes(input.allowedTypes, config.allowedTypes);
    if (!allowedTypes) throw new HttpError(422, 'invalid_types', 'allowedTypes contains no type the server allows');
    const now = Date.now();
    const clientToken = token('ct_');
    const session = {
      id: token('ses_').slice(0, 28),
      clientTokenHash: sha256(clientToken),
      allowedTypes,
      maxFileSize: Math.min(Number(input.maxFileSize) || config.maxFileSize, config.maxFileSize),
      maxFiles: Math.min(Number(input.maxFiles) || config.maxFiles, config.maxFiles),
      externalReference: input.externalReference == null ? null : String(input.externalReference).slice(0, 200),
      createdAt: new Date(now).toISOString(),
      expiresAt: now + config.sessionTtlMs,
    };
    store.sessions.set(session.id, session);
    store.save();
    return {
      sessionId: session.id,
      clientToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
      ...limits(session),
    };
  }

  function liveSession(id) {
    const s = store.sessions.get(id);
    if (!s) throw new HttpError(404, 'session_not_found', 'Session not found');
    if (s.expiresAt < Date.now()) throw new HttpError(410, 'session_expired', 'Session expired');
    return s;
  }

  function bearer(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  }

  function requireSecret(req) {
    if (!safeEqual(bearer(req), config.secretKey)) throw new HttpError(401, 'unauthorized', 'Invalid secret key');
  }

  function requireClient(req, sessionId, queryToken) {
    const s = liveSession(sessionId);
    const t = bearer(req) || queryToken || '';
    if (!t || !safeEqual(sha256(t), s.clientTokenHash)) throw new HttpError(401, 'unauthorized', 'Invalid client token');
    return s;
  }

  function requirePhone(req) {
    const entry = store.phones.get(bearer(req));
    if (!entry || entry.expiresAt < Date.now()) throw new HttpError(401, 'unauthorized', 'This QR code has expired. Scan a new one.');
    return liveSession(entry.sessionId);
  }

  async function pair(session) {
    const pairToken = token('pt_');
    const expiresAt = Math.min(Date.now() + config.pairTtlMs, session.expiresAt);
    store.pairs.set(pairToken, { sessionId: session.id, expiresAt });
    // The token travels in the fragment, so it never reaches server or proxy logs.
    const url = `${config.publicUrl}/p#${pairToken}`;
    const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { url, qrSvg, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Single use: the pairing token is exchanged once for a phone credential. */
  function claim(pairToken) {
    const entry = store.pairs.get(pairToken);
    store.pairs.delete(pairToken);
    if (!entry || entry.expiresAt < Date.now()) throw new HttpError(410, 'pairing_expired', 'This QR code was already used or has expired. Scan a new one.');
    const session = liveSession(entry.sessionId);
    const phoneToken = token('ph_');
    store.phones.set(phoneToken, { sessionId: session.id, expiresAt: session.expiresAt });
    store.save();
    return { phoneToken, ...limits(session) };
  }

  /** Streams one upload to disk, checks the real type, and settles the file. */
  async function receive(req, session, source) {
    const name = cleanName(req.headers['x-file-name']);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > session.maxFileSize) {
      throw new HttpError(413, 'file_too_large', `The file is larger than ${Math.round(session.maxFileSize / 1048576)} MB`);
    }
    const used = store.sessionFiles(session.id).filter((f) => f.status !== 'rejected').length;
    if (used >= session.maxFiles) throw new HttpError(409, 'max_files_reached', `This form accepts up to ${session.maxFiles} files`);

    const now = Date.now();
    const file = {
      id: token('file_').slice(0, 29), sessionId: session.id, externalReference: session.externalReference,
      name, size: 0, mime: null, status: 'checking', source, createdAt: new Date(now).toISOString(),
      deleteAt: now + config.fileTtlMs,
    };
    store.files.set(file.id, file);
    store.publish(session.id, publicFile(file));

    const tmp = path.join(store.tmpDir, file.id);
    const hash = createHash('sha256');
    const head = [];
    let headLen = 0;
    let size = 0;
    const tooLarge = `The file is larger than ${Math.round(session.maxFileSize / 1048576)} MB`;
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > session.maxFileSize) {
          // Keep reading (and dropping) a little past the limit so the client gets a clean 413.
          if (size > session.maxFileSize + 8 * 1048576) return cb(new HttpError(413, 'file_too_large', tooLarge));
          return cb();
        }
        if (headLen < 4096) { head.push(chunk); headLen += chunk.length; }
        hash.update(chunk);
        cb(null, chunk);
      },
    });

    const reject = (reason) => {
      rmSync(tmp, { force: true });
      Object.assign(file, { status: 'rejected', reason, size });
      store.save();
      store.publish(session.id, publicFile(file));
      return file;
    };

    try {
      await pipeline(req, limiter, createWriteStream(tmp));
    } catch (err) {
      reject(err instanceof HttpError ? err.message : 'Upload interrupted');
      throw err instanceof HttpError ? err : new HttpError(400, 'upload_failed', 'Upload interrupted');
    }

    if (size > session.maxFileSize) {
      reject(tooLarge);
      throw new HttpError(413, 'file_too_large', tooLarge);
    }
    if (size === 0) return reject('The file is empty');
    const { mime, dangerous } = sniff(Buffer.concat(head), name);
    file.mime = mime;
    if (dangerous) return reject('This file type is never accepted');
    if (!typeAllowed(mime, session.allowedTypes)) return reject(`This form does not accept ${mime} files`);

    renameSync(tmp, store.filePath(file.id));
    Object.assign(file, { status: 'accepted', size, sha256: hash.digest('hex') });
    store.save();
    store.publish(session.id, publicFile(file));
    return file;
  }

  // ---------- HTTP plumbing ----------

  function cors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return;
    const any = config.allowedOrigins.includes('*');
    if (any || config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', any ? '*' : origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-File-Name');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function readJson(req) {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 65536) throw new HttpError(413, 'body_too_large', 'Request body too large');
    }
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'invalid_json', 'Body must be JSON');
    }
  }

  async function serveStatic(res, file, type) {
    const body = await readFile(path.join(PUBLIC_DIR, file));
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
    if (type.startsWith('text/html')) {
      headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'";
      headers['Referrer-Policy'] = 'no-referrer';
    }
    res.writeHead(200, headers);
    res.end(body);
  }

  function events(req, res, session) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n'); // send headers now, not at the first event
    const send = (f) => res.write(`event: file\ndata: ${JSON.stringify(f)}\n\n`);
    for (const f of store.sessionFiles(session.id)) send(publicFile(f));
    const key = `session:${session.id}`;
    store.on(key, send);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      store.off(key, send);
    });
  }

  const routes = [
    ['GET', /^\/health$/, (req, res) => json(res, 200, { ok: true })],
    ['GET', /^\/favicon\.ico$/, (req, res) => res.writeHead(204).end()],

    ['POST', /^\/v1\/sessions$/, async (req, res) => {
      requireSecret(req);
      json(res, 201, createSession(await readJson(req)));
    }],
    ['GET', /^\/v1\/sessions\/([\w-]+)$/, (req, res, [id]) => {
      const s = requireClient(req, id);
      json(res, 200, { sessionId: s.id, ...limits(s), files: store.sessionFiles(s.id).map(publicFile) });
    }],
    ['POST', /^\/v1\/sessions\/([\w-]+)\/pair$/, async (req, res, [id]) => {
      json(res, 201, await pair(requireClient(req, id)));
    }],
    ['GET', /^\/v1\/sessions\/([\w-]+)\/events$/, (req, res, [id], url) => {
      events(req, res, requireClient(req, id, url.searchParams.get('token')));
    }],
    ['PUT', /^\/v1\/sessions\/([\w-]+)\/files$/, async (req, res, [id]) => {
      const f = await receive(req, requireClient(req, id), 'device');
      json(res, f.status === 'accepted' ? 201 : 422, publicFile(f));
    }],

    ['POST', /^\/v1\/phone\/claim$/, async (req, res) => {
      const { pairToken } = await readJson(req);
      json(res, 200, claim(String(pairToken || '')));
    }],
    ['GET', /^\/v1\/phone\/session$/, (req, res) => {
      const s = requirePhone(req);
      json(res, 200, { ...limits(s), files: store.sessionFiles(s.id).filter((f) => f.source === 'phone').map(publicFile) });
    }],
    ['PUT', /^\/v1\/phone\/files$/, async (req, res) => {
      const f = await receive(req, requirePhone(req), 'phone');
      json(res, f.status === 'accepted' ? 201 : 422, publicFile(f));
    }],

    ['GET', /^\/v1\/files\/([\w-]+)$/, (req, res, [id]) => {
      requireSecret(req);
      const f = store.files.get(id);
      if (!f) throw new HttpError(404, 'file_not_found', 'File not found');
      json(res, 200, serverFile(f));
    }],
    ['GET', /^\/v1\/files\/([\w-]+)\/content$/, (req, res, [id]) => {
      requireSecret(req);
      const f = store.files.get(id);
      if (!f || f.status !== 'accepted') throw new HttpError(404, 'file_not_found', 'File not found');
      res.writeHead(200, {
        'Content-Type': f.mime, 'Content-Length': statSync(store.filePath(id)).size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
      });
      createReadStream(store.filePath(id)).pipe(res);
    }],
    ['DELETE', /^\/v1\/files\/([\w-]+)$/, (req, res, [id]) => {
      requireSecret(req);
      if (!store.deleteFile(id)) throw new HttpError(404, 'file_not_found', 'File not found');
      res.writeHead(204).end();
    }],
  ];

  if (config.demo) {
    routes.push(
      ['GET', /^\/$/, (req, res) => serveStatic(res, 'demo.html', 'text/html; charset=utf-8')],
      // In your app this endpoint lives on your backend and calls POST /v1/sessions with SECRET_KEY.
      ['POST', /^\/demo\/session$/, (req, res) => json(res, 201, createSession({ externalReference: 'demo-form', maxFiles: 3 }))],
      // ...and this is your form handler: it re-checks every file id on the server.
      ['POST', /^\/demo\/submit$/, async (req, res) => {
        const body = await readJson(req);
        const ids = Array.isArray(body.attachment_ids) ? body.attachment_ids : [];
        const files = ids.map((id) => store.files.get(String(id)))
          .filter((f) => f && f.status === 'accepted' && f.externalReference === 'demo-form');
        json(res, 200, { ok: files.length === ids.length, name: String(body.name || ''), files: files.map(serverFile) });
      }],
    );
  } else {
    routes.push(['GET', /^\/$/, (req, res) => json(res, 200, { name: 'crossupload-core', widget: `${config.publicUrl}/v1/widget.js` })]);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    cors(req, res);
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    if (req.method === 'GET' && STATIC[url.pathname]) return serveStatic(res, ...STATIC[url.pathname]);
    for (const [method, pattern, fn] of routes) {
      const m = pattern.exec(url.pathname);
      if (m && method === req.method) return fn(req, res, m.slice(1), url);
    }
    throw new HttpError(404, 'not_found', 'Not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (res.headersSent) return res.destroy();
      const reply = () => json(res, status, { error: { code: err.code || 'internal', message: status === 500 ? 'Internal error' : err.message } });
      if (req.complete || req.readableEnded) return reply();
      // The client is still sending. Read (and discard) the rest so it can see the
      // answer, but never more than a few MB: past that, cut the connection.
      res.setHeader('Connection', 'close');
      let drained = 0;
      req.on('data', (c) => { drained += c.length; if (drained > 8 * 1048576) req.destroy(); });
      req.on('end', reply);
      req.on('error', () => res.destroy());
      req.resume();
    });
  });

  const sweeper = setInterval(() => store.sweep(), 60_000);
  sweeper.unref();
  server.on('close', () => {
    clearInterval(sweeper);
    store.flush();
  });

  return { server, store, createSession };
}
