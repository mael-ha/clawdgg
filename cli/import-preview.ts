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
import type { ImportEventRow } from "../src/lib/session-import";

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
