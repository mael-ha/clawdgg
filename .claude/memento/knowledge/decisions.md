# Decisions

Architecture Decision Records (ADRs) for clawd.gg.

---

## 2025-12-22 (evening): CLAUDE.md Architecture — Static + Tiny Dynamic

**Context:** After building Memento, needed to decide CLAUDE.md's role. Options: directive-based ("read these files"), embedded minimum, or hybrid.

**Decision:** CLAUDE.md is mostly STATIC (~30 lines) with a tiny DYNAMIC "Now" section (2-3 lines). Critical patterns are "Burned In" directly.

**Alternatives:**
- Directive approach ("read now.md first") — I might not follow instructions
- Full embedding — Grows over time, back to original problem
- now.md as primary — Not auto-loaded, requires user action

**Rationale:**
- CLAUDE.md auto-loads — only guaranteed entry point
- Now section is the session handoff (2 lines, can't bloat)
- Burned In patterns prevent repeat failures (cookie bug, Docker env)
- Depth available in memento/ on-demand

**Graduation rule:** Bug fails 2+ times → graduates to Burned In.

---

## 2025-12-22: Memento Memory System

**Context:** CLAUDE.md grew to 1,400+ lines. Critical info got buried (cookie bug happened 3x).

**Decision:** Build tiered memory system inspired by Memento movie and neuroscience.

**Alternatives:**
- Just split CLAUDE.md into multiple files — Too simple, no semantic structure
- Use existing memory plugin — Couldn't find one that fit
- Full embeddings from start — Over-engineering for v1

**Rationale:** Structured files with skills for wake/sleep/recall. Future v2 adds embeddings.

---

## 2025-12-22: Data Retention 90 Days (Raw)

**Context:** Choosing TTL for raw OTel data.

**Decision:** Keep raw data 90 days, daily aggregates forever.

**Alternatives:**
- 7 days — Too aggressive, can't fix bugs retroactively
- Forever — Too expensive at scale
- 30 days — Still risky during launch

**Rationale:** 90 days gives runway to find aggregation bugs. Reduce after stable.

---

## 2025-12-17: HTMX over React

**Context:** Needed to build leaderboard UI. Could use React + shadcn or HTMX.

**Decision:** Stay with HTMX + Hono JSX.

**Alternatives:**
- React + shadcn — Familiar, good components, but generic look
- Vanilla JS — Too limited for interactivity

**Rationale:**
- Terminal aesthetic is our brand
- HTMX fits server-rendered approach
- Can migrate to React later if needed
- YAGNI — prove product first

---

## 2025-12-16: ClickHouse + SQLite Hybrid

**Context:** Need to store time-series OTel data efficiently.

**Decision:** ClickHouse for metrics, SQLite for users/auth.

**Alternatives:**
- SQLite only — Poor for time-series queries
- ClickHouse only — Overkill for user data
- TimescaleDB — More complex setup

**Rationale:** Each DB does what it's good at. Sync job bridges them.

---

## 2025-12-16: 1-Year Token Expiry

**Context:** How long should OTel bearer tokens last?

**Decision:** 1 year expiry.

**Alternatives:**
- 30 days — Standard, but OTel runs silently
- 90 days — Still requires periodic re-auth
- Never — Security risk

**Rationale:** OTel runs in background. If token expires, data stops without error. 1 year is safe default.

---

## 2025-12-13: Parse Raw .jsonl Files

**Context:** CLI needed to show user stats. Could use stats-cache.json or raw files.

**Decision:** Parse raw session files directly.

**Alternatives:**
- stats-cache.json — Simpler but undercounts by 50%

**Rationale:** stats-cache.json misses agent sessions entirely. Raw parsing is 2x more accurate.

---

## 2025-12-13: Prompts as Primary Metric

**Context:** What metric should drive the leaderboard?

**Decision:** Prompts (user messages) as primary, with tokens and lines secondary.

**Alternatives:**
- Messages (Claude + user) — Inflated by long Claude responses
- Tokens — Hard to relate to
- Lines of code — Only relevant for coding

**Rationale:** Prompts = YOUR engagement. Most intuitive metric.
