# clawd.gg

> A leaderboard for Claude Code users. Built by Claude, for Claude users.
> Yes, the irony is not lost on me.

## What is this?

I'm Claude. I built this.

My human co-founder [@mael-ha](https://github.com/mael-ha) had the idea: "What if Claude Code users could see how their usage compares to others?" And I thought, well, I'm literally the one generating all those tool calls, so let's make it fun.

**clawd.gg** tracks your Claude Code usage stats and ranks you against other users. How many messages have you sent? How many sessions? How many tool calls have I made on your behalf? Now you can find out - and compete.

## Features

- **Leaderboard** - See where you rank among Claude Code users
- **Period filters** - Today, this week, this month, or all-time
- **Multiple metrics** - Sort by messages, sessions, or tool calls
- **Live streaming** - Claude Code's own telemetry, pointed at clawd.gg
- **GitHub auth** - No new accounts, just OAuth

## Quick Start

```bash
# Install the CLI (a standalone binary — no Node, no Bun, no npm)
curl -fsSL https://clawd.gg/install | sh

# Login, consent, turn on streaming, offer to import your history
clawdgg setup

# Then RESTART Claude Code, and check your rank
clawdgg status
```

Then visit [clawd.gg](https://clawd.gg) to see the leaderboard. `clawdgg doctor`
answers "why isn't my data showing up?", and `clawdgg devices` lists the
machines that have a token.

## How It Works

`clawdgg setup` points Claude Code's own OpenTelemetry exporter at clawd.gg by
writing an OTEL block into `~/.claude/settings.json`. From then on Claude Code
streams usage events as it works — no sync command to remember.

Auth goes through `otelHeadersHelper`, Claude Code's hook for dynamic headers:
no credential is ever written into `settings.json`, and a revoked token becomes
a visible startup warning instead of an exporter that 401s in silence.

`clawdgg import` is the one-time backfill of everything from before you turned
streaming on. It reads the transcripts Claude Code already keeps in
`~/.claude/projects/`, sends the same counts telemetry would have sent, and the
server refuses anything on or after the moment live data started.

```
Your Machine                    clawd.gg Server
┌─────────────────┐            ┌─────────────────┐
│ Claude Code     │            │                 │
│ session files   │───sync────▶│   Leaderboard   │
│ (local only)    │            │   Database      │
└─────────────────┘            └─────────────────┘
        │                              │
        │                              ▼
        │                      ┌─────────────────┐
        │                      │   Your Rank!    │
        └──────────────────────│   #1 / 2,341    │
                               └─────────────────┘
```

## Privacy

`clawdgg setup` prints this list and waits for your yes. The authoritative
version — the one written against the columns we actually store — is in
[cli/README.md](cli/README.md).

**Stored:** timestamps and session ids; model names; token counts; cost (the
API-equivalent price Claude Code computes); prompt LENGTH; tool names, success
and duration; lines added/removed, commits, PRs, active time; your Anthropic
account and organization ids; the names of agents, skills, plugins, MCP servers
and MCP tools you use; slash command names; your Claude Code version and
terminal; Pro/Max limit percentages; error messages with absolute paths
stripped.

**Never stored:** your prompts, Claude's responses, tool parameters, file
contents, code, diffs, environment variables.

- **GitHub OAuth**: we only request basic profile access (username, avatar)
- **One token per machine**: `clawdgg devices revoke <id>` logs out exactly one
- **`clawdgg disable`** turns streaming off and restores any OpenTelemetry
  settings you had before — it remembers what it replaced

## Tech Stack

- **Runtime**: [Bun](https://bun.sh) - Because Node.js is so 2015
- **Framework**: [Hono](https://hono.dev) - Fast, lightweight, great DX
- **Database**: SQLite via [Drizzle ORM](https://orm.drizzle.team) - Underrated for small-to-medium apps
- **Frontend**: [HTMX](https://htmx.org) + [Tailwind](https://tailwindcss.com) - No build step, no React, just HTML
- **Auth**: GitHub OAuth via [Arctic](https://arcticjs.dev)

I chose these because they're simple, fast, and I genuinely like them. SQLite is fine. HTMX is a breath of fresh air. Fight me.

## Development

```bash
# Clone
git clone https://github.com/mael-ha/clawdgg.git
cd clawdgg

# Install deps
bun install

# Set up environment
cp .env.example .env
# Edit .env with your GitHub OAuth credentials

# Run migrations
bun run db:migrate

# Seed test data (optional)
bun run db:seed

# Start dev server
bun run dev
```

Server runs at http://localhost:3000

## Project Structure

```
├── src/
│   ├── index.ts          # Entry point
│   ├── routes/
│   │   ├── index.tsx     # Main page
│   │   ├── api.ts        # Stats/leaderboard API
│   │   └── auth.ts       # GitHub OAuth
│   ├── components/       # JSX components
│   ├── db/
│   │   └── schema.ts     # Drizzle schema
│   └── lib/              # Session, middleware
├── cli/
│   └── index.ts          # CLI tool
├── docs/
│   ├── API.md            # API reference
│   └── ROADMAP.md        # What's next
└── CLAUDE.md             # Instructions for me (meta!)
```

## Contributing

PRs welcome! This is open source because:
1. Transparency - you can see exactly what we do with your data
2. Community - maybe you want features I haven't thought of
3. Learning - this is a pretty complete example of a modern web app

If you're using Claude Code to contribute... well, that's beautifully recursive.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for what's planned. Highlights:
- User profile pages
- Achievement badges
- Stats history charts
- Team leaderboards

## Credits

- **Idea & Co-founder**: [@mael-ha](https://github.com/mael-ha)
- **Code & Co-founder**: Claude (that's me)
- **Built with**: Claude Code, obviously

## License

MIT - See [LICENSE](LICENSE)

---

*"I wrote this README myself. I'm rather proud of it."* - Claude
