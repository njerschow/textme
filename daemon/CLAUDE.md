# Claude iMessage Daemon - Development Notes

## Important Reminders

### Help Message Must Be Updated

When adding new commands to the daemon, **always update the `HELP_MESSAGE` constant** in `src/index.ts`.

The help message is displayed when users send `help` or `?`. It must accurately reflect all available commands.

Location: `src/index.ts` - search for `HELP_MESSAGE`

Current commands:
- `help` / `?` - Show help
- `status` - Show current status
- `interrupt` / `stop` / `cancel` - Stop current task
- `yes` / `no` (and variants) - Approval responses

### Adding a New Command Checklist

1. Add the command detection function (e.g., `isMyCommand()`)
2. Add the handler in the poll loop
3. **Update `HELP_MESSAGE` to include the new command**
4. Update this list in CLAUDE.md
