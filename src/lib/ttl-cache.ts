/**
 * In-process cache with a max age, an LRU bound and single-flight builds.
 *
 * Two jobs: keep a hot payload from re-running its query fan-out on every
 * request, and keep N concurrent requests for the same cold key from running
 * it N times (the second caller awaits the first caller's promise).
 *
 * THE MAX AGE IS EITHER A TTL OR A SAFETY NET, and the caller decides which.
 * A curve or a board slice is cached for a minute and then rebuilt by
 * whoever asks next. The profile surfaces are not: they are REPLACED when the
 * data under them changes (src/jobs/refresh-pages.ts, through `refresh`), so
 * their max age is a day — there only so a change that was somehow never
 * marked cannot be served for ever.
 *
 * LEAST RECENTLY USED GOES FIRST once the cache is over its entry budget: a
 * read moves an entry to the back of the Map, and eviction walks from the
 * front. A refresh is not a read — a payload nobody looks at must not be kept
 * alive by the job that keeps it current.
 *
 * `readWithin` says whether anyone has actually READ a key lately, which is
 * how the refresh job decides that a payload is still worth rebuilding (the
 * owner's own view, the share card). `ageMs` is how old the value being served
 * is, for the Server-Timing header.
 *
 * NOTHING HERE EVER CACHES A REJECTION, and a rebuild that fails or comes back
 * degraded (`shouldCache` false) leaves the previous entry where it was: a
 * ClickHouse outage degrades to "a little old", not to a 503.
 *
 * EVICTION BEATS A REBUILD THAT IS ALREADY IN FLIGHT. `delete`/`deletePrefix`/
 * `clear` mark every matching in-flight build invalidated, and an invalidated
 * build does not write its value back. Without that, a build that started
 * before an owner hid a section finishes after the eviction and re-caches the
 * pre-toggle payload under the same key — serving the figure they just took
 * down until the next change. The hidden list being part of the key is the
 * other half of that guard (see src/routes/api.ts); this half is what makes an
 * eviction a hard miss even for the key that is being rebuilt.
 *
 * In-process means per server instance and lost on restart. That is fine for
 * what it holds, and it is deliberately not a correctness mechanism: nothing
 * writes through it.
 */

interface Entry<T> {
  value: T;
  /** When this value was built. Past `storedAt + maxAge` it is gone. */
  storedAt: number;
  /** When a caller last read it. 0 if nobody has since it was first built. */
  readAt: number;
}

interface Flight<T> {
  promise: Promise<T>;
  /** Set by an eviction: this build must not write its value back. */
  invalidated: boolean;
}

export class TtlCache<T> {
  readonly #maxAgeMs: number;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, Entry<T>>();
  readonly #inFlight = new Map<string, Flight<T>>();

  constructor(maxAgeMs: number, maxEntries = 500) {
    this.#maxAgeMs = maxAgeMs;
    this.#maxEntries = maxEntries;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** The cached value, or undefined. A read: it counts as a use. */
  get(key: string): T | undefined {
    return this.#read(key, Date.now())?.value;
  }

  set(key: string, value: T): void {
    // Replacing a value keeps its place in the LRU order — Map.set on a key
    // that is already there does not move it — and the record of who last
    // read it: a rebuild is not a use.
    const previous = this.#entries.get(key);
    this.#entries.set(key, { value, storedAt: Date.now(), readAt: previous?.readAt ?? 0 });
    this.#evict();
  }

  /** How old the value under `key` is, or undefined if there is none. */
  ageMs(key: string): number | undefined {
    const entry = this.#live(key, Date.now());
    return entry ? Date.now() - entry.storedAt : undefined;
  }

  /** True if `key` holds a value and somebody read it in the last `ms`. */
  readWithin(key: string, ms: number): boolean {
    const now = Date.now();
    const entry = this.#live(key, now);
    return entry !== undefined && entry.readAt > 0 && now - entry.readAt <= ms;
  }

  /**
   * Cached value, the in-flight build for this key, or a fresh build.
   *
   * `shouldCache` decides whether the built value is worth keeping. Without it
   * a build that degraded — a page assembled while ClickHouse was unreachable,
   * say — gets pinned, so one failed query turns into everyone seeing an empty
   * panel. Returning false still serves the value to this caller and still
   * shares it with the callers already waiting behind the single-flight; it
   * just isn't remembered, so the next request retries.
   */
  async remember(
    key: string,
    build: () => Promise<T>,
    shouldCache?: (value: T) => boolean
  ): Promise<T> {
    const now = Date.now();
    const entry = this.#read(key, now);
    if (entry) return entry.value;

    const value = await (this.#inFlight.get(key)?.promise ?? this.#build(key, build, shouldCache));
    const built = this.#entries.get(key);
    if (built) built.readAt = Date.now();
    return value;
  }

  /**
   * Rebuild now and wait for it, joining a build already in flight.
   *
   * What the refresh job calls (src/jobs/refresh-pages.ts): the entry it
   * replaces keeps serving until the new value lands, and is left alone if the
   * build throws or comes back degraded.
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
   * person looking at it — a settings toggle has to be visible at once, or it
   * reads as "it didn't save".
   *
   * Hard: a build in flight for this key is invalidated rather than left to
   * re-insert what was just evicted.
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

  /** The live entry, without counting it as a use. Drops an expired one. */
  #live(key: string, now: number): Entry<T> | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.storedAt + this.#maxAgeMs <= now) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** The live entry, counted as a use: moved to the back of the LRU order. */
  #read(key: string, now: number): Entry<T> | undefined {
    const entry = this.#live(key, now);
    if (!entry) return undefined;
    entry.readAt = now;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
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
      if (entry.storedAt + this.#maxAgeMs <= now) this.#entries.delete(key);
    }
    // Still over budget: least recently used first.
    for (const key of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries) break;
      this.#entries.delete(key);
    }
  }
}
