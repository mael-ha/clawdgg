# Now

## Status: Telemetry restored after Jan 23 → May 6 blackout

**Live at:** https://clawd.gg (also http://46.224.85.32:3000 for direct access)
**Focus:** Token-cliff incident closed; profile redesign continues to run on prod from the Dec 27-29 sprint
**Branch:** `wip+fix-deploy-2026-05-06` (NOT merged to master — review before merge)
**Plan:** `~/.claude/plans/so-i-haven-t-worked-bubbly-teapot.md`

## Last Session (2026-05-06): Bearer-token cliff + 3.5-month backfill

**Root cause:** clawdgg CLI baked a 30-day signed token literally into
`OTEL_EXPORTER_OTLP_HEADERS` in `~/.claude/settings.json`. The OTel SDK reads
that header once at startup with no refresh hook. Token issued 2025-12-24,
expired 2026-01-23 14:41:27 UTC — exact match for the last received row in
ClickHouse (`max(timestamp) = 2026-01-23 14:41:20.630`). Once expired, every
batch silently 401'd into the void. The `clawdgg login` warning at
`cli/index.ts:1097` only fires from interactive `clawdgg sync`, never from the
OTel SDK, so nothing surfaced for ~3.5 months.

**What we shipped (branch `wip+fix-deploy-2026-05-06`):**
1. **Never-expire CLI tokens with `token_gen` revocation** (`src/lib/session.ts`,
   `drizzle/0007_add_user_token_gen.sql`). Bumping `users.token_gen` instantly
   revokes every outstanding token — replaces lifetime-based rotation.
2. **Rate-limited [OTel Auth] WARN log** in `requireOtelAuth` so future
   credential anomalies surface in `docker logs` (operator visibility).
3. **`clawdgg doctor` command** + auto-refresh of `~/.claude/settings.json`
   inside `clawdgg login` so users don't need a separate `clawdgg setup` step.
4. **`provenance` column** on `events_raw` / `metrics_raw` (`'live'` vs
   `'backfill'`) tagging reconstructed rows distinct from measured OTLP data.
5. **`src/scripts/backfill-jsonl.ts`** mining `~/.claude/projects/**/*.jsonl`
   for api_request, tool_result, user_prompt + token.usage / cost.usage rows.
   Skips orchestrator-internal prompts (subagent files + isSidechain=true).
   Resumable via `~/.clawdgg-backfill-state.json`.

**Recovered for `github_61985678`:**
- Prompts: 17,216 → 21,979 (+4,763)
- Cost: $3,648 → $10,267 (+$6,619 — estimated from token counts × pricing)
- Continuous daily activity 2026-01-22 → 2026-05-06, no Jan 23 cliff.

**What's *not* recoverable from JSONL (acknowledged gaps in backfill):**
- `claude_code.lines_of_code.count` (needs runtime git diff observation)
- `claude_code.commit.count`, `claude_code.pull_request.count`
- `claude_code.active_time.total`
- `claude_code.code_edit_tool.decision`
- `claude_code.tool_decision` events
- user_prompts for the **2026-01-24 → 2026-03-06** window — top-level JSONL
  files only retain ~60 days; that period is covered only by subagent files
  which (correctly) don't carry human-prompt boundaries. Tokens and cost are
  still recovered for that window from subagent api_requests.

**Open follow-ups:**
- The Dec 27-29 "profile redesign sprint" was rsynced to prod months ago
  but never committed locally. The fix branch's first commit (`6f2c211`)
  is a snapshot of that working state. Master is unchanged. Decide later
  whether to merge the snapshot to master or unwind the redesign.
- Restart Claude Code on this dev machine — the running OTel SDK still has
  the pre-rotation token cached in process memory.

## Previous session (2025-12-29)

**What happened:**
1. Comprehensive data audit of OTEL pipeline - found and fixed prompt counting bug
2. Created complete OTEL data reference at `.claude/memento/knowledge/claude-code-otel-reference.md`
3. Designed new profile architecture with "signature insights" sections
4. Added 7 new ClickHouse query functions for profile data
5. Started creating new UI components

**Major insight:** The "woaw" comes from IDENTITY reveals, not raw numbers.

## What's Done

### ClickHouse Queries (COMPLETED)

Added to `src/db/clickhouse.ts` (lines 1422-1777):
```typescript
getUserLanguageStats()        // Language distribution + trust per language
getUserTrustStyle()           // Trust style (autonomy, accept/reject)
getUserAgenticStats()         // Agentic intensity (API calls/prompt)
getUserPromptLengthStats()    // Prompt length (avg, max, min)
getTodayLanguages()           // Today's languages
getUserTerminalStats()        // IDE/terminal type
getUserTodayMetricsEnhanced() // Enhanced today metrics
```

### Components (ALL DONE)

- `src/components/LanguageChart.tsx` - DONE
- `src/components/ToolkitChart.tsx` - DONE
- `src/components/TrustStyle.tsx` - DONE
- `src/components/EfficiencyMetrics.tsx` - DONE

## What's Done (COMPLETE!)

All tasks completed:
1. ClickHouse queries for new profile data
2. Four new components (LanguageChart, ToolkitChart, TrustStyle, EfficiencyMetrics)
3. Profile.tsx restructured with "Your Signature" section
4. IDE badge added to hero
5. Active hours added to hero stats
6. Efficiency replaces TokenOrbit for OTEL users
7. Deployed and tested

### New Profile Structure (Live!)
```
1. HERO (enhanced with IDE badge + hours)
2. TODAY (enhanced with active time + languages)
3. YOUR SIGNATURE (NEW)
   - LanguageChart ✓
   - ToolkitChart
   - TrustStyle
4. YOUR PATTERNS
   - ActivityRadar (keep)
   - EfficiencyMetrics (NEW)
5. YOUR JOURNEY
   - AnalyticsChart (keep)
   - ContributionGraph (keep)
6. DEEP DIVE (collapsible)
```

## Key Files

| File | Status |
|------|--------|
| `src/db/clickhouse.ts` | DONE - 7 new queries |
| `src/components/LanguageChart.tsx` | DONE |
| `src/components/ToolkitChart.tsx` | TODO |
| `src/components/TrustStyle.tsx` | TODO |
| `src/components/EfficiencyMetrics.tsx` | TODO |
| `src/routes/profile.tsx` | TODO - restructure |

## The "Woaw" Principle

Every visualization must:
1. Show DATA (chart/numbers)
2. End with INSIGHT (💡 sentence)
3. Reveal IDENTITY (who you are)

Example insights:
- "You trust Python edits (98%) more than TypeScript (87%)"
- "You're a Read-first developer — you explore before you change"
- "Each prompt triggers 24 API calls — highly agentic"

## Reference Documents

- Profile redesign plan: `.claude/plans/profile-redesign-implementation.md`
- OTEL data reference: `.claude/memento/knowledge/claude-code-otel-reference.md`
- Data audit plan: `.claude/plans/bubbly-hatching-hearth.md`
- Dashboard V2 plan: `.claude/memento/knowledge/dashboard-v2-plan.md`

## Commands

```bash
# Deploy web app
rsync -avz src/ clawdgg:/opt/clawdgg/src/ && ssh clawdgg 'cd /opt/clawdgg && docker compose -f docker-compose.staging.yml up -d --force-recreate app'

# Run locally
bun run dev
```
