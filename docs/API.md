# API Reference

Base URL: `http://localhost:3000` (dev) or `https://clawd.gg` (prod)

Derived from `src/routes/*.ts` and `src/index.ts`. Every number returned comes
from ClickHouse (directly, or via the `users.total_*` cache that the sync job
refreshes every 5 minutes). There is no other source.

## Auth

| Label | Accepts | Failure |
|-------|---------|---------|
| **public** | anyone | |
| **optional** | cookie session or bearer; anonymous allowed | |
| **auth** | cookie session **or** `Authorization: Bearer <token>` | `401 {"error":"Unauthorized"}` |
| **bearer** | `Authorization: Bearer <token>` only. A cookie is refused | `401 {"error":"Unauthorized","message":"This endpoint requires a clawdgg bearer token. Run \`clawdgg login\`."}` |
| **otel-bearer** | bearer, verified against `device_tokens` | `401` |
| **admin** | `Authorization: Bearer $ADMIN_TOKEN` | `403` when `ADMIN_TOKEN` is unset, `401` on mismatch |

Bearer tokens are `cgt_<32 hex>.<64 hex>`, one per `clawdgg login` (per machine,
individually revocable, no expiry). A pre-2.0 signed token is still accepted
until its holder logs in again.

## Rate limiting

All `/api/*` routes (including `/api/cli/*` and `/api/boards`): **60 requests
per minute**, per user (or per client IP when anonymous).

`/u/*` — the profile page, `/u/:username/curve` and the share card — has its own,
looser budget: **240 requests per minute**, same key, counted separately so one
surface cannot spend the other's. `/otel/*`, `/auth/*`, `/install/*` and the
remaining pages are not covered.

The client IP is the LAST `X-Forwarded-For` entry, which is the hop Caddy wrote.
The first entry is whatever the client claimed, and keying on it meant no limit
at all.

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 57
X-RateLimit-Reset: 1702432000     (epoch seconds)

HTTP 429  Retry-After: 45
{ "error": "Too many requests", "message": "Rate limit exceeded. Please try again in 45 seconds.", "retryAfter": 45 }
```

Extra per-user budgets: `POST /api/cli/import` 300 per 10 minutes,
`POST /api/cli/ultrathink` 60 per minute (both `429` with `Retry-After`).

## Index

| Method | Path | Auth |
|--------|------|------|
| GET | `/health` | public |
| GET | `/install` | public |
| GET | `/install/checksums/:version` | public |
| POST | `/otel/v1/metrics` | otel-bearer |
| POST | `/otel/v1/logs` | otel-bearer |
| GET | `/otel/health` | public |
| GET | `/auth/github` | public |
| GET | `/auth/callback` | public |
| POST, GET | `/auth/logout` | public |
| POST | `/auth/device` | public |
| GET, POST | `/auth/device/verify` | public |
| POST | `/auth/device/poll` | public |
| GET | `/api/boards` | optional |
| GET | `/api/boards/pulse` | public |
| GET | `/api/boards/list` | public |
| GET | `/api/leaderboard` | none. **410 Gone**, retired |
| GET | `/api/u/:username/fingerprint` | optional |
| GET | `/api/me` | auth |
| GET | `/api/me/today` | auth |
| GET | `/api/me/insights` | auth |
| GET | `/api/me/heatmap` | auth |
| GET | `/api/me/chart` | auth |
| GET, PUT | `/api/me/profile-settings` | auth |
| GET, PUT | `/api/me/timezone` | auth |
| POST | `/api/otel/enable` | auth |
| POST | `/api/otel/disable` | auth |
| POST | `/api/plan-usage` | auth |
| GET | `/api/cli/health` | bearer |
| GET | `/api/cli/devices` | bearer |
| POST | `/api/cli/devices/revoke` | bearer |
| PATCH | `/api/cli/devices/:id` | bearer |
| POST | `/api/cli/logout` | bearer |
| POST | `/api/cli/import` | bearer |
| POST | `/api/cli/ultrathink` | bearer |
| POST | `/api/admin/sync` | admin |
| POST | `/api/stats` | none. **410 Gone**, retired |

Pages (HTML, not API): `/`, `/u/:username`, `/about`, and `GET /rows`, the
fragment the homepage's load-more island appends (`?board=&scope=&offset=`).

Under `/u/:username` and not in the table above, because they serve a page's
data and a page's image rather than the API: `GET /u/:username/curve`
(`?metric=prompts|value|toolCalls|lines|ultrathinks&period=30d|90d|1y|all&groupBy=day|week|month`,
public, `404 {"error":"Not public"}` when the owner has hidden ⚡ activity **or
the section the metric plots** — `value`→💎, `lines`→anatomy,
`ultrathinks`→🌈 — and `503` when ClickHouse is unreachable, cached 60 s per
(user, metric, period, groupBy, hidden)) and `GET /u/:username/card.svg` /
`card.png` (the 1200×630 link-preview card, always the public payload).

---

## Health

```
GET /health

{
  "status": "ok" | "degraded" | "starting",
  "services": { "api": "ok", "clickhouse": "ok" | "unavailable" },
  "timestamp": "2026-10-18T14:00:00.000Z"
}
```

`degraded` means the app is up and ClickHouse is not.

## Install

```
GET /install
  text/plain installer script (scripts/install.sh). Cache-Control: public, max-age=60.
  Used as:  curl -fsSL https://clawd.gg/install | sh

GET /install/checksums/:version        (":version.txt" also accepted)
  text/plain, sha256sum format, one file per CLI release (cli/checksums/<version>.txt).
  Cache-Control: public, max-age=86400, immutable.
  404 for a malformed version or a release whose checksums are not committed.
  install.sh refuses to install on a 404.
```

The binary comes from GitHub Releases; the expected hash comes from here.

## OTLP receiver

Claude Code's OpenTelemetry exporter, `http/json` only. Configured for you by
`clawdgg setup`; the `Authorization` header is supplied by `otelHeadersHelper`.

```
POST /otel/v1/metrics      Content-Type: application/json   (body <= 1 MB)
POST /otel/v1/logs         Content-Type: application/json   (body <= 5 MB)
Authorization: Bearer cgt_…
Content-Encoding: gzip | identity (optional)
```

Both limits apply to the wire body and to the decompressed body.

| Status | When |
|--------|------|
| `200 {"partialSuccess":{}}` | everything stored |
| `200 {"partialSuccess":{"rejectedDataPoints":N,…}}` (logs: `rejectedLogRecords`) | some records unreadable; the rest stored |
| `400` | malformed JSON/gzip, wrong shape, or a batch with nothing readable |
| `401` | missing, malformed, revoked or unknown token; unknown user |
| `413` | body too large (compressed or decompressed) |
| `415` | not JSON, or an encoding other than gzip/identity |
| `500` | server error (retryable by the exporter; a bad payload is never a 500) |

```
GET /otel/health   → { "status": "ok" }
```

Stored rows get `provenance = "live"`. Absolute paths in error messages are
replaced by `<path>` before storage.

---

## Auth endpoints

### GitHub OAuth (browser)

```
GET /auth/github      Redirects to GitHub; CSRF state in a 10-minute cookie.
GET /auth/callback    ?code=&state=  Upserts the user. If a `device_code` cookie is
                      present, completes the CLI device flow; otherwise sets the
                      `session` cookie (30 days) and redirects to /.
POST /auth/logout     Clears the session cookie → { "success": true }
GET  /auth/logout     Clears the session cookie, redirects to /
```

### Device flow (CLI login)

```
POST /auth/device
→ {
    "deviceCode": "<64 hex>",
    "userCode": "ABCD-1234",
    "verificationUrl": "https://clawd.gg/auth/device/verify",
    "expiresIn": 900
  }

GET  /auth/device/verify[?code=&error=&success=true]   HTML page
POST /auth/device/verify   (form: code=ABCD-1234)
     valid → sets a `device_code` cookie, redirects to /auth/github
     invalid/expired → redirects back with ?error=

POST /auth/device/poll     { "deviceCode": "…" }
→ 200 { "token": "cgt_…", "userId": "github_123456", "username": "octocat" }   (once; row deleted)
→ 428 { "error": "Authorization pending" }
→ 410 { "error": "Device code expired" }
→ 404 { "error": "Invalid device code" }
→ 400 { "error": "Device code required" }
```

Every successful login mints a *new* per-device token and leaves other
machines' tokens alone.

---

## Boards (homepage)

Five boards, ranked per UTC week (Monday 00:00 UTC) or all time. The homepage
renders from the same function, so page and API cannot disagree. A user who hid
the profile section behind a board is left off that board.

Each board carries its OWN pair of scopes and its own default, which is not
always the first of the pair: 🪙 tokens offers week | all and opens on **all**,
because a lifetime token count is the figure the board exists for. `meta.scopes`
and `meta.defaultScope` report both, so a client never has to guess.

`offset` and `limit` are CLAMPED rather than refused, and the response reports
the values it was served with: an offset past the end of the board comes back
as `offset: total` with no rows. The ranking is cached per (board, scope) for
60 s and a page is a slice of it, so pagination does not re-rank.

```
GET /api/boards?board=value&scope=week&limit=25&offset=0

  board   tokens | value | streak | ultrathinks | leverage  (default tokens; unknown → tokens)
  scope   week | all, or current | best on `streak`        (default: that board's `defaultScope`;
                                                            a scope the board does not offer → it too)
  limit   1..100                                         (default 25; clamped, not refused)
  offset  >= 0                                           (default 0; clamped to `total`)

200 (503 with the same body if any underlying query failed)
{
  "board": "value", "scope": "week",
  "meta": {
    "emoji": "💎", "label": "value", "caption": "API-equivalent of the work Claude did",
    "scopes": ["week", "all"], "defaultScope": "week"
  },
  "total": 214, "offset": 0, "limit": 25,
  "weekStart": "2026-10-12T00:00:00.000Z",
  "resetIn": "3d 4h",           // countdown string to the next Monday 00:00 UTC
  "rows": [
    {
      "rank": 1, "userId": "github_1", "username": "octocat", "avatarUrl": "https://…",
      "value": 1234.5, "display": "$1.2K",
      "change": 2,                 // positions gained since last snapshot; ABSENT = new to the board
      "hours": [0,0,…],            // 24 local-hour prompt counts; absent when hidden
      "classLabel": "…", "ultrathinks": 3, "streak": 12,
      "isViewer": false
    }
  ]
}

GET /api/boards/pulse
→ { "devs": 120, "valueUsd": 48210.5, "ultrathinks": 311, "busiestHourUtc": 15, "complete": true }
  503 if incomplete.

GET /api/boards/list
→ { "boards": [ { "key": "tokens", "emoji": "🪙", "label": "tokens", "caption": "tokens Claude processed",
                  "scopes": ["week", "all"], "defaultScope": "all" }, … ] }
```

## Leaderboard

```
GET /api/leaderboard
410 {
  "error": "Endpoint retired",
  "message": "GET /api/leaderboard is gone — it published figures profile owners had hidden. Use GET /api/boards …",
  "use": "/api/boards"
}
```

**Retired.** It ranked every user by cost, lines and prompts without reading
`profile_settings`, so a user who had hidden 💎 value on their profile was still
listed here, by name, with their dollars. `GET /api/boards` ranks the same
figures, leaves a user off the board whose section they took down, and is what
the homepage and its load-more fragment already read — see
[Boards](#boards-homepage) above.

Gone with it: `period`, `sort`, `page`, `limit`, `rankChange`, the
`promptCount`/`tokenCount`/`linesWritten`/`commitCount`/`costUsdCents` entry
shape, and the HTMX HTML partial that preceded them.

## Profile

### Fingerprint

```
GET /api/u/:username/fingerprint        optional auth

200 {
  "username": "octocat",
  "timezone": "Europe/Paris",         // the IANA zone every hour/weekday/week was read in
  "generatedAt": "…",
  "sections": ["value","anatomy","conversation","rings","class","milestones","ultrathink", …],
  "hidden": [],                        // sections the owner hid — omitted from this payload
  "value": {…}, "anatomy": {…}, "conversation": {…}, "rings": {…},
  "class": {…}, "milestones": […], "ultrathink": {…},
  "hiddenFromOthers": []               // owner only: what visitors don't get
}
404 { "error": "No such user" }
503 { "error": "Failed to build fingerprint" }     // ClickHouse unreachable; never cached
```

A hidden section is *omitted* for everyone except the owner, never zeroed. The
owner always sees everything. Cached 60 s per (user, owner|public).

### Profile settings (owner)

```
GET /api/me/profile-settings           auth
→ { "sections": { "value": true, "anatomy": true, "conversation": true, "rings": true,
                  "class": true, "milestones": true, "curve": true, "year": true,
                  "ultrathink": true, "plan": true } }

PUT /api/me/profile-settings           auth
{ "ultrathink": false }                // any subset; true = shown, false = hidden
→ { "success": true, "sections": {…full map…} }
400 { "error": "Unknown section 'x'. Known: …" | "Section 'x' must be true or false"
                | "Nothing to change" | "Expected an object of section → boolean" | "Invalid JSON body" }
```

No username in the path: you can only read or write your own. Sections default to
visible.

A change takes effect at once everywhere. The hidden list is part of the cache
key of every cache built on it — the fingerprint payload, the profile page, each
curve view and the share card — and the PUT also evicts this user's entries in
all four, so the keys the previous list made are not left to sit out their TTL.
`/u/:username/card.svg` and `card.png` are served `Cache-Control: public,
max-age=60`: that is the one cache on the far side of this app, and it used to
say `stale-while-revalidate=86400`.

### Timezone

```
GET /api/me/timezone                   auth   → { "timezone": "Europe/Paris" }   ("UTC" if never set)
PUT /api/me/timezone                   auth   { "timezone": "Europe/Paris" }
→ { "success": true, "timezone": "Europe/Paris" }
400 { "error": "Not an IANA timezone name", "example": "Europe/Paris" }
```

`clawdgg setup` posts the zone the machine resolves; the site can change it.
Every hour-of-day, weekday and week-boundary figure is read in this zone.

## Me (dashboard)

All `auth`. Figures come from ClickHouse.

```
GET /api/me
→ { username, avatarUrl, rank, totalUsers, percentile, archetype, archetypeDescription,
    totalPrompts, totalTokens, totalCostCents,
    totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens,
    totalLines, totalCommits, outputLeverage, cacheEfficiency,
    currentStreak, longestStreak, badges }
  Rank is by total prompts.

GET /api/me/today        (400 {"error":"OTEL not enabled"} unless streaming is on)
→ today's prompts, tokens (input/output/cacheRead/cacheWrite), costUsd, costFormatted,
  linesAdded/Removed, commits, activeSeconds, activeMinutes, lastActivity

GET /api/me/insights     (400 unless OTEL enabled)
→ modelDiet, cacheStats, toolBreakdown (top 10), sessionStats, roi, averageDaily,
  velocityTrend, activeTime,
  dataSources: [ { provenance, prompts, tokens, costCents, firstDay, lastDay } ]
  // dataSources is every provenance there is, so the parts add up to the whole.

GET /api/me/heatmap?days=90   (400 unless OTEL enabled)
→ { matrix[7][24], maxActivity, peak: {day,hour,formatted}, days, raw }
  Hour-by-weekday in the user's timezone; Monday = row 0.

GET /api/me/chart?metric=tokens&period=30d&groupBy=day
  metric   tokens | cost | prompts | lines | commits   (default tokens)
  period   1d | 7d | 30d | 90d | all                    (default 30d)
  groupBy  day | week | month                           (default day; ignored for 1d, which is hourly)
  Invalid values fall back to the defaults.
  period=1d without OTEL → 200 { "noData": true, "reason": "otel_required", "fallbackPeriod": "7d", … }
  (imported history has no time of day, so an hourly chart would be a single noon spike).
```

## OTEL status

```
POST /api/otel/enable      auth
→ { "success": true, "otelEnabled": true, "alreadyEnabled": false, "otelSetupDate": "2026-10-18" }
Idempotent: a second call changes nothing and returns the original date with "alreadyEnabled": true.
`otel_setup_at` is what the history import uses as its cutoff, so it never moves.

POST /api/otel/disable     auth   → { "success": true, "otelEnabled": false }
```

## Plan usage

```
POST /api/plan-usage       auth
{
  "rate_limits": {
    "five_hour":   { "used_percentage": 42.5, "resets_at": 1790000000 },
    "seven_day":   { … },
    "spend_limit": { … }
  },
  "capturedAt": 1789999000          // epoch seconds, optional; ignored if in the future
}
→ { "success": true, "inserted": 1, "skipped": 2, "rejected": [] }
400 { "error": "Invalid JSON" }
```

Sent by `clawdgg statusline`. Forgiving on purpose: no usable window is a 200
no-op. A window is written only when it moved since the last stored snapshot.
`rejected` lists known windows that were present but unusable.

---

## CLI endpoints (`/api/cli/*`)

All **bearer-only**. A cookie session is rejected.

### Health

```
GET /api/cli/health
→ {
    "username": "octocat",
    "otelEnabled": true,
    "otelSetupAt": "2026-05-06T…Z" | null,
    "lastLiveEventAt": "2026-10-18T…Z" | null,    // newest provenance='live' event
    "lastEventAt": "…" | null,                     // newest event of any provenance
    "clickhouse": "ok" | "unavailable",
    "tokenKind": "device" | "legacy",
    "deviceId": "<32 hex>" | null
  }
```

What `clawdgg doctor` reads to tell "configured" from "actually arriving".

### Devices

```
GET   /api/cli/devices
→ { "devices": [ { "id", "name", "createdAt", "lastUsedAt", "revokedAt" } ],   // live first
    "currentDeviceId": "<id>" | null }

POST  /api/cli/devices/revoke      { "id": "<32 hex>" }   or   { "all": true }
→ { "success": true, "revoked": 1, "wasCurrentDevice": false }
→ { "success": true, "revoked": N, "all": true }          // also bumps users.token_gen (kills legacy tokens)
400 "Pass a device id, or { \"all\": true }" · 404 "No such live device"

PATCH /api/cli/devices/:id         { "name": "work-laptop" }      (id = 32 hex)
→ { "success": true }          400 invalid id · 404 "No such device"
```

Names are control-character-stripped and capped at 64 chars.

### Logout

```
POST /api/cli/logout
→ { "success": true, "revokedAllDevices": false, "revoked": 1 }
```

Revokes only the device making the call. A legacy token has no row to revoke, so
for it the only lever is the per-user bump: the response is
`{ "success": true, "revokedAllDevices": true, "revoked": N, "tokenKind": "legacy" }`.

### Import

```
POST /api/cli/import        (body <= 8 MB; <= 20,000 rows per request)
{
  "runId": "<id>",                  // optional; stable across the batches of one run
  "events": [ { "timestamp": "2026-03-01 12:00:00.000", "session_id": "…",
                "event_name": "claude_code.user_prompt" | "claude_code.api_request"
                            | "claude_code.tool_result" | "clawdgg.ultrathink", … } ],
  "metrics": [ … ]                   // accepted and discarded; the server derives its own
}

200
{
  "accepted": N, "inserted": N, "rejected": N,
  "skippedAfterCutoff": N, "skippedBeforeEpoch": N, "skippedBuiltinCommand": N,
  "skippedCoveredDay": N, "skippedDuplicate": N, "clamped": N, "ignoredClientMetrics": N,
  "cutoff": "2026-05-06T…Z",
  "skippedDays": ["2026-05-07", …]
}
413 { "error": "Request body too large", "maxBytes": 8388608 } · { "error": "Too many rows in one batch", "maxRows": 20000 }
429 { "error": "Too many import requests", "retryAfter": N }
400 invalid JSON · 500 { "error": "Import failed" }
```

The client's claims are not trusted:

1. `user_id` comes from the token.
2. `provenance` is always `import`.
3. `cost_usd` is **recomputed** from model + tokens with the shared price table
   (including the 5m/1h cache-write split).
4. Metric rows are derived from the sanitized events.
5. Token counts are clamped per request; timestamps before 2025-02-01 are refused.
6. Cutoff = `min(users.otel_setup_at, first live event)`. Rows at or after it are refused.
7. A UTC day that already holds rows of *any* provenance is skipped whole, so a
   re-import inserts nothing. Ultrathink flags have their own coverage check.

### Ultrathink

```
POST /api/cli/ultrathink      (body <= 2 KB)
{ "session_id": "…", "timestamp": "2026-10-18T14:00:00.000Z", "ultrathink": true }
→ { "success": true }
400 { "error": "Expected { ultrathink: true }" | "Invalid timestamp" | "Timestamp predates Claude Code"
              | "Timestamp is in the future" | "Invalid JSON body" }
413 body too large · 429 { "error": "Too many reports", "retryAfter": N } · 500 { "error": "Could not record it" }
```

Called by the `UserPromptSubmit` hook. There is no field for the prompt, its
length or a hash: the word is matched locally and only the yes/no travels. Stored
as event `clawdgg.ultrathink`, provenance `hook`. Idempotent: the row identity is
timestamp + session + event, so a retry collapses.

---

## Retired

```
POST /api/stats
410 {
  "error": "Endpoint retired",
  "message": "clawd.gg no longer accepts uploaded daily summaries. Reinstall the CLI (`curl -fsSL https://clawd.gg/install | sh`), then `clawdgg setup` …",
  "install": "curl -fsSL https://clawd.gg/install | sh",
  "upgrade": "https://clawd.gg/install"
}

GET /api/leaderboard
410 { "error": "Endpoint retired", "use": "/api/boards" }
```

The pre-OTEL daily-summary upload (`clawdgg sync`) is gone; nothing reads
`daily_stats` any more. 410 rather than 404 so an old CLI stops retrying and
the response says what to do.

The leaderboard is gone because it did not read `profile_settings`: it answered
with figures their owners had hidden. `/api/boards` is the replacement and
always was the one the site uses. Also gone with it: the HTMX HTML partials and
`sort=messages|sessions|tools`.

## Admin

```
POST /api/admin/sync        Authorization: Bearer $ADMIN_TOKEN
→ { "success": true, "synced": N, "errors": N }     500 { "error": "Sync failed", "details": "…" }
```

Runs the ClickHouse → SQLite cache job now. `403` when `ADMIN_TOKEN` is unset.

## Errors

```json
// 400 Bad Request
{ "error": "Invalid JSON body" }
// 401 Unauthorized
{ "error": "Unauthorized" }
// 404 Not Found (unknown route)
{ "error": "Not Found" }
// 429 Too Many Requests
{ "error": "Too many requests", "retryAfter": 45 }
// 500 Internal Server Error
{ "error": "Internal Server Error" }
```

Individual endpoints add their own messages (listed above). CORS: origin is
`APP_URL`, credentials allowed.
