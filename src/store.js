import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * A small persistent store: everything lives in memory and is written to
 * <dataDir>/db.json after each change. Good for one process; swap it for a
 * database if you run several instances.
 */
export class Store extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dataDir = dataDir;
    this.filesDir = path.join(dataDir, 'files');
    this.tmpDir = path.join(dataDir, 'tmp');
    this.dbFile = path.join(dataDir, 'db.json');
    mkdirSync(this.filesDir, { recursive: true });
    mkdirSync(this.tmpDir, { recursive: true });
    this.sessions = new Map();
    this.files = new Map();
    this.pairs = new Map(); // pairToken -> { sessionId, expiresAt }
    this.phones = new Map(); // sha256(phoneToken) -> { sessionId, expiresAt }
    this.tickets = new Map(); // single-use SSE tickets, memory only
    this.load();
    this.timer = null;
  }

  load() {
    if (!existsSync(this.dbFile)) return;
    try {
      const db = JSON.parse(readFileSync(this.dbFile, 'utf8'));
      for (const s of db.sessions || []) this.sessions.set(s.id, s);
      for (const f of db.files || []) this.files.set(f.id, f);
      for (const [k, v] of db.phones || []) this.phones.set(k, v);
    } catch (err) {
      console.warn(`[crossupload] could not read ${this.dbFile}: ${err.message}`);
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 50);
    this.timer.unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    const tmp = this.dbFile + '.tmp';
    writeFileSync(tmp, JSON.stringify({
      sessions: [...this.sessions.values()],
      files: [...this.files.values()],
      phones: [...this.phones.entries()],
    }));
    renameSync(tmp, this.dbFile);
  }

  filePath(id) {
    return path.join(this.filesDir, id);
  }

  sessionFiles(sessionId) {
    return [...this.files.values()].filter((f) => f.sessionId === sessionId);
  }

  /** Publish a file event to everyone listening on the session. */
  publish(sessionId, file) {
    this.emit(`session:${sessionId}`, file);
  }

  deleteFile(id) {
    const f = this.files.get(id);
    if (!f) return false;
    rmSync(this.filePath(id), { force: true });
    this.files.delete(id);
    this.save();
    return true;
  }

  /** Remove expired sessions, credentials and files past their retention. */
  sweep(now = Date.now()) {
    for (const [k, v] of this.pairs) if (v.expiresAt < now) this.pairs.delete(k);
    for (const [k, v] of this.phones) if (v.expiresAt < now) this.phones.delete(k);
    for (const [k, v] of this.tickets) if (v.expiresAt < now) this.tickets.delete(k);
    for (const f of this.files.values()) if (f.deleteAt < now) this.deleteFile(f.id);
    for (const s of this.sessions.values()) {
      if (s.expiresAt < now && this.sessionFiles(s.id).length === 0) this.sessions.delete(s.id);
    }
    this.save();
  }
}
