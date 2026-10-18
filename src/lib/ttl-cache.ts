/**
 * In-process TTL cache with single-flight.
 *
 * Two jobs: keep a hot profile from re-running its query fan-out on every
 * request, and keep N concurrent requests for the same cold key from running
 * it N times (the second caller awaits the first caller's promise).
 *
 * In-process means per server instance and lost on restart. That is fine for
 * what it holds — a page payload that is a few seconds stale at worst — and
 * it is deliberately not a correctness mechanism: nothing writes through it.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, Entry<T>>();
  readonly #inFlight = new Map<string, Promise<T>>();

  constructor(ttlMs: number, maxEntries = 500) {
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    // Re-insert so the Map's insertion order stays the eviction order.
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: Date.now() + this.#ttlMs });
    this.#evict();
  }

  /**
   * Cached value, the in-flight build for this key, or a fresh build.
   *
   * `shouldCache` decides whether the built value is worth keeping. Without it
   * a build that degraded — a page assembled while ClickHouse was unreachable,
   * say — gets pinned for the full TTL, so one failed query turns into a minute
   * of everyone seeing an empty panel. Returning false still serves the value
   * to this caller and still shares it with the callers already waiting behind
   * the single-flight; it just isn't remembered, so the next request retries.
   */
  async remember(
    key: string,
    build: () => Promise<T>,
    shouldCache?: (value: T) => boolean
  ): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    const pending = this.#inFlight.get(key);
    if (pending) return pending;

    const promise = build()
      .then((value) => {
        if (!shouldCache || shouldCache(value)) this.set(key, value);
        return value;
      })
      .finally(() => {
        this.#inFlight.delete(key);
      });

    this.#inFlight.set(key, promise);
    return promise;
  }

  /**
   * Forget one key, for when the thing it caches has just been changed by the
   * person looking at it. Without it a 60-second cache makes a settings toggle
   * look broken for a minute — which reads as "it didn't save".
   */
  delete(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  #evict(): void {
    if (this.#entries.size <= this.#maxEntries) return;
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
    // Still over budget: drop oldest-inserted first.
    for (const key of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries) break;
      this.#entries.delete(key);
    }
  }
}
