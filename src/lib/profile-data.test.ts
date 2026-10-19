/**
 * The profile's own reads, as SQL.
 *
 * These two functions used to name an alias after the column it was summing
 * (`… sumIf(value, …) AS value`), which prod's ClickHouse rejects outright:
 * with the analyzer on and `prefer_column_name_to_alias = 0`, the NEXT
 * `sumIf(value, …)` in the same SELECT reads the alias instead of the column,
 * and an aggregate inside an aggregate is Code 184, ILLEGAL_AGGREGATION. The
 * year graph was therefore missing from every profile on the site while every
 * test here passed, because nothing executed the query.
 *
 * The real fix for that gap is executing them against a ClickHouse. This file
 * is the cheap guard that runs everywhere, with no server: the invariant it
 * checks is that no alias in these queries reuses the name of a raw-table
 * column. It captures the SQL off a stubbed `fetch` rather than mocking
 * src/db/clickhouse — `mock.module` replaces the module for every other suite
 * in the process too, which breaks the limiter's tests.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { fetchToday, fetchYearSeries } from './profile-data';

/** Columns of metrics_raw / events_raw an alias must never shadow. */
const RAW_COLUMNS = new Set([
  'timestamp',
  'user_id',
  'session_id',
  'metric_name',
  'event_name',
  'value',
  'model',
  'token_type',
  'line_type',
  'time_type',
  'tool',
  'tool_name',
  'tool_success',
  'tool_duration_ms',
  'decision',
  'language',
  'source',
  'query_source',
  'speed',
  'effort',
  'agent_name',
  'skill_name',
  'plugin_name',
  'marketplace_name',
  'mcp_server_name',
  'mcp_tool_name',
  'start_type',
  'terminal_type',
  'app_version',
  'account_uuid',
  'organization_id',
  'provenance',
  'pricing_source',
  'row_id',
  'prompt_length',
  'cost_usd',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'error_message',
  'error_type',
  'status_code',
  'duration_ms',
  'tool_use_id',
  'tool_source',
  'prompt_id',
  'request_id',
  'client_request_id',
  'message_uuid',
  'event_sequence',
  'command_name',
  'command_source',
]);

function aliasesOf(sql: string): string[] {
  return [...sql.matchAll(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map(match => match[1]!);
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Every SQL body the reads send, answered with an empty result set. */
async function capture(run: () => Promise<unknown>): Promise<string[]> {
  const sqls: string[] = [];
  globalThis.fetch = ((_input: any, init: any) => {
    sqls.push(String(init?.body ?? ''));
    return Promise.resolve(new Response('', { status: 200 }));
  }) as typeof fetch;

  await run();
  return sqls;
}

function expectNoShadowedAlias(sqls: string[]) {
  for (const sql of sqls) {
    for (const alias of aliasesOf(sql)) {
      if (RAW_COLUMNS.has(alias)) {
        throw new Error(`alias "${alias}" shadows a raw-table column in:\n${sql}`);
      }
    }
  }
  // The alias that broke prod, named explicitly: a `value` here shadows
  // metrics_raw.value for the two sumIfs below it.
  expect(sqls.join('\n')).not.toMatch(/\bAS\s+value\b/i);
}

describe('the profile queries never alias a raw column name', () => {
  it('holds for fetchYearSeries', async () => {
    const sqls = await capture(() => fetchYearSeries('github_1', 'Europe/Paris'));

    expect(sqls.length).toBe(2);
    expectNoShadowedAlias(sqls);
  });

  it('holds for fetchToday', async () => {
    const sqls = await capture(() => fetchToday('github_1', 'Europe/Paris'));

    expect(sqls.length).toBe(2);
    expectNoShadowedAlias(sqls);
  });
});
