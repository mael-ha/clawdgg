# Now

## Status: 🟢 Deployed & Data Pipeline Working

**Live at:** http://46.224.85.32:3000
**Blockers:** Domain purchase for HTTPS

## Last Session (2025-12-22 evening, continued)

**What happened:**
1. Fixed OAuth credential mismatch (VPS container had cached dev credentials)
2. Fixed Docker env reload issue (restart ≠ recreate)
3. Fixed leaderboard cost query (wasn't summing daily_stats.cost_usd_cents)
4. Updated pricing from official Anthropic docs
5. Created claude-api-pricing.md reference with last-updated timestamp

**UX feedback to address:**
- User reaction to "10.9M tokens": "that's it??"
- Cache reads are 2.1B — much more impressive!
- Need to rethink token display on profile page
- Consider: "Tokens Exchanged: 10.9M" vs "Context Processed: 2.1B"

## Current State

| Component | Status |
|-----------|--------|
| App | Running (healthy) |
| ClickHouse | Running (healthy) |
| GitHub OAuth | ✅ Working (prod credentials) |
| V3 Pipeline | ✅ All 4 token types + cost |
| Login | ✅ Tested |
| Sync | ✅ Tested (15.6K prompts, $2,252) |
| Domain | Not purchased |
| HTTPS | Blocked on domain |

## Next Priority

1. **Profile UX** — Rethink token display (show context processed?)
2. **Purchase clawd.gg domain** — Enables HTTPS
3. **DNS + Caddy** — Auto-SSL once domain points to VPS

## OAuth Apps Reference

| Environment | Client ID | Callback URL |
|-------------|-----------|--------------|
| **Dev** (localhost) | `Ov23liqR0vdnXRlmxNY2` | `http://localhost:3000/auth/callback` |
| **Prod** (VPS) | `Ov23liC2rBz1Fq3cUbJu` | `http://46.224.85.32:3000/auth/callback` |

## Quick Commands

```bash
# Check app
ssh clawdgg 'docker ps'

# Deploy (IMPORTANT: --force-recreate for env changes!)
rsync -avz src/ clawdgg:/opt/clawdgg/src/ && ssh clawdgg 'cd /opt/clawdgg && docker compose -f docker-compose.staging.yml up -d --force-recreate app'

# Full restart (when .env changes)
ssh clawdgg 'cd /opt/clawdgg && docker compose -f docker-compose.staging.yml down && docker compose -f docker-compose.staging.yml up -d'
```
