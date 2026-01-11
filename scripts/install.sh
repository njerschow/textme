#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Claude iMessage Daemon Installer${NC}"
echo "================================="

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DAEMON_DIR="$PROJECT_DIR/daemon"
PLIST_SRC="$PROJECT_DIR/com.user.claude-imessage.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.user.claude-imessage.plist"
LOG_DIR="$HOME/.local/log"
CONFIG_DIR="$HOME/.config/claude-imessage"

echo "Project directory: $PROJECT_DIR"
echo "Daemon directory: $DAEMON_DIR"

# Check for node
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed${NC}"
    echo "Please install Node.js first: https://nodejs.org/"
    exit 1
fi

echo -e "${GREEN}Node.js found:${NC} $(node --version)"

# Check for claude CLI
if ! command -v claude &> /dev/null; then
    echo -e "${YELLOW}Warning: Claude CLI not found in PATH${NC}"
    echo "The daemon can run, but coding tasks won't work without it."
    echo "Install Claude Code: https://claude.ai/code"
fi

# Create log directory
echo "Creating log directory..."
mkdir -p "$LOG_DIR"

# Create config directory
echo "Creating config directory..."
mkdir -p "$CONFIG_DIR"

# Check for config file
if [ ! -f "$CONFIG_DIR/config.json" ]; then
    echo -e "${YELLOW}Config file not found. Creating example...${NC}"
    cat > "$CONFIG_DIR/config.json.example" << 'EOF'
{
  "sendblue": {
    "apiKey": "YOUR_SENDBLUE_API_KEY",
    "apiSecret": "YOUR_SENDBLUE_API_SECRET",
    "phoneNumber": "+1YOUR_SENDBLUE_NUMBER"
  },
  "whitelist": ["+1YOUR_PHONE_NUMBER"],
  "pollIntervalMs": 2000,
  "conversationWindowSize": 20,
  "progressIntervalMs": 5000
}
EOF
    echo ""
    echo -e "${YELLOW}Please create your config file:${NC}"
    echo "  1. Copy: cp $CONFIG_DIR/config.json.example $CONFIG_DIR/config.json"
    echo "  2. Edit: nano $CONFIG_DIR/config.json"
    echo "  3. Fill in your API keys and settings"
    echo ""
    echo "Then run this script again."
    exit 1
fi

echo -e "${GREEN}Config file found${NC}"

# Install npm dependencies
echo "Installing npm dependencies..."
cd "$DAEMON_DIR"
npm install

# Build TypeScript
echo "Building TypeScript..."
npm run build

# Check if build succeeded
if [ ! -f "$DAEMON_DIR/dist/index.js" ]; then
    echo -e "${RED}Error: Build failed - dist/index.js not found${NC}"
    exit 1
fi

echo -e "${GREEN}Build successful${NC}"

# Stop existing daemon if running
echo "Stopping existing daemon (if any)..."
launchctl unload "$PLIST_DST" 2>/dev/null || true

# Copy LaunchAgent plist
echo "Installing LaunchAgent..."
cp "$PLIST_SRC" "$PLIST_DST"

# Load LaunchAgent
echo "Starting daemon..."
launchctl load "$PLIST_DST"

# Wait a moment and check status
sleep 2

# Check if daemon is running
if launchctl list | grep -q "com.user.claude-imessage"; then
    echo -e "${GREEN}Daemon installed and running!${NC}"
else
    echo -e "${YELLOW}Daemon may not have started. Check logs:${NC}"
    echo "  tail -f $LOG_DIR/claude-imessage.log"
    echo "  tail -f $LOG_DIR/claude-imessage.err"
fi

echo ""
echo "================================="
echo -e "${GREEN}Installation complete!${NC}"
echo ""
echo "Useful commands:"
echo "  View logs:     tail -f $LOG_DIR/claude-imessage.log"
echo "  View errors:   tail -f $LOG_DIR/claude-imessage.err"
echo "  Stop daemon:   launchctl unload $PLIST_DST"
echo "  Start daemon:  launchctl load $PLIST_DST"
echo "  Edit config:   nano $CONFIG_DIR/config.json"
echo ""
echo "Send a text to your Sendblue number to test!"
