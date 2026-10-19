/**
 * The read limiter in src/db/clickhouse.ts.
 *
 * What this protects: a profile render fires ~30 `... FINAL` reads at once and
 * each one costs 100–300 MiB inside ClickHouse, which is more than prod's
 * server memory cap — the fan-out came back as MEMORY_LIMIT_EXCEEDED and the
 * page 503'd. The limiter is the only thing bounding that, so every property
 * it depends on is asserted here: the ceiling, the order, that a failure
 * cannot leak a permit, and that an insert never waits for one.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { insert, query, resolveReadConcurrency } from './clickhouse';

/** Must match DEFAULT_MAX_CONCURRENT_READS. */
const LIMIT = 4;

interface Call {
  label: string;
  isInsert: boolean;
  settled: boolean;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

const realFetch = globalThis.fetch;

let calls: Call[] = [];
let openCalls = 0;
let maxOpenReads = 0;

/** A fetch that answers nothing until the test says so. */
function installFetch() {
  calls = [];
  openCalls = 0;
  maxOpenReads = 0;

  globalThis.fetch = ((input: any, init: any) => {
    const isInsert = String(input).includes('INSERT');
    const label = String(init?.body ?? '');
    if (!isInsert) {
      openCalls++;
      maxOpenReads = Math.max(maxOpenReads, openCalls);
    }

    return new Promise<Response>((resolve, reject) => {
      const call: Call = {
        label,
        isInsert,
        settled: false,
        resolve: response => {
          if (call.settled) return;
          call.settled = true;
          if (!isInsert) openCalls--;
          resolve(response);
        },
        reject: error => {
          if (call.settled) return;
          call.settled = true;
          if (!isInsert) openCalls--;
          reject(error);
        },
      };
      calls.push(call);
    });
  }) as typeof fetch;
}

function readLabels(): string[] {
  return calls.filter(c => !c.isInsert).map(c => c.label);
}

const ok = () => new Response('{"n":1}\n', { status: 200 });
const failed = () => new Response('Code: 241. MEMORY_LIMIT_EXCEEDED', { status: 500 });

/** Let every pending microtask AND the queue hand-off run. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

/** Answer everything, including the calls that answering lets through. */
async function drain() {
  for (let guard = 0; guard < 100; guard++) {
    const open = calls.filter(c => !c.settled);
    if (open.length === 0) return;
    for (const call of open) call.resolve(ok());
    await settle();
  }
  throw new Error('queue never drained');
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('read concurrency limit', () => {
  it('never has more than LIMIT reads in flight', async () => {
    installFetch();

    // One profile render's worth of fan-out.
    const pending = Array.from({ length: 30 }, (_, i) =>
      query(`SELECT ${i}`).catch(() => [])
    );
    await settle();

    expect(readLabels().length).toBe(LIMIT);

    // The ceiling has to hold the whole way through, not only at the start.
    await drain();
    await Promise.all(pending);

    expect(maxOpenReads).toBe(LIMIT);
    expect(readLabels().length).toBe(30);
  });

  it('serves the queue in FIFO order', async () => {
    installFetch();

    const pending = Array.from({ length: LIMIT + 3 }, (_, i) => query(`SELECT ${i}`));
    await settle();

    expect(readLabels()).toEqual(['SELECT 0', 'SELECT 1', 'SELECT 2', 'SELECT 3']);

    // Free one permit: the FIRST waiter takes it, not the last.
    calls[0]!.resolve(ok());
    await settle();
    expect(readLabels()[LIMIT]).toBe('SELECT 4');

    calls[1]!.resolve(ok());
    await settle();
    expect(readLabels()[LIMIT + 1]).toBe('SELECT 5');

    await drain();
    expect(readLabels()[LIMIT + 2]).toBe('SELECT 6');
    await Promise.all(pending);
  });

  it('releases the permit of a query that fails, and of one that rejects', async () => {
    installFetch();

    const pending = Array.from({ length: LIMIT + 2 }, (_, i) =>
      query(`SELECT ${i}`).then(
        () => 'ok',
        () => 'threw'
      )
    );
    await settle();
    expect(readLabels().length).toBe(LIMIT);

    // A ClickHouse error response: query() throws.
    calls[0]!.resolve(failed());
    await settle();
    expect(await pending[0]).toBe('threw');
    expect(readLabels()[LIMIT]).toBe('SELECT 4');

    // A rejecting fetch — what an AbortSignal.timeout looks like from here.
    calls[1]!.reject(new Error('The operation timed out.'));
    await settle();
    expect(await pending[1]).toBe('threw');
    expect(readLabels()[LIMIT + 1]).toBe('SELECT 5');

    await drain();
    expect(await Promise.all(pending)).toEqual(['threw', 'threw', 'ok', 'ok', 'ok', 'ok']);
  });

  it('lets an insert through while every read permit is held', async () => {
    installFetch();

    const reads = Array.from({ length: LIMIT + 5 }, (_, i) => query(`SELECT ${i}`));
    await settle();
    expect(readLabels().length).toBe(LIMIT);

    // Ingestion does not queue behind a profile.
    const written = insert('events_raw', [{ user_id: 'github_1' }]);
    await settle();

    const inserts = calls.filter(c => c.isInsert);
    expect(inserts.length).toBe(1);

    inserts[0]!.resolve(ok());
    await written;

    await drain();
    await Promise.all(reads);
  });
});

describe('resolveReadConcurrency', () => {
  it('defaults to 4 when unset', () => {
    expect(resolveReadConcurrency(undefined)).toBe(LIMIT);
    expect(resolveReadConcurrency('')).toBe(LIMIT);
  });

  it('takes a positive integer', () => {
    expect(resolveReadConcurrency('1')).toBe(1);
    expect(resolveReadConcurrency('8')).toBe(8);
  });

  it('ignores anything else rather than running unbounded', () => {
    const realError = console.error;
    console.error = () => {};
    try {
      for (const raw of ['0', '-2', 'abc', '2.5', 'Infinity', ' ']) {
        expect(resolveReadConcurrency(raw)).toBe(LIMIT);
      }
    } finally {
      console.error = realError;
    }
  });
});
