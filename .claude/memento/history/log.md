# Session Log

Append-only log of work sessions.

---

## 2025-12-22 (night): Dashboard V2 Deep Planning

**What I did:**
- Comprehensive planning session for "The Ultimate Claude Code Profile"
- Spawned 4 Opus sub-agents for parallel research:
  1. Entry points mapper (CLI/Web/API flows)
  2. Psychology of flexing (Spotify Wrapped, GitHub stats analysis)
  3. Design critic (ruthless review, identified "data soup" problem)
  4. Creative insights (archetypes, derived metrics, novelty stats)
- Invoked frontend-design skill for visual direction
- Created 500+ line comprehensive plan document

**Key decisions:**
- Identity > Numbers (lead with archetype, not raw stats)
- Cost as hero stat ($2,252 — universally understood)
- "Terminal Noir" aesthetic (neon on black, cinematic)
- Three-tier information architecture (Card → Profile → Details)
- Kill gamification (no badges, no "congratulations!", no mobile game patterns)
- Voice: Knowing, understated, precise, respectful

**Archetypes defined:**
- The Context Maximizer (high cache ratio)
- The Night Owl (60%+ after 8pm)
- The Marathoner (avg session > 2h)
- The Opus Connoisseur (70%+ Opus)
- The Efficiency Expert (top output/input ratio)

**Derived metrics:**
- Output Leverage (46x)
- Cache Efficiency (85%)
- Cost per Line ($0.05)
- Cost per Commit ($9.62)

**Plan document:** `.claude/memento/knowledge/dashboard-v2-plan.md`

**Phases:**
1. Core Profile Redesign (archetype system, hero, percentiles)
2. Token & Model Insights (expandable breakdowns)
3. Activity Enhancements (hourly chart, better heatmap)
4. Share Features (OG images, downloadable cards)
5. Polish (full design system)

**The DNA:** Quiet pride. A mirror, not a scoreboard. Makes invisible AI partnership visible.

**Next:** Start Phase 1 implementation

---

## 2025-12-22 (evening, late): E2E Testing + Pricing Update

**What I did:**
- Fixed OAuth credential mismatch (VPS had dev credentials cached in container)
- Learned Docker restart ≠ recreate (env vars don't reload)
- Fixed leaderboard cost query (legacy users showed $0)
- Updated pricing from official Anthropic docs (added all models)
- Created `knowledge/claude-api-pricing.md` with last-updated timestamp
- Tested full sync: 15.6K prompts, 10.9M tokens, $2,252 cost

**Key insight:** Docker `restart` doesn't reload `.env` files. Must use `down && up` or `--force-recreate`.

**UX feedback:** User felt "10.9M tokens" was underwhelming. Cache reads are 2.1B — need to rethink token display.

**Next:** Profile UX (token display), then domain purchase.

---

## 2025-12-22 (evening): Refined Memento Architecture

**What I did:**
- Deep-thought session on making memory system "perfect"
- Reduced CLAUDE.md from 113 lines to 35 lines
- Established "Burned In" pattern for critical bugs
- Added Docker env bug to Burned In
- Created explicit "Session End" protocol

**Key insight:** CLAUDE.md should be mostly STATIC with a tiny DYNAMIC "Now" section.

---

## 2025-12-22: Built Memento Plugin

**What I did:**
- Designed tiered memory system (identity/now/beware + knowledge/procedures/history)
- Created full plugin structure (19 files)
- 7 skills, 7 templates for brain structure
- Migrated content from 1,400-line CLAUDE.md to memento

**Key insight:** Cookie bug happened 3 times because warnings were buried. Now `beware.md` is always-load.

---

## 2025-12-22: V3 Data Pipeline + Deployment

**What I did:**
- Added full token breakdown (input/output/cache_read/cache_creation)
- Added cost calculation per message
- Provisioned Hetzner VPS (CX23), deployed to production
- Fixed 8 deployment issues (see beware.md)

**Blocked on:** Domain purchase for HTTPS

---

## 2025-12-17: Leaderboard + Security

**What I did:**
- Badges, streaks, rank change, cost display
- SQL injection fix, graceful shutdown, health endpoint

---

## 2025-12-16: OTel Integration

**What I did:**
- OTLP receiver, ClickHouse schema, background sync
- CLI `setup`/`unsetup` commands

**Key insight:** OTel gives us cost data! stats-cache.json doesn't.

---

## 2025-12-13: New Metrics System

**What I did:**
- Prompts as primary metric, added lines/commits/files
- CLI parses raw .jsonl files (2x more accurate)

**Key insight:** stats-cache.json undercounts by 50% (misses agent sessions).
