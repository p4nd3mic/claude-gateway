const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const http = require('http');
const os = require('os');
const fs = require('fs');
const { spawnSync, spawn } = require('child_process');
const crypto = require('crypto');
const multer = require('multer');
const pty = require('node-pty');
const WebSocket = require('ws');

const PORT = Number(process.env.GATEWAY_PORT || 8787);
const HOST = process.env.GATEWAY_HOST || '0.0.0.0';
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
const CORS_ORIGINS_RAW = process.env.GATEWAY_CORS_ORIGINS || '';
const CODEX_SANDBOX_MODE = process.env.CODEX_SANDBOX_MODE || 'workspace-write';
const CODEX_APPROVAL_POLICY = process.env.CODEX_APPROVAL_POLICY || 'never';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
// Default model for new Codex sessions + runs (override via env).
// Note: Codex CLI (ChatGPT subscription login) supports the gpt-5.2-codex-* family.
const CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-5.2-codex-low';
const CODEX_MODELS = process.env.CODEX_MODELS || '';

function parseCorsOrigins(raw) {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isOriginAllowed(origin, allowed) {
  // Default: allow any origin when an Origin header is present.
  // Gateway API is protected by GATEWAY_API_KEY, so CORS here is about browser access,
  // not authentication.
  if (!allowed.length) return true;
  if (allowed.includes('*')) return true;

  for (const entry of allowed) {
    if (entry === origin) return true;
    // Support simple wildcard patterns like "https://*.example.com"
    if (entry.includes('*')) {
      const escaped = entry.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      const re = new RegExp(`^${escaped}$`);
      if (re.test(origin)) return true;
    }
  }

  return false;
}

// Request logging
function log(msg, meta = {}) {
  const ts = new Date().toISOString();
  const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  console.log(`[${ts}] ${msg}${metaStr}`);
}

// Require API key in production
if (!API_KEY) {
  console.error('FATAL: GATEWAY_API_KEY environment variable is required');
  process.exit(1);
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
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB limit
});
const sessions = new Map();
const jsonlToPtyMap = new Map(); // Maps JSONL session IDs to PTY session IDs for message routing
const activeCodexRuns = new Set();
const codexProcBySession = new Map(); // sessionId -> child_process
const codexFinalizeBySession = new Map(); // sessionId -> finalizeRun(stopReason, code, signal)
const codexQueueBySession = new Map(); // sessionId -> array of { prompt, content, imagePath, userMessageId }

function parseCodexModels(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    // Defaults intended for fast "driving mode" model switching.
    return [
      'gpt-5.2-codex-low',
      'gpt-5.2-codex-medium',
      'gpt-5.2-codex-high',
    ];
  }
  return trimmed
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

const CODEX_MODEL_CHOICES = parseCodexModels(CODEX_MODELS);

function formatModelLabel(model) {
  const m = String(model || '').trim();
  if (!m) return m;
  return m
    .replace(/^gpt-/, '')
    .replace(/-codex-/g, ' codex ')
    .replace(/-/g, ' ');
}

server.on('connection', (socket) => {
  socket.setNoDelay(true);
});

// CORS middleware for cross-origin requests (mobile app, web client)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = parseCorsOrigins(CORS_ORIGINS_RAW);

  if (origin && isOriginAllowed(origin, allowed)) {
    // Echo the origin (safer than "*", and works with custom headers like x-api-key).
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    // Cache preflight for a day
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '256kb' }));

// Check if a command exists
function commandExists(cmd) {
  try {
    const result = spawnSync('which', [cmd], { encoding: 'utf8', timeout: 5000 });
    return result.status === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function executableExists(cmd) {
  if (!cmd) return false;
  if (cmd.includes('/')) {
    try {
      return fs.existsSync(cmd);
    } catch {
      return false;
    }
  }
  return commandExists(cmd);
}

// Check for whisper model file
function whisperModelExists() {
  const modelPaths = [
    path.join(os.homedir(), '.cache', 'whisper', 'ggml-base.en.bin'),
    path.join(os.homedir(), '.cache', 'whisper', 'ggml-base.bin'),
    '/usr/local/share/whisper/ggml-base.en.bin',
  ];
  return modelPaths.some(p => fs.existsSync(p));
}

function expandHome(inputPath) {
  if (!inputPath) return inputPath;
  if (inputPath === '~' || inputPath.startsWith('~/')) {
    return inputPath.replace('~', os.homedir());
  }
  return inputPath;
}

function newId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${crypto.randomBytes(16).toString('hex')}`;
}

function emitCodexSessionMetaUpdate(sessionId) {
  try {
    const meta = readCodexSessionMeta(sessionId);
    const writer = createCodexEventWriter(sessionId);
    const isActive = activeCodexRuns.has(sessionId);
    const queueLength = (codexQueueBySession.get(sessionId) || []).length;
    const effectiveModel = meta.model || CODEX_MODEL || '';

    writer.append('session_meta', {
      provider: 'codex',
      sessionId,
      cwd: meta.cwd,
      model: effectiveModel,
      latestThreadId: meta.latestThreadId || '',
      usage: meta.usage || null,
      contextInfo: meta.contextInfo || null,
      isActive,
      queueLength,
    });
    writer.commit();
  } catch {
    // Ignore
  }
}

app.get('/api/health', (_req, res) => {
  const hasFfmpeg = commandExists('ffmpeg');
  const hasWhisper = commandExists('whisper') || commandExists('whisper-cpp') || commandExists('whisper.cpp');
  const hasModel = whisperModelExists();
  const uploadDirExists = fs.existsSync(UPLOAD_DIR);

  const diagnostics = {
    ffmpeg: hasFfmpeg,
    whisper: hasWhisper,
    whisperModel: hasModel,
    uploadDir: uploadDirExists,
    transcribeReady: hasFfmpeg && (hasWhisper || hasModel),
  };

  const allOk = diagnostics.ffmpeg && diagnostics.transcribeReady && diagnostics.uploadDir;

  res.json({
    status: allOk ? 'ok' : 'degraded',
    sessions: sessions.size,
    diagnostics,
  });
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

// ============================================================================
// Chat Stream API (JSONL-based, for Life Chat app)
// ============================================================================

const {
  SessionTailerManager,
  discoverSessions,
  getSessionDetails,
  markInteractiveSession,
  resolveSessionPath,
  formatSSE,
  HEARTBEAT_INTERVAL_MS,
} = require('./lib/chat-stream');

const tailerManager = new SessionTailerManager();
const {
  CodexTailerManager,
  listCodexSessions,
  createCodexSession,
  readSessionMeta: readCodexSessionMeta,
  createEventWriter: createCodexEventWriter,
} = require('./lib/codex-stream');

const codexTailerManager = new CodexTailerManager();

// List all Claude Code sessions from ~/.claude/projects/
app.get('/api/sessions', async (req, res) => {
  try {
    const { limit = 50, offset = 0, state, project } = req.query;

    const result = await discoverSessions({
      limit: Number(limit),
      offset: Number(offset),
      state,
      project,
    });

    res.json(result);
  } catch (err) {
    log('SESSIONS LIST ERROR', { error: err.message });
    res.status(500).json({ error: 'DISCOVERY_ERROR', message: err.message });
  }
});

// Get details for a specific session
app.get('/api/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await getSessionDetails(sessionId);
    res.json(session);
  } catch (err) {
    if (err.message === 'SESSION_NOT_FOUND' || err.message === 'INVALID_SESSION_ID') {
      return res.status(404).json({ error: err.message, message: 'Session not found' });
    }
    log('SESSION DETAIL ERROR', { sessionId: req.params.sessionId, error: err.message });
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
});

// Stream chat events from JSONL (SSE)
app.get('/api/chat-stream', (req, res) => {
  const sessionId = req.query.session;
  const since = req.headers['last-event-id'] || req.query.since || '0';
  const limit = Number(req.query.limit) || Infinity;

  if (!sessionId) {
    return res.status(400).json({ error: 'MISSING_SESSION', message: 'session query param required' });
  }

  let tailer;
  try {
    tailer = tailerManager.getOrCreate(sessionId);
  } catch (err) {
    if (err.message === 'SESSION_NOT_FOUND' || err.message === 'INVALID_SESSION_ID') {
      return res.status(404).json({ error: err.message, message: 'Session not found' });
    }
    log('CHAT STREAM ERROR', { sessionId, error: err.message });
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Send session_meta
  const meta = tailer.getSessionMeta();
  res.write(formatSSE('session_meta', 'meta', meta));

  // Add client and stream history + live updates
  tailer.addClient(res, { since, limit }).catch(err => {
    log('CHAT STREAM CLIENT ERROR', { sessionId, error: err.message });
  });

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(formatSSE('heartbeat', `heartbeat-${Date.now()}`, {}));
    } catch {
      clearInterval(heartbeat);
    }
  }, HEARTBEAT_INTERVAL_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    log('CHAT STREAM CLOSED', { sessionId });
  });
});

// Send message to a session (writes to PTY stdin)
app.post('/api/sessions/:sessionId/messages', (req, res) => {
  const { sessionId } = req.params;
  const { content, attachments = [], imagePath } = req.body || {};

  if (!content) {
    return res.status(400).json({ error: 'MISSING_CONTENT', message: 'content is required' });
  }

  // Look up PTY session from JSONL->PTY mapping
  const ptySessionId = jsonlToPtyMap.get(sessionId);

  if (!ptySessionId || !sessions.has(ptySessionId)) {
    // Verify JSONL exists even if we can't send to it
    try {
      resolveSessionPath(sessionId);
      return res.status(409).json({
        error: 'SESSION_NOT_INTERACTIVE',
        message: 'Session exists but was not started through this gateway. Use /api/session/start to create an interactive session.'
      });
    } catch (err) {
      return res.status(404).json({ error: 'SESSION_NOT_FOUND', message: 'Session not found' });
    }
  }

  const ptySession = sessions.get(ptySessionId);

  // Build message content with optional image reference
  let messageContent = content;
  if (imagePath) {
    // Append image path so Claude Code can read it with the Read tool
    messageContent += `\n\n[Attached image: ${imagePath}]`;
    log('MESSAGE WITH IMAGE', { sessionId, imagePath });
  }

  // Write message to PTY (add carriage return to submit)
  ptySession.ptyProcess.write(messageContent + '\r');

  res.json({
    accepted: true,
    messageId: `msg_user_${Date.now()}`,
    imagePath: imagePath || null,
  });
});

// Get tailer stats (for debugging)
app.get('/api/chat-stream/stats', (req, res) => {
  res.json(tailerManager.getStats());
});

// Start a new Claude Code session and return its JSONL session ID
app.post('/api/session/start', async (req, res) => {
  const { cwd = WORKDIR, waitForSession = true } = req.body || {};

  // Validate cwd exists
  if (!fs.existsSync(cwd)) {
    return res.status(400).json({ error: 'INVALID_CWD', message: 'Directory does not exist' });
  }

  // Generate unique PTY session ID
  const ptySessionId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  // Get list of existing JSONL files before spawning
  const projectSlug = cwd.replace(/\//g, '-');
  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectSlug);
  const existingFiles = new Set();
  if (fs.existsSync(projectDir)) {
    fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))
      .forEach(f => existingFiles.add(f));
  }

  // Spawn PTY session with claude command
  const env = { ...process.env, TERM: 'xterm-256color' };
  const ptyProcess = pty.spawn('claude', [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: cwd,
    env,
  });

  // Store in sessions map
  const clients = new Set();
  let history = '';

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
    log('SESSION EXIT', { sessionId: ptySessionId });
    sessions.delete(ptySessionId);
    // Clean up the mapping when PTY exits
    for (const [jsonlId, ptyId] of jsonlToPtyMap) {
      if (ptyId === ptySessionId) {
        jsonlToPtyMap.delete(jsonlId);
        break;
      }
    }
  });

  const session = {
    ptyProcess,
    clients,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    get history() { return history; },
  };
  sessions.set(ptySessionId, session);
  log('SESSION CREATED', { sessionId: ptySessionId, cwd });

  if (!waitForSession) {
    return res.json({
      ptySessionId,
      cwd,
      sessionId: null,  // Unknown until JSONL appears
    });
  }

  // Wait for new JSONL file to appear (Claude Code creates it on first message)
  const timeout = 15000;
  const pollInterval = 200;
  const startTime = Date.now();

  const checkForNewSession = () => {
    return new Promise((resolve) => {
      const check = () => {
        if (Date.now() - startTime > timeout) {
          resolve(null);
          return;
        }

        if (fs.existsSync(projectDir)) {
          const files = fs.readdirSync(projectDir)
            .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));

          for (const file of files) {
            if (!existingFiles.has(file)) {
              // New file found!
              const sessionId = path.basename(file, '.jsonl');
              resolve(sessionId);
              return;
            }
          }
        }

        setTimeout(check, pollInterval);
      };
      check();
    });
  };

  const jsonlSessionId = await checkForNewSession();

  if (jsonlSessionId) {
    // Store the mapping for message routing
    jsonlToPtyMap.set(jsonlSessionId, ptySessionId);
    // Persist marker so app can filter "interactive" sessions even after server restarts
    markInteractiveSession(jsonlSessionId);
  }

  res.json({
    sessionId: jsonlSessionId,
    ptySessionId,
    cwd,
    ready: !!jsonlSessionId,
  });
});

// ============================================================================
// Codex Provider API
// ============================================================================

app.get('/api/codex/sessions', (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;
    const result = listCodexSessions({
      limit: Number(limit),
      offset: Number(offset),
      activeSessions: activeCodexRuns,
    });
    res.json(result);
  } catch (err) {
    log('CODEX SESSIONS LIST ERROR', { error: err.message });
    res.status(500).json({ error: 'CODEX_DISCOVERY_ERROR', message: err.message });
  }
});

app.post('/api/codex/session/start', (req, res) => {
  const { cwd = WORKDIR } = req.body || {};
  const resolvedCwd = expandHome(cwd);

  if (!fs.existsSync(resolvedCwd)) {
    return res.status(400).json({ error: 'INVALID_CWD', message: 'Directory does not exist' });
  }

  const sessionId = newId();
  createCodexSession(sessionId, resolvedCwd, CODEX_MODEL);
  log('CODEX SESSION START', { sessionId, cwd: resolvedCwd });

  res.json({
    sessionId,
    cwd: resolvedCwd,
    ready: true,
  });
});

app.get('/api/codex/chat-stream', (req, res) => {
  const sessionId = req.query.session;
  const since = req.headers['last-event-id'] || req.query.since || '0';
  const limit = Number(req.query.limit) || Infinity;

  if (!sessionId) {
    return res.status(400).json({ error: 'MISSING_SESSION', message: 'session query param required' });
  }

  let tailer;
  try {
    tailer = codexTailerManager.getOrCreate(sessionId);
  } catch (err) {
    if (err.message === 'SESSION_NOT_FOUND' || err.message === 'INVALID_SESSION_ID') {
      return res.status(404).json({ error: err.message, message: 'Session not found' });
    }
    log('CODEX CHAT STREAM ERROR', { sessionId, error: err.message });
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const meta = tailer.getSessionMeta();
  meta.isActive = activeCodexRuns.has(sessionId);
  meta.queueLength = (codexQueueBySession.get(sessionId) || []).length;
  res.write(formatSSE('session_meta', 'meta', meta));

  tailer.addClient(res, { since, limit }).catch(err => {
    log('CODEX CHAT STREAM CLIENT ERROR', { sessionId, error: err.message });
  });

  const heartbeat = setInterval(() => {
    try {
      res.write(formatSSE('heartbeat', `heartbeat-${Date.now()}`, {}));
    } catch {
      clearInterval(heartbeat);
    }
  }, HEARTBEAT_INTERVAL_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    log('CODEX CHAT STREAM CLOSED', { sessionId });
  });
});

app.get('/api/codex/chat-stream/stats', (_req, res) => {
  res.json(codexTailerManager.getStats());
});

app.post('/api/codex/sessions/:sessionId/cancel', (req, res) => {
  const { sessionId } = req.params;
  const { clearQueue = false } = req.body || {};

  if (clearQueue) {
    codexQueueBySession.set(sessionId, []);
  }

  const finalize = codexFinalizeBySession.get(sessionId);
  const proc = codexProcBySession.get(sessionId);

  if (!proc && !finalize) {
    emitCodexSessionMetaUpdate(sessionId);
    return res.json({ ok: true, cancelled: false, running: false, clearedQueue: !!clearQueue });
  }

  if (typeof finalize === 'function') {
    finalize('cancelled', null, 'cancel_request');
  }

  if (proc && !proc.killed) {
    try {
      proc.kill('SIGTERM');
    } catch {
      // Ignore
    }
    setTimeout(() => {
      try {
        if (!proc.killed) proc.kill('SIGKILL');
      } catch {
        // Ignore
      }
    }, 1500);
  }

  emitCodexSessionMetaUpdate(sessionId);
  return res.json({ ok: true, cancelled: true, running: true, clearedQueue: !!clearQueue });
});

function startNextCodexTurn(sessionId) {
  if (activeCodexRuns.has(sessionId)) return;

  const queue = codexQueueBySession.get(sessionId) || [];
  if (queue.length === 0) return;

  const turn = queue.shift();
  codexQueueBySession.set(sessionId, queue);

  let sessionMeta;
  try {
    sessionMeta = readCodexSessionMeta(sessionId);
  } catch {
    return;
  }

  const writer = createCodexEventWriter(sessionId);
  const now = new Date().toISOString();
  const assistantMessageId = newId();

  let blockIndex = 0;
  let stderrBuf = '';
  let finished = false;
  let assistantPreview = '';
  let latestThreadId = '';
  let latestUsage = null;
  let lastCursor = writer.meta.lastCursor || 0;

  const append = (event, data) => {
    lastCursor = writer.append(event, data);
    return lastCursor;
  };

  const appendAssistantText = (text) => {
    append('content_block', {
      messageId: assistantMessageId,
      index: blockIndex++,
      block: { type: 'text', text: String(text || '') },
    });
  };

  const finalizeRun = (stopReason, code = null, signal = null) => {
    if (finished) return;
    finished = true;

    if (stopReason === 'error') {
      const stderrPreview = stderrBuf.trim().slice(0, 2000);
      if (blockIndex === 0) {
        appendAssistantText(
          `Codex failed to produce a response (exit=${code ?? 'unknown'}).\n` +
          (stderrPreview ? `\nStderr:\n${stderrPreview}` : '')
        );
      } else if (stderrPreview) {
        appendAssistantText(`(Codex stderr)\n${stderrPreview}`);
      }
    }

    if (stopReason === 'cancelled' && blockIndex === 0) {
      appendAssistantText('Cancelled.');
    }

    append('message_end', {
      id: assistantMessageId,
      stopReason,
    });

    const model = sessionMeta.model || CODEX_MODEL || '';
    const usage = latestUsage;
    const usageSummary = usage ? {
      inputTokens: usage.input_tokens ?? null,
      cachedInputTokens: usage.cached_input_tokens ?? null,
      outputTokens: usage.output_tokens ?? null,
      totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    } : null;

    const contextInfo = model ? computeContextInfo(model, usageSummary?.totalTokens ?? null) : null;

    writer.commit({
      lastMessageAt: new Date().toISOString(),
      lastMessagePreview: (assistantPreview || turn.content).slice(0, 120),
      messageCount: lastCursor,
      latestThreadId: latestThreadId || writer.meta.latestThreadId || '',
      model,
      usage: usageSummary,
      contextInfo,
    });

    codexProcBySession.delete(sessionId);
    codexFinalizeBySession.delete(sessionId);
    activeCodexRuns.delete(sessionId);
    emitCodexSessionMetaUpdate(sessionId);
    log('CODEX EXEC END', { sessionId, code, signal, stopReason });

    setImmediate(() => startNextCodexTurn(sessionId));
  };

  codexFinalizeBySession.set(sessionId, finalizeRun);
  activeCodexRuns.add(sessionId);
  emitCodexSessionMetaUpdate(sessionId);

  if (!executableExists(CODEX_BIN)) {
    stderrBuf = `Executable not found: ${CODEX_BIN}`;
    finalizeRun('error', null, 'bin_not_found');
    return;
  }

  const args = [
    '-a',
    CODEX_APPROVAL_POLICY,
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-C',
    sessionMeta.cwd || WORKDIR,
    '--sandbox',
    CODEX_SANDBOX_MODE,
    ...(sessionMeta.model || CODEX_MODEL ? ['--model', (sessionMeta.model || CODEX_MODEL)] : []),
    turn.prompt,
  ];

  log('CODEX EXEC START', { sessionId, cwd: sessionMeta.cwd, sandbox: CODEX_SANDBOX_MODE, queueRemaining: queue.length });

  append('message_start', {
    id: assistantMessageId,
    lineNumber: lastCursor + 1,
    role: 'assistant',
    timestamp: now,
    sessionId,
  });

  const proc = spawn(CODEX_BIN, args, {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  codexProcBySession.set(sessionId, proc);

  const stdoutRl = require('readline').createInterface({ input: proc.stdout, crlfDelay: Infinity });
  stdoutRl.on('line', (line) => {
    if (!line.trim()) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      log('CODEX JSONL PARSE ERROR', { sessionId, line: line.slice(0, 200) });
      return;
    }

    if (entry.type === 'thread.started' && entry.thread_id) {
      latestThreadId = String(entry.thread_id);
    }
    if (entry.type === 'turn.completed' && entry.usage) {
      latestUsage = entry.usage;
    }

    if (entry.type === 'item.started' && entry.item?.type === 'command_execution') {
      append('content_block', {
        messageId: assistantMessageId,
        index: blockIndex++,
        block: {
          type: 'tool_use',
          toolUseId: entry.item.id,
          toolName: 'bash',
          input: { command: entry.item.command },
        },
      });
    }

    if (entry.type === 'item.completed') {
      if (entry.item?.type === 'command_execution') {
        const output = entry.item.aggregated_output || '';
        append('content_block', {
          messageId: assistantMessageId,
          index: blockIndex++,
          block: {
            type: 'tool_result',
            toolUseId: entry.item.id,
            content: output,
            isError: Number(entry.item.exit_code || 0) !== 0,
            charCount: output.length,
          },
        });
      } else if (entry.item?.type === 'agent_message') {
        const text = entry.item.text || '';
        if (text) assistantPreview = text;
        append('content_block', {
          messageId: assistantMessageId,
          index: blockIndex++,
          block: { type: 'text', text },
        });
      } else if (entry.item?.type === 'reasoning') {
        append('content_block', {
          messageId: assistantMessageId,
          index: blockIndex++,
          block: { type: 'thinking', thinking: entry.item.text || '' },
        });
      }
    }
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString();
    if (text.trim()) {
      stderrBuf += text;
      if (stderrBuf.length > 8000) {
        stderrBuf = stderrBuf.slice(stderrBuf.length - 8000);
      }
      log('CODEX STDERR', { sessionId, message: text.trim().slice(0, 200) });
    }
  });

  proc.on('close', (code, signal) => {
    const stopReason = code === 0 ? 'end_turn' : 'error';
    finalizeRun(stopReason, code, signal);
  });

  proc.on('error', (err) => {
    stderrBuf = err.message || stderrBuf;
    finalizeRun('error', null, 'spawn_error');
  });
}

app.post('/api/codex/sessions/:sessionId/messages', (req, res) => {
  const { sessionId } = req.params;
  const { content, imagePath } = req.body || {};

  if (!content) {
    return res.status(400).json({ error: 'MISSING_CONTENT', message: 'content is required' });
  }

  let sessionMeta;
  try {
    sessionMeta = readCodexSessionMeta(sessionId);
  } catch (err) {
    if (err.message === 'SESSION_NOT_FOUND' || err.message === 'INVALID_SESSION_ID') {
      return res.status(404).json({ error: err.message, message: 'Session not found' });
    }
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }

  let prompt = content;
  if (imagePath) {
    prompt += `\n\n[Attached image: ${imagePath}]`;
  }

  const queue = codexQueueBySession.get(sessionId) || [];
  codexQueueBySession.set(sessionId, queue);

  const writer = createCodexEventWriter(sessionId);
  const now = new Date().toISOString();
  const userMessageId = newId();
  let lastCursor = writer.meta.lastCursor || 0;
  const append = (event, data) => {
    lastCursor = writer.append(event, data);
    return lastCursor;
  };

  const userLineNumber = lastCursor + 1;
  append('message_start', {
    id: userMessageId,
    lineNumber: userLineNumber,
    role: 'user',
    timestamp: now,
    sessionId,
  });
  append('content_block', {
    messageId: userMessageId,
    index: 0,
    block: { type: 'text', text: prompt },
  });
  append('message_end', {
    id: userMessageId,
    stopReason: 'end_turn',
  });

  writer.commit({
    lastMessageAt: now,
    lastMessagePreview: content.slice(0, 120),
    messageCount: lastCursor,
  });

  // Handle lightweight gateway commands (no Codex run)
  const trimmed = String(content || '').trim();
  if (trimmed === '/models' || trimmed.startsWith('/model')) {
    const modelList = CODEX_MODEL_CHOICES;
    const assistantMessageId = newId();
    let assistantCursor = lastCursor;
    const appendAssistant = (event, data) => {
      assistantCursor = writer.append(event, data);
      return assistantCursor;
    };
    let assistantBlockIndex = 0;
    const appendAssistantText = (text) => {
      appendAssistant('content_block', {
        messageId: assistantMessageId,
        index: assistantBlockIndex++,
        block: { type: 'text', text: String(text || '') },
      });
    };

    appendAssistant('message_start', {
      id: assistantMessageId,
      lineNumber: assistantCursor + 1,
      role: 'assistant',
      timestamp: now,
      sessionId,
    });

    if (trimmed === '/models') {
      const current = sessionMeta.model || CODEX_MODEL || '(default)';
      appendAssistantText(
        `Current model: ${current}\n\n` +
        `Quick set:\n` +
        modelList.map(m => `- ${formatModelLabel(m)}  (/model ${m})`).join('\n')
      );
    } else {
      const parts = trimmed.split(/\s+/).filter(Boolean);
      const requested = parts.length >= 2 ? parts.slice(1).join(' ') : '';

      if (!requested) {
        const current = sessionMeta.model || CODEX_MODEL || '(default)';
        appendAssistantText(`Current model: ${current}\n\nUse: /model <name> or /models`);
      } else {
        sessionMeta.model = requested;
        try {
          const updated = { ...sessionMeta, model: requested };
          const { writeSessionMeta: writeCodexSessionMeta } = require('./lib/codex-stream');
          writeCodexSessionMeta(sessionId, updated);
        } catch {
          // Ignore
        }
        appendAssistantText(`Model set to: ${requested}`);
      }
    }

    appendAssistant('message_end', {
      id: assistantMessageId,
      stopReason: 'end_turn',
    });

    writer.commit({ messageCount: assistantCursor });
    emitCodexSessionMetaUpdate(sessionId);
    return res.json({ accepted: true, messageId: userMessageId });
  }

  queue.push({ prompt, content, imagePath, userMessageId });
  emitCodexSessionMetaUpdate(sessionId);
  setImmediate(() => startNextCodexTurn(sessionId));

  res.json({
    accepted: true,
    messageId: userMessageId,
  });
});

function computeContextInfo(model, totalTokens) {
  if (!model || !Number.isFinite(totalTokens)) return null;

  const maxByModel = {
    o3: 200000,
    'o4-mini': 200000,
    'gpt-4.1': 128000,
    'gpt-4.1-mini': 128000,
    'gpt-4o': 128000,
    'gpt-4o-mini': 128000,
    'gpt-5.2-low': 200000,
    'gpt-5.2-medium': 200000,
    'gpt-5.2-high': 200000,
    'gpt-5.2-xhigh': 200000,
    'gpt-5.2-codex-low': 200000,
    'gpt-5.2-codex-medium': 200000,
    'gpt-5.2-codex-high': 200000,
  };

  const modelKey = String(model).trim();
  const max = maxByModel[modelKey] || (modelKey.startsWith('gpt-5.2') ? 200000 : null);
  if (!max) {
    return { maxTokens: null, usedTokens: totalTokens, percentLeft: null };
  }

  const used = Math.max(0, Number(totalTokens) || 0);
  const left = Math.max(0, max - used);
  const percentLeft = Math.max(0, Math.min(1, left / max));
  return { maxTokens: max, usedTokens: used, percentLeft };
}

// ============================================================================

function runTranscribe(inputPath) {
  return new Promise((resolve, reject) => {
    const TRANSCRIBE_TIMEOUT_MS = 60000; // 60 second timeout
    let killed = false;

    const proc = spawn(TRANSCRIBE_SCRIPT, [inputPath], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      reject(new Error('Transcription timed out after 60 seconds'));
    }, TRANSCRIBE_TIMEOUT_MS);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Transcribe script error: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (killed) return; // Already rejected by timeout
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

server.listen(PORT, HOST, () => {
  log('STARTED', { host: HOST, port: PORT, workdir: WORKDIR, tmux: hasTmux() });
});
