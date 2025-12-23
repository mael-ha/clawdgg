# Session Log

Append-only log of work sessions.

---

## 2025-12-23 (evening): X Bot Thread Structure & Orchestration

**What I did:**
- Redesigned tweet thread structure with summary hook + all items
- Implemented X Premium support (no splits, 4000 char limit)
- Added "changelog pending" flow for when GitHub lags behind brew
- Added 48h timeout for missing changelogs (closes thread gracefully)
- Fixed model IDs (Opus 4.5 + Haiku 4.5)
- Tested full orchestration flow with AI validation
- Updated formatter.ts to 670+ lines with new structure

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
```
detected → wait 15min for GitHub → ready → posted
    │                                 │
    └──────(timeout)──────────────────┘

If pending (no GitHub):
  - Post "Changelog incoming..." summary
  - When GitHub arrives: Post "Update" + details
  - After 48h: Close thread, move on
```

**Key decisions:**
- X Premium recommended (~$8/mo) for no splits
- Opus 4.5 for all writing (account doesn't have Sonnet 4.5 access)
- ~$4-5/month API costs at 7 releases/week

**Files modified:**
- `bot/src/ai/formatter.ts` — Complete rewrite (670+ lines)
- `bot/src/jobs/version-check.ts` — New orchestration (560+ lines)
- `.claude/memento/knowledge/bot.md` — Updated docs

**Next:** X Developer credentials, live testing

---

## 2025-12-23: X Bot Scaffolding

**What I did:**
- Designed X bot strategy for Claude Code community building
- Researched data sources: brew commits, GitHub releases, cchistory, npm stats
- Scaffolded complete `bot/` codebase (14 TypeScript files)
- Implemented version detection and lifecycle state machine
- Created AI formatter with Sonnet 4.5 + extended thinking
- Added few-shot examples for consistent bot voice
- Weekly summary with download stats + WoW comparison

**Files created (14):**
```
bot/src/index.ts              # Entry point (daemon + one-shot)
bot/src/db/schema.ts          # versions, download_stats, reddit_posts
bot/src/db/index.ts           # SQLite connection
bot/src/db/init.ts            # Schema initialization
bot/src/watchers/brew.ts      # Homebrew cask monitoring
bot/src/watchers/github.ts    # Releases API + note parser
bot/src/watchers/npm.ts       # Download stats
bot/src/watchers/cchistory.ts # Prompt diff extraction
bot/src/publishers/twitter.ts # X API with threading + mock mode
bot/src/publishers/gist.ts    # Prompt diff hosting
bot/src/jobs/version-check.ts # Main orchestration
bot/src/jobs/stats.ts         # Weekly summary + stats collection
bot/src/ai/formatter.ts       # Claude-powered formatting (480+ lines)
bot/drizzle.config.ts         # Drizzle config for bot db
```

**AI model decisions:**
- Sonnet 4.5 + extended thinking (4K budget) for ALL tweet writing
- Haiku 4.5 (no thinking) only for Reddit post classification
- ~$1.30/month estimated cost

**Bot voice examples (in TONE_EXAMPLES):**
```
✅ "Claude Code 2.0.74 just shipped. Thread incoming."
✅ "LSP support. Finally."
❌ "We're thrilled to announce..." (corporate)
```

**Version lifecycle:**
```
detected → announced → detailed → complete
  (brew)    (tweet)    (github + prompt diff)
```

**Data sources:**
- Homebrew cask commits (fastest for version detection)
- GitHub releases (detailed changelog)
- cchistory npm package (prompt diffs)
- npm registry + brew API (download stats)

**Updated memento:**
- Created `knowledge/bot.md` (comprehensive bot docs)
- Updated `knowledge/project.md` (three-codebase architecture)
- Updated `now.md` with bot status

**Next:** X Developer credentials, dry-run testing, Reddit integration

---

## 2025-12-22 (late night): Dashboard V2 Phase 2 Implementation

**What I did:**
- Created TokenBreakdown component with log-scale SVG bars
  - Shows cache reads, output, cache write, input tokens
  - Uses log scale when disparity > 50x (e.g., 2B cache vs 5M input)
  - Color-coded: cyan (cache read), purple (output), amber (cache write), green (input)
- Created HourlyActivity bar chart
  - 24-hour distribution with time-of-day coloring
  - Shows morning (amber), afternoon (green), evening (purple), night (blue)
  - Includes peak hour callout and dominant period insight
- Added expandable sections using CSS-only details/summary
  - Token Breakdown section (Tier 2 - on demand)
  - Hourly Patterns section (Tier 2 - on demand)
- Deployed to VPS and verified working

**Files created:**
- `src/components/TokenBreakdown.tsx` (130+ lines)
- `src/components/HourlyActivity.tsx` (100+ lines)

**Files modified:**
- `src/routes/profile.tsx` — Added imports and expandable sections

**Token Breakdown features:**
- Log-scale bars for extreme disparities
- Percentage breakdown
- Summary stats (total tokens, output leverage, cache efficiency)
- Scale indicator when using logarithmic scale

---

## 2025-12-22 (late night): Dashboard V2 Phase 1 Implementation

**What I did:**
- Implemented complete archetype system (`src/lib/archetypes.ts`)
- 9 archetypes: Context Maximizer, Night Owl, Early Bird, Marathoner, Sprinter, Opus Connoisseur, Efficiency Expert, Code Machine, Pioneer
- Added derived metrics: outputLeverage, cacheEfficiency, costPerLine, costPerCommit, contextReuse
- Redesigned profile page with new hero section (archetype + cost + percentile)
- Created two-column grid: "Your Numbers" + "Your Style"
- Added peak hour detection and display
- Updated CLI status output to match Dashboard V2 design
- Applied database migration (archetype fields)
- Deployed to VPS and verified working

**Files created/modified:**
- `src/lib/archetypes.ts` — NEW: 480+ lines of archetype calculation logic
- `src/db/schema.ts` — Added archetype, archetypeSecondary, archetypeUpdatedAt
- `src/routes/profile.tsx` — Complete rewrite with Dashboard V2 design
- `src/routes/api.ts` — Updated /api/me with new fields
- `cli/index.ts` — Updated cmdStatus with new design
- `drizzle/0004_dashboard_v2_archetypes.sql` — Migration
- `scripts/migrate-0004.ts` — Migration runner

**Dashboard V2 features:**
- Archetype as identity ("CODE MACHINE")
- Cost as hero stat ("$2.1K invested in Claude")
- Rank + percentile badge
- Token breakdown with in/out split
- Output Leverage, Cache Efficiency, Peak Hour
- Cost per Line, Cost per Commit
- Fun comparison text ("13x the King James Bible")

**Live at:** http://46.224.85.32:3000/u/mael-ha

**Next:** Domain purchase, HTTPS, Phase 2 (token insights)

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
