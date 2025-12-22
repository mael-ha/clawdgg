# Session Log

Append-only log of work sessions.

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
