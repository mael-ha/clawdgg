/**
 * Every FULL OUTER JOIN in the read layer must ask for NULLs.
 *
 * ClickHouse fills an unmatched side with the column's DEFAULT instead, so
 * `COALESCE(e.user_id, m.user_id)` reads `''` and `COALESCE(e.date, m.date)`
 * reads `1970-01-01` for a row that only exists on the metrics side. Both were
 * live: a day with token rows and no events came back dated 1970 (which the
 * sync job stored as the user's first session), and a user with metric rows and
 * no events came back under the empty id.
 *
 * Verified against a real clickhouse-local, which is why this file does not
 * need one — the behaviour is settled, and what can still go wrong is someone
 * adding a seventh join without the setting. That is a property of the SOURCE,
 * so the source is what is asserted.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOIN_NULLS_SETTING } from './clickhouse';

// Comments go first: this file's own prose names FULL OUTER JOIN, and so does
// the note on JOIN_NULLS_SETTING, and neither is a statement.
const SOURCE = readFileSync(join(import.meta.dir, 'clickhouse.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * The template literal each join sits in, from its `const sql = \`` (or the
 * `query(\`` that replaces it) to the backtick that closes it. Crude on
 * purpose: a join and its SETTINGS clause are always in one literal, and
 * anything cleverer would be a SQL parser.
 */
function statementsWithFullOuterJoin(): string[] {
  const out: string[] = [];
  for (const literal of SOURCE.split('`')) {
    if (literal.includes('FULL OUTER JOIN')) out.push(literal);
  }
  return out;
}

describe('FULL OUTER JOIN', () => {
  const statements = statementsWithFullOuterJoin();

  it('is used by the queries that join events to metrics', () => {
    // Six today: totals, daily metrics, the leaderboard, a user's rank, the
    // velocity trend and the provenance breakdown. The number is here so that
    // adding one is a deliberate act with a test to update.
    expect(statements.length).toBe(6);
  });

  it('always asks ClickHouse for NULLs on the unmatched side', () => {
    const missing = statements
      .filter((sql) => !sql.includes('JOIN_NULLS_SETTING') && !sql.includes('join_use_nulls'))
      .map((sql) => sql.trim().slice(0, 120));
    expect(missing).toEqual([]);
  });

  it('puts the setting last, where ClickHouse accepts it', () => {
    // SETTINGS has to follow LIMIT / OFFSET / ORDER BY, not precede them.
    for (const sql of statements) {
      const settingsAt = sql.indexOf('JOIN_NULLS_SETTING');
      if (settingsAt < 0) continue;
      const tail = sql.slice(settingsAt);
      expect(tail).not.toMatch(/\b(ORDER BY|LIMIT|OFFSET)\b/);
    }
  });

  it('spells the setting one way', () => {
    expect(JOIN_NULLS_SETTING).toBe('SETTINGS join_use_nulls = 1');
  });
});
