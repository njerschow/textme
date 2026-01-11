#!/bin/bash
# Install the Claude iMessage daemon as a macOS launch agent
# This makes it start automatically on login

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
PLIST_NAME="com.claude.imessage-daemon.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

echo "Installing Claude iMessage daemon as launch agent..."

# Create LaunchAgents directory if it doesn't exist
mkdir -p "$LAUNCH_AGENTS_DIR"

# Copy the plist file
cp "$REPO_DIR/$PLIST_NAME" "$LAUNCH_AGENTS_DIR/"

# Load the agent
launchctl load "$LAUNCH_AGENTS_DIR/$PLIST_NAME"

echo "Done! The daemon will now start automatically on login."
echo ""
echo "To check status: launchctl list | grep claude"
echo "To stop:         launchctl unload ~/Library/LaunchAgents/$PLIST_NAME"
echo "To uninstall:    ./scripts/uninstall-launchd.sh"
