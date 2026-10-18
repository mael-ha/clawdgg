# Roadmap

> **Status note (2026-10-18).** Most of this file is a snapshot from the
> December 2025 MVP and is kept as a log. What it describes as *current* is not:
> the `sync` command, the `POST /api/stats` upload, `stats-cache.json` parsing,
> the HTMX leaderboard and the 30-day stateless CLI token have all been replaced.
> Usage now streams in over OpenTelemetry into ClickHouse, the CLI is a
> standalone binary with per-device tokens, and profiles, badges, boards and
> rank movement have shipped. For how it works today read
> [ARCHITECTURE.md](./ARCHITECTURE.md), [DATA_PIPELINE.md](./DATA_PIPELINE.md)
> and [API.md](./API.md). Sections marked *(historical)* below are superseded.

## MVP (v0.1) ✓ *(historical)*

- [x] Database schema (users, daily_stats)
- [x] GitHub OAuth authentication
- [x] Stats submission API (`POST /api/stats`, now 410 Gone)
- [x] Leaderboard API (period filters, sorting; sort is now prompts/tokens/lines/commits/cost)
- [x] Web UI (cyberpunk theme, HTMX - since replaced by server-rendered JSX + compiled Tailwind + islands)
- [x] CLI tool (sync, login, status - `sync` is gone; see the CLI README)
- [x] Rate limiting
- [x] Device flow auth for CLI
- [x] Delta sync (CLI only uploads new days)
- [x] Real leaderboard data (no more mock data)

## v0.2 - Polish ✓ *(historical)*

### Completed
- [x] Set proper file permissions on CLI config (chmod 600)
- [x] Add JSON validation for stats file parsing
- [x] Add bearer token expiry (30 days) - replaced by long-lived per-device tokens, individually revocable
- [x] Move device auth store to SQLite
- [x] User profile pages (`/u/:username`) with creative design
  - [x] GitHub-style contribution graph
  - [x] Giant "TOP X%" percentile hero
  - [x] Share button (copy tweet to clipboard)
- [x] Badge system (12 badges implemented)
- [x] CLI celebration moments (new badge, #1, streak record)
- [x] Leaderboard "You are here" pill + row highlighting
- [x] CLI commands: `gg`, `logout`, `--version`
- [x] Token count display (replaced Sessions with Tokens)
  - [x] Added tokenCount to database schema
  - [x] CLI parses dailyModelTokens from stats-cache.json
  - [x] Leaderboard shows Messages | Tools | Tokens
  - [x] Profile shows token stats
  - [x] Formatted as K/M/B with ⚡ icon

### Was still needed (now done)
- [x] Production deployment setup (VPS)
- [x] CLI ships as a standalone binary: `curl -fsSL https://clawd.gg/install | sh`
- [x] Domain purchase (clawd.gg)

### Future Polish
- [ ] Twitter/X authentication
  - [ ] Link X account alongside GitHub
  - [ ] Show X avatar/handle on leaderboard
- [ ] OG meta tags for profile social previews
- [x] Rank change indicators (daily `rank_snapshots`)
- [ ] Use system keychain for CLI token storage (today: `~/.config/clawdgg/config.json`, mode 0600)

## Future: v0.3 - Gamification (Partially Complete)

### Done
- [x] Achievement badges (12 implemented):
  - Night Owl, Early Bird, On Fire, Streak 7/30
  - Messages 1k/5k/10k, Tools 1k/5k, Marathon, OG
- [x] Activity streaks (current + longest)
- [x] Streak celebration in CLI

### Future
- [ ] Rank titles (Bronze → Diamond)
- [ ] Weekly challenges
- [ ] "Beat X to reach #Y" gamification

## Future: v0.4 - Community

- [ ] Team/org leaderboards
- [ ] Following users
- [ ] Activity feed
- [ ] Comments/reactions

## Future: v1.0 - MCP Integration

- [ ] MCP server for Claude Code
- [x] Real-time stats updates (OTEL streaming)
- [x] Claude Code hook integration (statusLine, UserPromptSubmit)

## Infrastructure

### Deployment
- [ ] VPS setup (DigitalOcean/Hetzner)
- [ ] Domain configuration (clawd.gg)
- [ ] SSL certificate (Let's Encrypt)
- [ ] Nginx reverse proxy
- [ ] Systemd service
- [ ] SQLite backup to S3

### Monitoring
- [ ] Error tracking (Sentry)
- [ ] Uptime monitoring
- [ ] Analytics (privacy-respecting)

## Token Data Investigation (2025-12-13) *(historical, superseded)*

> We no longer read `stats-cache.json`. Usage comes from Claude Code's OTEL
> export (with `cost.usage`, which this section says does not exist) and, for
> history, from the JSONL transcripts. See [DATA_PIPELINE.md](./DATA_PIPELINE.md).

### What We Discovered

Claude Code has TWO data sources:
1. **`~/.claude/stats-cache.json`** - Computed periodically (STALE!)
2. **`~/.claude/projects/<project>/*.jsonl`** - Real-time session data

### The Problem

`stats-cache.json` is NOT real-time:
- Example: Last computed at 01:06 AM
- By 4:16 PM, user had 1.3M MORE tokens not in cache
- Users may see outdated data until Claude Code refreshes the cache

### Token Types

| Type | Description | In dailyModelTokens? |
|------|-------------|---------------------|
| inputTokens | Your prompts | ✅ Yes |
| outputTokens | Claude's responses | ✅ Yes |
| cacheReadInputTokens | Reused context | ❌ No (aggregate only) |
| cacheCreationInputTokens | New context cached | ❌ No (aggregate only) |

**We show input+output (not cache)** because cache is repeated context, not new usage.

### Open Questions (Need Investigation)

- [ ] When exactly does stats-cache.json refresh? App start? Background timer?
- [ ] Compare yesterday's data: stats-cache vs raw .jsonl - are they consistent?
- [ ] Are agent-*.jsonl sessions included in stats?
- [ ] Are there gaps in data collection?
- [ ] Can we trigger a cache refresh from CLI?

### Current Decision

Using `stats-cache.json` because:
- Official format from Claude Code
- Simple to parse
- "Sync at end of day" UX is acceptable (like fitness apps)
- Parsing raw .jsonl is complex and format may change

### No Cost/Spend Data

There is NO `costUSD` field in any Claude Code data file. Cannot show money spent.

---

## Known Issues *(historical)*

From Opus code review (2025-12-13):

1. **Session Management**: No server-side session storage means can't revoke sessions
2. ~~**CLI Token Storage**: Stored in plaintext at `~/.clawdgg/config.json`~~ ✅ Fixed (chmod 600)
3. **Missing Validation**: GitHub API response and session data not schema-validated
4. ~~**Device Flow**: CLI references `/api/auth/device` endpoints that don't exist yet~~ ✅ Fixed
5. ~~**Token Expiry**: Bearer tokens never expire (permanent access if compromised)~~ ✅ Fixed (30-day expiry)
6. ~~**Device Auth Store**: In-memory Map lost on server restart (login fails mid-flow)~~ ✅ Fixed (SQLite)
7. ~~**CLI JSON Parsing**: No validation of stats file structure~~ ✅ Fixed (validateStats function)

## Security Considerations *(historical; MVP design)*

> Current scheme: per-device `cgt_<id>.<secret>` tokens (only `sha256(secret)` stored,
> no expiry, individually revocable), bearer-only `/api/cli/*`, origin-pinned CLI.
> See [ARCHITECTURE.md](./ARCHITECTURE.md#auth).

### Current Architecture (MVP)

**Token Format**: HMAC-SHA256 signed JSON payload
```
{ userId: "github_12345", iat: 1702425600 } + signature
```

**Why not JWT?** Similar security, simpler implementation. JWT would add built-in expiry but marginal benefit for MVP.

**Why custom device flow?** GitHub's built-in device flow gives us a GitHub token, which we'd need to exchange anyway. Our implementation is simpler and gives us direct control.

**Why not localhost callback?** Device flow works over SSH, avoids port conflicts and firewall issues. Same UX as GitHub CLI, Vercel CLI.

### Trade-offs Made

| Decision | Trade-off | Mitigation |
|----------|-----------|------------|
| Stateless tokens | Can't revoke | Add expiry (planned) |
| In-memory device store | Lost on restart | Move to SQLite (planned) |
| Plaintext CLI config | Readable by local processes | Use keychain (planned) |
| No refresh tokens | Must re-login on expiry | Implement refresh flow (planned) |

## Ideas Parking Lot

- Browser extension for auto-sync
- Discord bot integration
- Slack app
- GitHub Action for CI stats
- VS Code extension
- Terminal dashboard widget
