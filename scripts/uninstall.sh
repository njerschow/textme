#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Claude iMessage Daemon Uninstaller${NC}"
echo "==================================="

PLIST_DST="$HOME/Library/LaunchAgents/com.user.claude-imessage.plist"
LOG_DIR="$HOME/.local/log"
CONFIG_DIR="$HOME/.config/claude-imessage"

# Stop and unload daemon
echo "Stopping daemon..."
launchctl unload "$PLIST_DST" 2>/dev/null || true

# Remove plist
if [ -f "$PLIST_DST" ]; then
    rm -f "$PLIST_DST"
    echo "Removed LaunchAgent plist"
else
    echo "LaunchAgent plist not found (already removed?)"
fi

echo ""
echo -e "${GREEN}Daemon uninstalled${NC}"
echo ""
echo "Note: Config and logs were NOT removed:"
echo "  Config: $CONFIG_DIR"
echo "  Logs:   $LOG_DIR/claude-imessage.*"
echo ""
echo "To completely remove, also run:"
echo "  rm -rf $CONFIG_DIR"
echo "  rm -f $LOG_DIR/claude-imessage.*"
