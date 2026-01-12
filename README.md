# TextMe

Text Claude from your phone via iMessage. Send a message, get a response.

## Quick Start

### 1. Sendblue Setup

1. Sign up at [dashboard.sendblue.com/company-signup](https://dashboard.sendblue.com/company-signup)
2. Get your **API Key** and **API Secret** from Dashboard → API Keys
3. Add your phone number as a **verified contact** in the dashboard

### 2. Install

```bash
brew install node
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
  "pollIntervalMs": 5000,
  "conversationWindowSize": 20
}
```

Phone format: `+1` followed by 10 digits (e.g., `+19175551234`)

### 4. Run

```bash
git clone https://github.com/njerschow/textme.git
cd textme/daemon && npm install && npm run build
node dist/index.js
```

### 5. Test

Text your Sendblue number: `hello`

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

## Auto-Start (Optional)

```bash
./scripts/install-launchd.sh    # Enable
./scripts/uninstall-launchd.sh  # Disable
```

---

## Troubleshooting

Check logs: `tail -f ~/.local/log/claude-imessage.log`

---

## Uninstall

```bash
pkill -f "node.*daemon/dist"
rm -rf ~/.config/claude-imessage ~/.local/log/claude-imessage.log
```

---

MIT License
