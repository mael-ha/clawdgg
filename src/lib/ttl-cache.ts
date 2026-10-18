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

  /** Cached value, the in-flight build for this key, or a fresh build. */
  async remember(key: string, build: () => Promise<T>): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    const pending = this.#inFlight.get(key);
    if (pending) return pending;

    const promise = build()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.#inFlight.delete(key);
      });

    this.#inFlight.set(key, promise);
    return promise;
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
