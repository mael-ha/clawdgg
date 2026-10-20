import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import {
  recordClickhouse,
  serverTiming,
  serverTimingHeader,
  newRequestTiming,
  recordSnapshotAge,
  timeStatement,
  untimed,
  withRequestTiming,
} from './request-timing';

function parse(header: string | null): Record<string, { dur: number; desc?: string }> {
  const out: Record<string, { dur: number; desc?: string }> = {};
  for (const part of (header ?? '').split(', ')) {
    const [name, ...fields] = part.split(';');
    const dur = Number(fields.find((f) => f.startsWith('dur='))?.slice(4));
    const desc = fields.find((f) => f.startsWith('desc='))?.slice(6, -1);
    out[name!] = { dur, desc };
  }
  return out;
}

describe('Server-Timing', () => {
  it('formats durations and counts, nothing else', () => {
    const timing = { ...newRequestTiming(), chMs: 812.04, chQueries: 4, sqliteMs: 3, sqliteQueries: 7, renderMs: 41 };
    expect(serverTimingHeader(timing, 870)).toBe(
      'ch;dur=812.0;desc="4 queries", sqlite;dur=3.0;desc="7 queries", render;dur=41.0, total;dur=870.0'
    );
  });

  it('says how old the served payload is, in whole seconds, when a route recorded it', () => {
    const timing = newRequestTiming();
    withRequestTiming(timing, () => {
      recordSnapshotAge(3_200);
      // Two payloads behind one response: the older one is how stale it is.
      recordSnapshotAge(37_900);
      recordSnapshotAge(1_000);
    });
    expect(serverTimingHeader(timing, 10)).toBe(
      'ch;dur=0.0;desc="0 queries", sqlite;dur=0.0;desc="0 queries", render;dur=0.0, snap;desc="age=37s", total;dur=10.0'
    );
    // Outside a request it is a no-op, like every other record.
    recordSnapshotAge(5_000);
    expect(serverTimingHeader(newRequestTiming(), 1)).not.toContain('snap');
  });

  it('keeps two interleaved requests apart', async () => {
    // Request A records, then waits for B to run to completion inside its
    // window, then records again. If the store leaked, A would carry B's
    // query or B would carry A's.
    let releaseA!: () => void;
    const aWaiting = new Promise<void>((resolve) => (releaseA = resolve));
    let aStarted!: () => void;
    const aHasStarted = new Promise<void>((resolve) => (aStarted = resolve));

    const app = new Hono();
    app.use('*', serverTiming);
    app.get('/a', async (c) => {
      recordClickhouse(100);
      aStarted();
      await aWaiting;
      recordClickhouse(50);
      return c.html('<p>a</p>');
    });
    app.get('/b', async (c) => {
      recordClickhouse(7);
      return c.json({ ok: true });
    });

    const a = app.request('/a');
    await aHasStarted;
    const b = await app.request('/b');
    releaseA();
    const aResponse = await a;

    const timingA = parse(aResponse.headers.get('Server-Timing'));
    const timingB = parse(b.headers.get('Server-Timing'));
    expect(timingA.ch).toEqual({ dur: 150, desc: '2 queries' });
    expect(timingB.ch).toEqual({ dur: 7, desc: '1 queries' });
    expect(timingA.total!.dur).toBeGreaterThanOrEqual(0);
    expect(timingA.render!.dur).toBeGreaterThanOrEqual(0);
  });

  it('times SQLite statements inside a request and ignores them outside', () => {
    const sqlite = new Database(':memory:');
    const prepare = sqlite.prepare.bind(sqlite);
    const timed = (sql: string) => timeStatement(prepare(sql));

    expect(timed('SELECT 1 AS x').all()).toEqual([{ x: 1 }]);

    const timing = newRequestTiming();
    withRequestTiming(timing, () => {
      timed('SELECT 1 AS x').all();
      timed('SELECT 2 AS y').get();
      untimed(() => timed('SELECT 3 AS z').all());
    });
    expect(timing.sqliteQueries).toBe(2);
    expect(timing.sqliteMs).toBeGreaterThanOrEqual(0);
  });

  it('leaves work started with untimed out of the request', async () => {
    const timing = newRequestTiming();
    await withRequestTiming(timing, async () => {
      recordClickhouse(5);
      await untimed(async () => {
        await Promise.resolve();
        recordClickhouse(3_000);
      });
    });
    expect(timing.chQueries).toBe(1);
    expect(timing.chMs).toBe(5);
  });
});
