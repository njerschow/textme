# iMessage Skill

## Description
Send and receive iMessages via Claude Code. Get real-time input from the user via their phone, similar to how call-me enables voice conversations.

## When to Use This Skill

**Use `ask_user` when:**
- You've **completed significant work** and want to report status and ask what's next
- You need **real-time input** for decisions
- You're **blocked** and need clarification to proceed
- You want to **discuss next steps** with the user

**Use `notify_user` when:**
- You want to send a **status update** without needing a response
- The information is **non-urgent**
- You don't want to block waiting for a reply

**Do NOT use for:**
- Simple yes/no questions that can be asked in the terminal
- Information the user has already provided
- Sending to non-whitelisted numbers

## Primary Tools

### `ask_user`
Send an iMessage and wait for the user to respond. **This is the main tool** - similar to `initiate_call` in call-me.

**Parameters:**
- `message` (string, required): What to ask the user. Be conversational.
- `timeout_seconds` (number, optional): How long to wait (default: 300 = 5 minutes)

**Behavior:**
1. Sends iMessage to the user
2. Waits for response (polls every 5 seconds)
3. Returns the user's response when received
4. If timeout: returns notice, response will be picked up later via `check_messages`

**Example:**
```
ask_user({ message: "Finished the auth module. Should I work on API endpoints or tests next?" })
→ User responds via phone: "API endpoints"
→ Returns: "User responded: API endpoints"
→ Claude continues working on API endpoints
```

### `notify_user`
Send an iMessage without waiting for a response. Fire-and-forget.

**Parameters:**
- `message` (string, required): Message to send

**Example:**
```
notify_user({ message: "Starting the database migration. This will take about 10 minutes." })
→ Returns immediately: "Notification sent"
→ Claude continues working
```

## Secondary Tools

### `check_messages`
Check for pending iMessages. Use this to pick up responses that arrived after a timeout.

### `send_message`
Send a message to a specific number. Lower-level than `notify_user`.

### `get_conversation`
Get conversation history with a contact for context.

### `mark_read`
Mark a message as processed without responding.

### `list_contacts`
List all contacts who have messaged.

### `clear_history`
Clear conversation history with a contact.

## Example Workflows

**Simple question and continue:**
```
Claude: [finishes auth module]
Claude: ask_user("Hey! Finished the auth module. API endpoints or tests next?")
        → sends iMessage, waits...
User:   [responds on phone] "API endpoints please"
Claude: → receives response
Claude: [continues with API endpoints]
```

**Status update (no response needed):**
```
Claude: notify_user("Starting the build process. Will let you know when done.")
Claude: [runs build]
Claude: ask_user("Build complete! 0 errors. Ready to deploy to staging?")
User:   "Yes, deploy it"
Claude: [deploys to staging]
```

**Multi-turn conversation:**
```
Claude: ask_user("I found 3 approaches for the caching layer. Want me to explain them?")
User:   "Yes please"
Claude: ask_user("Option 1: Redis - fast, needs server. Option 2: In-memory - simple, no persistence. Option 3: SQLite - persistent, slower. Which sounds best?")
User:   "Redis"
Claude: [implements Redis caching]
```

## Best Practices

1. **Be conversational** - Write messages like texts, not documentation
2. **Be concise** - Phone screens are small
3. **Provide context** - Explain what you did before asking
4. **Offer clear options** - "A or B?" is easier than open-ended questions
5. **Use `notify_user` for updates** - Don't block when you don't need input
6. **Trust the timeout** - If no response in 5 min, user is busy - continue or wait

## How It Works

- MCP server polls Sendblue every 5 seconds for new messages
- `ask_user` blocks up to 5 minutes waiting for response
- Only whitelisted phone numbers can send/receive
- Conversation history is maintained for context
- Stop hook evaluates if Claude should proactively message the user
