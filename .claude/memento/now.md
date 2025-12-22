# Now

## Status: 🟢 Deployed & Data Pipeline Working

**Live at:** http://46.224.85.32:3000
**Blockers:** Domain purchase for HTTPS

## Last Session (2025-12-22 evening)

**What happened:**
1. Fixed OAuth credential mismatch (VPS had dev credentials, needed prod)
2. Fixed Docker env reload (restart doesn't reload .env, need recreate)
3. Fixed leaderboard cost query bug (wasn't summing daily_stats.cost_usd_cents)
4. Tested full sync: 15K prompts, 10.7M tokens, $2,137 cost synced!

**Bugs found & fixed:**
- VPS container had cached old (dev) OAuth credentials → `docker compose down && up`
- Leaderboard returned `costUsdCents: 0` for legacy users → Fixed SQL query
- ClickHouse permissions issue on restart → `chmod 644` on config files

**Key insight:**
Docker `restart` doesn't reload `.env` files. Must use `down && up` or `--force-recreate`.

## Current State

| Component | Status |
|-----------|--------|
| App | Running (healthy) |
| ClickHouse | Running (healthy) |
| GitHub OAuth | ✅ Working (prod credentials) |
| V3 Pipeline | ✅ All 4 token types + cost |
| Login | ✅ Tested |
| Sync | ✅ Tested |
| Domain | Not purchased |
| HTTPS | Blocked on domain |

## Production OAuth Apps

| Environment | Client ID | Callback URL |
|-------------|-----------|--------------|
| **Dev** (localhost) | `Ov23liqR0vdnXRlmxNY2` | `http://localhost:3000/auth/callback` |
| **Prod** (VPS) | `Ov23liC2rBz1Fq3cUbJu` | `http://46.224.85.32:3000/auth/callback` |

## Next Priority

1. **Purchase clawd.gg domain** — Enables HTTPS
2. **DNS + Caddy** — Auto-SSL once domain points to VPS
3. **Update GitHub OAuth callback** — To `https://clawd.gg/auth/callback`

## Quick Commands

```bash
# Check app
ssh clawdgg 'docker ps'

# View logs
ssh clawdgg 'docker logs clawdgg-app-1 -f'

# Quick deploy (IMPORTANT: use --force-recreate for env changes!)
rsync -avz /Users/maelh/code/mael-ha/nomadz/clawdgg/src/ clawdgg:/opt/clawdgg/src/
ssh clawdgg 'cd /opt/clawdgg && docker compose -f docker-compose.staging.yml build app && docker compose -f docker-compose.staging.yml up -d --force-recreate app'

# Full restart (when env changes)
ssh clawdgg 'cd /opt/clawdgg && docker compose -f docker-compose.staging.yml down && docker compose -f docker-compose.staging.yml up -d'
```
