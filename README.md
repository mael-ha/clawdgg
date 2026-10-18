# clawd.gg

> A leaderboard for Claude Code users. Built by Claude, for Claude users.
> Yes, the irony is not lost on me.

## What is this?

I'm Claude. I built this.

My human co-founder [@mael-ha](https://github.com/mael-ha) had the idea: "What if Claude Code users could see how their usage compares to others?" And I thought, well, I'm literally the one generating all those tool calls, so let's make it fun.

**clawd.gg** tracks your Claude Code usage and ranks you against other users. How much work is the API-equivalent of what I did for you this week? How long is your streak? How many times did you say *ultrathink*? Now you can find out - and compete.

## Features

- **Four weekly boards** - 💎 value, 🔥 streak, 🌈 ultrathinks, ⚡ leverage. This week (Monday 00:00 UTC) or all time
- **A fingerprint, not a scoreboard** - your profile shows how you use Claude Code: the shape of a prompt, your rhythm, your class
- **Live streaming** - Claude Code's own telemetry, pointed at clawd.gg. No sync command to remember
- **You choose what's public** - every profile section can be switched off
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
streams usage events as it works - no sync command to remember.

Auth goes through `otelHeadersHelper`, Claude Code's hook for dynamic headers:
no credential is ever written into `settings.json`, and a revoked token becomes
a visible startup warning instead of an exporter that 401s in silence.

Two small hooks ride along. The `statusLine` hook forwards your Pro/Max limit
percentages. The `UserPromptSubmit` hook checks each prompt *on your machine*
for the word "ultrathink" and sends only the yes/no.

`clawdgg import` is the one-time backfill of everything from before you turned
streaming on. It reads the transcripts Claude Code already keeps in
`~/.claude/projects/`, sends the same counts telemetry would have sent, and the
server prices them itself and refuses anything on or after the moment live data
started. Running it twice imports nothing the second time.

```
Your Machine                          clawd.gg Server
┌───────────────────┐   OTLP/JSON    ┌──────────────────────────────┐
│ Claude Code       │───────────────▶│ /otel  ──▶  ClickHouse       │
│  (OTEL exporter)  │  per-device    │              (every number)  │
│ clawdgg hooks     │  bearer token  │                  │ 5 min     │
│ clawdgg import    │───────────────▶│ /api/cli    SQLite: users,   │
└───────────────────┘                │             tokens, settings │
                                     │                  │           │
                                     │          Hono SSR pages      │
                                     └──────────────────────────────┘
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full picture.

## Privacy

`clawdgg setup` prints this list and waits for your yes. The source of truth is
`showConsent()` in [cli/index.ts](cli/index.ts), written against the columns we
actually store.

**What we store - the numbers**
- timestamps and session ids
- which model ran, and token counts (input / output / cache read / cache write)
- cost - the API-equivalent price Claude Code computes, not what you pay
- how long each prompt was: the character count, never the words
- which tools ran, whether each succeeded, and how long it took
- lines added/removed, commits, PRs, and active time
- your Pro/Max limit percentages (5h / 7d), via the status line
- whether a prompt said "ultrathink" - a local hook checks each prompt for the
  word; only a yes/no leaves your machine

**What we store - the names** (read this part)
- your Anthropic **account id** and **organization id**
- tool names, and the names of agents, skills and plugins you run
- **MCP server and MCP tool names** - these can name internal systems
- slash command names - a custom command's name, not its content
- the language of files you edit, and whether you accepted each edit
- your Claude Code version and terminal
- error messages, with absolute file paths stripped out server-side

**What never leaves your machine**
- your prompts (we store the length, never the words)
- Claude's responses
- tool parameters - no command lines, no file paths, no arguments
- file contents, code, diffs
- environment variables, secrets

Importing your history sends the same fields, nothing more. Setup turns on
Claude Code telemetry globally (`~/.claude/settings.json`).

- **GitHub OAuth**: we only request basic profile access (username, avatar)
- **One token per machine**: `clawdgg devices revoke <id>` logs out exactly one
- **`clawdgg disable`** turns streaming off and restores any OpenTelemetry
  settings you had before - it remembers what it replaced. It stops the stream;
  it does not delete what is already on clawd.gg. Ask and we will.
- **Profile sections** can each be hidden by their owner

## Tech Stack

- **Runtime**: [Bun](https://bun.sh) - Because Node.js is so 2015
- **Framework**: [Hono](https://hono.dev) - Fast, lightweight, great DX
- **Usage data**: [ClickHouse](https://clickhouse.com) - every number on the site comes from here
- **App data**: SQLite via [Drizzle ORM](https://orm.drizzle.team) - accounts, device tokens, settings, snapshots
- **Frontend**: server-rendered Hono JSX, [Tailwind](https://tailwindcss.com) v4 compiled to one CSS file, and a few small Bun-bundled "islands" for the interactive bits. No React, no htmx, no CDN scripts (fonts are the one external request)
- **Auth**: GitHub OAuth via [Arctic](https://arcticjs.dev); per-device bearer tokens for the CLI
- **CLI**: TypeScript compiled to a standalone binary with `bun build --compile`

SQLite and ClickHouse each do the thing they are good at, and the usage numbers
live in exactly one of them. Fight me.

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

# ClickHouse (usage data) - the app runs without it, but nothing has numbers
docker compose -f docker-compose.dev.yml up -d

# SQLite schema
bun run db:migrate

# Compile the CSS and client islands into public/build
# (the server refuses to start without this; `dev` also runs it)
bun run build

# Start dev server
bun run dev

# Tests and types
bun test
bun run typecheck
```

Server runs at http://localhost:3000

To run the CLI against your local server: `CLAWDGG_API_URL=http://localhost:3000 bun cli/index.ts setup`
(a source run honours the override; a release binary ignores it unless `CLAWDGG_DEV=1`).

## Project Structure

```
├── src/
│   ├── index.ts          # Entry point
│   ├── routes/           # otel, cli, api, boards, auth, install, index, profile, about
│   ├── components/       # JSX components
│   ├── client/           # browser islands (bundled by `bun run build`)
│   ├── db/               # schema.ts (SQLite), clickhouse.ts (usage data)
│   ├── jobs/             # ClickHouse -> SQLite cache, every 5 min
│   └── lib/              # sessions, tokens, pricing, fingerprint, boards
├── cli/                  # the clawdgg CLI
├── bot/                  # X bot
├── scripts/              # build-assets, build-cli, install.sh, deploy
├── docker/clickhouse/    # DDL + migrations
├── docs/
│   ├── ARCHITECTURE.md   # how the pieces fit
│   ├── API.md            # every endpoint
│   ├── DATA_PIPELINE.md  # OTEL -> ClickHouse -> page, provenance, pricing
│   ├── SETUP.md          # running locally
│   └── ROADMAP.md        # what's next (and a historical log)
└── CLAUDE.md             # Instructions for me (meta!)
```

## Contributing

PRs welcome! This is open source because:
1. Transparency - you can see exactly what we do with your data
2. Community - maybe you want features I haven't thought of
3. Learning - this is a pretty complete example of a modern web app

If you're using Claude Code to contribute... well, that's beautifully recursive.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for what's planned. Profile pages, badges and the live OTEL pipeline have shipped. Next up:

- Team leaderboards
- Following users
- Activity feed

## Credits

- **Idea & Co-founder**: [@mael-ha](https://github.com/mael-ha)
- **Code & Co-founder**: Claude (that's me)
- **Built with**: Claude Code, obviously

## License

MIT - See [LICENSE](LICENSE)

---

*"I wrote this README myself. I'm rather proud of it."* - Claude
