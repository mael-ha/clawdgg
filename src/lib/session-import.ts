/**
 * Claude Code JSONL → OTLP-equivalent rows.
 *
 * One mapper, three callers:
 *   - src/scripts/backfill-jsonl.ts  (operator-run, provenance='backfill')
 *   - cli/index.ts `clawdgg import`  (user-run, provenance='import')
 *   - its tests
 *
 * It is deliberately pure: no filesystem, no ClickHouse, no module-level
 * mutable state. The CLI bundles this file into a compiled binary, so it must
 * not reach for anything a `bun build --compile` target can't carry.
 *
 * What it reads (per line of ~/.claude/projects/**\/*.jsonl):
 *   type:"user"       → claude_code.user_prompt  (prompt LENGTH, never text)
 *   type:"assistant"  → claude_code.api_request + token/cost metrics
 *                     → claude_code.tool_result per tool_use block
 *
 * What it deliberately drops, to match what live OTEL emits:
 *   - subagent files and isSidechain lines: those user prompts are Task-tool
 *     delegations written by the orchestrator, not typed by a human
 *   - model="<synthetic>" assistant rows: locally generated placeholders with
 *     all-zero usage that would inflate api-requests-per-prompt
 *   - built-in slash commands (/clear, /compact, …): session management, not work
 *
 * ONE PROMPT RULE, EVERY SOURCE. Built-in slash commands are dropped and
 * custom / skill / MCP commands are kept, which is exactly what
 * PROMPT_EVENT_SQL does to live OTEL rows via command_source. It is the
 * default here rather than an option a caller might forget, because a source
 * that applied a different rule would make the headline prompt number mean
 * something different depending on which days you were looking at.
 */

import {
  getModelPricingDetailed,
  splitCacheCreationTokens,
  type PricingMatchQuality,
} from "./pricing";
import { ULTRATHINK_EVENT_NAME, containsUltrathink } from "./ultrathink";

export type Provenance = "live" | "backfill" | "backfill-history" | "import";

/**
 * Superset of src/db/clickhouse.ts's EventRow: the provenance union there is
 * narrower than the ClickHouse column (a plain `String DEFAULT 'live'`), and
 * `pricing_source` exists in the DDL but not yet in that interface. Rows cross
 * into clickhouse.ts's types at the insert boundary.
 */
export interface ImportEventRow {
  timestamp: string; // 'YYYY-MM-DD HH:MM:SS.sss', UTC
  user_id: string;
  session_id: string;
  event_name: string;
  prompt_length?: number;
  tool_name?: string;
  /**
   * Claude Code's own id for a tool call. Part of EVENT_IDENTITY_COLUMNS, and
   * the only thing that keeps two calls to the SAME tool inside one assistant
   * message (same millisecond, same tool_name) from hashing to one row.
   */
  tool_use_id?: string;
  model?: string;
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  /**
   * How many of `cache_write_tokens` were written with a 1-HOUR TTL, which
   * bills at 2x input against the 5m rate's 1.25x.
   *
   * WIRE-ONLY: there is no ClickHouse column for it, deliberately — api_request
   * reports a single untyped cache-creation total, so a column would be empty
   * on every live row (see the "NOT added" note in
   * docker/clickhouse/migrations/2026-10-18_add_otel_attributes.sql). It exists
   * so `clawdgg import` can tell the server the split it read out of the
   * transcript, letting the server reprice the row the way the operator-run
   * backfill does instead of pricing all cache writes at the 5m rate (~22% low
   * on cache-write cost over the current corpus).
   *
   * ANYTHING THAT INSERTS THESE ROWS DIRECTLY must drop it first —
   * withoutWireOnlyFields() below — or the insert dies on an unknown column.
   */
  cache_write_1h_tokens?: number;
  /**
   * `message.usage.speed` as the transcript records it ('standard' | 'fast').
   * Stored, not just used: a row billed at Opus fast-mode rates has to say so
   * for its cost to be reconcilable, and it is part of the row identity, so a
   * fast and a standard call in the same millisecond stay two rows.
   */
  speed?: string;
  provenance: Provenance;
  pricing_source?: PricingMatchQuality;
}

export interface ImportMetricRow {
  timestamp: string;
  user_id: string;
  session_id: string;
  metric_name: string;
  value: number;
  model?: string;
  token_type?: string;
  speed?: string;
  provenance: Provenance;
  pricing_source?: PricingMatchQuality;
}

export interface MappedRows {
  events: ImportEventRow[];
  metrics: ImportMetricRow[];
}

export interface MapOptions {
  userId: string;
  provenance: Provenance;
  /** sessionId to use when a line doesn't carry one (from the file name). */
  sessionFallback: string;
  /** Lines from a `subagents/` file never produce user_prompt events. */
  isSubagentFile: boolean;
  /**
   * Drop user_prompt events whose text is a built-in slash command.
   *
   * ON BY DEFAULT, because this is THE prompt rule and it has to be the same
   * rule on every source — PROMPT_EVENT_SQL applies it to live OTEL rows by
   * excluding command_source='builtin', and reconstructed rows carry no
   * command_source, so the only place it can be applied to them is here. A
   * source that opted out would contribute prompts the live path would not
   * have counted, and the headline number would mean two different things
   * depending on where a day's data came from.
   *
   * Pass `false` only to deliberately count built-ins, which nothing does.
   */
  excludeBuiltinSlashPrompts?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in slash commands
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Claude Code's own session/UI/config commands. Typing one is not a prompt —
 * no model is asked anything — so it must not land in the prompt count.
 *
 * Deliberately NOT in here: the bundled skills and workflow commands
 * (/code-review, /security-review, /simplify, /init, /review, /deep-research,
 * /loop, …). Those do real work through the model, so they count exactly like
 * a typed prompt does. Same for any custom, plugin or MCP command.
 *
 * Erring short is the safe direction: a command we fail to list is counted as
 * a prompt (a small overcount), while listing a real one would silently lose
 * work from someone's history.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  "add-dir", "agents", "autocompact", "background", "bashes", "bug", "cd",
  "clear", "color", "compact", "config", "context", "continue", "copy", "cost",
  "debug", "diff", "doctor", "effort", "exit", "export", "feedback", "focus",
  "fork", "heapdump", "help", "hooks", "ide", "install-github-app",
  "install-slack-app", "keybindings", "list-agents", "login", "logout", "mcp",
  "memory", "migrate-installer", "model", "new", "output-style", "passes",
  "peers", "permissions", "plugin", "pr-comments", "privacy-settings", "quit",
  "rate-limit-options", "release-notes", "reload-plugins", "reload-skills",
  "remote-control", "remote-env", "rename", "reset", "resume", "rewind",
  "sandbox", "scroll-speed", "settings", "setup-bedrock", "setup-vertex",
  "share", "skill-doctor", "skills", "stats", "status", "statusline",
  "stickers", "stop", "tasks", "teleport", "terminal-setup", "theme", "todos",
  "tui", "undo", "upgrade", "usage", "usage-credits", "vim", "voice",
]);

/**
 * Claude Code wraps a dispatched command in XML-ish tags rather than storing
 * the raw text. Both orderings occur in real transcripts:
 *
 *   <command-name>/compact</command-name>
 *     <command-message>compact</command-message><command-args></command-args>
 *   <command-message>init</command-message>
 *     <command-name>/init</command-name>
 *
 * so the name is extracted from wherever the tag is, not by assuming it comes
 * first. Without this the wrapped text does not start with "/" at all, every
 * built-in command read as a free-typed prompt, and /compact and /model
 * inflated the count.
 */
const COMMAND_NAME_TAG = /<command-name>\s*([^<]*?)\s*<\/command-name>/;

/** True for `/clear`, `/model opus`, … and false for `/code-review`, `/my-cmd`. */
export function isBuiltinSlashCommand(text: string): boolean {
  const tagged = COMMAND_NAME_TAG.exec(text);
  const trimmed = (tagged ? tagged[1]! : text).trimStart();
  if (!trimmed.startsWith("/")) return false;
  const name = trimmed.slice(1).split(/[\s:]/, 1)[0]?.toLowerCase() ?? "";
  return BUILTIN_SLASH_COMMANDS.has(name);
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

/** Format a JS Date as ClickHouse DateTime64(3): "YYYY-MM-DD HH:MM:SS.sss" (UTC) */
export function fmtTs(d: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.` +
    `${pad(d.getUTCMilliseconds(), 3)}`
  );
}

/** Character count of a message's content — the only thing we take from it. */
export function contentLength(content: unknown): number {
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

/** The plain text of a message's content, for slash-command detection only. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && typeof (block as any).text === "string") {
        return (block as any).text;
      }
    }
  }
  return "";
}

export interface CostEstimate {
  costUsd: number;
  pricingSource: PricingMatchQuality;
  /**
   * The usage object had no nested `cache_creation` breakdown, so its
   * cache-creation tokens were all priced at the 5m rate and this row's
   * cache-write cost is understated.
   */
  usedFlatCacheFallback: boolean;
}

/**
 * USD cost from token usage + model, plus how the price was looked up.
 *
 * Cache creation is billed per TTL: 1h costs 2x input, 5m costs 1.25x. Pricing
 * everything at 5m understates cache-write cost by ~22% on the current corpus,
 * where 37% of cache-creation tokens are 1h.
 *
 * Two prices depend on the request rather than the model id, and both are
 * decidable from this one usage block:
 *   - `usage.speed === 'fast'` is Opus fast mode, billed at 2x.
 *   - a prompt over 100K tokens pays Haiku 5.5's higher tier. "Prompt length"
 *     is every input token including cache reads and cache writes, which is
 *     what promptTokens sums below.
 */
export function computeCostUsd(model: string, usage: any): CostEstimate {
  const input = Number(usage?.input_tokens ?? 0);
  const output = Number(usage?.output_tokens ?? 0);
  const cacheRead = Number(usage?.cache_read_input_tokens ?? 0);
  const { tokens5m, tokens1h, fromFlatFallback } = splitCacheCreationTokens(usage);

  const { pricing: p, matchQuality } = getModelPricingDetailed(model || "", {
    speed: typeof usage?.speed === "string" ? usage.speed : undefined,
    promptTokens: input + cacheRead + tokens5m + tokens1h,
  });

  return {
    costUsd:
      (input * p.input +
        output * p.output +
        cacheRead * p.cacheRead +
        tokens5m * p.cacheWrite5m +
        tokens1h * p.cacheWrite1h) / 1_000_000,
    pricingSource: matchQuality,
    usedFlatCacheFallback: fromFlatFallback,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Line → rows
// ─────────────────────────────────────────────────────────────────────────────

export interface MapLineResult extends MappedRows {
  /** Rows whose cache-creation cost had to fall back to the flat 5m rate. */
  flatCacheFallbacks: number;
}

/** Map one already-JSON-parsed JSONL line. Unmappable lines return nothing. */
export function mapLine(line: any, opts: MapOptions): MapLineResult {
  const out: MapLineResult = { events: [], metrics: [], flatCacheFallbacks: 0 };

  const tsStr: string | undefined = line?.timestamp;
  if (!tsStr) return out;
  const ts = new Date(tsStr);
  if (isNaN(ts.getTime())) return out;

  const sessionId: string = line?.sessionId || opts.sessionFallback;
  const base = {
    timestamp: fmtTs(ts),
    user_id: opts.userId,
    session_id: sessionId,
    provenance: opts.provenance,
  };

  const type: string | undefined = line?.type;
  const isSidechain: boolean = line?.isSidechain === true;

  if (type === "user") {
    // Only top-level human-typed prompts. Subagent files and isSidechain lines
    // carry orchestrator-internal prompts (Task tool delegations) that live
    // OTEL does NOT emit as user_prompt events.
    if (opts.isSubagentFile || isSidechain) return out;
    const content = line?.message?.content;
    const text = contentText(content);
    if (opts.excludeBuiltinSlashPrompts !== false && isBuiltinSlashCommand(text)) {
      return out;
    }
    out.events.push({
      ...base,
      event_name: "claude_code.user_prompt",
      prompt_length: contentLength(content),
    });
    // The ultrathink flag, decided here and nowhere else. The transcript is the
    // better source than history.jsonl for a day it still covers: it holds the
    // prompt as submitted, with no up-arrow repeats to collapse.
    if (containsUltrathink(text)) {
      out.events.push({ ...base, event_name: ULTRATHINK_EVENT_NAME });
    }
    return out;
  }

  if (type === "assistant") {
    const usage = line?.message?.usage;
    const model: string = line?.message?.model || "";

    if (model === "<synthetic>") return out;

    if (usage && (usage.input_tokens != null || usage.output_tokens != null)) {
      const inputTokens = Number(usage.input_tokens ?? 0);
      const outputTokens = Number(usage.output_tokens ?? 0);
      const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
      const cacheWrite = Number(usage.cache_creation_input_tokens ?? 0);
      const { costUsd, pricingSource, usedFlatCacheFallback } = computeCostUsd(model, usage);
      if (usedFlatCacheFallback) out.flatCacheFallbacks++;
      const speed = typeof usage.speed === "string" ? usage.speed : "";
      // Carried so the import endpoint can reprice this row at the same rates
      // computeCostUsd just used. Omitted when there is nothing to say, which
      // keeps it off the ~63% of rows that are all-5m.
      const { tokens1h } = splitCacheCreationTokens(usage);

      out.events.push({
        ...base,
        event_name: "claude_code.api_request",
        model,
        speed,
        cost_usd: costUsd,
        pricing_source: pricingSource,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        ...(tokens1h > 0 && { cache_write_1h_tokens: tokens1h }),
      });

      const tokenMetricBase = { ...base, metric_name: "claude_code.token.usage", model, speed };
      if (inputTokens > 0)
        out.metrics.push({ ...tokenMetricBase, value: inputTokens, token_type: "input" });
      if (outputTokens > 0)
        out.metrics.push({ ...tokenMetricBase, value: outputTokens, token_type: "output" });
      if (cacheRead > 0)
        out.metrics.push({ ...tokenMetricBase, value: cacheRead, token_type: "cacheRead" });
      if (cacheWrite > 0)
        out.metrics.push({ ...tokenMetricBase, value: cacheWrite, token_type: "cacheCreation" });

      // cost.usage so getUserTotals' total_cost_usd aggregates correctly. This
      // is *estimated* from token counts × pricing table, not measured, and
      // pricing_source records how well the model id matched the price table.
      if (costUsd > 0) {
        out.metrics.push({
          ...base,
          metric_name: "claude_code.cost.usage",
          value: costUsd,
          model,
          speed,
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
            tool_use_id: String((block as any).id || ""),
          });
        }
      }
    }
    return out;
  }

  return out;
}

/**
 * Drop the fields that exist only on the wire to POST /api/cli/import.
 *
 * Call this on any path that hands these rows to insertEvents() instead of to
 * the import endpoint: the mapper's rows are a superset of the events_raw
 * columns, and ClickHouse fails a JSONEachRow insert that names a column it
 * does not have. The list is short on purpose — a wire-only field is a cost to
 * every caller, so add one only when the server genuinely cannot derive it.
 */
export function withoutWireOnlyFields(rows: ImportEventRow[]): ImportEventRow[] {
  return rows.map(({ cache_write_1h_tokens, ...row }) => row);
}

export interface MapTextOptions extends MapOptions {
  /** Keep only lines at or after this instant. */
  from?: Date;
  /** Keep only lines strictly before this instant. */
  to?: Date;
}

/** Map a whole JSONL file's text. Malformed lines are skipped, not fatal. */
export function mapJsonlText(raw: string, opts: MapTextOptions): MapLineResult {
  const out: MapLineResult = { events: [], metrics: [], flatCacheFallbacks: 0 };

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const tsStr: string | undefined = parsed?.timestamp;
    if (!tsStr) continue;
    const ts = new Date(tsStr);
    if (isNaN(ts.getTime())) continue;
    if (opts.from && ts < opts.from) continue;
    if (opts.to && ts >= opts.to) continue;

    const mapped = mapLine(parsed, opts);
    out.events.push(...mapped.events);
    out.metrics.push(...mapped.metrics);
    out.flatCacheFallbacks += mapped.flatCacheFallbacks;
  }

  return out;
}

/** Derive the session-id fallback and subagent flag from a transcript path. */
export function describeTranscriptPath(path: string): {
  sessionFallback: string;
  isSubagentFile: boolean;
} {
  return {
    sessionFallback: path.split("/").pop()?.replace(/\.jsonl$/, "") || "",
    isSubagentFile: path.includes("/subagents/"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ~/.claude/history.jsonl → user_prompt events
// ─────────────────────────────────────────────────────────────────────────────
//
// history.jsonl is the chronological log of every prompt typed at the REPL. It
// persists far longer than the per-session transcripts (which rotate at ~60d),
// so it's the only source for prompt counts in older windows — at the cost of
// carrying slash commands and up-arrow repeats, which we filter here.

export type HistorySlashPolicy = "drop-all" | "drop-builtin";

export interface HistoryOptions {
  userId: string;
  provenance: Provenance;
  from?: Date;
  to?: Date;
  /**
   * 'drop-builtin' is the prompt rule and the default: built-ins out, custom /
   * skill / MCP commands in, exactly as PROMPT_EVENT_SQL treats live rows.
   *
   * 'drop-all' drops every slash entry. It was the backfill's original
   * behaviour and is kept only for comparing a historical run against a new
   * one — it UNDERCOUNTS, because a custom or MCP command is a real request to
   * a model and the live path counts it.
   */
  slashPolicy?: HistorySlashPolicy;
}

export interface HistoryResult {
  events: ImportEventRow[];
  parsed: number;
  droppedSlash: number;
  droppedEmpty: number;
  droppedOutOfWindow: number;
  droppedDuplicate: number;
  /** Prompts that contained the word "ultrathink". A count, from a yes/no. */
  ultrathinks: number;
}

/**
 * Map history.jsonl text. Prompt text is used for filtering only, never emitted.
 *
 * Including the ultrathink flag: the word is matched HERE, on the user's own
 * machine, and what leaves is a second event row carrying a timestamp and a
 * session id — no text, no length, no hash. It is the same matcher the live
 * hook uses (src/lib/ultrathink.ts), so an imported month and a live month mean
 * the same thing.
 */
export function mapHistoryText(raw: string, opts: HistoryOptions): HistoryResult {
  const result: HistoryResult = {
    events: [],
    parsed: 0,
    droppedSlash: 0,
    droppedEmpty: 0,
    droppedOutOfWindow: 0,
    droppedDuplicate: 0,
    ultrathinks: 0,
  };

  const seen = new Set<string>();

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    result.parsed++;

    if (typeof rec.timestamp !== "number" || typeof rec.display !== "string") continue;

    const display = rec.display.trim();
    if (display.length === 0) {
      result.droppedEmpty++;
      continue;
    }
    if (display.startsWith("/") || display.includes("<command-name>")) {
      if (opts.slashPolicy === "drop-all" || isBuiltinSlashCommand(display)) {
        result.droppedSlash++;
        continue;
      }
    }

    const ts = new Date(rec.timestamp);
    if (isNaN(ts.getTime())) continue;
    if ((opts.from && ts < opts.from) || (opts.to && ts >= opts.to)) {
      result.droppedOutOfWindow++;
      continue;
    }

    // Collapse up-arrow repeats: same session, same text, same minute.
    const sessionId = typeof rec.sessionId === "string" ? rec.sessionId : "";
    const key = `${sessionId}|${display.slice(0, 200)}|${Math.floor(rec.timestamp / 60000)}`;
    if (seen.has(key)) {
      result.droppedDuplicate++;
      continue;
    }
    seen.add(key);

    const base = {
      timestamp: fmtTs(ts),
      user_id: opts.userId,
      session_id: sessionId,
      provenance: opts.provenance,
    };

    result.events.push({
      ...base,
      event_name: "claude_code.user_prompt",
      prompt_length: display.length,
    });

    // A separate row rather than a column on the prompt: there is no OTEL
    // attribute for this, so a live flag has nowhere else to go either, and one
    // storage shape for both sources is what keeps the counts comparable.
    if (containsUltrathink(display)) {
      result.ultrathinks++;
      result.events.push({ ...base, event_name: ULTRATHINK_EVENT_NAME });
    }
  }

  return result;
}

/**
 * Keep only the history-derived prompts for days the transcripts don't cover.
 *
 * Both sources describe the same prompts, and they do NOT agree to the
 * millisecond (history records when you hit enter, the transcript when the
 * line was written), so dedup can't catch the overlap — importing both would
 * double every prompt. history.jsonl is only useful where the transcripts have
 * rotated away, which is a whole-day phenomenon: a day either has transcripts
 * or it doesn't.
 */
export function fillPromptGapsFromHistory(
  transcriptEvents: ImportEventRow[],
  historyEvents: ImportEventRow[]
): { events: ImportEventRow[]; coveredDays: number; gapDays: string[] } {
  const covered = new Set<string>();
  for (const event of transcriptEvents) {
    if (event.event_name === "claude_code.user_prompt") covered.add(event.timestamp.slice(0, 10));
  }

  const gapDays = new Set<string>();
  const events: ImportEventRow[] = [];
  for (const event of historyEvents) {
    const day = event.timestamp.slice(0, 10);
    if (covered.has(day)) continue;
    gapDays.add(day);
    events.push(event);
  }

  return { events, coveredDays: covered.size, gapDays: [...gapDays].sort() };
}

// Row identity (what makes a re-import a no-op) is NOT defined here: it is
// src/db/clickhouse.ts's `eventRowId` / `metricRowId`, the same hash the
// ReplacingMergeTree sorting key ends in. Keeping a second notion of identity
// in this file is how the two would drift.
