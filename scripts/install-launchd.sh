#!/bin/bash
# Install the Claude iMessage daemon as a macOS launch agent
# This makes it start automatically on login

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
PLIST_NAME="com.claude.imessage-daemon.plist"
TEMPLATE_FILE="$SCRIPT_DIR/$PLIST_NAME.template"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
TARGET_PLIST="$LAUNCH_AGENTS_DIR/$PLIST_NAME"

echo "Installing Claude iMessage daemon as launch agent..."

# Find node path
NODE_PATH=$(which node)
if [ -z "$NODE_PATH" ]; then
    echo "Error: node not found in PATH"
    exit 1
fi
NODE_DIR=$(dirname "$NODE_PATH")

echo "Using node at: $NODE_PATH"

# Create LaunchAgents directory if it doesn't exist
mkdir -p "$LAUNCH_AGENTS_DIR"

# Create log directory
mkdir -p "$HOME/.local/log"

# Generate plist from template
sed -e "s|__NODE_PATH__|$NODE_PATH|g" \
    -e "s|__NODE_DIR__|$NODE_DIR|g" \
    -e "s|__REPO_PATH__|$REPO_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    "$TEMPLATE_FILE" > "$TARGET_PLIST"

echo "Generated plist at: $TARGET_PLIST"

# Load the agent
launchctl load "$TARGET_PLIST"

echo ""
echo "Done! The daemon will now start automatically on login."
echo ""
echo "To check status: launchctl list | grep claude"
echo "To stop:         launchctl unload ~/Library/LaunchAgents/$PLIST_NAME"
echo "To uninstall:    ./scripts/uninstall-launchd.sh"
