/**
 * The ultrathink flag is a SYNTHETIC event in the same table as the measured
 * ones, so the read layer has to be unable to mistake it for one.
 *
 * Why a grep and not a behavioural test: the risk is not that any one query is
 * wrong today, it is that a query added next month counts rows without naming
 * the event it means. That is a property of the whole read layer — the same
 * reason no-legacy-reads.test.ts exists — and nothing else would notice the
 * regression until a prompt count was already wrong in public.
 *
 * The defence is the `clawdgg.` prefix: every measured event is
 * `claude_code.*`, so a query that names its event cannot pick these up. What
 * follows checks that every count over events_raw names one.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAPPED_ULTRATHINKS_SQL,
  PROMPT_EVENT_SQL,
  ULTRATHINK_EVENT_NAME,
  ULTRATHINK_EVENT_SQL,
  eventRowId,
} from './clickhouse';
import { containsUltrathink } from '../lib/ultrathink';

const SRC = join(import.meta.dir, '..');
const clickhouse = readFileSync(join(SRC, 'db/clickhouse.ts'), 'utf8');
const fingerprint = readFileSync(join(SRC, 'lib/fingerprint.ts'), 'utf8');

describe('the flag cannot be mistaken for a measurement', () => {
  it('is named outside the claude_code namespace', () => {
    expect(ULTRATHINK_EVENT_NAME).toBe('clawdgg.ultrathink');
    expect(ULTRATHINK_EVENT_NAME.startsWith('claude_code.')).toBe(false);
  });

  it('is excluded by the prompt predicate, which names its event', () => {
    expect(PROMPT_EVENT_SQL).toContain("event_name = 'claude_code.user_prompt'");
    expect(PROMPT_EVENT_SQL).not.toContain(ULTRATHINK_EVENT_NAME);
  });

  /**
   * Every query that counts rows in events_raw must constrain event_name.
   * A bare `count()` or `COUNT(*)` over the table would include the flags —
   * which is exactly how an ultrathink would become a prompt.
   *
   * Whole template literals, not the text after `FROM`: the predicate often
   * lives in the SELECT (`countIf(${PROMPT_EVENT_SQL})`), which comes first.
   */
  it.each([
    ['db/clickhouse.ts', clickhouse],
    ['lib/fingerprint.ts', fingerprint],
  ])('%s never counts events_raw rows without naming the event', (_name, source) => {
    const queries = (source.match(/`[^`]*FROM events_raw[^`]*`/g) ?? []);
    const offenders: string[] = [];

    for (const sql of queries) {
      // countIf() always carries its own condition; a bare count does not.
      const bareCount = /(?<!If)\s*\((?:\s*\*\s*|\s*|\s*DISTINCT[^)]*)\)/i;
      const counts = sql
        .split(/\bcount/i)
        .slice(1)
        .some((tail) => bareCount.test(tail.slice(0, 40)));
      if (!counts) continue;
      const namesEvent =
        sql.includes('event_name') ||
        sql.includes('${PROMPT_EVENT_SQL}') ||
        sql.includes('${ULTRATHINK_EVENT_SQL}') ||
        // CAPPED_ULTRATHINKS_SQL is two countIfs, both naming their event.
        sql.includes('${CAPPED_ULTRATHINKS_SQL}') ||
        sql.includes('${CLAUDE_CODE_EVENT_SQL}');
      if (!namesEvent) offenders.push(sql.slice(0, 200).replace(/\s+/g, ' ').trim());
    }

    // Sanity: the sweep has to have found queries at all, or it proves nothing.
    expect(queries.length).toBeGreaterThan(3);
    expect(offenders).toEqual([]);
  });

  it('is counted only where it is asked for by name', () => {
    expect(ULTRATHINK_EVENT_SQL).toBe(`event_name = '${ULTRATHINK_EVENT_NAME}'`);

    // The readers go through CAPPED_ULTRATHINKS_SQL, which is BUILT from that
    // predicate — so the flag is still only ever counted by name, and now it is
    // also capped at the number of prompts the same day holds. The fingerprint
    // used to count it bare; a bare count can exceed its own denominator.
    expect(CAPPED_ULTRATHINKS_SQL).toContain(ULTRATHINK_EVENT_SQL);
    expect(CAPPED_ULTRATHINKS_SQL).toContain(PROMPT_EVENT_SQL);
    expect(CAPPED_ULTRATHINKS_SQL).toStartWith('least(');
    expect(fingerprint).toContain('CAPPED_ULTRATHINKS_SQL');
    expect(fingerprint).not.toMatch(/countIf\(\$\{ULTRATHINK_EVENT_SQL\}\)/);
  });

  // api_request and tool_result are the other two counts a flag could pollute.
  it.each(['claude_code.api_request', 'claude_code.tool_result'])(
    'every count of %s names that event explicitly',
    (eventName) => {
      for (const source of [clickhouse, fingerprint]) {
        const uses = source.split(eventName).length - 1;
        if (uses === 0) continue;
        expect(source).toContain(`event_name = '${eventName}'`);
      }
    }
  );
});

describe('flag rows are idempotent by identity', () => {
  const row = {
    timestamp: '2026-10-18 09:00:00.000',
    user_id: 'github_1',
    session_id: 's1',
    event_name: ULTRATHINK_EVENT_NAME,
    provenance: 'hook' as const,
  };

  // The whole de-duplication story for this endpoint: a retried report, or the
  // same prompt reported twice, must land on one row.
  it('hashes a repeated report identically', () => {
    expect(eventRowId(row)).toBe(eventRowId({ ...row }));
  });

  it('separates two reports a millisecond apart', () => {
    expect(eventRowId(row)).not.toBe(
      eventRowId({ ...row, timestamp: '2026-10-18 09:00:00.001' })
    );
  });

  // The live hook and the history import are different sources for the same
  // fact, so they must not collapse onto each other — provenance is in the key.
  it('separates a hook report from an imported one', () => {
    expect(eventRowId(row)).not.toBe(eventRowId({ ...row, provenance: 'import' }));
  });
});

describe('containsUltrathink', () => {
  it.each([
    'ultrathink this',
    'ULTRATHINK',
    'Ultrathink and then plan',
    'please ultrathink.',
    'go deep (ultrathink)',
    'ultrathink, then plan',
  ])('matches %p', (text) => {
    expect(containsUltrathink(text)).toBe(true);
  });

  // "ultrathinking" is deliberately NOT a match — see src/lib/ultrathink.ts.
  it.each(['multrathink', 'ultra think', 'ultrathin', 'ultrathinking', 'think hard', ''])(
    'does not match %p',
    (text) => {
      expect(containsUltrathink(text)).toBe(false);
    }
  );

  it('is false for anything that is not a string', () => {
    expect(containsUltrathink(undefined)).toBe(false);
    expect(containsUltrathink(null)).toBe(false);
    expect(containsUltrathink({ prompt: 'ultrathink' })).toBe(false);
  });
});
