// What `clawdgg import` says it is about to send, counted from exactly the rows
// it is about to send.
//
// Split out of index.ts because the preview had a counting bug that a unit test
// would have caught: the "of those prompts come from history.jsonl" line was
// fed `gaps.events.length`, and gaps.events holds BOTH the prompt rows and the
// ultrathink flag rows that history.jsonl produced. So it reported 2,665 of
// 1,629 prompts — more "of those" than there were.
//
// Every figure here is counted by event_name off the same array, which is what
// makes a subset's count necessarily smaller than the whole's.

import { ULTRATHINK_EVENT_NAME } from "../src/lib/ultrathink";
import { computeCostUsd, type ImportEventRow } from "../src/lib/session-import";

export interface RowCounts {
  /** Human-typed prompts. NOT the flags, which are their own rows. */
  prompts: number;
  apiRequests: number;
  /** "This prompt said ultrathink" — a yes/no, with no prompt in it. */
  flags: number;
  /** Everything, which is what actually goes over the wire. */
  rows: number;
}

export function countRows(events: readonly ImportEventRow[]): RowCounts {
  const counts: RowCounts = { prompts: 0, apiRequests: 0, flags: 0, rows: events.length };
  for (const event of events) {
    if (event.event_name === "claude_code.user_prompt") counts.prompts++;
    else if (event.event_name === "claude_code.api_request") counts.apiRequests++;
    else if (event.event_name === ULTRATHINK_EVENT_NAME) counts.flags++;
  }
  return counts;
}

/**
 * What the server has already got, as `GET /api/cli/import/coverage` answers
 * it. Parsed into sets and instants once, so the split below is arithmetic.
 */
export interface ImportCoverage {
  /** UTC days that already hold a measured row of any provenance. */
  days: ReadonlySet<string>;
  /** UTC days that already hold an ultrathink flag — a separate question. */
  ultrathinkDays: ReadonlySet<string>;
  /** Measured rows at or after this are refused. */
  cutoffMs: number;
  /** Flags at or after this are refused, and it is NOT the same instant. */
  flagCutoffMs: number;
}

export interface PreviewTotals extends RowCounts {
  /** What the server will price these rows at, not what the mapper claimed. */
  costUsd: number;
}

/**
 * The cost the server will compute for these rows.
 *
 * Deliberately NOT the mapper's own `cost_usd`: the server recomputes cost from
 * model + token counts (it does not trust a client's arithmetic about money).
 * Pricing the preview from exactly the fields we are about to upload — the
 * cache-creation total AND its 1h share — is what keeps "we'll upload $X" and
 * "clawd.gg says $X" the same number.
 */
export function previewCostUsd(events: readonly ImportEventRow[]): number {
  let total = 0;
  for (const event of events) {
    if (event.event_name !== "claude_code.api_request") continue;
    const cacheWrite = event.cache_write_tokens ?? 0;
    const cacheWrite1h = Math.min(event.cache_write_1h_tokens ?? 0, cacheWrite);
    total += computeCostUsd(event.model ?? "", {
      input_tokens: event.input_tokens ?? 0,
      output_tokens: event.output_tokens ?? 0,
      cache_read_input_tokens: event.cache_read_tokens ?? 0,
      cache_creation_input_tokens: cacheWrite,
      cache_creation: {
        ephemeral_1h_input_tokens: cacheWrite1h,
        ephemeral_5m_input_tokens: cacheWrite - cacheWrite1h,
      },
    }).costUsd;
  }
  return total;
}

export function previewTotals(events: readonly ImportEventRow[]): PreviewTotals {
  return { ...countRows(events), costUsd: previewCostUsd(events) };
}

/** ms since epoch for the mapper's 'YYYY-MM-DD HH:MM:SS.sss' UTC literal. */
function rowMs(timestamp: string): number {
  return Date.parse(`${timestamp.replace(" ", "T")}Z`);
}

/**
 * Whether the import endpoint would keep this row, by its own rules 6–8.
 *
 * Measured rows answer to the live-telemetry cutoff and the covered-day set;
 * flags answer to the hook's cutoff and their own day set, because a day being
 * counted for prompts says nothing about whether its flags were ever recorded.
 * Mirroring the server is the only way to preview it, and it is mirrored at the
 * level of the rules rather than the numbers — the endpoint hands over the sets
 * and the instants it will itself judge by, so there is nothing here to keep in
 * sync but this predicate.
 *
 * Not modelled, because none of them change the answer the user is asking:
 * in-batch duplicates, token clamping, and the 2025-02-01 floor (nothing local
 * predates Claude Code).
 *
 * The reason matters and is not collapsed into a boolean: "clawd.gg already has
 * that day" and "that is past where live data takes over" are different facts
 * about an import, and only the first is a day the user could go and look at.
 */
export type DropReason = "covered-day" | "after-cutoff";

export function serverWouldDrop(
  event: ImportEventRow,
  coverage: ImportCoverage
): DropReason | null {
  const day = event.timestamp.slice(0, 10);
  const ms = rowMs(event.timestamp);
  const flag = event.event_name === ULTRATHINK_EVENT_NAME;

  const cutoffMs = flag ? coverage.flagCutoffMs : coverage.cutoffMs;
  if (Number.isFinite(ms) && ms >= cutoffMs) return "after-cutoff";

  const days = flag ? coverage.ultrathinkDays : coverage.days;
  return days.has(day) ? "covered-day" : null;
}

export interface PreviewSplit {
  /** Everything the CLI found locally and will send. */
  found: PreviewTotals;
  /** The part of it the server will actually keep. */
  landing: PreviewTotals;
  /** The days of this history clawd.gg already holds, sorted. */
  coveredDays: string[];
}

/**
 * Split a preview into what is new and what the server already has.
 *
 * Every row is still uploaded — the server is the one that decides, and this is
 * a forecast of its decision, not a replacement for it. What changes is that
 * the user is told "742 new of 1,629" instead of "1,629", which for the owner's
 * first run was the difference between 68 days and the 31 of them that were not
 * already covered by a legacy import.
 */
export function splitByCoverage(
  events: readonly ImportEventRow[],
  coverage: ImportCoverage
): PreviewSplit {
  const landing: ImportEventRow[] = [];
  const coveredDays = new Set<string>();

  for (const event of events) {
    const reason = serverWouldDrop(event, coverage);
    if (reason === null) landing.push(event);
    // Only a day clawd.gg actually holds. A row past a cutoff is dropped for a
    // different reason, and naming its day "already on clawd.gg" would send
    // someone to look at a day that is empty.
    else if (reason === "covered-day") coveredDays.add(event.timestamp.slice(0, 10));
  }

  return {
    found: previewTotals(events),
    landing: previewTotals(landing),
    coveredDays: [...coveredDays].sort(),
  };
}
