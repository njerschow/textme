#!/bin/bash
# Uninstall the Claude iMessage daemon launch agent
# The daemon will no longer start automatically on login

set -e

PLIST_NAME="com.claude.imessage-daemon.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENTS_DIR/$PLIST_NAME"

echo "Uninstalling Claude iMessage daemon launch agent..."

# Unload if loaded
if launchctl list | grep -q "com.claude.imessage-daemon"; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    echo "Stopped running daemon."
fi

# Remove the plist file
if [ -f "$PLIST_PATH" ]; then
    rm "$PLIST_PATH"
    echo "Removed launch agent configuration."
fi

echo "Done! The daemon will no longer start automatically."
echo ""
echo "To start manually: node daemon/dist/index.js"
echo "To reinstall:      ./scripts/install-launchd.sh"
