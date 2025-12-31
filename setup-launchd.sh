#!/bin/bash
# Setup claude-gateway as a persistent launchd service
# Run this on your Mac mini to auto-start and auto-restart the gateway

set -e

PLIST_NAME="com.lifeos.claude-gateway"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
GATEWAY_DIR="$HOME/code/claude-gateway"
NODE_PATH=$(which node)
LOG_DIR="$HOME/Library/Logs/claude-gateway"

echo "┌─────────────────────────────────────────────────────────────────┐"
echo "│  🚀 Claude Gateway launchd Setup                                │"
echo "└─────────────────────────────────────────────────────────────────┘"
echo ""

# Check if gateway directory exists
if [ ! -d "$GATEWAY_DIR" ]; then
    echo "❌ Gateway directory not found: $GATEWAY_DIR"
    exit 1
fi

# Check if node exists
if [ -z "$NODE_PATH" ]; then
    echo "❌ Node.js not found in PATH"
    exit 1
fi

echo "📍 Gateway dir: $GATEWAY_DIR"
echo "📍 Node path: $NODE_PATH"
echo ""

# Create log directory
mkdir -p "$LOG_DIR"

# Unload existing service if present
if launchctl list | grep -q "$PLIST_NAME"; then
    echo "⏹️  Stopping existing service..."
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# Create the plist file
echo "📝 Creating launchd plist..."
cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$PLIST_NAME</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$GATEWAY_DIR/server.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$GATEWAY_DIR</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>

    <!-- Start on login -->
    <key>RunAtLoad</key>
    <true/>

    <!-- Auto-restart if it crashes -->
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
        <key>Crashed</key>
        <true/>
    </dict>

    <!-- Wait 5 seconds before restarting after crash -->
    <key>ThrottleInterval</key>
    <integer>5</integer>

    <!-- Logging -->
    <key>StandardOutPath</key>
    <string>$LOG_DIR/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/stderr.log</string>

    <!-- Process settings -->
    <key>ProcessType</key>
    <string>Interactive</string>
</dict>
</plist>
EOF

echo "✅ Plist created at: $PLIST_PATH"

# Load the service
echo "▶️  Starting service..."
launchctl load "$PLIST_PATH"

# Check if it's running
sleep 2
if launchctl list | grep -q "$PLIST_NAME"; then
    echo ""
    echo "┌─────────────────────────────────────────────────────────────────┐"
    echo "│  ✅ Claude Gateway is now running as a service!                │"
    echo "├─────────────────────────────────────────────────────────────────┤"
    echo "│                                                                 │"
    echo "│  Commands:                                                      │"
    echo "│  • Status:  launchctl list | grep claude-gateway                │"
    echo "│  • Stop:    launchctl unload $PLIST_PATH                        │"
    echo "│  • Start:   launchctl load $PLIST_PATH                          │"
    echo "│  • Logs:    tail -f $LOG_DIR/stdout.log                         │"
    echo "│  • Errors:  tail -f $LOG_DIR/stderr.log                         │"
    echo "│                                                                 │"
    echo "│  The gateway will:                                              │"
    echo "│  • Start automatically on login                                 │"
    echo "│  • Restart automatically if it crashes                          │"
    echo "│                                                                 │"
    echo "└─────────────────────────────────────────────────────────────────┘"
else
    echo "❌ Service failed to start. Check logs:"
    echo "   tail -f $LOG_DIR/stderr.log"
    exit 1
fi

# Check Tailscale status
echo ""
echo "┌─────────────────────────────────────────────────────────────────┐"
echo "│  🔗 Tailscale Status                                            │"
echo "└─────────────────────────────────────────────────────────────────┘"

if command -v tailscale &> /dev/null; then
    if tailscale status &> /dev/null; then
        echo "✅ Tailscale is running"
        tailscale status | head -5
    else
        echo "⚠️  Tailscale installed but not connected"
        echo "   Run: tailscale up"
    fi
else
    echo "❌ Tailscale not installed"
    echo "   Install from: https://tailscale.com/download/mac"
fi

echo ""
echo "Done! 🎉"
