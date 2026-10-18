#!/usr/bin/env bun
/**
 * Backfill ClickHouse from local Claude Code JSONL transcripts.
 *
 * Reconstructs events_raw and metrics_raw rows from
 *   ~/.claude/projects/<slug>/{<sessionId>.jsonl, **\/<file>.jsonl}
 *
 * Used to fill the 2026-01-23 → 2026-05-06 telemetry gap caused by the
 * bearer-token expiry blackout. All inserted rows carry provenance='backfill'
 * to distinguish from live OTLP-received data.
 *
 * Modes:
 *   --dry-run [--limit N]         Print sample rows, no DB writes.
 *   --diff-overlap --from D --to D  Compare reconstructed rows vs prod for
 *                                   the overlap window. Read-only.
 *   --from D [--to D]             Insert rows for time window. Resumable.
 *
 * Date format: YYYY-MM-DD or full ISO 'YYYY-MM-DD HH:MM:SS'. UTC.
 *
 * Required env:
 *   CLAWDGG_USER_ID            user_id to attribute rows to (e.g. github_61985678)
 *   CLAWDGG_CLICKHOUSE_URL     prod CH endpoint (default http://localhost:8123)
 *   CLAWDGG_CLICKHOUSE_DB      database name (default clawd)
 *
 * Rows go in through src/db/clickhouse.ts's insertEvents / insertMetrics, NOT
 * through a private HTTP helper. This script used to have its own `chInsert`,
 * which meant it was the one writer that never computed `row_id` — every row it
 * wrote landed with an empty hash, and under the v2 sorting key (which ends in
 * row_id) every hashless row in a (user, metric, type, timestamp) group
 * collapses onto every other. A whole backfill could merge away.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  describeTranscriptPath,
  fmtTs,
  mapHistoryText,
  mapJsonlText,
  type ImportEventRow,
  type ImportMetricRow,
} from "../lib/session-import";

// src/db/clickhouse.ts reads these at module scope, so the aliases have to be
// in place before it is imported — hence the dynamic import below.
if (process.env.CLAWDGG_CLICKHOUSE_URL) {
  process.env.CLICKHOUSE_URL = process.env.CLAWDGG_CLICKHOUSE_URL;
}
if (process.env.CLAWDGG_CLICKHOUSE_DB) {
  process.env.CLICKHOUSE_DATABASE = process.env.CLAWDGG_CLICKHOUSE_DB;
}

const { insertEvents, insertMetrics, query } = await import("../db/clickhouse");

// ─────────────────────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────────────────────

type Mode = "dry-run" | "diff-overlap" | "insert" | "from-history";

interface Args {
  mode: Mode;
  from?: Date;
  to?: Date;
  limit?: number;
  resetCheckpoint: boolean;
}

function parseArgs(argv: string[]): Args {
  const has = (f: string) => argv.includes(f);
  const get = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  let mode: Mode = "insert";
  if (has("--dry-run")) mode = "dry-run";
  else if (has("--diff-overlap")) mode = "diff-overlap";
  else if (has("--from-history")) mode = "from-history";

  const from = get("--from");
  const to = get("--to");
  const limit = get("--limit");

  return {
    mode,
    from: from ? parseDate(from) : undefined,
    to: to && to !== "now" ? parseDate(to) : undefined,
    limit: limit ? parseInt(limit, 10) : undefined,
    resetCheckpoint: has("--reset-checkpoint"),
  };
}

function parseDate(s: string): Date {
  // Accept YYYY-MM-DD or full ISO. Treat as UTC if no timezone supplied.
  const d = new Date(s.includes("T") || s.includes(" ") ? s : `${s}T00:00:00Z`);
  if (isNaN(d.getTime())) throw new Error(`Bad date: ${s}`);
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config / paths
// ─────────────────────────────────────────────────────────────────────────────

const USER_ID = process.env.CLAWDGG_USER_ID || "github_61985678";
const CH_URL = process.env.CLICKHOUSE_URL || "http://localhost:8123";
const CH_DB = process.env.CLICKHOUSE_DATABASE || "clawd";
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const CHECKPOINT_PATH = join(homedir(), ".clawdgg-backfill-state.json");

const BATCH_SIZE = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes + JSONL mapping now live in src/lib/session-import.ts, shared with
// `clawdgg import`. This script keeps its own provenance and its own
// cache-breakdown counter; everything else is the same code path.
// ─────────────────────────────────────────────────────────────────────────────

type EventRow = ImportEventRow;
type MetricRow = ImportMetricRow;

interface MappedRows {
  events: EventRow[];
  metrics: MetricRow[];
}

/**
 * Count of assistant rows whose usage carried no nested `cache_creation`
 * breakdown, so their cache-creation tokens were all billed at the 5m rate.
 * Reported at the end of a run — a non-zero count means that run's cache-write
 * cost is understated.
 */
let rowsWithoutCacheBreakdown = 0;

// ─────────────────────────────────────────────────────────────────────────────
// File walking + checkpoint
// ─────────────────────────────────────────────────────────────────────────────

interface Checkpoint {
  completedFiles: string[];
  rowsInserted: number;
  startedAt: string;
  lastUpdatedAt: string;
}

async function loadCheckpoint(reset: boolean): Promise<Checkpoint> {
  if (!reset && existsSync(CHECKPOINT_PATH)) {
    try {
      return JSON.parse(await readFile(CHECKPOINT_PATH, "utf-8"));
    } catch {
      // fallthrough
    }
  }
  return {
    completedFiles: [],
    rowsInserted: 0,
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  };
}

async function saveCheckpoint(cp: Checkpoint): Promise<void> {
  cp.lastUpdatedAt = new Date().toISOString();
  await writeFile(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

async function walkJsonlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        out.push(full);
      }
    }
  }
  await walk(root);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Modes
// ─────────────────────────────────────────────────────────────────────────────

async function runDryRun(args: Args): Promise<void> {
  const limit = args.limit ?? 5;
  console.log(`[dry-run] Sampling up to ${limit} JSONL files; printing first events from each.\n`);

  const files = (await walkJsonlFiles(PROJECTS_DIR)).slice(0, limit);
  for (const file of files) {
    const rel = file.replace(homedir(), "~");
    console.log(`── ${rel} ──`);
    const rows = await mapFile(file, args);
    const eventsByName = new Map<string, number>();
    for (const ev of rows.events) {
      eventsByName.set(ev.event_name, (eventsByName.get(ev.event_name) ?? 0) + 1);
    }
    console.log(`  events: ${rows.events.length}  metrics: ${rows.metrics.length}`);
    for (const [k, v] of eventsByName) console.log(`    ${k}: ${v}`);
    if (rows.events.length > 0) {
      console.log(`  sample event: ${JSON.stringify(rows.events[0])}`);
    }
    if (rows.metrics.length > 0) {
      console.log(`  sample metric: ${JSON.stringify(rows.metrics[0])}`);
    }
    console.log();
  }
  reportCacheBreakdownCoverage();
}

/** Warn if any priced row lacked the 1h/5m cache-creation split. */
function reportCacheBreakdownCoverage(): void {
  if (rowsWithoutCacheBreakdown > 0) {
    console.warn(
      `[cache-split] ${rowsWithoutCacheBreakdown} priced row(s) carried no nested ` +
      `cache_creation breakdown; their cache-creation tokens were billed at the 5m ` +
      `rate, so cache-write cost for those rows is understated.`
    );
  } else {
    console.log(`[cache-split] every priced row carried the 1h/5m cache_creation breakdown.`);
  }
}

async function runDiffOverlap(args: Args): Promise<void> {
  if (!args.from || !args.to) {
    throw new Error("--diff-overlap requires --from and --to");
  }
  console.log(
    `[diff-overlap] Comparing reconstructed rows vs prod for ${args.from.toISOString()} → ${args.to.toISOString()}\n`
  );

  // 1. Build the reconstructed row set in memory.
  const files = await walkJsonlFiles(PROJECTS_DIR);
  const reconstructed = new Map<string, EventRow>();
  for (const file of files) {
    const rows = await mapFile(file, args);
    for (const ev of rows.events) {
      const key = `${ev.user_id}|${ev.session_id}|${ev.event_name}|${ev.timestamp}|${ev.tool_name ?? ""}`;
      reconstructed.set(key, ev);
    }
  }
  console.log(`  reconstructed events: ${reconstructed.size}`);

  // 2. Pull prod events for overlap window.
  const fromStr = fmtTs(args.from);
  const toStr = fmtTs(args.to);
  const sql = `
    SELECT user_id, session_id, event_name,
           formatDateTime(timestamp, '%F %T.%f') AS ts_str,
           tool_name, prompt_length, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, cost_usd, model, provenance
    FROM events_raw FINAL
    WHERE user_id = {userId:String}
      AND timestamp >= toDateTime64({from:String}, 3)
      AND timestamp <  toDateTime64({to:String}, 3)
  `;
  const prodRows = await query<any>(sql, { userId: USER_ID, from: fromStr, to: toStr });
  console.log(`  prod events:          ${prodRows.length}`);

  // 3. Diff: keys only in prod, only in reconstructed, deltas.
  const prodKeys = new Set<string>();
  let onlyProd = 0;
  let onlyReconstructed = 0;
  const sampleDeltas: any[] = [];

  for (const r of prodRows) {
    const key = `${r.user_id}|${r.session_id}|${r.event_name}|${r.ts_str.replace(/0+$/, "").replace(/\.$/, "")}|${r.tool_name ?? ""}`;
    prodKeys.add(key);
    // Try a few normalizations to find a match — prod's formatDateTime trailing zeros differ.
    const matched =
      reconstructed.get(key) ||
      reconstructed.get(`${r.user_id}|${r.session_id}|${r.event_name}|${String(r.ts_str).slice(0, 23)}|${r.tool_name ?? ""}`);
    if (!matched) {
      onlyProd++;
    } else if (sampleDeltas.length < 5) {
      const fields: string[] = [];
      for (const f of [
        "prompt_length",
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
      ]) {
        const a = Number((matched as any)[f] ?? 0);
        const b = Number((r as any)[f] ?? 0);
        if (a !== b) fields.push(`${f}: backfill=${a} prod=${b}`);
      }
      const costA = Number(matched.cost_usd ?? 0);
      const costB = Number(r.cost_usd ?? 0);
      if (Math.abs(costA - costB) > 0.001) {
        fields.push(`cost_usd: backfill=$${costA.toFixed(4)} prod=$${costB.toFixed(4)}`);
      }
      if (fields.length) sampleDeltas.push({ key, fields });
    }
  }

  for (const k of reconstructed.keys()) {
    if (!prodKeys.has(k)) onlyReconstructed++;
  }

  console.log(`\n  only-in-prod:           ${onlyProd}`);
  console.log(`  only-in-reconstructed:  ${onlyReconstructed}`);
  console.log(`\n  sample column-level deltas (matched rows only):`);
  for (const s of sampleDeltas) console.log(`    ${s.key}\n      ${s.fields.join("\n      ")}`);
  console.log();
  console.log(
    "  NOTE: cost_usd drift is expected (live rows carry measured cost; backfill estimates from pricing table)."
  );
  console.log(
    "       prompt_length / input_tokens / output_tokens drift is the relevant correctness signal."
  );
}

async function runInsert(args: Args): Promise<void> {
  if (!args.from) throw new Error("--from is required for insert mode");
  const to = args.to ?? new Date();
  console.log(
    `[insert] Backfill window: ${args.from.toISOString()} → ${to.toISOString()}  (provenance='backfill')`
  );

  const checkpoint = await loadCheckpoint(args.resetCheckpoint);
  console.log(`[insert] Loaded checkpoint: ${checkpoint.completedFiles.length} files already done.`);

  const allFiles = await walkJsonlFiles(PROJECTS_DIR);
  const todo = allFiles.filter((f) => !checkpoint.completedFiles.includes(f));
  console.log(`[insert] Files remaining: ${todo.length} of ${allFiles.length}`);

  let eventsBatch: EventRow[] = [];
  let metricsBatch: MetricRow[] = [];
  let totalEvents = 0;
  let totalMetrics = 0;

  const flush = async () => {
    if (eventsBatch.length) {
      await insertEvents(eventsBatch);
      totalEvents += eventsBatch.length;
      eventsBatch = [];
    }
    if (metricsBatch.length) {
      await insertMetrics(metricsBatch);
      totalMetrics += metricsBatch.length;
      metricsBatch = [];
    }
  };

  let i = 0;
  for (const file of todo) {
    i++;
    const rows = await mapFile(file, args);
    eventsBatch.push(...rows.events);
    metricsBatch.push(...rows.metrics);

    if (eventsBatch.length >= BATCH_SIZE || metricsBatch.length >= BATCH_SIZE) {
      await flush();
    }

    checkpoint.completedFiles.push(file);
    checkpoint.rowsInserted = totalEvents + totalMetrics;
    if (i % 25 === 0 || i === todo.length) {
      await saveCheckpoint(checkpoint);
      process.stdout.write(`\r[insert] ${i}/${todo.length} files | ${totalEvents} events + ${totalMetrics} metrics`);
    }
  }
  await flush();
  await saveCheckpoint(checkpoint);
  console.log(`\n[insert] Done. Inserted ${totalEvents} events + ${totalMetrics} metrics.`);
  reportCacheBreakdownCoverage();
}

/** Read one JSONL file, filter by date window, map to rows. */
async function mapFile(file: string, args: Args): Promise<MappedRows> {
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch {
    return { events: [], metrics: [] };
  }
  const mapped = mapJsonlText(raw, {
    userId: USER_ID,
    provenance: "backfill",
    from: args.from,
    to: args.to,
    ...describeTranscriptPath(file),
  });
  rowsWithoutCacheBreakdown += mapped.flatCacheFallbacks;
  return { events: mapped.events, metrics: mapped.metrics };
}

// ─────────────────────────────────────────────────────────────────────────────
// from-history: reconstruct user_prompt events from ~/.claude/history.jsonl
//
// Used to recover prompt counts for the 2026-01-24 → 2026-03-06 gap window
// where main-session JSONL files have rotated out and only subagent files
// (which carry orchestrator-internal prompts, not human ones) survive.
// history.jsonl is the chronological log of every prompt the user typed in
// the Claude Code REPL — slash commands and up-arrow repeats included, which
// we filter / dedupe here.
// ─────────────────────────────────────────────────────────────────────────────

const HISTORY_PATH = join(homedir(), ".claude", "history.jsonl");

async function runFromHistory(args: Args): Promise<void> {
  if (!args.from) throw new Error("--from-history requires --from");
  const to = args.to ?? new Date();
  console.log(
    `[from-history] Window: ${args.from.toISOString()} → ${to.toISOString()}  (provenance='backfill-history')`
  );
  console.log(`[from-history] Source: ${HISTORY_PATH}\n`);

  const raw = await readFile(HISTORY_PATH, "utf-8");

  // 'drop-builtin' — the default, and the same rule PROMPT_EVENT_SQL applies
  // to live rows. This script used to pass 'drop-all', which dropped custom,
  // skill and MCP commands too: real requests to a model that the live path
  // counts, so the gap window came out lower than the days around it for no
  // reason the numbers could explain. Re-running adds those prompts; it cannot
  // duplicate the ones already there, because row_id is deterministic.
  const mapped = mapHistoryText(raw, {
    userId: USER_ID,
    provenance: "backfill-history",
    from: args.from,
    to,
  });
  const rows = mapped.events;

  console.log(
    `[from-history] parsed=${mapped.parsed}  in-window=${rows.length}  dropped: slash=${mapped.droppedSlash} empty=${mapped.droppedEmpty} out-of-window=${mapped.droppedOutOfWindow} dup=${mapped.droppedDuplicate}`
  );

  // Daily breakdown for sanity.
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const day = r.timestamp.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  console.log(`[from-history] daily counts:`);
  for (const [day, n] of [...byDay.entries()].sort()) {
    console.log(`  ${day}  ${n}`);
  }

  // Phase 3: insert in batches.
  console.log(`\n[from-history] Inserting ${rows.length} events_raw rows...`);
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    await insertEvents(rows.slice(i, i + BATCH_SIZE));
  }
  console.log(`[from-history] Done.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`backfill-jsonl: mode=${args.mode}  user=${USER_ID}  ch=${CH_URL}/${CH_DB}\n`);
  switch (args.mode) {
    case "dry-run":
      await runDryRun(args);
      break;
    case "diff-overlap":
      await runDiffOverlap(args);
      break;
    case "insert":
      await runInsert(args);
      break;
    case "from-history":
      await runFromHistory(args);
      break;
  }
}

main().catch((err) => {
  console.error("backfill-jsonl: fatal error:", err);
  process.exit(1);
});
