# Session Log

Append-only log of work sessions.

---

## 2025-12-22 (evening): Refined Memento Architecture

**What I did:**
- Deep-thought session on making memory system "perfect"
- Reduced CLAUDE.md from 113 lines to 35 lines
- Established "Burned In" pattern for critical bugs
- Added Docker env bug to Burned In (just bit us in parallel session)
- Created explicit "Session End" protocol

**Key insight:** CLAUDE.md should be mostly STATIC with a tiny DYNAMIC "Now" section. The Now section is the handoff between sessions — 2 lines max.

**Architecture finalized:**
- CLAUDE.md: ~35 lines (Now + Deploy + Burned In + pointers)
- now.md: full current state (updated each session)
- beware.md: all warnings (Burned In graduates from here)
- Session End: Update Now section + now.md + history/log.md

**Decision:** When a bug fails 2+ times, it graduates to "Burned In" in CLAUDE.md.

---

## 2025-12-22: Built Memento Plugin

**Duration:** ~2 hours

**What I did:**
- Designed tiered memory system (identity/now/beware + knowledge/procedures/history)
- Created full plugin structure (19 files)
- 7 skills: init, wake, sleep, log, beware, decide, recall
- 7 templates for brain structure
- Updated CLAUDE.md with memento protocol
- Migrated content from 1,400-line CLAUDE.md to memento

**Key insight:** Cookie bug happened 3 times because warnings were buried. Now `beware.md` is always-load.

**Decisions made:**
- v1 is skills-only, v2 adds embeddings via MCP
- Brain location: `.claude/memento/`
- Tiered loading: ~200 lines always-load vs 1,400 before

---

## 2025-12-22: V3 Data Pipeline

**What I did:**
- Added full token breakdown (input/output/cache_read/cache_creation)
- Added cost calculation per message
- Created migration `0003_v3_token_breakdown.sql`
- Updated CLI to extract all token types

**Key insight:** Cache tokens are huge (billions!) but input+output is what users care about.

---

## 2025-12-22: Deployed to Production

**What I did:**
- Provisioned Hetzner VPS (CX23)
- Fixed 8 deployment issues (see beware.md)
- OAuth login working over HTTP

**Blocked on:** Domain purchase for HTTPS

---

## 2025-12-17: Leaderboard Enhancement

**What I did:**
- Added badges, streaks, rank change, cost display
- HTMX "Load More" for infinite scroll
- Fixed SQL injection in sort parameter

---

## 2025-12-17: Security + Production Readiness

**What I did:**
- SQL injection fix (whitelist validation)
- Graceful shutdown (SIGTERM/SIGINT handlers)
- Health endpoint (starting/ok/degraded states)
- Sync job overlap guard

---

## 2025-12-16: OTel Integration

**What I did:**
- Built OTLP receiver endpoints
- ClickHouse schema for time-series
- Background sync job (ClickHouse → SQLite)
- CLI `setup`/`unsetup` commands

**Key insight:** OTel gives us cost data! stats-cache.json doesn't.

---

## 2025-12-13: New Metrics System

**What I did:**
- Switched from messages to prompts as primary metric
- Added lines written, commits, files edited
- CLI parses raw .jsonl files (2x more accurate than cache)

**Key insight:** stats-cache.json undercounts by 50% (misses agent sessions).
