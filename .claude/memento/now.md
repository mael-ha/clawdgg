# Now

## Status: 🟢 Deployed | X Bot Ready for Testing

**Live at:** http://46.224.85.32:3000
**Blockers:** X Developer account credentials
**Focus:** Get X credentials, test bot live, then Reddit integration

## Last Session (2025-12-23)

**What happened:**
1. Redesigned tweet thread structure (summary hook + all items)
2. Implemented X Premium support (no splits, 4000 char limit)
3. Added "changelog pending" flow for when GitHub lags
4. Added 48h timeout for missing changelogs
5. Tested full orchestration flow with AI validation
6. Fixed model IDs (using Opus 4.5 + Haiku 4.5)

**Thread structure finalized:**
```
Tweet 1: Summary Hook
  "Claude Code 2.0.74
   ✨ 5 new (LSP, terminal setup, shortcuts)
   🐛 6 fixed (allowed-tools, Opus tip)
   🤖 Prompt: +47/-12 lines
   Details ↓"

Tweet 2: What's New (ALL items)
Tweet 3: Fixes (ALL items)
Tweet 4: Prompt Changes (w/ cchistory)
Tweet 5: Links (changelog, gist, clawd.gg)
```

**Orchestration flow:**
- Brew detects version → Wait 15min for GitHub
- If GitHub ready: Post full thread
- If timeout: Post "Changelog incoming..." summary
- When GitHub arrives later: Post "Update" + details
- After 48h with no GitHub: Close thread, move on

**Key decisions:**
- X Premium recommended (~$8/mo) for no splits, better UX
- Opus 4.5 for all writing, Haiku 4.5 for classification only
- ~$4-5/month API costs at 7 releases/week

## Current State

| Component | Status |
|-----------|--------|
| Web App | ✅ Running (healthy) |
| CLI | ✅ Working |
| Bot | ✅ Ready (needs X creds) |
| ClickHouse | ✅ Running (healthy) |
| Dashboard V2 | ✅ Complete |
| Domain | ❌ Not purchased |
| HTTPS | ❌ Blocked on domain |

## Bot Status

| Feature | Status |
|---------|--------|
| Summary Hook | ✅ Ready |
| What's New | ✅ Ready (with split support) |
| Fixes | ✅ Ready (with split support) |
| Prompt Changes | ✅ Ready (w/ cchistory) |
| Pending flow | ✅ Ready |
| Update flow | ✅ Ready |
| 48h timeout | ✅ Ready |
| X Premium mode | ✅ Ready |
| Twitter client | ✅ Ready (needs creds) |
| Weekly summary | ✅ Ready |
| Reddit integration | 🟡 Schema only |

## Next Priority

1. **X Developer Account** — Get API credentials
2. **Test bot live** — `bun bot` with real credentials
3. **X Premium** — Subscribe for better UX (~$8/mo)
4. **Domain** — Purchase clawd.gg, configure DNS
5. **Reddit integration** — Wire up watcher + poster

## Quick Commands

```bash
# Web app
bun dev                    # Local dev
ssh clawdgg 'docker ps'    # Check containers

# Bot
bun bot                    # Run once
bun bot:daemon             # Continuous
DRY_RUN=true bun bot       # Test without posting

# Deploy web
rsync -avz src/ clawdgg:/opt/clawdgg/src/ && ssh clawdgg 'cd /opt/clawdgg && docker compose -f docker-compose.staging.yml up -d --force-recreate app'

# Init bot db
bun bot/src/db/init.ts
```

## Environment Variables Needed

```bash
# .env additions for bot
TWITTER_API_KEY=
TWITTER_API_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_ACCESS_SECRET=
X_PREMIUM=true  # Optional, enables long tweets
```
