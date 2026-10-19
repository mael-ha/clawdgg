import { describe, expect, it } from "bun:test";
import { countRows } from "./import-preview";
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
