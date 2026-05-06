# clawdgg

Track your Claude Code usage. See how much you've invested, compete on the leaderboard, and flex your stats.

## Quick Start

```bash
npx clawdgg gg
```

That's it. One command does everything:
1. Links your GitHub account
2. Syncs your historical Claude Code usage
3. Enables real-time streaming

After running, **restart Claude Code** to activate streaming.

Then visit [clawd.gg](https://clawd.gg) to see your stats.

## What It Does

- **Parses your local Claude Code sessions** from `~/.claude/projects/`
- **Calculates your stats**: prompts, tokens, cost, lines written, commits
- **Uploads to the leaderboard** at [clawd.gg](https://clawd.gg)
- **Streams real-time telemetry** so your stats update automatically

## Commands

| Command | Description |
|---------|-------------|
| `clawdgg gg` | **Do everything** - login, sync history, enable streaming |
| `clawdgg status` | See your current stats and rank |
| `clawdgg login` | Link your GitHub account |
| `clawdgg sync` | Manually sync history (usually not needed) |
| `clawdgg setup` | Enable OTEL streaming (usually not needed) |
| `clawdgg disable` | Turn off streaming |
| `clawdgg logout` | Unlink your account |

## How It Works

### Before OTEL (historical data)
The CLI parses your local `.jsonl` session files to calculate usage statistics.

### After OTEL (real-time)
Once you run `clawdgg gg`, Claude Code streams telemetry directly to clawd.gg. Your stats update in real-time as you use Claude Code.

## Privacy

- Your **prompts and code are never sent** - only aggregate metrics
- Metrics include: token counts, costs, lines written, tool usage
- All data is tied to your GitHub username
- You can disable streaming anytime with `clawdgg disable`

## Installation Options

```bash
# Easiest - run directly with npx
npx clawdgg gg

# Or install globally
npm install -g clawdgg
clawdgg gg

# Or with bun
bun install -g clawdgg
clawdgg gg
```

## Requirements

- Node.js 18+ or Bun
- Claude Code with session data in `~/.claude/projects/`

## Configuration

- Auth token stored in: `~/.config/clawdgg/config.json`
- Stats cache: `~/.config/clawdgg/cache.json`
- OTEL config written to: `~/.claude/settings.json`

## Environment Variables

- `CLAWDGG_API_URL` - Override the API URL (default: `https://clawd.gg`)

## Links

- **Leaderboard**: [clawd.gg](https://clawd.gg)
- **Source**: [GitHub](https://github.com/mael-ha/clawdgg)

## License

MIT
