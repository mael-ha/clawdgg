/**
 * In-process TTL cache with single-flight and an optional stale window.
 *
 * Three jobs: keep a hot profile from re-running its query fan-out on every
 * request, keep N concurrent requests for the same cold key from running it N
 * times (the second caller awaits the first caller's promise), and — where a
 * `staleMs` is given — keep the ONE request that arrives after the TTL from
 * paying for the rebuild.
 *
 * STALE-WHILE-REVALIDATE. An entry has two deadlines. Until `expiresAt` it is
 * fresh and served as-is. Between `expiresAt` and `staleUntil` it is served
 * anyway, and the first caller to see it that way kicks off a rebuild behind
 * it — one per key, so a stale entry under load does not become N builds.
 * Past `staleUntil` it is gone and the caller waits, still single-flighted.
 *
 * That is the whole fix for the cold profile: /u/mael-ha is ~23 `… FINAL`
 * reads over ~1.8M rows through a 4-permit limiter (src/db/clickhouse.ts), so
 * a miss costs 12 s. With a stale window the miss happens to a background
 * task, and the reader gets last build's page in 0.17 s.
 *
 * A REBUILD THAT FAILS CHANGES NOTHING. The stale entry stays, the failure is
 * logged, and the next caller inside the window kicks another rebuild. Nothing
 * here ever caches a rejection — the whole point of the stale window is that a
 * ClickHouse outage degrades to "a few minutes old" rather than to a 503.
 *
 * EVICTION BEATS A REBUILD THAT IS ALREADY IN FLIGHT. `delete`/`deletePrefix`/
 * `clear` mark every matching in-flight build invalidated, and an invalidated
 * build does not write its value back. Without that, a build that started
 * before an owner hid a section finishes after the eviction and re-caches the
 * pre-toggle payload under the same key — serving the figure they just took
 * down for the rest of the window. The hidden list being part of the key is
 * the other half of that guard (see src/routes/api.ts); this half is what
 * makes an eviction a hard miss even for the key that is being rebuilt.
 *
 * In-process means per server instance and lost on restart. That is fine for
 * what it holds — a page payload that is a few minutes stale at worst — and
 * it is deliberately not a correctness mechanism: nothing writes through it.
 */

import { untimed } from './request-timing';

interface Entry<T> {
  value: T;
  /** Served as-is until here. */
  expiresAt: number;
  /** Served stale, with a rebuild behind it, until here. Then it is gone. */
  staleUntil: number;
}

interface Flight<T> {
  promise: Promise<T>;
  /** Set by an eviction: this build must not write its value back. */
  invalidated: boolean;
}

export interface TtlCacheOptions {
  /**
   * How long past the TTL an entry may still be served while it is rebuilt.
   * 0 (the default) is the plain TTL cache: past `ttlMs` the caller waits.
   */
  staleMs?: number;
  /** Prefix for the one log line a failed background rebuild writes. */
  name?: string;
}

export class TtlCache<T> {
  readonly #ttlMs: number;
  readonly #staleMs: number;
  readonly #name: string;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, Entry<T>>();
  readonly #inFlight = new Map<string, Flight<T>>();

  constructor(ttlMs: number, maxEntries = 500, options: TtlCacheOptions = {}) {
    this.#ttlMs = ttlMs;
    this.#staleMs = options.staleMs ?? 0;
    this.#name = options.name ?? 'cache';
    this.#maxEntries = maxEntries;
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * The FRESH value, or undefined.
   *
   * A stale entry answers undefined here and is left in place: `get` is what
   * callers use to ask "is this current", and dropping the entry would throw
   * away the value `remember` is about to serve while it rebuilds.
   */
  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    const now = Date.now();
    if (entry.staleUntil <= now) {
      this.#entries.delete(key);
      return undefined;
    }
    if (entry.expiresAt <= now) return undefined;
    return entry.value;
  }

  set(key: string, value: T): void {
    // Re-insert so the Map's insertion order stays the eviction order.
    this.#entries.delete(key);
    const now = Date.now();
    this.#entries.set(key, {
      value,
      expiresAt: now + this.#ttlMs,
      staleUntil: now + this.#ttlMs + this.#staleMs,
    });
    this.#evict();
  }

  /**
   * Cached value, a stale value with a rebuild behind it, the in-flight build
   * for this key, or a fresh build.
   *
   * `shouldCache` decides whether the built value is worth keeping. Without it
   * a build that degraded — a page assembled while ClickHouse was unreachable,
   * say — gets pinned for the full TTL, so one failed query turns into a minute
   * of everyone seeing an empty panel. Returning false still serves the value
   * to this caller and still shares it with the callers already waiting behind
   * the single-flight; it just isn't remembered, so the next request retries —
   * and it leaves any stale entry alone, so a degraded rebuild keeps serving
   * the last good build rather than replacing it.
   */
  async remember(
    key: string,
    build: () => Promise<T>,
    shouldCache?: (value: T) => boolean
  ): Promise<T> {
    const entry = this.#entries.get(key);
    const now = Date.now();

    if (entry && entry.expiresAt > now) return entry.value;

    if (entry && entry.staleUntil > now) {
      // One rebuild per key, and this caller does not wait for it.
      // Untimed: nobody is waiting on it, so it is not this request's time.
      if (!this.#inFlight.has(key)) {
        untimed(() => this.#build(key, build, shouldCache)).catch((error) => {
          console.error(`[${this.#name}] background rebuild of ${key} failed:`, error);
        });
      }
      return entry.value;
    }

    if (entry) this.#entries.delete(key);

    const pending = this.#inFlight.get(key);
    if (pending) return pending.promise;

    return this.#build(key, build, shouldCache);
  }

  /**
   * Rebuild now and wait for it, joining a build already in flight.
   *
   * What the warmer calls (src/lib/warm.ts). `remember` is wrong for it: on a
   * stale entry `remember` kicks a background rebuild and returns at once, so a
   * warmer walking users one at a time would have every user's fan-out in the
   * server simultaneously — the opposite of sequential.
   */
  refresh(
    key: string,
    build: () => Promise<T>,
    shouldCache?: (value: T) => boolean
  ): Promise<T> {
    const pending = this.#inFlight.get(key);
    if (pending) return pending.promise;
    return this.#build(key, build, shouldCache);
  }

  /**
   * Forget one key, for when the thing it caches has just been changed by the
   * person looking at it. Without it a 60-second cache makes a settings toggle
   * look broken for a minute — which reads as "it didn't save".
   *
   * Hard: the stale value goes too, and a build in flight for this key is
   * invalidated rather than left to re-insert what was just evicted.
   */
  delete(key: string): void {
    this.#entries.delete(key);
    const flight = this.#inFlight.get(key);
    if (flight) flight.invalidated = true;
  }

  /**
   * Forget every key starting with `prefix`.
   *
   * For a cache whose key carries more than the subject — a profile payload
   * keyed by user AND by the visibility settings it was built under, say. The
   * settings change, so the old keys can no longer be named one by one, and
   * `clear()` would throw away every other user's entry to evict one user's.
   */
  deletePrefix(prefix: string): void {
    for (const key of this.#entries.keys()) {
      if (key.startsWith(prefix)) this.#entries.delete(key);
    }
    for (const [key, flight] of this.#inFlight) {
      if (key.startsWith(prefix)) flight.invalidated = true;
    }
  }

  clear(): void {
    this.#entries.clear();
    for (const flight of this.#inFlight.values()) flight.invalidated = true;
  }

  #build(
    key: string,
    build: () => Promise<T>,
    shouldCache?: (value: T) => boolean
  ): Promise<T> {
    const flight: Flight<T> = { promise: undefined as unknown as Promise<T>, invalidated: false };

    flight.promise = build()
      .then((value) => {
        // An eviction while this was in flight wins: see the note at the top.
        if (!flight.invalidated && (!shouldCache || shouldCache(value))) this.set(key, value);
        return value;
      })
      .finally(() => {
        // Only if it is still ours — a `refresh` that overlapped a rejection
        // could already have installed the next build under this key.
        if (this.#inFlight.get(key) === flight) this.#inFlight.delete(key);
      });

    this.#inFlight.set(key, flight);
    return flight.promise;
  }

  #evict(): void {
    if (this.#entries.size <= this.#maxEntries) return;
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      if (entry.staleUntil <= now) this.#entries.delete(key);
    }
    // Still over budget: drop oldest-inserted first.
    for (const key of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries) break;
      this.#entries.delete(key);
    }
  }
}
