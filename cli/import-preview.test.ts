import { describe, expect, it } from "bun:test";
import {
  countRows,
  serverWouldDrop,
  splitByCoverage,
  type ImportCoverage,
} from "./import-preview";
import { ULTRATHINK_EVENT_NAME } from "../src/lib/ultrathink";
import type { ImportEventRow } from "../src/lib/session-import";

const row = (event_name: string, timestamp = "2026-01-01 10:00:00.000"): ImportEventRow =>
  ({ timestamp, user_id: "github_1", session_id: "s1", provenance: "import", event_name }) as ImportEventRow;

const prompt = (ts?: string) => row("claude_code.user_prompt", ts);
const apiRequest = (ts?: string) => row("claude_code.api_request", ts);
const flag = (ts?: string) => row(ULTRATHINK_EVENT_NAME, ts);

describe("countRows", () => {
  it("counts each kind of row by its event name", () => {
    const counts = countRows([prompt(), prompt(), apiRequest(), flag(), row("claude_code.tool_result")]);
    expect(counts).toEqual({ prompts: 2, apiRequests: 1, flags: 1, rows: 5 });
  });

  it("never counts an ultrathink flag as a prompt", () => {
    // The bug: a flag is a row of its own, so the rows a source contributed is
    // not the prompts it contributed.
    expect(countRows([flag(), flag(), flag()]).prompts).toBe(0);
    expect(countRows([flag(), flag(), flag()]).rows).toBe(3);
  });

  it("is empty for an empty import", () => {
    expect(countRows([])).toEqual({ prompts: 0, apiRequests: 0, flags: 0, rows: 0 });
  });
});

describe('the "of those" figure can never exceed the prompt total', () => {
  /**
   * The preview reports history.jsonl's share of the prompts, and the regression
   * was that it reported its share of the ROWS instead. Both figures now come
   * from countRows over the same arrays, with the history rows a subset of the
   * whole — so the invariant holds by construction, and this asserts it over
   * mixes that would have broken the old arithmetic.
   */
  const mixes: { name: string; history: ImportEventRow[]; transcripts: ImportEventRow[] }[] = [
    {
      name: "the owner's shape: every prompt from history, plus its flags",
      history: [...Array(1629)].flatMap((_, i) =>
        i % 2 === 0 ? [prompt(), flag()] : [prompt()]
      ),
      transcripts: [],
    },
    { name: "flags only from history", history: [flag(), flag(), flag()], transcripts: [prompt()] },
    { name: "nothing from history", history: [], transcripts: [prompt(), apiRequest(), flag()] },
    {
      name: "history and transcripts both contributing",
      history: [prompt(), flag(), prompt()],
      transcripts: [prompt(), apiRequest(), apiRequest(), flag()],
    },
  ];

  for (const mix of mixes) {
    it(mix.name, () => {
      // Exactly what runLocalImport does: the gap-filled history rows are
      // appended to the transcript rows, then both are counted.
      const all = [...mix.transcripts, ...mix.history];
      const fromHistory = countRows(mix.history);
      const total = countRows(all);

      expect(fromHistory.prompts).toBeLessThanOrEqual(total.prompts);
      expect(fromHistory.flags).toBeLessThanOrEqual(total.flags);
      expect(fromHistory.rows).toBeLessThanOrEqual(total.rows);
    });
  }

  it("would have caught the shipped bug", () => {
    const history = [prompt(), flag(), flag()];
    const total = countRows(history);
    // What the preview used to print — the row count — against the prompt total.
    expect(history.length).toBeGreaterThan(total.prompts);
    expect(countRows(history).prompts).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The new-vs-already split
// ═══════════════════════════════════════════════════════════════════════════

const CUTOFF = Date.parse("2026-05-06T00:00:00.000Z");
/** Later than the measured cutoff, which is the whole point of rule 8. */
const FLAG_CUTOFF = Date.parse("2026-09-01T00:00:00.000Z");

const coverageOf = (days: string[] = [], ultrathinkDays: string[] = []): ImportCoverage => ({
  days: new Set(days),
  ultrathinkDays: new Set(ultrathinkDays),
  cutoffMs: CUTOFF,
  flagCutoffMs: FLAG_CUTOFF,
});

const apiCall = (ts: string): ImportEventRow =>
  ({
    timestamp: ts,
    user_id: "github_1",
    session_id: "s1",
    provenance: "import",
    event_name: "claude_code.api_request",
    model: "claude-opus-5",
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  }) as ImportEventRow;

describe("serverWouldDrop", () => {
  it("keeps a measured row on an uncovered day before the cutoff", () => {
    expect(serverWouldDrop(prompt("2026-03-01 10:00:00.000"), coverageOf())).toBeNull();
  });

  it("drops a measured row on a day clawd.gg already has", () => {
    expect(serverWouldDrop(prompt("2026-03-01 10:00:00.000"), coverageOf(["2026-03-01"])))
      .toBe("covered-day");
  });

  it("drops a measured row at or after the live cutoff", () => {
    expect(serverWouldDrop(prompt("2026-05-06 00:00:00.000"), coverageOf())).toBe("after-cutoff");
    expect(serverWouldDrop(prompt("2026-05-05 23:59:59.999"), coverageOf())).toBeNull();
  });

  it("judges a flag by the FLAG cutoff, not the measured one", () => {
    // The window between the two is the gap nothing ever recorded — the reason
    // ImportDeps.flagCutoffMs exists at all. A flag in it is new.
    expect(serverWouldDrop(flag("2026-06-01 10:00:00.000"), coverageOf())).toBeNull();
    expect(serverWouldDrop(flag("2026-09-01 00:00:00.000"), coverageOf())).toBe("after-cutoff");
  });

  it("judges a flag by its OWN day set", () => {
    const coverage = coverageOf(["2026-03-01"], ["2026-03-02"]);
    // A day covered for prompts says nothing about whether its flags exist.
    expect(serverWouldDrop(flag("2026-03-01 10:00:00.000"), coverage)).toBeNull();
    expect(serverWouldDrop(flag("2026-03-02 10:00:00.000"), coverage)).toBe("covered-day");
    expect(serverWouldDrop(prompt("2026-03-02 10:00:00.000"), coverage)).toBeNull();
  });
});

describe("splitByCoverage", () => {
  it("splits the prompts into new and already-held", () => {
    const events = [
      prompt("2026-03-01 10:00:00.000"),
      prompt("2026-03-01 11:00:00.000"),
      prompt("2026-03-02 10:00:00.000"),
    ];
    const split = splitByCoverage(events, coverageOf(["2026-03-01"]));

    expect(split.found.prompts).toBe(3);
    expect(split.landing.prompts).toBe(1);
    expect(split.coveredDays).toEqual(["2026-03-01"]);
  });

  it("prices only what will land", () => {
    const events = [apiCall("2026-03-01 10:00:00.000"), apiCall("2026-03-02 10:00:00.000")];
    const split = splitByCoverage(events, coverageOf(["2026-03-01"]));

    expect(split.found.costUsd).toBeGreaterThan(0);
    expect(split.landing.costUsd).toBeCloseTo(split.found.costUsd / 2, 10);
  });

  it("never names a day covered because a row was past a cutoff", () => {
    // Rows after the cutoff are dropped for a different reason, and listing
    // their day as "already on clawd.gg" would point at an empty day.
    const split = splitByCoverage([prompt("2026-06-01 10:00:00.000")], coverageOf());

    expect(split.landing.rows).toBe(0);
    expect(split.coveredDays).toEqual([]);
  });

  it("reports everything as new when clawd.gg holds nothing", () => {
    const events = [prompt("2026-03-01 10:00:00.000"), apiCall("2026-03-01 10:00:01.000")];
    const split = splitByCoverage(events, coverageOf());

    expect(split.landing).toEqual(split.found);
    expect(split.coveredDays).toEqual([]);
  });

  it("can never report more new than found", () => {
    const events = [
      prompt("2026-03-01 10:00:00.000"),
      flag("2026-03-01 10:00:00.000"),
      prompt("2026-03-02 10:00:00.000"),
      apiCall("2026-03-02 10:00:01.000"),
      prompt("2026-10-01 10:00:00.000"),
      flag("2026-10-01 10:00:00.000"),
    ];
    for (const coverage of [
      coverageOf(),
      coverageOf(["2026-03-01"]),
      coverageOf(["2026-03-01", "2026-03-02"], ["2026-03-01"]),
      coverageOf([], ["2026-03-01", "2026-10-01"]),
    ]) {
      const split = splitByCoverage(events, coverage);
      for (const key of ["prompts", "apiRequests", "flags", "rows", "costUsd"] as const) {
        expect(split.landing[key]).toBeLessThanOrEqual(split.found[key]);
      }
    }
  });

  it("the owner's shape: most of the history already covered", () => {
    // 68 days of local history, 37 of them already imported by the legacy path.
    const days = [...Array(68)].map((_, i) =>
      new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 86_400_000).toISOString().slice(0, 10)
    );
    const events = days.map((day) => prompt(`${day} 10:00:00.000`));
    const split = splitByCoverage(events, coverageOf(days.slice(0, 37)));

    expect(split.found.prompts).toBe(68);
    expect(split.landing.prompts).toBe(31);
    expect(split.coveredDays.length).toBe(37);
  });
});
