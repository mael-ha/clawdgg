/**
 * Where one request's time went, as a `Server-Timing` header.
 *
 *   Server-Timing: ch;dur=812;desc="4 queries", sqlite;dur=3;desc="7 queries",
 *                  render;dur=41, snap;desc="age=37s", total;dur=870
 *
 * Measured, per request, in the process that served it: the ClickHouse reads
 * (src/db/clickhouse.ts query(), from the call to the parsed answer, so a read
 * that waited for a permit counts its wait), the SQLite statements (every
 * statement drizzle runs, via the prepare hook in src/db/index.ts), the JSX
 * render (c.html) and the wall clock. `snap` is how old the cached payload the
 * response was built from is — the caches are replaced when the data changes
 * rather than on a timer, so this is the figure that says how stale a page
 * is; a route that serves no such payload leaves it out. `ch` and `sqlite` are SUMS over reads
 * that may have run concurrently, so on a page that fans out they can exceed
 * `total` — that is the fan-out showing, not a bug.
 *
 * Durations and counts only, which is why it is safe to send to anyone: no
 * SQL, no user id, no parameter ever reaches the header.
 *
 * ONE STORE PER REQUEST, through AsyncLocalStorage, so two interleaved
 * requests cannot add to each other's figures. Work a request merely STARTS
 * and does not wait for runs outside it via `untimed`, or a visitor served in
 * 5 ms would be shown the 3 s scan their visit happened to kick off.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { MiddlewareHandler } from 'hono';

export interface RequestTiming {
  chMs: number;
  chQueries: number;
  sqliteMs: number;
  sqliteQueries: number;
  renderMs: number;
  /** Age of the cached payload served, if the route recorded one. */
  snapAgeMs?: number;
}

const storage = new AsyncLocalStorage<RequestTiming>();

export function newRequestTiming(): RequestTiming {
  return { chMs: 0, chQueries: 0, sqliteMs: 0, sqliteQueries: 0, renderMs: 0 };
}

/** Run `fn` with `timing` as the store every record below adds to. */
export function withRequestTiming<T>(timing: RequestTiming, fn: () => T): T {
  return storage.run(timing, fn);
}

/** Run `fn` outside any request's timing — for work nobody is waiting on. */
export function untimed<T>(fn: () => T): T {
  return storage.exit(fn);
}

export function currentRequestTiming(): RequestTiming | undefined {
  return storage.getStore();
}

export function recordClickhouse(ms: number): void {
  const timing = storage.getStore();
  if (!timing) return;
  timing.chMs += ms;
  timing.chQueries++;
}

export function recordSqlite(ms: number): void {
  const timing = storage.getStore();
  if (!timing) return;
  timing.sqliteMs += ms;
  timing.sqliteQueries++;
}

export function recordRender(ms: number): void {
  const timing = storage.getStore();
  if (timing) timing.renderMs += ms;
}

/**
 * The age of the cached payload this response is built from. The oldest wins
 * if a route records more than one, since that is how stale the response is.
 */
export function recordSnapshotAge(ageMs: number): void {
  const timing = storage.getStore();
  if (timing) timing.snapAgeMs = Math.max(timing.snapAgeMs ?? 0, ageMs);
}

function ms(value: number): string {
  return value.toFixed(1);
}

export function serverTimingHeader(timing: RequestTiming, totalMs: number): string {
  return [
    `ch;dur=${ms(timing.chMs)};desc="${timing.chQueries} queries"`,
    `sqlite;dur=${ms(timing.sqliteMs)};desc="${timing.sqliteQueries} queries"`,
    `render;dur=${ms(timing.renderMs)}`,
    ...(timing.snapAgeMs === undefined
      ? []
      : [`snap;desc="age=${Math.floor(timing.snapAgeMs / 1000)}s"`]),
    `total;dur=${ms(totalMs)}`,
  ].join(', ');
}

/**
 * Wrap a bun:sqlite statement so each execution is recorded. Bun's Statement
 * methods are plain properties, so the four drizzle calls are replaced on the
 * instance; outside a request the record is a single getStore() and a return.
 */
export function timeStatement<S extends object>(statement: S): S {
  const target = statement as Record<string, unknown>;
  for (const name of ['all', 'get', 'run', 'values'] as const) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    target[name] = function (this: unknown, ...args: unknown[]) {
      if (!storage.getStore()) return original.apply(this, args);
      const start = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        recordSqlite(performance.now() - start);
      }
    };
  }
  return statement;
}

/**
 * The middleware: one store per request, the header on whatever comes back.
 * First in the chain, so `total` covers every other middleware too, and it
 * times `c.html` for `render` — that is where hono/jsx turns the tree into a
 * string.
 */
export const serverTiming: MiddlewareHandler = async (c, next) => {
  const start = performance.now();
  const timing = newRequestTiming();

  const html = c.html;
  c.html = ((...args: Parameters<typeof html>) => {
    const renderStart = performance.now();
    const done = () => recordRender(performance.now() - renderStart);
    const result = html(...args);
    if (result instanceof Promise) return result.finally(done);
    done();
    return result;
  }) as typeof html;

  await withRequestTiming(timing, next);

  try {
    c.res.headers.set('Server-Timing', serverTimingHeader(timing, performance.now() - start));
  } catch {
    // An immutable response (a proxied fetch) keeps its headers; nothing lost
    // but the figure.
  }
};
