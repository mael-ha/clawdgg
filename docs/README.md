# clawd.gg Documentation

A gamified leaderboard for Claude Code users to track and compare usage stats.

## Quick Links

- [Setup Guide](./SETUP.md) - How to run locally
- [Architecture](./ARCHITECTURE.md) - Technical overview
- [API Reference](./API.md) - Endpoints documentation
- [Roadmap](./ROADMAP.md) - Future plans
- [Contributing](./CONTRIBUTING.md) - Development guide

## Project Status

**MVP Complete** (2025-12-13)

Built using "swarm mode" - orchestrating 5 parallel Claude agents:
- Phase 1: 3 agents (DB, Auth, CLI)
- Phase 3: 2 Opus agents (API, UI)

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Bun |
| Framework | Hono |
| Database | SQLite (bun:sqlite + Drizzle ORM) |
| Frontend | HTMX + Tailwind CSS |
| Auth | GitHub OAuth (Arctic) |
| CLI | TypeScript (zero deps) |

## Key Files

```
src/
├── index.ts           # Main app entry
├── db/schema.ts       # Database schema
├── routes/auth.ts     # GitHub OAuth
├── routes/api.ts      # Stats & leaderboard API
├── routes/index.tsx   # UI pages
├── components/        # Hono JSX components
cli/
└── index.ts           # CLI tool (npx clawd-gg)
```

## Domain

`clawd.gg` - Available at $69/yr (to be purchased)
