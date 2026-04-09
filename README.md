# TextMe

**Your personal Claude AI, accessible via iMessage.**

Text Claude from anywhere. Send messages, voice notes, or images — get intelligent responses back to your phone. Built on [Sendblue](https://sendblue.com) + [Claude Code](https://docs.anthropic.com/en/docs/claude-code).

---

## Features

- **Text Claude** - Natural conversation via iMessage
- **Voice Notes** - Send audio, automatically transcribed via OpenAI Whisper
- **Images** - Send photos, Claude can see and analyze them
- **File Access** - Claude has full filesystem access for coding tasks
- **Attachments** - Claude can send files back to you
- **Crash Alerts** - Get notified if the daemon goes down
- **Queue System** - Multiple messages processed in order

---

## Quick Start

### 1. Requirements

```bash
brew install node                           # Node.js 18+
npm install -g @sendblue/cli               # Sendblue CLI
npm install -g @anthropic-ai/claude-code   # Claude Code
```

### 2. Get Your Sendblue Credentials

Run the Sendblue setup wizard:

```bash
sendblue setup
```

This creates your account, assigns a phone number, and guides you through verifying your first contact. When done, print your credentials:

```bash
sendblue show-keys
```

Copy the **API Key**, **API Secret**, and **phone number** — you'll need them in the next step.

<details>
<summary>Already have an account? (dashboard method)</summary>

1. Go to [dashboard.sendblue.com](https://dashboard.sendblue.com)
2. **Settings → API Settings** — copy your **API Key** and **API Secret**
3. **Settings → Phone Lines** — copy your **Sendblue phone number**

</details>

### 3. Install

```bash
git clone https://github.com/njerschow/textme.git
cd textme/daemon && npm install && npm run build
```

### 4. Configure

```bash
mkdir -p ~/.config/claude-imessage
nano ~/.config/claude-imessage/config.json
```

```json
{
  "sendblue": {
    "apiKey": "YOUR_API_KEY",
    "apiSecret": "YOUR_API_SECRET",
    "phoneNumber": "+1SENDBLUE_NUMBER"
  },
  "whitelist": ["+1YOUR_PHONE"],
  "pollIntervalMs": 5000,
  "conversationWindowSize": 20
}
```

| Field | What to put |
|-------|-------------|
| `sendblue.apiKey` | Your Sendblue API key (from `sendblue show-keys`) |
| `sendblue.apiSecret` | Your Sendblue API secret (from `sendblue show-keys`) |
| `sendblue.phoneNumber` | The Sendblue number assigned to you (from `sendblue show-keys`) |
| `whitelist` | Array of **your personal phone numbers** that can text the bot |

### 5. Voice Notes (Optional)

To enable voice memo transcription, add your OpenAI API key (run from inside `textme/daemon/`):

```bash
echo "OPENAI_API_KEY=sk-your-key-here" > .env
```

### 6. Run

From inside `textme/daemon/`:

```bash
npm start
```

### 7. Test

Text your Sendblue number from your phone: `hello`

---

## Want iMessage in Claude Code Instead?

If you want Claude Code to send/receive iMessages directly from your terminal (without running a persistent daemon), add the Sendblue MCP server:

```bash
claude mcp add sendblue_api \
  --env SENDBLUE_API_API_KEY=your-api-key \
  --env SENDBLUE_API_API_SECRET=your-api-secret \
  -- npx -y sendblue-api-mcp --client=claude-code --tools=all
```

This gives Claude Code tools to send iMessages, check number types, manage group chats, and more — all from within your coding session. See [Sendblue MCP docs](https://docs.sendblue.com/mcp/) for details.

---

## Commands

| Command | Action |
|---------|--------|
| `?` | Show commands |
| `status` | Current status & directory |
| `queue` | View queued messages |
| `history` | Recent messages |
| `home` | Go to home directory |
| `reset` | Home + clear history |
| `cd /path` | Change directory |
| `stop` | Cancel current task |
| `yes` / `no` | Approve/reject actions |

---

## Production (PM2)

```bash
pm2 start dist/index.js --name textme
pm2 save
pm2 startup
```

---

## Architecture

```
daemon/
├── src/
│   ├── index.ts      # Main loop, message processing, media handling
│   ├── sendblue.ts   # Sendblue API (send, receive, upload files)
│   └── ...
├── dist/             # Compiled output
└── package.json
```

---

## Logs

```bash
# PM2
pm2 logs textme

# Standalone
tail -f ~/.local/log/claude-imessage.log
```

---

## Auto-Start (launchd)

```bash
./scripts/install-launchd.sh    # Enable
./scripts/uninstall-launchd.sh  # Disable
```

---

## Uninstall

```bash
pm2 delete textme  # or: pkill -f "node.*daemon/dist"
rm -rf ~/.config/claude-imessage ~/.local/log/claude-imessage.log
```

---

Built with [Sendblue](https://sendblue.com/cli) + [Claude Code](https://claude.ai/code)

MIT License
