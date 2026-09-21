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
 *   CLAWDGG_CLICKHOUSE_DB      database name (default clawdgg)
 */

import { readFile, readdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getModelPricingDetailed, splitCacheCreationTokens, type PricingMatchQuality } from "../lib/pricing";

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
const CH_URL = process.env.CLAWDGG_CLICKHOUSE_URL || "http://localhost:8123";
const CH_DB = process.env.CLAWDGG_CLICKHOUSE_DB || "clawd";
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const CHECKPOINT_PATH = join(homedir(), ".clawdgg-backfill-state.json");

const BATCH_SIZE = 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Types matching docker/clickhouse/init/01_schema.sql
// ─────────────────────────────────────────────────────────────────────────────

interface EventRow {
  timestamp: string;          // YYYY-MM-DD HH:MM:SS.sss
  user_id: string;
  session_id: string;
  event_name: string;
  prompt_length?: number;
  tool_name?: string;
  tool_success?: number;
  tool_duration_ms?: number;
  model?: string;
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  error_message?: string;
  status_code?: number;
  duration_ms?: number;
  decision?: string;
  source?: string;
  tool_parameters?: string;
  provenance?: "live" | "backfill" | "backfill-history";
  /** Price-table match quality behind cost_usd. Omitted when no cost was estimated. */
  pricing_source?: PricingMatchQuality;
}

interface MetricRow {
  timestamp: string;
  user_id: string;
  session_id: string;
  metric_name: string;
  value: number;
  model?: string;
  token_type?: string;
  line_type?: string;
  terminal_type?: string;
  app_version?: string;
  account_uuid?: string;
  tool?: string;
  decision?: string;
  language?: string;
  provenance?: "live" | "backfill" | "backfill-history";
  /** Price-table match quality behind a cost.usage value. Omitted for token metrics. */
  pricing_source?: PricingMatchQuality;
}

// ─────────────────────────────────────────────────────────────────────────────
// JSONL → row mapping
// ─────────────────────────────────────────────────────────────────────────────

interface MappedRows {
  events: EventRow[];
  metrics: MetricRow[];
}

/** Format a JS Date as ClickHouse DateTime64(3): "YYYY-MM-DD HH:MM:SS.sss" (UTC) */
function fmtTs(d: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.` +
    `${pad(d.getUTCMilliseconds(), 3)}`
  );
}

function contentLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const block of content) {
      if (block && typeof block === "object" && "text" in block && typeof (block as any).text === "string") {
        n += (block as any).text.length;
      }
    }
    return n;
  }
  return 0;
}

/**
 * Count of assistant rows whose usage carried no nested `cache_creation`
 * breakdown, so their cache-creation tokens were all billed at the 5m rate.
 * Reported at the end of a run — a non-zero count means that run's cache-write
 * cost is understated.
 */
let rowsWithoutCacheBreakdown = 0;

/**
 * USD cost from token usage + model. Returns dollars (Float64) plus how the
 * price was looked up, so the row can carry its own estimate quality.
 *
 * Cache creation is billed per TTL: 1h costs 2x input, 5m costs 1.25x. Pricing
 * everything at 5m (what this did before) understates cache-write cost by ~22%
 * on the current corpus, where 37% of cache-creation tokens are 1h.
 */
function computeCostUsd(model: string, usage: any): { costUsd: number; pricingSource: PricingMatchQuality } {
  const { pricing: p, matchQuality } = getModelPricingDetailed(model || "");
  const input = Number(usage?.input_tokens ?? 0);
  const output = Number(usage?.output_tokens ?? 0);
  const cacheRead = Number(usage?.cache_read_input_tokens ?? 0);
  const { tokens5m, tokens1h, fromFlatFallback } = splitCacheCreationTokens(usage);
  if (fromFlatFallback) rowsWithoutCacheBreakdown++;
  return {
    costUsd:
      (input * p.input +
        output * p.output +
        cacheRead * p.cacheRead +
        tokens5m * p.cacheWrite5m +
        tokens1h * p.cacheWrite1h) / 1_000_000,
    pricingSource: matchQuality,
  };
}

/** Map one JSONL line (already JSON-parsed) into rows. Returns nothing for unmappable lines. */
function mapLine(line: any, sessionFallback: string, isSubagentFile: boolean): MappedRows {
  const out: MappedRows = { events: [], metrics: [] };

  const tsStr: string | undefined = line?.timestamp;
  if (!tsStr) return out;
  const ts = new Date(tsStr);
  if (isNaN(ts.getTime())) return out;

  const sessionId: string = line?.sessionId || sessionFallback;
  const timestamp = fmtTs(ts);
  const base = { timestamp, user_id: USER_ID, session_id: sessionId, provenance: "backfill" as const };

  const type: string | undefined = line?.type;
  const isSidechain: boolean = line?.isSidechain === true;

  if (type === "user") {
    // Only emit user_prompt for top-level human-typed prompts. Subagent files
    // and isSidechain=true lines carry orchestrator-internal prompts (Task
    // tool delegations) which live OTEL does NOT emit as user_prompt events.
    if (isSubagentFile || isSidechain) return out;
    const content = line?.message?.content;
    out.events.push({
      ...base,
      event_name: "claude_code.user_prompt",
      prompt_length: contentLength(content),
    });
    return out;
  }

  if (type === "assistant") {
    const usage = line?.message?.usage;
    const model: string = line?.message?.model || "";

    // Claude Code writes model="<synthetic>" for locally-generated assistant
    // messages (interrupts, error placeholders) that never hit the API. Every
    // one of them carries all-zero usage, so they add $0 — but emitting them as
    // api_request events inflates the API-calls-per-prompt agentic ratio.
    if (model === "<synthetic>") return out;
    if (usage && (usage.input_tokens != null || usage.output_tokens != null)) {
      const inputTokens = Number(usage.input_tokens ?? 0);
      const outputTokens = Number(usage.output_tokens ?? 0);
      const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
      const cacheWrite = Number(usage.cache_creation_input_tokens ?? 0);
      const { costUsd, pricingSource } = computeCostUsd(model, usage);

      out.events.push({
        ...base,
        event_name: "claude_code.api_request",
        model,
        cost_usd: costUsd,
        pricing_source: pricingSource,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
      });

      const tokenMetricBase = {
        ...base,
        metric_name: "claude_code.token.usage",
        model,
      };
      if (inputTokens > 0)
        out.metrics.push({ ...tokenMetricBase, value: inputTokens, token_type: "input" });
      if (outputTokens > 0)
        out.metrics.push({ ...tokenMetricBase, value: outputTokens, token_type: "output" });
      if (cacheRead > 0)
        out.metrics.push({ ...tokenMetricBase, value: cacheRead, token_type: "cacheRead" });
      if (cacheWrite > 0)
        out.metrics.push({ ...tokenMetricBase, value: cacheWrite, token_type: "cacheCreation" });
      // Emit cost.usage metric so getUserTotals total_cost_usd aggregates correctly.
      // Note: this is *estimated* cost from token counts × pricing table, not measured.
      // pricing_source records how well the model id matched the price table, so a
      // fallback-priced row is traceable instead of blending into the totals.
      if (costUsd > 0) {
        out.metrics.push({
          ...base,
          metric_name: "claude_code.cost.usage",
          value: costUsd,
          model,
          pricing_source: pricingSource,
        });
      }
    }

    // Tool uses inside an assistant message → tool_result events. Best-effort.
    const blocks = line?.message?.content;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block && typeof block === "object" && (block as any).type === "tool_use") {
          out.events.push({
            ...base,
            event_name: "claude_code.tool_result",
            tool_name: String((block as any).name || ""),
          });
        }
      }
    }
    return out;
  }

  return out;
}

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
// ClickHouse client (minimal — avoids importing src/db/index which initialises SQLite)
// ─────────────────────────────────────────────────────────────────────────────

async function chQuery<T = any>(sql: string): Promise<T[]> {
  const url = new URL(CH_URL);
  url.searchParams.set("database", CH_DB);
  const res = await fetch(url.toString(), {
    method: "POST",
    body: `${sql} FORMAT JSONEachRow`,
    headers: { "Content-Type": "text/plain" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    throw new Error(`CH query failed (${res.status}): ${await res.text()}`);
  }
  const text = await res.text();
  if (!text.trim()) return [];
  return text.trim().split("\n").map((l) => JSON.parse(l)) as T[];
}

async function chInsert(table: string, rows: Record<string, any>[]): Promise<void> {
  if (rows.length === 0) return;
  const url = new URL(CH_URL);
  url.searchParams.set("database", CH_DB);
  url.searchParams.set("query", `INSERT INTO ${table} FORMAT JSONEachRow`);
  const body = rows.map((r) => JSON.stringify(r)).join("\n");
  const res = await fetch(url.toString(), {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    throw new Error(`CH insert failed (${res.status}): ${await res.text()}`);
  }
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
    FROM clawd.events_raw FINAL
    WHERE user_id = '${USER_ID}'
      AND timestamp >= toDateTime64('${fromStr}', 3)
      AND timestamp <  toDateTime64('${toStr}', 3)
  `;
  const prodRows = await chQuery<any>(sql);
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
      await chInsert("events_raw", eventsBatch);
      totalEvents += eventsBatch.length;
      eventsBatch = [];
    }
    if (metricsBatch.length) {
      await chInsert("metrics_raw", metricsBatch);
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
  const out: MappedRows = { events: [], metrics: [] };
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch {
    return out;
  }
  // Derive sessionId fallback from filename "<sessionId>.jsonl"
  const sessionFallback = file.split("/").pop()?.replace(/\.jsonl$/, "") || "";
  const isSubagentFile = file.includes("/subagents/");
  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    // Date filter
    const tsStr: string | undefined = parsed?.timestamp;
    if (!tsStr) continue;
    const ts = new Date(tsStr);
    if (args.from && ts < args.from) continue;
    if (args.to && ts >= args.to) continue;

    const mapped = mapLine(parsed, sessionFallback, isSubagentFile);
    out.events.push(...mapped.events);
    out.metrics.push(...mapped.metrics);
  }
  return out;
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
  const lines = raw.split("\n").filter((l) => l.length > 0);

  // Phase 1: parse + filter + dedupe in memory.
  type Entry = { ts: Date; sessionId: string; display: string };
  const seen = new Map<string, Entry>();
  let parsed = 0;
  let droppedSlash = 0;
  let droppedEmpty = 0;
  let droppedOutOfWindow = 0;
  let droppedDup = 0;

  for (const line of lines) {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    parsed++;
    if (typeof rec.timestamp !== "number" || typeof rec.display !== "string") continue;
    const display = rec.display.trim();
    if (display.length === 0) {
      droppedEmpty++;
      continue;
    }
    if (display.startsWith("/")) {
      droppedSlash++;
      continue;
    }
    const ts = new Date(rec.timestamp);
    if (isNaN(ts.getTime())) continue;
    if (ts < args.from) {
      droppedOutOfWindow++;
      continue;
    }
    if (ts >= to) {
      droppedOutOfWindow++;
      continue;
    }
    // Dedupe per-minute bucket to collapse up-arrow repeats with the same content.
    const sessionId = typeof rec.sessionId === "string" ? rec.sessionId : "";
    const minuteBucket = Math.floor(rec.timestamp / 60000);
    const key = `${sessionId}|${display.slice(0, 200)}|${minuteBucket}`;
    if (seen.has(key)) {
      droppedDup++;
      continue;
    }
    seen.set(key, { ts, sessionId, display });
  }

  console.log(
    `[from-history] parsed=${parsed}  in-window=${seen.size}  dropped: slash=${droppedSlash} empty=${droppedEmpty} out-of-window=${droppedOutOfWindow} dup=${droppedDup}`
  );

  // Phase 2: emit rows.
  const rows: EventRow[] = [];
  for (const e of seen.values()) {
    rows.push({
      timestamp: fmtTs(e.ts),
      user_id: USER_ID,
      session_id: e.sessionId,
      event_name: "claude_code.user_prompt",
      prompt_length: e.display.length,
      provenance: "backfill-history",
    });
  }

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
    await chInsert("events_raw", rows.slice(i, i + BATCH_SIZE));
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
