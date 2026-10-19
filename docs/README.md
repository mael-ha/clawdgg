# clawd.gg Documentation

How you use Claude Code, as a fingerprint, ranked every week.

## Quick Links

- [Setup Guide](./SETUP.md) - How to run locally
- [Architecture](./ARCHITECTURE.md) - Technical overview
- [Data Pipeline](./DATA_PIPELINE.md) - OTEL to ClickHouse to page; provenance, pricing, what each number means
- [API Reference](./API.md) - Endpoints documentation
- [Roadmap](./ROADMAP.md) - Future plans (and a historical log of the MVP)
- [Contributing](./CONTRIBUTING.md) - Development guide

Elsewhere: [cli/README.md](../cli/README.md) (the `clawdgg` CLI),
`docker/clickhouse/migrations/README-2026-10.md` (prod migration runbook),
`cli/checksums/README.md` (CLI release procedure).

## Project Status

Live at https://clawd.gg. Usage is counted over Claude Code's own OpenTelemetry
export; ClickHouse is the single source of truth for every displayed number.
The MVP (December 2025) was a stats-file upload and an HTMX leaderboard; both
are gone, replaced by the pipeline above.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Bun |
| Framework | Hono |
| Usage data | ClickHouse (ReplacingMergeTree, `row_id` identity) |
| App data | SQLite (bun:sqlite + Drizzle ORM) |
| Frontend | Hono JSX (SSR) + Tailwind v4 (compiled) + Bun.build islands |
| Auth | GitHub OAuth (Arctic); per-device bearer tokens for the CLI |
| Ingest | OTLP http/json at `/otel/v1/{metrics,logs}` |
| CLI | TypeScript, compiled to a standalone binary (`curl -fsSL https://clawd.gg/install \| sh`) |

## Key Files

```
src/
├── index.ts              # Main app entry, route mounting
├── db/schema.ts          # SQLite schema
├── db/clickhouse.ts      # ClickHouse client, row identity, shared SQL
├── jobs/sync-clickhouse.ts # ClickHouse -> users.* cache (5 min)
├── routes/otel.ts        # OTLP receiver
├── routes/cli.ts         # /api/cli/*: health, devices, logout, import, ultrathink
├── routes/api.ts         # /api/*: leaderboard, me, fingerprint, settings, plan usage
├── routes/boards.ts      # /api/boards
├── routes/auth.ts        # GitHub OAuth + CLI device flow
├── routes/install.ts     # /install, /install/checksums/:version
├── routes/index.tsx      # Homepage (boards)
├── routes/profile.tsx    # /u/:username
├── lib/                  # session, pricing, fingerprint, boards, session-import
├── client/               # browser islands
cli/
├── index.ts              # clawdgg commands
└── settings.ts, statusline.ts, prompt-hook.ts, otel-headers.ts
docker/clickhouse/        # DDL + migrations
```
