# Now

## Status: 🟢 Deployed | Planning Dashboard V2

**Live at:** http://46.224.85.32:3000
**Blockers:** Domain purchase for HTTPS
**Focus:** Dashboard V2 implementation

## Last Session (2025-12-22)

**What happened:**
1. Deep planning session for Dashboard V2 ("The Ultimate Claude Code Profile")
2. Spawned 4 Opus agents for research:
   - Entry points mapping (CLI, Web, API flows)
   - Psychology of flexing (Spotify Wrapped analysis)
   - Design critique (ruthless review of current proposal)
   - Creative insights (derived metrics, archetypes)
3. Invoked frontend-design skill for visual direction
4. Created comprehensive plan: `.claude/memento/knowledge/dashboard-v2-plan.md`

**Key decisions:**
- **Identity > Numbers** — Lead with archetype ("The Context Maximizer"), not raw stats
- **Cost is the hero** — $2,252 invested (universally understood flex)
- **One story** — "A portrait of your Claude partnership", not data soup
- **Terminal Noir aesthetic** — Neon on black, cinematic, not gamified
- **Three tiers** — Card (3 sec) → Profile (30 sec) → Details (on-demand)
- **Kill the fluff** — No badges, no "congratulations!", no gamification

## Dashboard V2 Plan Summary

**Location:** `.claude/memento/knowledge/dashboard-v2-plan.md`

### Phases:
1. **Core Profile Redesign** — Archetype system, hero section, percentiles
2. **Token & Model Insights** — Expandable breakdowns, derived metrics
3. **Activity Enhancements** — Better heatmap, hourly chart
4. **Share Features** — OG image generation, download card
5. **Polish** — Full design system application

### The Feeling:
- Quiet pride (not arrogance)
- Validation (I'm doing this right)
- Recognition (the system sees me)
- Belonging (these are my people)

### Voice:
- Knowing (like a friend who gets it)
- Understated (confidence, not hype)
- Precise (specific, not vague)
- Respectful (treats users as professionals)

## Current State

| Component | Status |
|-----------|--------|
| App | Running (healthy) |
| ClickHouse | Running (healthy) |
| GitHub OAuth | ✅ Working (prod credentials) |
| V3 Pipeline | ✅ All 4 token types + cost |
| Dashboard V2 Plan | ✅ Complete |
| Domain | Not purchased |
| HTTPS | Blocked on domain |

## Next Priority

1. **Start Phase 1** — Core Profile Redesign
   - Add archetype calculation logic
   - Redesign hero section (archetype + cost + percentile)
   - Add "Your Numbers" + "Your Style" grid
   - Update CLI output to match

2. **Purchase clawd.gg domain** — Enables HTTPS
3. **DNS + Caddy** — Auto-SSL once domain points to VPS

## Quick Reference

### Archetypes (calculate from data):
- Context Maximizer (high cache ratio)
- Night Owl (60%+ after 8pm)
- Marathoner (avg session > 2h)
- Opus Connoisseur (70%+ Opus)
- Efficiency Expert (top 10% output/input)

### Derived Metrics:
- Output Leverage: output_tokens / input_tokens → "46x"
- Cache Efficiency: cache_read / (input + cache_creation) → "85%"
- Cost per Line: total_cost / lines → "$0.05/line"

### Copy Rules:
- ❌ "Congratulations!" → ✅ State facts
- ❌ "Great job!" → ✅ Let numbers speak
- ❌ Excessive emojis → ✅ Minimal, meaningful
- ❌ Gamified language → ✅ Professional respect

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
