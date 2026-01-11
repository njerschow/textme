# TextMe

Text Claude from your phone via iMessage. Send a message, get a response. It can run coding tasks on your Mac while you're away.

---

## Quick Start

### 1. Get Your Free Sendblue Number

1. Sign up at [sendblue.com/company-signup](https://sendblue.com/company-signup)
2. Get your **free iMessage number**
3. Copy your **API Key** and **API Secret** from Dashboard → API Keys

### 2. Install Requirements

```bash
# Node.js 18+
brew install node

# Claude Code CLI
npm install -g @anthropic-ai/claude-code
```

### 3. Configure

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
  "pollIntervalMs": 2000,
  "conversationWindowSize": 20
}
```

**Phone format:** `+1` followed by 10 digits, no spaces (e.g., `+19175551234`)

### 4. Run

```bash
git clone https://github.com/USER/textme.git
cd textme
cd daemon && npm install && npm run build && cd ..
node daemon/dist/index.js
```

### 5. Test

Text your Sendblue number: `hello`

---

## Commands

Text these to your bot:

| Command | Action |
|---------|--------|
| `?` or `help` | Show commands |
| `status` | Current status & directory |
| `queue` or `q` | View queued messages |
| `home` | Go to home directory |
| `reset` or `fresh` | Home + clear history |
| `cd /path` | Change directory |
| `stop` or `interrupt` | Cancel current task |

Everything else goes to Claude.

---

## Auto-Start on Login (Optional)

```bash
# Enable
./scripts/install-launchd.sh

# Disable
./scripts/uninstall-launchd.sh
```

---

## Logs

```bash
tail -f ~/.local/log/claude-imessage.log
```

---

## How It Works

```
Phone (iMessage) → Sendblue API → Daemon (Node.js) → Claude CLI
                 ←              ←                  ←
```

---

## Troubleshooting

**No messages?**
- Check whitelist in config.json uses E.164 format (`+1XXXXXXXXXX`)
- Check logs: `tail -f ~/.local/log/claude-imessage.log`

**Daemon won't start?**
- Validate config: `cat ~/.config/claude-imessage/config.json | python3 -m json.tool`
- Check if already running: `ps aux | grep daemon/dist`

**Claude not found?**
- Install: `npm install -g @anthropic-ai/claude-code`
- Authenticate: run `claude` and follow prompts

---

## License

MIT
