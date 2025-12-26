# Claude Gateway (MVP)

Voice-first Claude Code access from mobile. Runs on your Mac mini, streams a terminal over WebSocket, and supports push-to-talk transcription via local Whisper.

## What this MVP does

- Streams a real terminal session from your Mac mini
- Lets you send text prompts from a mobile chat input
- Push-to-talk voice input with local transcription
- Works from iOS/Android via browser

## Requirements (Mac mini)

- Node.js 18+
- `tmux` (optional but recommended)
- `ffmpeg`
- Local Whisper engine (recommended: `whisper.cpp`)

## Install (Mac mini)

```bash
cd /Users/jmwillis/code/claude-gateway
npm install
```

## Configure

Copy the example env file and update paths if needed:

```bash
cp .env.example .env
```

Optional environment variables:

- `GATEWAY_BOOT_CMD` - command to run on connect (use `claude` for Claude Code)
- `GATEWAY_WORKDIR` - default working directory
- `GATEWAY_USE_TMUX` - set to `false` to disable tmux
- `GATEWAY_UPLOAD_DIR` - where uploaded images are stored (default: `~/.claude-gateway/uploads`)

## Install Whisper + ffmpeg (recommended)

```bash
brew install ffmpeg
brew install whisper-cpp
```

Download a model (example):

```bash
mkdir -p ~/.local/share/whisper
curl -L -o ~/.local/share/whisper/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

Then set:

```bash
export WHISPER_ENGINE=cpp
export WHISPER_CPP_BIN=/opt/homebrew/opt/whisper-cpp/bin/whisper-cli
export WHISPER_CPP_ARGS=-ng
export WHISPER_MODEL=$HOME/.local/share/whisper/ggml-base.en.bin
```

## Run

```bash
cd /Users/jmwillis/code/claude-gateway
npm start
```

Open in a browser on the Mac:

```
http://localhost:8787
```

## Tailscale (mobile access + HTTPS for microphone)

On the Mac mini:

```bash
tailscale up
```

Then proxy the local server via Tailscale HTTPS (required for mic permissions):

```bash
tailscale serve https / http://127.0.0.1:8787
```

Open the Tailscale HTTPS URL on your phone (shown by `tailscale serve status`).

## Notes

- The connector works by streaming a real terminal. If you set `GATEWAY_BOOT_CMD=claude`, it auto-starts Claude Code.
- If you want multiple sessions, change `GATEWAY_SESSION` or pass `?session=name` in the URL.
- If voice transcription fails, you can still type into the input box.
- Images uploaded from mobile are saved on disk; the UI inserts the file path into the input so you can reference it.
