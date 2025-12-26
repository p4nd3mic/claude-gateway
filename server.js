const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const http = require('http');
const os = require('os');
const fs = require('fs');
const { spawnSync, spawn } = require('child_process');
const multer = require('multer');
const pty = require('node-pty');
const WebSocket = require('ws');

const PORT = Number(process.env.GATEWAY_PORT || 8787);
const WORKDIR = process.env.GATEWAY_WORKDIR || process.env.HOME || process.cwd();
const DEFAULT_SESSION = process.env.GATEWAY_SESSION || 'main';
const BOOT_CMD = process.env.GATEWAY_BOOT_CMD || '';
const USE_TMUX = (process.env.GATEWAY_USE_TMUX || 'true').toLowerCase() !== 'false';
const SHELL = process.env.SHELL || 'zsh';
const TRANSCRIBE_SCRIPT = process.env.TRANSCRIBE_SCRIPT || path.join(__dirname, 'scripts', 'transcribe.sh');
const TMP_DIR = process.env.GATEWAY_TMP_DIR || path.join(os.tmpdir(), 'claude-gateway');
const UPLOAD_DIR =
  process.env.GATEWAY_UPLOAD_DIR || path.join(os.homedir(), '.claude-gateway', 'uploads');
const HISTORY_LIMIT = Number(process.env.GATEWAY_HISTORY_LIMIT || 200000);
const API_KEY = process.env.GATEWAY_API_KEY;
const SESSION_TTL_MS = Number(process.env.GATEWAY_SESSION_TTL_HOURS || 4) * 60 * 60 * 1000;
const IDLE_TIMEOUT_MS = Number(process.env.GATEWAY_IDLE_TIMEOUT_MINS || 30) * 60 * 1000;

// Require API key in production
if (!API_KEY) {
  console.error('FATAL: GATEWAY_API_KEY environment variable is required');
  process.exit(1);
}

// Request logging
function log(msg, meta = {}) {
  const ts = new Date().toISOString();
  const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${ts}] ${msg}${metaStr}`);
}

// Auth middleware - accepts key from header or query param
function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) {
    log('AUTH DENIED', { path: req.path, ip: req.ip });
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const upload = multer({ dest: TMP_DIR });
const sessions = new Map();

server.on('connection', (socket) => {
  socket.setNoDelay(true);
});

// CORS middleware for cross-origin requests (mobile app, web client)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Allow localhost origins for development
  if (origin && (origin.includes('localhost') || origin.includes('127.0.0.1'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', sessions: sessions.size });
});

// Apply auth to all /api routes except /health
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  authMiddleware(req, res, next);
});

// Request logging middleware
app.use('/api', (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    log('HTTP', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start });
  });
  next();
});

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Missing audio file' });
  }

  const inputPath = req.file.path;
  try {
    const text = await runTranscribe(inputPath);
    res.json({ text: text.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Transcription failed' });
  } finally {
    fs.rm(inputPath, { force: true }, () => {});
  }
});

app.post('/api/upload-image', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Missing image file' });
  }

  const ext = path.extname(req.file.originalname || '').slice(0, 8) || '.jpg';
  const targetName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const targetPath = path.join(UPLOAD_DIR, targetName);

  try {
    fs.renameSync(req.file.path, targetPath);
  } catch (err) {
    try {
      fs.copyFileSync(req.file.path, targetPath);
      fs.rmSync(req.file.path, { force: true });
    } catch (copyErr) {
      return res.status(500).json({ error: 'Failed to save image' });
    }
  }

  res.json({ path: targetPath });
});

// File browser API - list directory contents
app.get('/api/files', (req, res) => {
  let targetPath = req.query.path || '~';

  // Expand ~ to home directory
  if (targetPath === '~' || targetPath.startsWith('~/')) {
    targetPath = targetPath.replace('~', os.homedir());
  }

  // Resolve to absolute path
  targetPath = path.resolve(targetPath);

  // Security: prevent path traversal attacks
  const home = os.homedir();
  if (!targetPath.startsWith(home) && !targetPath.startsWith('/tmp')) {
    // Allow browsing within home directory and /tmp only
    return res.status(403).json({ error: 'Access denied: path outside allowed directories' });
  }

  try {
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is not a directory' });
    }

    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const files = entries
      .filter((entry) => !entry.name.startsWith('.')) // Hide dotfiles by default
      .map((entry) => {
        const fullPath = path.join(targetPath, entry.name);
        let size;
        let modified;
        try {
          const fileStat = fs.statSync(fullPath);
          size = fileStat.size;
          modified = fileStat.mtime.toISOString();
        } catch {
          // Ignore stat errors (permission denied, etc.)
        }
        return {
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory(),
          size: entry.isDirectory() ? undefined : size,
          modified,
        };
      });

    res.json({ path: targetPath, files });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Directory not found' });
    }
    if (err.code === 'EACCES') {
      return res.status(403).json({ error: 'Permission denied' });
    }
    log('FILES ERROR', { path: targetPath, error: err.message });
    res.status(500).json({ error: err.message || 'Failed to list directory' });
  }
});

function hasTmux() {
  if (!USE_TMUX) return false;
  const result = spawnSync('tmux', ['-V']);
  return result.status === 0;
}

function spawnSession(sessionId) {
  const env = { ...process.env, TERM: 'xterm-256color' };
  const cols = 120;
  const rows = 40;

  try {
    if (hasTmux()) {
      const args = ['new-session', '-A', '-s', sessionId, '-c', WORKDIR];
      return pty.spawn('tmux', args, { name: 'xterm-256color', cols, rows, cwd: WORKDIR, env });
    }
    return pty.spawn(SHELL, [], { name: 'xterm-256color', cols, rows, cwd: WORKDIR, env });
  } catch (err) {
    log('PTY SPAWN ERROR', { sessionId, error: err.message });
    throw err;
  }
}

function getSession(sessionId) {
  if (sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    session.lastActivity = Date.now();
    return session;
  }

  const ptyProcess = spawnSession(sessionId);
  const clients = new Set();
  let history = '';

  if (BOOT_CMD) {
    setTimeout(() => {
      ptyProcess.write(`${BOOT_CMD}\r`);
    }, 200);
  }

  ptyProcess.onData((data) => {
    history += data;
    if (history.length > HISTORY_LIMIT) {
      history = history.slice(history.length - HISTORY_LIMIT);
    }
    for (const send of clients) {
      send(data);
    }
  });

  ptyProcess.onExit(() => {
    log('SESSION EXIT', { sessionId });
    for (const send of clients) {
      send(null, true);
    }
    clients.clear();
    sessions.delete(sessionId);
  });

  const session = {
    ptyProcess,
    clients,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    get history() {
      return history;
    },
  };
  sessions.set(sessionId, session);
  log('SESSION CREATED', { sessionId });
  return session;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const key = url.searchParams.get('key');

  // WebSocket authentication
  if (key !== API_KEY) {
    log('WS AUTH DENIED', { ip: req.socket.remoteAddress });
    ws.close(4001, 'Unauthorized');
    return;
  }

  const sessionId = url.searchParams.get('session') || DEFAULT_SESSION;
  log('WS CONNECTED', { sessionId, ip: req.socket.remoteAddress });

  let session;
  try {
    session = getSession(sessionId);
  } catch (err) {
    ws.close(4002, 'Session spawn failed');
    return;
  }

  const send = (data, closed = false) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (closed) {
      ws.send(JSON.stringify({ type: 'exit' }));
      return;
    }
    ws.send(JSON.stringify({ type: 'output', data }));
  };

  session.clients.add(send);
  if (session.history) {
    send(session.history);
  }

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'input' && typeof msg.data === 'string') {
      session.ptyProcess.write(msg.data);
    }

    if (msg.type === 'resize') {
      const cols = Number(msg.cols || 0);
      const rows = Number(msg.rows || 0);
      if (cols > 0 && rows > 0) {
        session.ptyProcess.resize(cols, rows);
      }
    }
  });

  ws.on('close', () => {
    session.clients.delete(send);
    log('WS DISCONNECTED', { sessionId });
  });
});

app.get('/api/stream', (req, res) => {
  const sessionId = req.query.session || DEFAULT_SESSION;
  const session = getSession(sessionId);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('event: open\ndata: {}\n\n');
  res.write('retry: 1000\n\n');

  const send = (data, closed = false) => {
    if (closed) {
      res.write(`data: ${JSON.stringify({ type: 'exit' })}\n\n`);
      if (typeof res.flush === 'function') res.flush();
      return;
    }
    res.write(`data: ${JSON.stringify({ type: 'output', data })}\n\n`);
    if (typeof res.flush === 'function') res.flush();
  };

  session.clients.add(send);
  if (session.history) {
    send(session.history);
  }

  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 2000);

  req.on('close', () => {
    clearInterval(keepAlive);
    session.clients.delete(send);
  });
});

app.post('/api/input', (req, res) => {
  const sessionId = req.body?.session || DEFAULT_SESSION;
  const data = req.body?.data || '';
  const session = getSession(sessionId);
  if (data) {
    session.ptyProcess.write(data);
  }
  res.json({ ok: true });
});

function runTranscribe(inputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(TRANSCRIBE_SCRIPT, [inputPath], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr.trim() || `Transcribe failed (${code})`));
      }
      resolve(stdout);
    });
  });
}

// Session cleanup - runs every 5 minutes
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    const age = now - session.createdAt;
    const idle = now - session.lastActivity;
    const hasClients = session.clients.size > 0;

    // Kill sessions older than TTL or idle too long with no clients
    if (age > SESSION_TTL_MS || (!hasClients && idle > IDLE_TIMEOUT_MS)) {
      log('SESSION CLEANUP', { sessionId, ageHours: (age / 3600000).toFixed(1), idleMins: (idle / 60000).toFixed(0), clients: session.clients.size });
      try {
        session.ptyProcess.kill();
      } catch (e) {
        // Already dead
      }
      sessions.delete(sessionId);
    }
  }
}, 5 * 60 * 1000);

// Graceful shutdown
function shutdown(signal) {
  log('SHUTDOWN', { signal, sessions: sessions.size });

  clearInterval(cleanupInterval);

  // Close all WebSocket connections
  for (const client of wss.clients) {
    client.close(1001, 'Server shutting down');
  }

  // Kill all PTY sessions
  for (const [sessionId, session] of sessions) {
    try {
      session.ptyProcess.kill();
    } catch (e) {
      // Already dead
    }
  }
  sessions.clear();

  server.close(() => {
    log('SHUTDOWN COMPLETE');
    process.exit(0);
  });

  // Force exit after 5 seconds
  setTimeout(() => {
    log('SHUTDOWN FORCED');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, () => {
  log('STARTED', { port: PORT, workdir: WORKDIR, tmux: hasTmux() });
});
