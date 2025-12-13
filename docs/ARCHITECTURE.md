# Architecture

## Overview

```
┌─────────────────────────────────────────────────────────┐
│                      clawd.gg                           │
├─────────────────────────────────────────────────────────┤
│  UI Layer (Hono JSX + HTMX + Tailwind)                 │
│  - Server-rendered HTML                                 │
│  - HTMX for dynamic updates (no client JS framework)   │
│  - Cyberpunk/terminal aesthetic                        │
├─────────────────────────────────────────────────────────┤
│  API Layer (Hono)                                       │
│  - /api/stats - Stats submission                       │
│  - /api/leaderboard - Rankings (JSON + HTMX partials)  │
│  - Rate limiting (10 req/min per user)                 │
├─────────────────────────────────────────────────────────┤
│  Auth Layer (Arctic + Cookie Sessions)                 │
│  - GitHub OAuth flow                                   │
│  - HMAC-signed cookies (no server-side sessions)       │
├─────────────────────────────────────────────────────────┤
│  Data Layer (Drizzle ORM + bun:sqlite)                 │
│  - users table                                         │
│  - daily_stats table                                   │
│  - WAL mode for concurrent access                      │
└─────────────────────────────────────────────────────────┘
```

## Directory Structure

```
clawdgg/
├── src/
│   ├── index.ts              # Main Hono app, routes mounting
│   ├── types.ts              # Shared TypeScript types
│   │
│   ├── db/
│   │   ├── schema.ts         # Drizzle table definitions
│   │   ├── index.ts          # Database connection
│   │   └── seed.ts           # Test data seeding
│   │
│   ├── lib/
│   │   ├── session.ts        # Cookie session management
│   │   ├── auth-middleware.ts # requireAuth, optionalAuth
│   │   └── rate-limit.ts     # In-memory rate limiter
│   │
│   ├── routes/
│   │   ├── auth.ts           # /auth/* - GitHub OAuth
│   │   ├── api.ts            # /api/* - Stats, leaderboard
│   │   └── index.tsx         # / - Main pages (JSX)
│   │
│   └── components/
│       ├── Layout.tsx        # Base HTML layout
│       ├── Leaderboard.tsx   # Ranking table component
│       └── index.ts          # Component exports
│
├── cli/
│   ├── index.ts              # CLI entry point
│   ├── package.json          # CLI package config
│   └── tsconfig.json         # CLI TypeScript config
│
├── public/
│   └── styles.css            # Custom CSS (glitch, scanlines)
│
├── drizzle/
│   └── 0000_*.sql            # Generated migrations
│
├── data/
│   └── clawd.db              # SQLite database file
│
├── docs/                     # Documentation (you are here)
│
├── drizzle.config.ts         # Drizzle kit config
├── package.json              # Project config
├── tsconfig.json             # TypeScript config
├── .env                      # Environment variables
└── CLAUDE.md                 # Claude Code context file
```

## Database Schema

### users
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id TEXT UNIQUE NOT NULL,
  github_username TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  first_session_date TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
```

### daily_stats
```sql
CREATE TABLE daily_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,  -- YYYY-MM-DD
  message_count INTEGER DEFAULT 0,
  session_count INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0,
  submitted_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(user_id, date)
);

-- Indexes for leaderboard queries
CREATE INDEX idx_daily_stats_date ON daily_stats(date);
CREATE INDEX idx_daily_stats_user ON daily_stats(user_id);
```

## Auth Flow

```
User clicks "Login with GitHub"
         │
         ▼
GET /auth/github
  - Generate state token
  - Store in cookie
  - Redirect to GitHub
         │
         ▼
GitHub prompts user to authorize
         │
         ▼
GET /auth/callback?code=xxx&state=xxx
  - Verify state matches cookie
  - Exchange code for access token
  - Fetch user info from GitHub API
  - Create/update user in database
  - Create signed session cookie
  - Redirect to /
         │
         ▼
User is now authenticated
Session stored in signed cookie (30 days)
```

## Session Security

- Sessions stored in signed cookies (HMAC-SHA256)
- No server-side session storage
- Constant-time signature comparison (timing attack protection)
- HttpOnly, Secure (in prod), SameSite=Lax
- 30-day expiration

**Limitation**: Cannot revoke sessions server-side (noted in code review)

## Rate Limiting

- In-memory Map storage
- 10 requests per minute per user (or per IP if unauthenticated)
- Automatic cleanup every 5 minutes
- Returns 429 with Retry-After header when exceeded

## Data Flow: Stats Sync

```
User runs: clawd-gg sync
         │
         ▼
CLI reads ~/.claude/stats-cache.json
         │
         ▼
POST /api/stats (with Bearer token)
  {
    dailyActivity: [{date, messageCount, sessionCount, toolCallCount}, ...],
    totalMessages: N,
    totalSessions: N,
    firstSessionDate: "..."
  }
         │
         ▼
Server UPSERTs each day into daily_stats
         │
         ▼
Leaderboard rankings update automatically
```

## Component Architecture

```
Layout.tsx
├── NavBar (login/logout)
├── {children}
│   └── Page content
├── Scanlines overlay
└── Grid background

Leaderboard.tsx
├── Period tabs (HTMX)
├── LeaderboardRow × N
│   ├── RankBadge (gold/silver/bronze)
│   ├── UserAvatar
│   └── StatPills
└── Pagination (HTMX)
```
