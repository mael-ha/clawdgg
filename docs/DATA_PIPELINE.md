# clawd.gg Data Pipeline

How a token spent in Claude Code becomes a number on clawd.gg, and what each
number is allowed to mean. For the system around it see
[ARCHITECTURE.md](./ARCHITECTURE.md); for endpoints see [API.md](./API.md).

**Rule zero:** ClickHouse is the only source for any displayed usage figure.
`users.total_*` in SQLite is a cache of it, refreshed every 5 minutes. Nothing
reads `daily_stats` or `users.legacy_total_*` any more
(`src/db/no-legacy-reads.test.ts` enforces it, because adding one back
double counts).

```
 Claude Code ──OTLP http/json──▶ /otel/v1/{metrics,logs} ─┐
 ~/.claude/projects/*.jsonl ──▶ clawdgg import ──▶ /api/cli/import ──┤  provenance=import
 ~/.claude/history.jsonl ─────▶ (import: days with no transcript)    │  provenance=backfill-history
 UserPromptSubmit hook ───────▶ /api/cli/ultrathink ──────────────┤  provenance=hook
 operator: src/scripts/backfill-jsonl.ts ─────────────────────────┤  provenance=backfill
 operator: migrations/2026-10-18_import_daily_stats.ts ──────────┤  provenance=legacy
 operator: migrations/2026-10-19_repair_token_metrics.ts ────────┤  provenance=repair
                                                                   ▼
                               ClickHouse  metrics_raw / events_raw   (row_id identity, FINAL reads)
                                                                   │
                         sync job, every 5 min ───────────────────┤──▶ SQLite users.total_*, streaks, badges
                                                                   │
                                  pages & API read cache or query directly
```

## Data sources

### 1. OTLP streaming (primary, `provenance = live`)

Claude Code's own OpenTelemetry exporter, configured by `clawdgg setup`
(`http/json`, endpoint `https://clawd.gg/otel`, auth via `otelHeadersHelper`).
Metrics use delta temporality, so **a batch the server refuses is gone, not
resent**. This is why ingestion never answers 5xx for a bad payload and why the
app stays up during migrations.

Metrics (`metrics_raw`):

```
claude_code.token.usage          token_type: input | output | cacheRead | cacheCreation
claude_code.cost.usage           USD, Claude Code's own measurement
claude_code.lines_of_code.count  line_type: added | removed
claude_code.commit.count
claude_code.pull_request.count
claude_code.active_time.total    type: user | cli
claude_code.session.count
claude_code.code_edit_tool.decision
```

Events (`events_raw`):

```
claude_code.user_prompt   prompt_length (never the text); command_name/command_source (Claude Code 2.1.117+)
claude_code.api_request   model, tokens, cost_usd, duration, prompt_id (a prompt fans out to many requests)
claude_code.tool_result   tool_name, success, duration, decision, error_type/error_message (paths stripped)
claude_code.tool_decision
```

Attributes that separate otherwise identical datapoints (model, `query_source`
main/subagent/auxiliary, speed, effort, agent/skill/plugin/MCP names,
`event.sequence`, ...) are stored as columns and hashed into `row_id`.

### 2. Local transcripts, history file (`import`, `backfill`, `backfill-history`)

Claude Code keeps session transcripts in `~/.claude/projects/<slug>/*.jsonl`
(rotating after roughly 60 days) and every typed prompt in
`~/.claude/history.jsonl`. `src/lib/session-import.ts` maps both into the same
rows OTLP would have produced:

| Line | Becomes |
|------|---------|
| `type:"user"` | `claude_code.user_prompt` (length only) |
| `type:"assistant"` | `claude_code.api_request` + token and cost metrics |
| each `tool_use` block | `claude_code.tool_result` |
| `history.jsonl` entry (no transcript for that day) | `user_prompt`, provenance `backfill-history` |

Dropped on purpose, to match live OTLP: subagent files and `isSidechain` lines
(delegations, not human prompts), `<synthetic>` zero-usage assistant rows, and
built-in slash commands (`/clear`, `/compact`, ...).

One mapper, three callers: `clawdgg import` (user-run, `import`), the
operator-run `src/scripts/backfill-jsonl.ts` (`backfill`), and their tests.

`clawdgg import` runs on the user's machine, so the server treats it as
untrusted. See the seven rules under `POST /api/cli/import` in
[API.md](./API.md#import). The ones that matter for numbers: cost is recomputed
server-side, client metrics are discarded in favour of ones derived from the
events, and a UTC day that already has any row is skipped whole.

### 3. Hook flags (`hook`)

The `UserPromptSubmit` hook matches each prompt for "ultrathink" locally
(`src/lib/ultrathink.ts`; the history import applies the same rule) and sends
`{session_id, timestamp, ultrathink: true}`, stored as event
`clawdgg.ultrathink`. The `clawdgg.` prefix keeps these out of every
`claude_code.*` query, so a flag can never be counted as a prompt or API call.

### 4. Pre-OTEL history (`legacy`)

The retired CLI uploaded one summary per day into SQLite `daily_stats`. That
history was converted once into ClickHouse rows
(`docker/clickhouse/migrations/2026-10-18_import_daily_stats.ts`, strictly before
each user's OTEL cutoff). Each row sits at **12:00 UTC** with no session and no
model. Counts and sums include them; anything that reads the *shape* of a day
excludes them with `NO_LEGACY_SQL`.

### 5. Plan limits (SQLite, not ClickHouse)

The `statusLine` hook forwards Pro/Max `rate_limits` to `POST /api/plan-usage`
into `plan_usage_snapshots`. There is no OTLP or REST source for these.

## Provenance

Part of the row identity, so a reconstructed row can never overwrite a measured one.

| `provenance` | From | Cost is |
|--------------|------|---------|
| `live` | OTLP | Claude Code's own `cost.usage` |
| `repair` | rebuilt from the `api_request` that measured a datapoint the old key had collapsed | measured; counts everywhere `live` counts |
| `backfill` | operator JSONL backfill | estimated from the price table |
| `import` | `clawdgg import` | estimated from the price table, server-side |
| `backfill-history` | `history.jsonl` | none (prompt counts only) |
| `legacy` | `daily_stats` | whatever the old CLI computed |
| `hook` | local hook | none (flag only) |

`GET /api/me/insights` returns `dataSources`, the per-provenance split of a
user's prompts, tokens and cost. Every row has a provenance, so the parts add up
to the whole.

## Row identity and dedup

Both tables are `ReplacingMergeTree` ordered by `(..., timestamp, row_id)` and
every read uses `FINAL`. `row_id` is a 128-bit SHA-256 over the row's identifying
columns (`METRIC_IDENTITY_COLUMNS` / `EVENT_IDENTITY_COLUMNS` in
`src/db/clickhouse.ts`) and **never its value**:

- An OTLP retry re-sends the identical datapoint, hashes identically, collapses.
- Two datapoints at the same millisecond that differ in model, subagent, tool,
  etc. hash differently and both survive. (Before October 2026 they collapsed,
  which silently dropped about 63% of live tokens; see the runbook.)
- `provenance` is in the hash; `pricing_source` is not, so re-running a backfill
  after a price update replaces rows instead of duplicating them.
- Anyone synthesizing timestamps must keep them distinct per record or pass an
  explicit `row_id`.

`docker/clickhouse/migrations/identity-parity.test.ts` checks that the SQL hash
used in migrations equals the TypeScript hash over awkward inputs (CJK, split
surrogate pairs, `event_sequence` at `MAX_SAFE_INTEGER`).

## What each number means

| Metric | Definition |
|--------|------------|
| **Prompts** | `user_prompt` events with `command_source != 'builtin'` (`PROMPT_EVENT_SQL`). One rule for every source. A prompt is not an `api_request`: one prompt fans out to 20+ requests |
| **Tokens** (headline) | input + output. Cache reads and writes are tracked separately |
| **Value / cost** | `cost.usage`: what the same work would cost at API prices. Most users are on a Max plan and paid none of it |
| **Lines** | `lines_of_code.count` with `line_type = added` |
| **Streak** | consecutive UTC days with activity, computed by the sync job from ClickHouse days (`users.current_streak`) |
| **Ultrathinks** | `clawdgg.ultrathink` events |
| **Leverage** | Claude output characters per character you typed |
| **Hour / weekday / "this week" on a profile** | read in `users.timezone` (`LOCAL_TS_SQL`), never UTC |
| **Homepage "this week"** | Monday 00:00 UTC to now, for everyone, so a shared board is one field |

Every ratio on a profile is a ratio of sums (total divided by total), never an
average of per-row ratios, so it reconciles with the totals beside it.

## Tokens

| Token type | What it is | Rate vs. input |
|------------|-----------|----------------|
| `input` | fresh prompt + new context | 1x |
| `output` | Claude's response | higher $/tok |
| `cacheRead` | reused context | 0.1x (0.05x on Opus 5.5 / Sonnet 5.5; 0.025x on Fable 5.1 / Mythos 5.1) |
| `cacheCreation` | newly cached context | 1.25x (5 min TTL) or 2x (1 hour TTL) |

Cache reads dominate (around 95% of tokens) because Claude re-reads the working
context every turn. That is why the model mix is split by value, not tokens: a
token split only says which model reads the most context.

## Cost for non-live rows

`live` rows carry Claude Code's measured cost and are never recomputed. Rows
reconstructed from transcripts (`import`, `backfill`) are priced from one table,
`src/lib/pricing.ts` (`PRICING_VERSION` 2026-10, read off the public pricing
page). Never declare a second table.

```typescript
cost =
  input * p.input + output * p.output + cacheRead * p.cacheRead +
  cache5m * p.cacheWrite5m + cache1h * p.cacheWrite1h        // all per MTok
```

- The 5m/1h cache-write split is read from `usage.cache_creation.ephemeral_{5m,1h}_input_tokens`.
  Pricing everything at the 5m rate understates cache-write cost by about 22%
  across real transcripts. `clawdgg import` sends the 1h share per request so the
  server prices it identically to the operator backfill.
- Request-dependent variants: Opus fast mode (`speed=fast`, listed models only)
  and Haiku 5.5's over-100K-token-prompt tier (decided per request, never from a
  sum).
- `pricing_source` records the match: `exact`, `normalized`, `family` (a guess,
  logged once per model), or `fallback` (`DEFAULT_PRICING`, logged). It is
  stored on the row but not part of its identity.
- A new model id with no entry is priced by family rule or fallback and **logged
  with its exact text** so the table gets a real price. Never add a model whose
  price was not read off the pricing page.

## The sync job

`src/jobs/sync-clickhouse.ts`, started at boot if ClickHouse answers its health
check, then every 5 minutes (skipped if the previous run is still going), for
**every** user:

1. `users.total_*` (prompts, tokens, input/output/cache tokens, cost in cents,
   lines, commits, PRs, active seconds, average prompt length) from ClickHouse.
   Nothing is added on top.
2. Streaks (365-day window, keeping the max with the stored longest), hour counts
   in the user's timezone (excluding `legacy` rows), longest session, badges.
3. After the loop, the once-a-day rank snapshot (`rank_snapshots`), so boards can
   show movement. A snapshot failure costs the arrows, not the numbers.

`POST /api/admin/sync` triggers it by hand.

## Retention and migrations

The October 2026 migration (`docker/clickhouse/migrations/README-2026-10.md`)
introduced `row_id`, removed the 365-day TTL from the raw tables on prod (this
is a usage history), imported `daily_stats`, and repaired the token rows the old
key had collapsed. Fresh databases are created from
`docker/clickhouse/init/01_schema.sql`. Operational steps live in that runbook,
not here.

## Known limits

- Rows collapsed by the pre-October key cannot be recovered except where the
  `api_request` that measured them still exists (that is what `repair` does).
- Imported and backfilled costs are estimates; live costs are measured.
- Transcripts rotate after about 60 days; `history.jsonl` outlives them but only
  holds prompts, which is why `backfill-history` carries prompt counts alone.
- Plan-limit percentages exist only for sessions where Claude Code passed
  `rate_limits` to the status line (Pro/Max, after the first API response).
