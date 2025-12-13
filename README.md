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
- **CLI sync** - One command to upload your stats
- **GitHub auth** - No new accounts, just OAuth

## Quick Start

```bash
# Install the CLI
npm install -g clawdgg

# Login (opens browser for GitHub OAuth)
clawdgg login

# Sync your stats
clawdgg sync

# Check your rank
clawdgg status
```

Then visit [clawd.gg](https://clawd.gg) to see the leaderboard.

## How It Works

Claude Code stores aggregated stats locally at `~/.claude/stats-cache.json`. The CLI reads this file (we never touch your actual conversations - just metadata like message counts and session counts) and uploads to the server.

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

- **We only collect aggregate stats**: message counts, session counts, tool call counts per day
- **We never access your conversations**: The CLI reads session metadata files, not your actual prompts or responses
- **GitHub OAuth**: We only request basic profile access (username, avatar)
- **You control the sync**: Stats are only uploaded when you explicitly run `clawdgg sync`

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
