# clawd.gg Data Pipeline Architecture

## Overview

This document describes the complete data flow from Claude Code to our display.

## Data Sources

### 1. Local .jsonl Files (Legacy Sync)

**Location:** `~/.claude/projects/<project>/*.jsonl`

**Available per message:**
```typescript
{
  message: {
    model: "claude-opus-4-5-20251101",
    usage: {
      input_tokens: number,              // New input (billable at full rate)
      output_tokens: number,             // Response (billable at full rate)
      cache_read_input_tokens: number,   // Cached context reused (0.1x rate)
      cache_creation_input_tokens: number, // New cache created (1.25x rate)
      cache_creation: {
        ephemeral_5m_input_tokens: number,  // 5-minute cache
        ephemeral_1h_input_tokens: number,  // 1-hour cache (2x rate)
      }
    }
  }
}
```

**Limitations:**
- No direct cost field (must calculate from tokens + model)
- Requires parsing all files (slow for first sync)
- Only available on user's machine

### 2. OTel Streaming (Real-time)

**Sent by Claude Code every 60s:**
```
claude_code.token.usage (with type: input/output/cacheRead/cacheCreation)
claude_code.cost.usage (USD!) ← ONLY SOURCE OF ACTUAL COST
claude_code.lines_of_code.count
claude_code.commit.count
claude_code.pull_request.count
claude_code.active_time.total
claude_code.session.count
```

**Limitations:**
- No historical data (only from when configured)
- Requires user to run `clawdgg setup`

## Token Types Explained

| Token Type | What It Is | Billing Rate | Example |
|------------|-----------|--------------|---------|
| `input_tokens` | Your prompts + new context | 1.0x | 5.3M |
| `output_tokens` | Claude's responses | 1.0x (higher $/tok) | 5.4M |
| `cache_read_input_tokens` | Reused context | 0.1x | 2.0B |
| `cache_creation_input_tokens` | New cached context | 1.25x (5m) or 2x (1h) | 232M |

**Key insight:** Cache reads are HUGE because Claude re-reads your entire codebase context every turn.

## What We Should Display

### Leaderboard (Primary Metrics)

| Metric | Source | Calculation |
|--------|--------|-------------|
| **Prompts** | Count of user messages | Direct count |
| **Tokens** | input + output | Sum of both |
| **Lines** | Edit/Write tool inputs | Line count from tool args |
| **Cost** | OTel: `cost.usage` / Local: calculated | See cost formula below |

### Profile Page (Detailed Metrics)

| Metric | Source | Notes |
|--------|--------|-------|
| **Token Breakdown** | All 4 types | Show pie chart |
| **Cost Breakdown** | By model | If available from OTel |
| **Context Processed** | input + output + cache_read | "Claude read X tokens" |
| **Model Diet** | Tokens per model | From tokensByModel |
| **Active Time** | OTel only | Seconds of active coding |

## Cost Calculation Formula

```typescript
// Pricing varies by model - this is Opus 4.5
const PRICING = {
  'claude-opus-4-5': {
    input: 5.00,       // per MTok
    output: 25.00,     // per MTok
    cache_read: 0.50,  // 0.1x input
    cache_5m: 6.25,    // 1.25x input
    cache_1h: 10.00,   // 2x input
  },
  'claude-sonnet-4-5': {
    input: 3.00,
    output: 15.00,
    cache_read: 0.30,
    cache_5m: 3.75,
    cache_1h: 6.00,
  },
  // ... etc
};

function calculateCost(usage: Usage, model: string): number {
  const p = PRICING[model] || PRICING['claude-sonnet-4-5'];
  return (
    (usage.input_tokens / 1e6) * p.input +
    (usage.output_tokens / 1e6) * p.output +
    (usage.cache_read_input_tokens / 1e6) * p.cache_read +
    (usage.cache_creation?.ephemeral_5m_input_tokens / 1e6) * p.cache_5m +
    (usage.cache_creation?.ephemeral_1h_input_tokens / 1e6) * p.cache_1h
  );
}
```

## Current Gaps (MUST FIX)

### 1. CLI Not Capturing Cache Tokens ❌

**Problem:** We only extract `input_tokens` and `output_tokens`, ignoring cache tokens.

**Impact:**
- Can't calculate cost
- Can't show "context processed"
- Token count feels "low" to users

**Fix:** Update `parseSessionFile()` to extract all token types.

### 2. CLI Not Calculating Cost ❌

**Problem:** No cost field in local files, and we don't calculate it.

**Impact:** Users can't see how much they've "spent" historically.

**Fix:** Calculate cost from tokens + model using pricing table.

### 3. Model Breakdown Lost on Upload ❌

**Problem:** We flatten `tokensByModel` to `{ 'raw-parsed': total }`.

**Impact:** Can't show "Claude Diet" for legacy sync users.

**Fix:** Send actual model breakdown to API.

### 4. Session Count Hardcoded ❌

**Problem:** Always send `sessionCount: 1`.

**Impact:** Session count metric is useless.

**Fix:** Count unique session files per day.

### 5. No Hourly Cache Token Breakdown ❌

**Problem:** We don't distinguish 5m vs 1h cache.

**Impact:** Cost calculation slightly inaccurate.

**Fix:** Extract `cache_creation.ephemeral_*` fields.

## Database Schema Requirements

### SQLite (daily_stats)

Current columns:
```sql
prompt_count, message_count, token_count, lines_written, commit_count, session_count
```

Need to add:
```sql
input_tokens INTEGER DEFAULT 0,
output_tokens INTEGER DEFAULT 0,
cache_read_tokens INTEGER DEFAULT 0,
cache_creation_tokens INTEGER DEFAULT 0,
cost_usd_cents INTEGER DEFAULT 0,  -- Store as cents to avoid float issues
```

### ClickHouse (already correct)

The ClickHouse schema already captures all token types correctly. No changes needed.

## Migration Strategy

### For Existing Users

1. Keep current `token_count` for backwards compatibility
2. Add new columns for detailed breakdown
3. On next sync, populate new columns
4. Historical data will have `token_count` but null detailed columns

### For New Users

1. Full breakdown from first sync
2. Cost calculated and stored

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         USER'S MACHINE                              │
│                                                                     │
│  ~/.claude/projects/*.jsonl                                         │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ Each message has:                                            │   │
│  │   - input_tokens                                             │   │
│  │   - output_tokens                                            │   │
│  │   - cache_read_input_tokens                                  │   │
│  │   - cache_creation_input_tokens                              │   │
│  │   - model                                                    │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                    ┌─────────┴─────────┐                           │
│                    ▼                   ▼                           │
│            `clawdgg sync`          `clawdgg setup`                     │
│            (one-time)            (enables OTel)                    │
│                    │                   │                           │
└────────────────────┼───────────────────┼───────────────────────────┘
                     │                   │
                     ▼                   ▼
              ┌──────────────────────────────────────────────┐
              │              clawd.gg SERVER                 │
              │                                              │
              │   ┌────────────┐    ┌────────────────────┐  │
              │   │   SQLite   │    │    ClickHouse      │  │
              │   │            │    │                    │  │
              │   │ daily_stats│    │ metrics_raw        │  │
              │   │ users      │    │ events_raw         │  │
              │   │            │    │ metrics_daily      │  │
              │   └────────────┘    │ (all token types!) │  │
              │         │           └────────────────────┘  │
              │         │                    │              │
              │         └──────┬─────────────┘              │
              │                │                            │
              │                ▼                            │
              │        ┌─────────────┐                      │
              │        │  Sync Job   │                      │
              │        │ (5 min)     │                      │
              │        └─────────────┘                      │
              │                │                            │
              │                ▼                            │
              │        ┌─────────────┐                      │
              │        │    API      │                      │
              │        │ /leaderboard│                      │
              │        │ /profile    │                      │
              │        └─────────────┘                      │
              │                │                            │
              └────────────────┼────────────────────────────┘
                               ▼
                        ┌─────────────┐
                        │   Web UI    │
                        │             │
                        │ Leaderboard │
                        │ Profile     │
                        └─────────────┘
```

## Action Items

1. **[HIGH] Fix CLI parsing** - Add cache token extraction
2. **[HIGH] Add cost calculation** - In CLI from tokens + model
3. **[HIGH] Update API** - Accept full token breakdown
4. **[MEDIUM] Add DB columns** - For detailed token types
5. **[MEDIUM] Update UI** - Show cost on profiles
6. **[LOW] Session counting** - Fix hardcoded value
