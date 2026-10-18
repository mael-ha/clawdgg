# Architecture

ClickHouse is the single source of truth for every number the site shows.
SQLite holds the things that are not usage: accounts, settings, credentials,
snapshots. If a figure appears on two pages, it was computed once.

## Overview

```
 Your machine                                   clawd.gg server
┌────────────────────────┐                     ┌─────────────────────────────────────┐
│ Claude Code            │  OTLP http/json     │ POST /otel/v1/metrics               │
│  OTEL exporter ────────┼────────────────────▶│ POST /otel/v1/logs                  │
│  otelHeadersHelper ──┐ │  Authorization:     │   bearer check → parse → row_id     │
│   (clawdgg otel-     │ │  Bearer cgt_…       │                  │                  │
│    headers)          │ │                     │                  ▼                  │
│  statusLine hook ────┼─┼──POST /api/plan-usage       ┌─────────────────────┐       │
│  UserPromptSubmit ───┼─┼──POST /api/cli/ultrathink   │ ClickHouse          │       │
│   hook               │ │                     │       │  metrics_raw        │       │
│                      │ │                     │       │  events_raw         │       │
│ clawdgg import ──────┼─┼──POST /api/cli/import ─────▶│  (source of truth)  │       │
│  (~/.claude/projects,│ │                     │       └──────────┬──────────┘       │
│   history.jsonl)     │ │                     │                  │ every 5 min      │
└──────────────────────┘ │                     │                  ▼                  │
                         │                     │       ┌─────────────────────┐       │
                         │                     │       │ SQLite (bun:sqlite) │       │
                         │                     │       │  users (+ cached    │       │
                         │                     │       │   totals, badges)   │       │
                         │                     │       │  device_tokens      │       │
                         │                     │       │  plan_usage_snapshots       │
                         │                     │       │  rank_snapshots     │       │
                         │                     │       │  profile_settings   │       │
                         │                     │       └──────────┬──────────┘       │
                         │                     │                  ▼                  │
                         │                     │  Hono SSR + Tailwind + islands      │
                         └─────────────────────┴─────────────────────────────────────┘
```

Nothing is uploaded on a schedule and there is no `sync` command. Claude Code
streams its own telemetry; the server never asks the client for anything.

## Layers

```
┌─────────────────────────────────────────────────────────────────────┐
│ UI      Hono JSX, server-rendered. Tailwind v4 compiled to one CSS  │
│         file; a few Bun.build "islands" for the bits that need JS.  │
│         No htmx, no client framework, no CDN scripts.               │
├─────────────────────────────────────────────────────────────────────┤
│ Routes  /            homepage: four boards          (routes/index)  │
│         /u/:name     profile                        (routes/profile)│
│         /about       about                          (routes/about)  │
│         /auth/*      GitHub OAuth + CLI device flow (routes/auth)   │
│         /otel/*      OTLP receiver                  (routes/otel)   │
│         /api/*       JSON API                       (routes/api)    │
│         /api/cli/*   CLI-only, bearer-only          (routes/cli)    │
│         /api/boards  the homepage boards as JSON    (routes/boards) │
│         /install/*   installer + release checksums  (routes/install)│
├─────────────────────────────────────────────────────────────────────┤
│ Auth    Browser: signed cookie session (HMAC-SHA256, 30 days).      │
│         CLI/OTLP: per-device bearer `cgt_<id>.<secret>`.            │
├─────────────────────────────────────────────────────────────────────┤
│ Data    ClickHouse (usage)  +  SQLite via Drizzle (everything else) │
└─────────────────────────────────────────────────────────────────────┘
```

## Data flow: how a number gets onto a page

1. **Claude Code emits OTEL.** `clawdgg setup` writes an OTEL block into
   `~/.claude/settings.json`: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, OTLP exporters
   for metrics and logs, protocol `http/json`, endpoint `https://clawd.gg/otel`.
   Metrics (`claude_code.token.usage`, `cost.usage`, `lines_of_code.count`, ...)
   and events (`user_prompt`, `api_request`, `tool_result`, ...) arrive as OTLP.
2. **Auth is dynamic, not baked in.** The settings file names an
   `otelHeadersHelper`: Claude Code runs `clawdgg otel-headers` at startup and
   periodically, and it prints the `Authorization` header. No credential is in
   `settings.json`. A revoked token makes the helper exit non-zero, which Claude
   Code shows as a startup warning instead of an exporter that 401s in silence.
3. **`/otel/v1/{metrics,logs}` validates and stores.** Bearer is verified
   against `device_tokens` (revoked rows are rejected everywhere at once). The
   body may be gzip; size is capped on the wire *and* decompressed. A bad
   datapoint is skipped and reported as OTLP `partialSuccess`; only a batch with
   nothing readable is a 4xx, because a 5xx makes the SDK retry the same batch
   forever. Absolute paths in error messages are replaced with `<path>` before
   anything is written.
4. **ClickHouse is the record.** Rows land in `metrics_raw` / `events_raw`
   (ReplacingMergeTree, every read uses `FINAL`). See [row identity](#row-identity-and-provenance).
5. **A job caches totals into SQLite.** `src/jobs/sync-clickhouse.ts` runs at
   startup and every 5 minutes, for every user: totals, streaks, hour counts,
   and badges into `users.*`. It then writes the once-a-day rank
   snapshot. `users.total_*` is a cache of ClickHouse and nothing more.
6. **Pages read the cache or ClickHouse directly.** All-time boards read
   `users.total_*`; period boards, the profile fingerprint and charts query
   ClickHouse. Both are the same answer, five minutes apart at most.

### Row identity and provenance

Both raw tables are `ReplacingMergeTree` and end their sorting key in `row_id`:
a SHA-256 (128 bits) over every *identifying* attribute of a datapoint and none
of its value. An OTLP retry hashes identically and collapses; two datapoints
that share a timestamp but differ in model, `query_source`, tool, agent, etc.
both survive. `provenance` is part of the hash, so a reconstructed row can
never overwrite a measured one. The TypeScript hash and the SQL used in
migrations are generated from the same column lists and tested against each
other (`src/db/clickhouse.test.ts`, `docker/clickhouse/migrations/identity-parity.test.ts`).

Every row carries a `provenance`:

| Value | Meaning |
|-------|---------|
| `live` | Received over OTLP from a running Claude Code (default). Carries Claude Code's own measured cost. |
| `backfill` | Reconstructed from local JSONL transcripts by the operator-run `src/scripts/backfill-jsonl.ts`. Cost is an estimate. |
| `backfill-history` | Prompt counts recovered from `~/.claude/history.jsonl` for windows whose transcripts have rotated away. |
| `legacy` | Imported from the retired SQLite `daily_stats` table. One row per day, stamped 12:00 UTC, no session, no model. |
| `import` | Reconstructed from the user's own transcripts by `clawdgg import`. Cost is recomputed server-side. |
| `hook` | Reported by a local hook. Today only the ultrathink flag, event `clawdgg.ultrathink`. |
| `repair` | A token/cost datapoint rebuilt from the `api_request` event that measured it. Counts everywhere `live` counts. |

Two SQL predicates keep the definitions in one place (`src/db/clickhouse.ts`):

- `PROMPT_EVENT_SQL`: a prompt is a `user_prompt` event whose `command_source`
  is not `builtin`. `/clear`, `/compact`, `/model` are not prompts.
- `NO_LEGACY_SQL`: excludes `legacy` rows from anything that reads the *shape*
  of a day (hour, weekday, per-session structure, success rates). Counts and
  sums include them.

Time-of-day figures are read in the user's own clock (`users.timezone`, an IANA
name set by `clawdgg setup` or `PUT /api/me/timezone`). ClickHouse's server
timezone is pinned to UTC; the timestamps are UTC instants and every
hour/weekday/week query converts with `toTimeZone`.

### Where each store is used

| Store | Holds | Never holds |
|-------|-------|-------------|
| ClickHouse `metrics_raw`, `events_raw` | Every usage datapoint, with provenance | Accounts, credentials |
| SQLite `users` | GitHub identity, `timezone`, OTEL status, cached `total_*`, streaks, badges, `token_gen` | Anything not derivable from ClickHouse that a page displays |
| SQLite `device_tokens` | One row per `clawdgg login`: id, device name, `sha256(secret)`, last used, revoked | The secret itself |
| SQLite `device_auths` | In-flight CLI login (device flow), 15 minutes | |
| SQLite `plan_usage_snapshots` | Pro/Max limit windows (`five_hour`, `seven_day`, `spend_limit`), one row per observed change | |
| SQLite `rank_snapshots` | Where each user stood per metric per UTC day, so boards can show arrows | |
| SQLite `profile_settings` | Which profile sections the owner shows (all on by default) | |

`daily_stats` and the `users.legacy_total_*` columns still exist in the schema
but nothing reads or writes them. They are the retired pre-OTEL path; the
history was imported into ClickHouse as `legacy` rows
(`docker/clickhouse/migrations/2026-10-18_import_daily_stats.ts`), and
`src/db/no-legacy-reads.test.ts` fails the build if a read of either comes back
(it would double count).

## The CLI

`cli/` builds to a standalone binary (`bun build --compile`; eight targets
including musl and baseline-x64) installed to `~/.clawdgg/bin/clawdgg` by
`curl -fsSL https://clawd.gg/install | sh`. No Node, no Bun, no sudo.

- **Install trust.** The binary comes from GitHub Releases; the expected SHA-256
  comes from `https://clawd.gg/install/checksums/<version>.txt` (committed in
  `cli/checksums/`). Neither host alone is enough to ship a swapped binary.
- **Auth.** `clawdgg login` runs the device flow and receives a per-device
  token, stored in `~/.config/clawdgg/config.json` (0600) and *pinned to the
  origin that issued it*: a release binary ignores `CLAWDGG_API_URL` unless
  `CLAWDGG_DEV=1`, and the token is never sent elsewhere.
- **`setup`** links the account, prints the consent list and waits for a yes,
  writes the OTEL block, registers the two hooks, tells the server
  (`POST /api/otel/enable`), reports the machine's timezone, and offers the
  history import. `settings.json` is backed up before every write, aborted on
  if unparseable, and only values recognisably ours are ever changed or removed.
- **Hooks**, both registered in `~/.claude/settings.json` and both silent on
  stdout (stdout is injected into Claude's context on some events):
  - `statusLine` runs `clawdgg statusline`, which forwards `rate_limits` to
    `POST /api/plan-usage` from a detached child so the prompt never waits.
  - `UserPromptSubmit` runs `clawdgg prompt-hook`, which tests each prompt for
    the word "ultrathink" locally and sends only the yes/no
    (`POST /api/cli/ultrathink`, event `clawdgg.ultrathink`, provenance `hook`).
- **`import`** maps `~/.claude/projects/**/*.jsonl` (and `history.jsonl` for
  rotated-away days) with the shared mapper `src/lib/session-import.ts`, the
  same code the operator backfill uses, and posts rows to `POST /api/cli/import`.
  The server trusts none of it: `user_id` comes from the token, provenance is
  forced to `import`, cost is recomputed from model + tokens with
  `src/lib/pricing.ts`, metrics are derived from the sanitized events (the
  client's are ignored), counts are clamped, and rows at or after the live-data
  cutoff (`min(otel_setup_at, first live event)`) or on a UTC day already on
  record are skipped. A re-run inserts nothing.
- **`doctor`** answers "why isn't my data showing up?" using `GET /api/cli/health`
  (last live event, token kind, ClickHouse status). `devices` lists, renames and
  revokes tokens. `disable` restores whatever OTEL settings existed before.

## Frontend

Hono JSX rendered on the server, one shell for every page (`components/Layout.tsx`).

- **CSS:** Tailwind v4 compiled by `@tailwindcss/cli` from `src/styles/app.css`.
- **JS:** `bun run build` (`scripts/build-assets.ts`) emits content-hashed files
  into `public/build/` plus `manifest.json`. Each file in `src/client/*.ts` is a
  self-contained island (no shared chunks); a page includes only the islands it
  uses. `/public/build/*` is served `immutable` for a year.
- **The server will not start without a build** (`src/lib/assets.ts` reads the
  manifest). `bun run dev` builds first.
- **No CDN scripts.** The one external request is the web font (Google Fonts).
- **Pages work without JS.** Board selection lives in the URL
  (`/?board=value&scope=week`); islands add copy-to-clipboard, load-more
  (`GET /rows` returns the next rows as an HTML fragment for that island),
  chart interactivity, and the device-code input.
- Number formatting is one module (`src/lib/format.ts`), imported by server
  components and islands alike so a value cannot render two ways.

## Directory structure

```
clawdgg/
├── src/
│   ├── index.ts              # Hono app, middleware, route mounting, sync job start
│   ├── db/
│   │   ├── schema.ts         # Drizzle tables (SQLite)
│   │   ├── index.ts          # bun:sqlite connection (WAL, foreign keys)
│   │   ├── clickhouse.ts     # ClickHouse client, row identity, shared SQL predicates, queries
│   │   └── seed.ts           # test data
│   ├── jobs/
│   │   └── sync-clickhouse.ts# ClickHouse → users.* cache, rank snapshots (every 5 min)
│   ├── lib/
│   │   ├── session.ts        # cookie sessions, device tokens (issue/verify/revoke)
│   │   ├── auth-middleware.ts# optionalAuth, requireAuth, requireBearerAuth
│   │   ├── rate-limit.ts     # 60 req/min per user-or-IP on /api/*
│   │   ├── pricing.ts        # the only price table
│   │   ├── session-import.ts # JSONL → OTLP-equivalent rows (CLI + backfill share it)
│   │   ├── fingerprint.ts    # the profile's typed payload
│   │   ├── boards.ts         # the four homepage boards
│   │   ├── rank-snapshots.ts # daily rank history
│   │   ├── plan-usage.ts     # rate-limit window parsing + dedup
│   │   ├── profile-settings.ts # per-section visibility
│   │   ├── timezone.ts       # IANA validation, week bounds
│   │   ├── format.ts         # number/cost formatting
│   │   └── ttl-cache.ts      # 60 s caches that never hold a failure
│   ├── routes/               # otel, cli, api, boards, auth, install, index, profile, about
│   ├── components/           # Layout, home/*, profile/*, charts
│   ├── client/               # one file per browser island
│   ├── styles/app.css        # Tailwind entry
│   └── scripts/              # operator tools (backfill-jsonl.ts, …)
├── cli/                      # the clawdgg CLI (standalone binary)
│   ├── index.ts              # commands
│   ├── settings.ts           # safe ~/.claude/settings.json edits
│   ├── statusline.ts         # statusLine hook
│   ├── prompt-hook.ts        # UserPromptSubmit hook
│   ├── otel-headers.ts       # otelHeadersHelper
│   ├── paths.ts              # file locations, API origin pinning
│   └── checksums/            # per-release SHA-256 lists, served by /install/checksums
├── bot/                      # X bot (changelog + Reddit), separate codebase
├── scripts/
│   ├── build-assets.ts       # CSS + islands → public/build
│   ├── build-cli.ts          # CLI binaries + checksums
│   ├── install.sh            # served at /install
│   └── deploy.sh
├── docker/clickhouse/        # init DDL, migrations, prod runbook (README-2026-10.md)
├── drizzle/                  # generated SQLite migrations
├── public/build/             # build output (content-hashed)
├── data/                     # SQLite file (not committed)
└── docs/
```

## Database schema (SQLite)

Authoritative: `src/db/schema.ts`. Summary of what is live:

- `users`: id `github_<id>`, GitHub identity, `timezone`, `otel_enabled`,
  `otel_setup_at` / `otel_setup_date`, cached `total_*` (prompts, tokens,
  input/output/cache tokens, cost in cents, lines, commits, PRs, active
  seconds), `badges`, `hour_counts`, streaks, `token_gen`.
- `device_tokens`: `id` (32 hex, public half of the bearer), `user_id`,
  `device_name`, `secret_hash`, `created_at`, `last_used_at` (written at most
  every 5 minutes), `revoked_at`.
- `device_auths`: in-flight device-flow codes.
- `plan_usage_snapshots`: `(user_id, window_type, used_percentage, resets_at, captured_at)`.
- `rank_snapshots`: unique on `(user_id, day, metric)`; `metric` is a
  leaderboard sort (`prompts | tokens | lines | commits | cost`) or
  `board:<board>:<week|all>`.
- `profile_settings`: one boolean column per section.
- Retired, unused: `daily_stats`, `users.legacy_total_*`, `users.token_expires_at`,
  `users.archetype*`.

ClickHouse DDL: `docker/clickhouse/init/01_schema.sql`; changes ship as
migrations in `docker/clickhouse/migrations/` (October 2026 runbook:
`README-2026-10.md`).

## Auth

### Browser: GitHub OAuth

```
GET /auth/github           state token → cookie, redirect to GitHub
GET /auth/callback         verify state, exchange code, upsert user,
                           set signed `session` cookie (30 days), redirect /
```

Cookie: HMAC-SHA256 signed, constant-time compare, HttpOnly, SameSite=Lax,
`Secure` iff `APP_URL` starts with `https://`. No server-side session store, so
a cookie session cannot be revoked server-side.

### CLI: device flow, per-device tokens

```
clawdgg login
  POST /auth/device          → deviceCode, userCode, verificationUrl (15 min)
  user opens /auth/device/verify, enters userCode → GitHub OAuth
  /auth/callback sees the `device_code` cookie, mints a device token
  POST /auth/device/poll     → 428 pending … 200 { token, userId, username }
  PATCH /api/cli/devices/:id → CLI names the device after its hostname
```

A token is `cgt_<id>.<secret>`; only `sha256(secret)` is stored. Tokens have no
expiry (the OTel SDK has no refresh hook) and are revoked individually
(`clawdgg devices revoke <id>`, `clawdgg logout` for this machine) or all at
once (`--all`, which also bumps `users.token_gen`). A pre-2.0 token
(`sign({userId, gen})` checked against `token_gen`) is still accepted; `doctor`
tells its holder to log in again.

### Which auth where

| Surface | Accepts |
|---------|---------|
| `/otel/*` | bearer only |
| `/api/cli/*` | bearer only. A cookie is refused on purpose: these are called by a local binary, so accepting the cookie would make "revoke my devices" a CSRF target |
| `/api/*` with `requireAuth` | cookie session or bearer |
| `/api/*` public / `optionalAuth` | anyone |

## Rate limiting

- `/api/*` (including `/api/cli/*` and `/api/boards`): 60 requests per minute,
  per user (or per IP when anonymous), in memory. `429` with `Retry-After`.
- `POST /api/cli/import`: an additional 300 requests per 10 minutes per user.
- `POST /api/cli/ultrathink`: an additional 60 per minute per user.
- `/otel/*` and `/install/*` are deliberately outside it: Claude Code paces its
  own exporter, and `curl | sh` must not be able to exhaust anyone's budget.

## Caching

- `GET /public/build/*`: immutable, content-hashed.
- `GET /install`: `max-age=60`. `GET /install/checksums/:version`: immutable.
- Profile payload and fingerprint: 60 s `TtlCache`, keyed per owner/public view.
  A failed or incomplete build is never cached.
- `users.total_*`: refreshed every 5 minutes by the sync job.

## Component architecture

```
Layout.tsx                       one shell: head, assets, optional nav/effects
├── home/HomePage.tsx            board tabs, podium, rows (BoardRows), pulse strip
└── profile/ProfilePage.tsx      Fingerprint, Activity, Year, Milestones, Owner panels
```

Profile sections (`value`, `anatomy`, `conversation`, `rings`, `class`,
`milestones`, `curve`, `year`, `ultrathink`, `plan`) can each be hidden by the
owner. A hidden section is *omitted* from the payload for everyone else, never
zeroed, and the user is left off the board that ranks on it.

## Deploy

See `CLAUDE.md` (`Deploy`) and `scripts/deploy.sh`. The image builds the CSS and
islands (`bun run build`), and copies `cli/` and `scripts/` in because
`/install` and `/install/checksums/*` read them from disk.
