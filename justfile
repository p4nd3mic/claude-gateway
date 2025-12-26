# Claude Gateway - Voice-first mobile interface for Claude Code

# Start the gateway server
start:
    npm start

# Start with logging
dev:
    npm start 2>&1 | tee /tmp/claude-gateway.log

# Install dependencies
install:
    npm install

# Tailscale: start daemon (requires sudo)
tailscale-daemon:
    sudo /opt/homebrew/opt/tailscale/bin/tailscaled

# Tailscale: login
tailscale-login:
    tailscale up

# Tailscale: expose gateway over HTTPS
tailscale-serve:
    tailscale serve https / http://127.0.0.1:8787
    tailscale serve status

# Tailscale: check status
tailscale-status:
    tailscale serve status

# Test transcription pipeline
test-transcribe file:
    ./scripts/transcribe.sh {{file}}

# Test with sample audio
test-whisper:
    say -o /tmp/test-gateway.wav "Testing the gateway transcription pipeline"
    ./scripts/transcribe.sh /tmp/test-gateway.wav

# Health check
health:
    curl -s http://127.0.0.1:8787/api/health | jq .

# Show uploads directory
uploads:
    ls -la ~/.claude-gateway/uploads/

# Clean uploads
clean-uploads:
    rm -rf ~/.claude-gateway/uploads/*

# Show logs
logs:
    tail -f /tmp/claude-gateway.log

# Full startup (run in separate terminals)
@startup:
    echo "Run these in separate terminals:"
    echo "  1. just tailscale-daemon"
    echo "  2. just start"
    echo "  3. just tailscale-serve"
