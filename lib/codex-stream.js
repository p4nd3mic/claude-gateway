/**
 * Codex Stream + Storage Helpers
 *
 * Provides session storage and JSONL streaming for Codex CLI runs.
 * Events are already normalized to LifeChat SSE schema.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const chokidar = require('chokidar');

const CODEX_GATEWAY_DIR = path.join(os.homedir(), '.claude-gateway');
const CODEX_SESSIONS_DIR = path.join(CODEX_GATEWAY_DIR, 'codex-sessions');
const CODEX_EVENTS_DIR = path.join(CODEX_GATEWAY_DIR, 'codex-events');
const TAILER_IDLE_TIMEOUT_MS = 60000;

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function ensureCodexDirs() {
  fs.mkdirSync(CODEX_SESSIONS_DIR, { recursive: true });
  fs.mkdirSync(CODEX_EVENTS_DIR, { recursive: true });
}

function validateSessionId(sessionId) {
  if (!UUID_PATTERN.test(sessionId)) {
    throw new Error('INVALID_SESSION_ID');
  }
}

function getSessionPaths(sessionId) {
  validateSessionId(sessionId);
  return {
    metaPath: path.join(CODEX_SESSIONS_DIR, `${sessionId}.json`),
    jsonlPath: path.join(CODEX_EVENTS_DIR, `${sessionId}.jsonl`),
  };
}

function readSessionMeta(sessionId) {
  ensureCodexDirs();
  const { metaPath } = getSessionPaths(sessionId);
  if (!fs.existsSync(metaPath)) {
    throw new Error('SESSION_NOT_FOUND');
  }
  const raw = fs.readFileSync(metaPath, 'utf8');
  return JSON.parse(raw);
}

function writeSessionMeta(sessionId, meta) {
  ensureCodexDirs();
  const { metaPath } = getSessionPaths(sessionId);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

function touchEventLog(sessionId) {
  ensureCodexDirs();
  const { jsonlPath } = getSessionPaths(sessionId);
  if (!fs.existsSync(jsonlPath)) {
    fs.writeFileSync(jsonlPath, '');
  }
}

function readLastCursorFromFile(jsonlPath) {
  if (!fs.existsSync(jsonlPath)) return 0;
  try {
    const stat = fs.statSync(jsonlPath);
    const chunkSize = Math.min(64 * 1024, stat.size);
    const fd = fs.openSync(jsonlPath, 'r');
    const buffer = Buffer.alloc(chunkSize);
    fs.readSync(fd, buffer, 0, chunkSize, stat.size - chunkSize);
    fs.closeSync(fd);
    const lines = buffer.toString('utf8').split('\n').reverse();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const cursor = Number(entry.cursor);
        return Number.isFinite(cursor) ? cursor : 0;
      } catch {
        // Skip malformed line
      }
    }
  } catch {
    return 0;
  }
  return 0;
}

function createEventWriter(sessionId) {
  ensureCodexDirs();
  const { metaPath, jsonlPath } = getSessionPaths(sessionId);
  if (!fs.existsSync(metaPath)) {
    throw new Error('SESSION_NOT_FOUND');
  }
  if (!fs.existsSync(jsonlPath)) {
    fs.writeFileSync(jsonlPath, '');
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  if (!Number.isFinite(meta.lastCursor)) {
    meta.lastCursor = readLastCursorFromFile(jsonlPath);
  }
  let cursor = meta.lastCursor || 0;

  return {
    meta,
    jsonlPath,
    append(event, data) {
      cursor += 1;
      const record = {
        cursor: String(cursor),
        event,
        data,
      };
      fs.appendFileSync(jsonlPath, JSON.stringify(record) + '\n');
      return cursor;
    },
    commit(updates = {}) {
      meta.lastCursor = cursor;
      Object.assign(meta, updates);
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    },
  };
}

function updateSessionMeta(sessionId, updates) {
  const meta = readSessionMeta(sessionId);
  const merged = { ...meta, ...updates };
  writeSessionMeta(sessionId, merged);
  return merged;
}

function listCodexSessions(options = {}) {
  const { limit = 50, offset = 0, activeSessions = new Set() } = options;
  ensureCodexDirs();

  if (!fs.existsSync(CODEX_SESSIONS_DIR)) {
    return { sessions: [], total: 0, hasMore: false };
  }

  const files = fs.readdirSync(CODEX_SESSIONS_DIR)
    .filter(f => f.endsWith('.json'));

  const total = files.length;
  const indexed = files.map((file) => {
    const metaPath = path.join(CODEX_SESSIONS_DIR, file);
    const stat = fs.statSync(metaPath);
    return { file, metaPath, mtimeMs: stat.mtimeMs };
  });

  indexed.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const start = Number(offset) || 0;
  const pageSize = Number(limit) || 50;
  const page = indexed.slice(start, start + pageSize);

  const sessions = page.map((item) => {
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(item.metaPath, 'utf8'));
    } catch {
      meta = {};
    }

    const sessionId = path.basename(item.file, '.json');
    const { jsonlPath } = getSessionPaths(sessionId);
    let fileSize = 0;
    try {
      fileSize = fs.statSync(jsonlPath).size;
    } catch {
      fileSize = 0;
    }

    return {
      id: sessionId,
      project: 'codex',
      displayName: 'codex',
      cwd: meta.cwd || '',
      jsonlPath,
      state: 'interactive',
      isActive: activeSessions.has(sessionId),
      createdAt: meta.createdAt || new Date(item.mtimeMs).toISOString(),
      lastMessageAt: meta.lastMessageAt || new Date(item.mtimeMs).toISOString(),
      lastMessagePreview: meta.lastMessagePreview || '',
      messageCount: meta.messageCount || 0,
      fileSize,
    };
  });

  const hasMore = start + sessions.length < total;
  return { sessions, total, hasMore };
}

function createCodexSession(sessionId, cwd, model = '') {
  ensureCodexDirs();
  const now = new Date().toISOString();
  const meta = {
    id: sessionId,
    cwd,
    model: model || '',
    createdAt: now,
    lastMessageAt: now,
    lastMessagePreview: '',
    messageCount: 0,
    lastCursor: 0,
  };

  writeSessionMeta(sessionId, meta);
  touchEventLog(sessionId);
  return meta;
}

// ============================================================================
// SSE Formatting
// ============================================================================

function formatSSE(eventType, cursor, data) {
  const lines = [];
  lines.push(`id: ${cursor}`);
  lines.push(`event: ${eventType}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  lines.push('');
  lines.push('');
  return lines.join('\n');
}

// ============================================================================
// Codex JSONL Tailer
// ============================================================================

class CodexTailer {
  constructor(sessionId, jsonlPath, cwd, onIdle = null) {
    this.sessionId = sessionId;
    this.jsonlPath = jsonlPath;
    this.cwd = cwd;
    this.clients = new Set();
    this.position = 0;
    this.lastCursor = 0;
    this.processing = false;
    this.watcher = null;
    this.onIdle = onIdle;
    this.idleTimer = null;
  }

  start() {
    if (this.watcher) return;

    this.watcher = chokidar.watch(this.jsonlPath, {
      persistent: true,
      usePolling: false,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.watcher.on('change', () => this.processNewLines());
    this.watcher.on('error', (err) => {
      console.error(`[CodexTailer] Watch error for ${this.sessionId}:`, err.message);
    });
  }

  stop() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.clients.clear();
  }

  startIdleTimeout() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      if (this.clients.size === 0 && this.onIdle) {
        this.onIdle(this.sessionId);
      }
    }, TAILER_IDLE_TIMEOUT_MS);
  }

  cancelIdleTimeout() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  async addClient(res, options = {}) {
    const { since = '0', limit = Infinity } = options;
    const sinceCursor = Number(since) || 0;

    await this.streamHistory(res, sinceCursor, limit);

    this.cancelIdleTimeout();
    this.clients.add(res);

    res.on('close', () => {
      this.clients.delete(res);
      if (this.clients.size === 0) {
        this.startIdleTimeout();
      }
    });
  }

  async streamHistory(res, sinceCursor, limit) {
    if (!fs.existsSync(this.jsonlPath)) return;

    res.write(formatSSE('history_start', 'history-start', { since: sinceCursor }));

    const fileStream = fs.createReadStream(this.jsonlPath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let eventCount = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      if (eventCount >= limit) break;

      try {
        const entry = JSON.parse(line);
        const cursor = Number(entry.cursor);
        if (!Number.isFinite(cursor) || cursor <= sinceCursor) {
          continue;
        }

        res.write(formatSSE(entry.event, entry.cursor, entry.data));
        eventCount += 1;
        this.lastCursor = Math.max(this.lastCursor, cursor);
      } catch {
        // Skip malformed lines
      }

      if (eventCount % 200 === 0) {
        await new Promise(resolve => setImmediate(resolve));
      }
    }

    const stat = fs.statSync(this.jsonlPath);
    this.position = stat.size;

    res.write(formatSSE('history_end', 'history-end', { count: eventCount }));
  }

  async processNewLines() {
    if (this.processing) return;
    this.processing = true;

    try {
      const stat = fs.statSync(this.jsonlPath);
      if (stat.size <= this.position) {
        this.processing = false;
        return;
      }

      const stream = fs.createReadStream(this.jsonlPath, { start: this.position });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          this.lastCursor = Math.max(this.lastCursor, Number(entry.cursor) || this.lastCursor);
          this.broadcast(entry.event, entry.cursor, entry.data);
        } catch {
          // Skip malformed lines
        }
      }

      this.position = stat.size;
    } catch (err) {
      console.error(`[CodexTailer] Error processing ${this.sessionId}:`, err.message);
    }

    this.processing = false;
  }

  broadcast(eventType, cursor, data) {
    const sseData = formatSSE(eventType, cursor, data);
    for (const client of this.clients) {
      try {
        client.write(sseData);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  getSessionMeta() {
    let meta;
    try {
      meta = readSessionMeta(this.sessionId);
    } catch {
      meta = {};
    }

    let totalLines = 0;
    try {
      const content = fs.readFileSync(this.jsonlPath, 'utf8');
      totalLines = content.split('\n').filter(l => l.trim()).length;
    } catch {
      totalLines = 0;
    }

    return {
      provider: 'codex',
      sessionId: this.sessionId,
      project: 'codex',
      cwd: meta.cwd || this.cwd,
      jsonlPath: this.jsonlPath,
      createdAt: meta.createdAt || new Date().toISOString(),
      isActive: false,
      totalLines,
      model: meta.model || '',
      latestThreadId: meta.latestThreadId || '',
      usage: meta.usage || null,
      contextInfo: meta.contextInfo || null,
    };
  }
}

class CodexTailerManager {
  constructor() {
    this.tailers = new Map();
  }

  getOrCreate(sessionId) {
    if (this.tailers.has(sessionId)) {
      return this.tailers.get(sessionId);
    }

    const { jsonlPath } = getSessionPaths(sessionId);
    const meta = readSessionMeta(sessionId);
    const tailer = new CodexTailer(sessionId, jsonlPath, meta.cwd, (id) => {
      this.remove(id);
    });
    tailer.start();
    this.tailers.set(sessionId, tailer);
    return tailer;
  }

  remove(sessionId) {
    const tailer = this.tailers.get(sessionId);
    if (tailer) {
      tailer.stop();
      this.tailers.delete(sessionId);
    }
  }

  getStats() {
    const stats = {
      activeTailers: this.tailers.size,
      sessions: [],
    };

    for (const [sessionId, tailer] of this.tailers) {
      stats.sessions.push({
        sessionId,
        clients: tailer.clients.size,
        lastCursor: tailer.lastCursor,
      });
    }

    return stats;
  }
}

module.exports = {
  CODEX_SESSIONS_DIR,
  CODEX_EVENTS_DIR,
  TAILER_IDLE_TIMEOUT_MS,
  ensureCodexDirs,
  getSessionPaths,
  readSessionMeta,
  writeSessionMeta,
  updateSessionMeta,
  createEventWriter,
  listCodexSessions,
  createCodexSession,
  formatSSE,
  CodexTailerManager,
};
