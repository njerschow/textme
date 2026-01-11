# Claude via iMessage

Text Claude from your phone via iMessage. Send a message, get a response. It can also run coding tasks on your Mac.

**How it works:** A daemon runs on your Mac, polls SendBlue for incoming messages, sends them to Claude Code CLI, and texts you back the response.

---

## Requirements

Before you start, you need:

| Requirement | Why | How to get it |
|-------------|-----|---------------|
| **macOS** | The daemon uses macOS LaunchAgent | You're on a Mac, right? |
| **Node.js 18+** | Runs the daemon | `brew install node` or [nodejs.org](https://nodejs.org) |
| **Claude Code CLI** | Processes your messages | `npm install -g @anthropic-ai/claude-code` |
| **SendBlue account** | Sends/receives iMessages via API | [sendblue.co](https://sendblue.co) - $5/mo + per-message |

### Verify requirements

```bash
# Check Node.js (need 18+)
node --version

# Check Claude Code CLI
claude --version

# Should output version numbers, not errors
```

---

## Step 1: Get SendBlue Credentials

1. Go to [sendblue.co](https://sendblue.co) and create an account
2. Add a payment method (required for API access)
3. Go to **Dashboard** → **API Keys**
4. Copy your:
   - **API Key** (looks like: `24ed302fcae70ef48f3a17e33d80f74c`)
   - **API Secret** (looks like: `c87a9fcafe8ba7135b17d47b80db3d4c`)
5. Go to **Phone Numbers** and note your SendBlue number (e.g., `+15559876543`)

**Cost:** SendBlue charges ~$0.01-0.03 per message sent/received.

---

## Step 2: Create Config File

```bash
# Create the config directory
mkdir -p ~/.config/claude-imessage

# Create the config file
nano ~/.config/claude-imessage/config.json
```

Paste this JSON, replacing the placeholder values:

```json
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
```

### Config explained

| Field | What it is | Example |
|-------|-----------|---------|
| `sendblue.apiKey` | Your SendBlue API key | `24ed302fcae70ef48f3a17e33d80f74c` |
| `sendblue.apiSecret` | Your SendBlue API secret | `c87a9fcafe8ba7135b17d47b80db3d4c` |
| `sendblue.phoneNumber` | The SendBlue phone number (you text FROM this) | `+15559876543` |
| `whitelist` | Phone numbers allowed to use the bot (YOUR phone) | `["+19175551234"]` |
| `pollIntervalMs` | How often to check for messages (ms) | `2000` = every 2 seconds |
| `progressIntervalMs` | How often to send "working..." updates | `5000` = every 5 seconds |

**Phone number format:** Use E.164 format: `+1` then 10 digits, no spaces or dashes.
- Correct: `+19175551234`
- Wrong: `917-555-1234`, `(917) 555-1234`, `19175551234`

---

## Step 3: Clone and Install

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/claude-via-imessage.git
cd claude-via-imessage

# Run the installer
./scripts/install.sh
```

The installer will:
1. Check Node.js and Claude CLI are installed
2. Install npm dependencies
3. Build the TypeScript
4. Install and start the macOS LaunchAgent (runs on login)

---

## Step 4: Test It

1. Open Messages on your iPhone
2. Text your SendBlue number: `hello`
3. Wait 5-10 seconds
4. You should get a response from Claude

**If nothing happens:** Check the logs:

```bash
tail -f ~/.local/log/claude-imessage.log
```

---

## Commands

### View logs (most useful for debugging)

```bash
# Main log (see what's happening)
tail -f ~/.local/log/claude-imessage.log

# Error log
tail -f ~/.local/log/claude-imessage.err
```

### Stop/start the daemon

```bash
# Stop
launchctl unload ~/Library/LaunchAgents/com.user.claude-imessage.plist

# Start
launchctl load ~/Library/LaunchAgents/com.user.claude-imessage.plist

# Restart (stop + start)
launchctl unload ~/Library/LaunchAgents/com.user.claude-imessage.plist && launchctl load ~/Library/LaunchAgents/com.user.claude-imessage.plist
```

### Check if daemon is running

```bash
launchctl list | grep claude-imessage
```

### Rebuild after code changes

```bash
cd daemon
npm run build
# Then restart the daemon
```

### Uninstall

```bash
./scripts/uninstall.sh
```

---

## How to Use

Just text naturally. Claude responds via iMessage.

**Basic questions:**
- `what time is it in tokyo?`
- `explain quantum computing simply`
- `write me a haiku about coffee`

**Coding tasks (runs on your Mac):**
- `what's in my git log?`
- `run npm test`
- `fix the type error in src/index.ts`
- `create a new React component called Button`

**Special commands:**
| Command | What it does |
|---------|-------------|
| `status` or `?` | Check if daemon is alive |
| `stop` or `cancel` | Kill current task, get partial output |

---

## Progress Updates

While Claude is working, you'll get periodic updates:

```
🚀 [1] Starting up...
🔄 [2] Working... (5s)
🔄 [3] Working... (10s)
✨ [4] Finishing up... (2341 chars)
✅ [Complete] Here's your answer...
```

This lets you know Claude is still working on longer tasks.

---

## Message Queue

If you send multiple messages while Claude is processing, they get queued:

```
📥 Queued (position 2): "your message..."
```

When Claude starts your queued message:

```
📬 Now processing: "your message..." | 1 still queued
```

---

## Troubleshooting

### "No messages received"

1. **Check your whitelist:** Your phone number must be in the `whitelist` array in config.json, in E.164 format (`+1XXXXXXXXXX`)
2. **Check SendBlue dashboard:** Go to sendblue.co → Dashboard → Messages. Do you see your inbound message?
3. **Check the logs:** `tail -f ~/.local/log/claude-imessage.log`

### "Daemon not starting"

1. **Check if already running:** `launchctl list | grep claude-imessage`
2. **Check error log:** `cat ~/.local/log/claude-imessage.err`
3. **Check config is valid JSON:** `cat ~/.config/claude-imessage/config.json | python3 -m json.tool`

### "Config file not found"

Make sure the config exists at exactly: `~/.config/claude-imessage/config.json`

```bash
ls -la ~/.config/claude-imessage/
```

### "Claude not found"

The daemon needs Claude Code CLI in your PATH. Check:

```bash
which claude
claude --version
```

If not installed: `npm install -g @anthropic-ai/claude-code`

### "Permission denied" errors

Make sure Claude Code is authenticated:

```bash
claude
# Follow the login prompts if asked
```

### Messages are slow

Reduce `pollIntervalMs` in config.json:
- `2000` = check every 2 seconds
- `1000` = check every second (more API calls)

### "ESOCKET" or network errors

- Check your internet connection
- Check SendBlue status: [status.sendblue.co](https://status.sendblue.co)
- Your SendBlue API credentials might be wrong

---

## Files

| Path | Purpose |
|------|---------|
| `~/.config/claude-imessage/config.json` | Your configuration |
| `~/.config/claude-imessage/daemon.db` | SQLite database (conversations, queue) |
| `~/.local/log/claude-imessage.log` | Daemon output log |
| `~/.local/log/claude-imessage.err` | Daemon error log |
| `~/Library/LaunchAgents/com.user.claude-imessage.plist` | macOS auto-start config |

---

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Your Phone  │────▶│   SendBlue   │────▶│    Daemon    │
│  (iMessage)  │◀────│     API      │◀────│   (Node.js)  │
└──────────────┘     └──────────────┘     └──────┬───────┘
                                                  │
                                           ┌──────▼───────┐
                                           │  Claude CLI  │
                                           │  (spawned)   │
                                           └──────────────┘
```

1. You send iMessage to your SendBlue number
2. Daemon polls SendBlue API every 2 seconds
3. Daemon spawns Claude Code CLI with your message
4. Claude processes, daemon sends progress updates
5. Final response sent back via SendBlue → iMessage

---

## Development

```bash
cd daemon

# Run in dev mode (auto-reload)
npm run dev

# Build
npm run build

# Run tests
npm test
```

---

## FAQ

**Q: Does this use my Anthropic API key?**
A: No. It uses Claude Code CLI, which has its own authentication.

**Q: Can multiple people use the same bot?**
A: Yes, add their phone numbers to the `whitelist` array.

**Q: What happens if I send a message while Claude is thinking?**
A: It gets queued and processed in order. You'll get a "Queued (position N)" confirmation.

**Q: Is there a message length limit?**
A: SMS/iMessage has limits. Very long responses may be truncated or split.

**Q: Can Claude access my files?**
A: Yes. Claude Code CLI runs on your Mac with your permissions. It can read/write files in the working directory.

**Q: How do I change the working directory?**
A: Currently defaults to your home directory. This can be changed in the daemon code.

---

## Security Notes

- **Whitelist is required:** Only phone numbers in the whitelist can interact with the bot
- **API keys are stored locally:** In `~/.config/claude-imessage/config.json`
- **Claude has file access:** Same permissions as your user account
- **Messages route through SendBlue:** They see message content (encrypted in transit)

---

## License

MIT
