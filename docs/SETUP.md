# Setup Guide

Running clawd.gg locally. To just *use* it, install the CLI instead:
`curl -fsSL https://clawd.gg/install | sh && clawdgg setup`.

## Prerequisites

- [Bun](https://bun.sh)
- Docker (for ClickHouse, where all usage data lives)
- A GitHub OAuth app (for auth)

## Quick Start

```bash
# Install dependencies
bun install

# Copy environment file
cp .env.example .env
# Edit .env:
# - GITHUB_CLIENT_ID
# - GITHUB_CLIENT_SECRET
# - SESSION_SECRET (generate with: openssl rand -hex 32)

# ClickHouse (creates the `clawd` database from docker/clickhouse/init)
docker compose -f docker-compose.dev.yml up -d

# SQLite schema
bun run db:migrate

# Compile the CSS and client islands into public/build.
# The server throws at startup without public/build/manifest.json.
bun run build

# Start dev server (runs `bun run build` first, then bun --hot)
bun run dev
```

Server runs at http://localhost:3000. If ClickHouse is not reachable the app
still starts, `/health` reports `degraded`, and the sync job stays off: pages
render, but no numbers.

## Environment Variables

```env
# GitHub OAuth (create at https://github.com/settings/developers)
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret

# Session secret (32+ chars). Required: the server throws without it.
SESSION_SECRET=your_random_secret

# App URL (for OAuth callback). Cookies are Secure iff this starts with https://
APP_URL=http://localhost:3000

# SQLite path
DATABASE_PATH=./data/clawd.db

# Port (optional, default 3000)
PORT=3000

# ClickHouse (optional; these are the defaults)
CLICKHOUSE_URL=http://localhost:8123
CLICKHOUSE_DATABASE=clawd

# Enables POST /api/admin/sync (optional; the endpoint is disabled without it)
ADMIN_TOKEN=
```

`.env.example` stops at `PORT`; add the ClickHouse and admin variables when you need them.
Comment on the line *above* a value, never inline: Foreman-style launchers pass
`KEY=value # comment` through verbatim.

## GitHub OAuth Setup

1. Go to https://github.com/settings/developers
2. Click "New OAuth App"
3. Fill in:
   - Application name: `clawd.gg (dev)`
   - Homepage URL: `http://localhost:3000`
   - Authorization callback URL: `http://localhost:3000/auth/callback`
4. Copy Client ID and Client Secret to `.env`

## Scripts

```bash
bun run dev          # build assets, then start with hot reload
bun run build        # compile CSS + bundle client islands → public/build/
bun run start        # production server (needs a prior build)
bun test             # test suite
bun run typecheck    # tsc --noEmit
bun run db:generate  # generate a Drizzle migration after editing src/db/schema.ts
bun run db:migrate   # apply SQLite migrations
```

`bun run db:seed` still exists but writes only the retired `daily_stats` table,
which nothing reads, so seeded users do not appear on any board. To get data
into a dev instance, run the CLI against it (below).

## Getting data into a dev instance

Point the CLI (run from source) at your local server:

```bash
CLAWDGG_API_URL=http://localhost:3000 bun cli/index.ts setup
```

A source run honours `CLAWDGG_API_URL`; a release binary ignores it unless
`CLAWDGG_DEV=1`, and the URL must be https or loopback. **`setup` edits your real
`~/.claude/settings.json`** (it backs the file up first, and
`bun cli/index.ts disable` puts your previous OTEL settings back). Restart Claude
Code afterwards and use it; events arrive at `/otel/v1/*`, land in ClickHouse,
and the sync job copies totals to SQLite within 5 minutes
(`POST /api/admin/sync` with `ADMIN_TOKEN` forces it).

`bun cli/index.ts import` loads your local transcript history the same way a
real user's would.

## Building the CLI

```bash
bun scripts/build-cli.ts                   # standalone binary for this machine → dist/cli/
bun scripts/build-cli.ts --all --checksums # all release targets + SHA-256 list
```

The release procedure (tag, workflow, committing `cli/checksums/<version>.txt`)
is in `cli/checksums/README.md`.

## Troubleshooting

### "No public/build/manifest.json"
```bash
bun run build
```

### Port 3000 in use
```bash
lsof -i :3000 | grep LISTEN | awk '{print $2}' | xargs kill -9
```

### Pages render but every number is 0
ClickHouse is down or empty. Check `curl localhost:3000/health`, then
`docker compose -f docker-compose.dev.yml ps`.

### SQLite issues
```bash
rm -rf data/clawd.db*
bun run db:migrate
```
This drops accounts, device tokens and settings, not usage data (that is in
ClickHouse).

### Docker: `.env` changes not picked up
`docker compose restart` does not reload `.env`; use
`docker compose down && docker compose up -d`.
