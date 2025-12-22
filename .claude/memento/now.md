# Now

## Status: 🟢 Deployed | Dashboard V2 Phase 2 Complete

**Live at:** http://46.224.85.32:3000
**Blockers:** Domain purchase for HTTPS
**Focus:** Phase 3 (Share features), domain setup

## Last Session (2025-12-22)

**What happened:**
1. Implemented Dashboard V2 Phase 2 — Token & Activity Insights
2. Created TokenBreakdown component with log-scale bars
3. Created HourlyActivity bar chart with time-of-day colors
4. Added expandable sections (CSS-only with details/summary)
5. Deployed to VPS and verified working

**Files created/modified:**
- `src/components/TokenBreakdown.tsx` — NEW: Log-scale token visualization
- `src/components/HourlyActivity.tsx` — NEW: Hourly bar chart
- `src/routes/profile.tsx` — Added expandable sections
- `src/routes/profile.tsx` — Complete rewrite with Dashboard V2 design
- `src/routes/api.ts` — Updated /api/me with new fields
- `cli/index.ts` — Updated cmdStatus with new design
- `drizzle/0004_dashboard_v2_archetypes.sql` — Migration (applied)
- `scripts/migrate-0004.ts` — Migration runner script

**Dashboard V2 Profile Features:**
- Archetype as identity ("CODE MACHINE", not "User #123")
- Cost as hero stat ($2.1K invested in Claude)
- Two-column grid: "Your Numbers" + "Your Style"
- Derived metrics: Output Leverage, Cache Efficiency, Peak Hour
- Fun comparison text ("13x the King James Bible")
- Activity contribution graph

## Current State

| Component | Status |
|-----------|--------|
| App | Running (healthy) |
| ClickHouse | Running (healthy) |
| Dashboard V2 Phase 1 | ✅ Complete |
| GitHub OAuth | ✅ Working (prod credentials) |
| V3 Pipeline | ✅ All 4 token types + cost |
| Domain | Not purchased |
| HTTPS | Blocked on domain |

## Archetypes Implemented

| Archetype | Trigger |
|-----------|---------|
| Context Maximizer | 10x+ cache reuse ratio |
| Night Owl | 50%+ activity after 8pm |
| Early Bird | 40%+ activity before 10am |
| Marathoner | Longest session 4h+ OR avg 2h+ |
| Sprinter | Avg session <30min, 50+ prompts |
| Opus Connoisseur | 50%+ Opus usage |
| Efficiency Expert | 30x+ output leverage |
| Code Machine | 5+ lines per prompt |
| Pioneer | Beta user or early adopter |

## Next Priority

1. **Domain** — Purchase clawd.gg, configure DNS
2. **HTTPS** — Setup Caddy with auto-SSL
3. **Dashboard V2 Phase 2** — Token & model insights
4. **Share features** — OG image generation

## Quick Commands

```bash
# Check app
ssh clawdgg 'docker ps'

# Deploy
rsync -avz src/ clawdgg:/opt/clawdgg/src/ && ssh clawdgg 'cd /opt/clawdgg && docker compose -f docker-compose.staging.yml up -d --build --force-recreate app'

# Sync CLI too
rsync -avz cli/ clawdgg:/opt/clawdgg/cli/

# Run migration (if needed)
rsync -avz scripts/ clawdgg:/opt/clawdgg/scripts/ && ssh clawdgg 'cd /opt/clawdgg && docker cp scripts/migrate-0004.ts clawdgg-app-1:/app/migrate-0004.ts && docker exec clawdgg-app-1 bun /app/migrate-0004.ts'
```
