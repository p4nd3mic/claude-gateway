# Claude Gateway - Session Handoff

**Date:** 2025-12-19
**Session:** Initial MVP Build (Codex)
**Status:** MVP Complete, Ready for Testing

---

## What Was Built

Voice-first mobile gateway for Claude Code. Access your full Mac Mini/MacBook setup from your phone via a web PWA.

### Architecture
```
Phone (PWA) → Tailscale HTTPS → Gateway Server → PTY → Claude Code CLI
                                     ↓
                              Local Whisper (voice)
```

### Core Components

| Component | File | Purpose |
|-----------|------|---------|
| Server | `server.js` | WebSocket/SSE bridge to PTY sessions |
| Frontend | `public/` | xterm.js PWA with voice + image |
| Transcription | `scripts/transcribe.sh` | Local whisper-cpp pipeline |
| Config | `.env` | Ports, paths, model settings |

### Features Implemented

1. **Terminal Streaming**
   - WebSocket primary, SSE fallback
   - Auto-launches `claude` on connect
   - Session persistence via shared PTY

2. **Voice Input**
   - Tap-to-record (toggle, not hold)
   - Live transcript while speaking (when browser supports)
   - Local whisper-cpp transcription (no cloud)

3. **Navigation**
   - Esc / Up / Down buttons for CLI menus
   - Enter button for sending blank lines
   - Send button for text input

4. **Image Upload**
   - Upload from camera/gallery
   - Saved to `~/.claude-gateway/uploads/`
   - Path inserted into input for Claude analysis

5. **Connection Health**
   - Transport indicator (WS vs HTTP)
   - Live latency ping (ms)

---

## Dependencies Installed

```bash
# Homebrew
brew install ffmpeg whisper-cpp tailscale

# NPM (in claude-gateway/)
npm install  # express, ws, node-pty, multer, dotenv, xterm, etc.

# Whisper model
~/.local/share/whisper/ggml-base.en.bin
```

---

## Configuration

**`.env`** (created, gitignored):
```
GATEWAY_PORT=8787
GATEWAY_WORKDIR=/Users/jmwillis/code
GATEWAY_BOOT_CMD=claude
GATEWAY_USE_TMUX=true
WHISPER_ENGINE=cpp
WHISPER_CPP_BIN=/opt/homebrew/opt/whisper-cpp/bin/whisper-cli
WHISPER_CPP_ARGS=-ng
WHISPER_MODEL=/Users/jmwillis/.local/share/whisper/ggml-base.en.bin
FFMPEG_BIN=ffmpeg
GATEWAY_UPLOAD_DIR=/Users/jmwillis/.claude-gateway/uploads
```

---

## How to Run

```bash
# Terminal 1: Start Tailscale daemon (if not running)
sudo /opt/homebrew/opt/tailscale/bin/tailscaled

# Terminal 2: Login to Tailscale (one-time)
tailscale up

# Terminal 3: Start gateway
cd /Users/jmwillis/code/claude-gateway
npm start

# Terminal 4: Expose via Tailscale HTTPS
tailscale serve https / http://127.0.0.1:8787
tailscale serve status  # shows your URL
```

Open the HTTPS URL on your phone (with Tailscale app connected).

---

## Known Issues / Limitations

1. **iOS Safari MediaRecorder** - May not work; use keyboard dictation as fallback
2. **Live transcript** - Only works if browser supports Web Speech API
3. **Image analysis** - Depends on Claude Code CLI vision support
4. **MagicDNS required** - Enable in Tailscale admin console for *.ts.net URLs

---

## Potential Next Steps

1. **WebAudio recorder** - True push-to-talk on iOS (bypasses MediaRecorder)
2. **Thumbnail preview** - Show uploaded image before sending
3. **OCR on upload** - Extract text from images locally
4. **Session picker** - Multiple concurrent Claude sessions
5. **Restart Claude button** - One-tap CLI restart
6. **Page Up/Down buttons** - For scrolling long output
7. **Auth layer** - Token-based auth beyond Tailscale
8. **Auto-reconnect polish** - Better UX on connection drops

---

## Files Created

```
claude-gateway/
├── .agents/
│   └── handoff.md          # This file
├── .env                    # Config (gitignored)
├── .env.example            # Template
├── .gitignore
├── package.json
├── README.md
├── server.js               # Main server
├── public/
│   ├── index.html          # PWA shell
│   ├── styles.css          # Mobile-first styles
│   ├── app.js              # Client logic
│   └── vendor/             # Local xterm.js
│       ├── xterm.js
│       ├── xterm.css
│       └── xterm-addon-fit.js
└── scripts/
    └── transcribe.sh       # Whisper pipeline
```

---

## Session Notes

- Latency issue was SSE buffering (fixed with `res.flush()` + `socket.setNoDelay`)
- WebSocket fallback timeout extended to 4s for iOS Safari
- Tailscale Serve requires HTTPS for microphone access
- whisper-cpp binary is `whisper-cli` not `whisper-cpp`
