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

# ─────────────────────────────────────────────────────────────────
# LAUNCHD SERVICE MANAGEMENT (Auto-start & Auto-restart)
# ─────────────────────────────────────────────────────────────────

# Setup as launchd service (runs on boot, auto-restarts)
service-setup:
    ./setup-launchd.sh

# Check service status
service-status:
    @launchctl list | grep -E "PID|claude-gateway" || echo "Service not running"
    @echo ""
    @echo "Recent logs:"
    @tail -5 ~/Library/Logs/claude-gateway/stdout.log 2>/dev/null || echo "No logs yet"

# Stop the launchd service
service-stop:
    launchctl unload ~/Library/LaunchAgents/com.lifeos.claude-gateway.plist

# Start the launchd service
service-start:
    launchctl load ~/Library/LaunchAgents/com.lifeos.claude-gateway.plist

# Restart the launchd service
service-restart:
    launchctl unload ~/Library/LaunchAgents/com.lifeos.claude-gateway.plist 2>/dev/null || true
    launchctl load ~/Library/LaunchAgents/com.lifeos.claude-gateway.plist

# View service logs (stdout)
service-logs:
    tail -f ~/Library/Logs/claude-gateway/stdout.log

# View service errors
service-errors:
    tail -f ~/Library/Logs/claude-gateway/stderr.log

# Uninstall the service
service-uninstall:
    launchctl unload ~/Library/LaunchAgents/com.lifeos.claude-gateway.plist 2>/dev/null || true
    rm -f ~/Library/LaunchAgents/com.lifeos.claude-gateway.plist
    @echo "Service uninstalled"
