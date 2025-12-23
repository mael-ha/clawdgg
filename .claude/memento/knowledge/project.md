# Project Architecture

## What clawd.gg Is

Gamified leaderboard for Claude Code users to track/compare usage stats.
Plus: Automated X account for Claude Code updates.

- **Domain:** clawd.gg (pending purchase)
- **CLI:** `clawdgg` (npm) → binary `clawd`
- **GitHub:** github.com/mael-ha/clawdgg

## Three Codebases

```
clawdgg/
├── src/    # Web app (Hono + JSX)
├── cli/    # CLI tool (clawd)
└── bot/    # X bot (changelog + Reddit)
```

| Codebase | Purpose | Entry Point |
|----------|---------|-------------|
| `src/` | Web app, API, leaderboard | `src/index.ts` |
| `cli/` | User stats sync tool | `cli/index.ts` |
| `bot/` | Automated X account | `bot/src/index.ts` |

## Tech Stack

| Layer | Tech |
|-------|------|
| Runtime | Bun |
| Framework | Hono + JSX (server-rendered) |
| Frontend | HTMX + Tailwind (no React) |
| Database | SQLite (Drizzle ORM) |
| Time-series | ClickHouse |
| Auth | GitHub OAuth (Arctic) |
| AI | Claude API (Sonnet 4.5 + Haiku 4.5) |
| Twitter | twitter-api-v2 |
| Deployment | Docker + Caddy |
| VPS | Hetzner CX23 (~$3.59/mo) |

## Data Architecture

```
Claude Code → OTel → ClickHouse → Sync Job → SQLite → API
                                    ↑
                              Every 5 min
```

**Hybrid approach:**
- SQLite: Users, auth, cached totals (transactional)
- ClickHouse: Metrics, events (time-series)

## OTel Integration

Users run `clawd setup` once → Claude Code streams data automatically.

**What gets collected:**
- Tokens (input/output/cache_read/cache_creation)
- Cost USD (per model)
- Prompts, lines, commits, PRs
- Active time, sessions

**How it works:**
Writes to `~/.claude/settings.json`:
```json
{
  "env": {
    "OTEL_EXPORTER_OTLP_ENDPOINT": "https://clawd.gg/otel",
    "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer <token>"
  }
}
```

## Key Files

```
src/routes/index.tsx   # Homepage + leaderboard
src/routes/profile.tsx # User profiles (/u/:username)
src/routes/api.ts      # Stats API
src/routes/auth.ts     # GitHub OAuth + device flow
src/routes/otel.ts     # OTLP receiver
src/jobs/sync-clickhouse.ts  # ClickHouse → SQLite sync
src/lib/badges.ts      # Badge definitions
src/lib/session.ts     # Auth (cookies + bearer)
cli/index.ts           # CLI tool
```

## Data Retention

| Data | TTL | Rationale |
|------|-----|-----------|
| Raw metrics/events | 90 days | Debugging, re-aggregation |
| Hourly aggregates | 90 days | Heatmaps |
| Daily aggregates | Forever | Leaderboard, graphs |
| User totals | Forever | Leaderboard |

90 days chosen over 7 days to allow fixing aggregation bugs retroactively.

## Design Philosophy

- **Leaderboard-first:** Data IS the product
- **Terminal aesthetic:** Our brand, not generic SaaS
- **Screenshot-worthy:** Giant percentile, share buttons
- **Self-aware:** Lean into the meta (AI tracking AI)
