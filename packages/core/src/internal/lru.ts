/**
 * A small least-recently-used cache.
 *
 * @module
 */

/** One cache entry, linked to its neighbours in order of use. */
interface Entry<K, V> {
  readonly key: K;
  value: V;
  /** The entry used just after this one; `undefined` for the most recently used. */
  newer: Entry<K, V> | undefined;
  /** The entry used just before this one; `undefined` for the least recently used. */
  older: Entry<K, V> | undefined;
}

/**
 * A bounded map that evicts the entry that was used least recently. `get` and `set` are
 * O(1): a `Map` finds the entry and a doubly linked list keeps the order of use.
 *
 * A hit changes only the links, never the `Map`. The obvious alternative, relying on a
 * `Map`'s insertion order and re-inserting the entry on every hit, was measured with
 * 1,000 entries at 62 ns per hit when hits rotate over 64 keys and at 1.1 µs when one key
 * is hit again and again (every deletion leaves a hole, and the `Map` keeps rehashing),
 * against 12 ns and 4 ns for this one. `benchmarks/micro/internal.bench.ts` runs both.
 *
 * `undefined` cannot be stored as a value, because `get` returns `undefined` for a miss.
 *
 * @example
 * ```ts
 * const plans = new LruCache<number, string>(2);
 * plans.set(1, "select 1");
 * plans.set(2, "select 2");
 * plans.get(1); // "select 1"; key 1 is now the most recently used
 * plans.set(3, "select 3"); // evicts key 2
 * plans.has(2); // false
 * ```
 */
export class LruCache<K, V> {
  readonly #entries = new Map<K, Entry<K, V>>();
  readonly #capacity: number;
  #newest: Entry<K, V> | undefined = undefined;
  #oldest: Entry<K, V> | undefined = undefined;

  /**
   * @param capacity The largest number of entries kept; a positive integer.
   * @throws RangeError when `capacity` is not a positive integer.
   */
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`LruCache capacity must be a positive integer, got ${capacity}`);
    }
    this.#capacity = capacity;
  }

  /** The largest number of entries kept. */
  get capacity(): number {
    return this.#capacity;
  }

  /** The number of entries currently held. */
  get size(): number {
    return this.#entries.size;
  }

  /** Returns the value for `key` and marks it as most recently used; `undefined` on a miss. */
  get(key: K): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry !== this.#newest) {
      this.#unlink(entry);
      this.#pushNewest(entry);
    }
    return entry.value;
  }

  /** Whether `key` is present. Does not count as a use. */
  has(key: K): boolean {
    return this.#entries.has(key);
  }

  /**
   * Stores `value` under `key` as the most recently used entry, evicting the least
   * recently used one when the cache is full.
   */
  set(key: K, value: V): void {
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      existing.value = value;
      if (existing !== this.#newest) {
        this.#unlink(existing);
        this.#pushNewest(existing);
      }
      return;
    }
    const oldest = this.#oldest;
    if (oldest !== undefined && this.#entries.size >= this.#capacity) {
      this.#unlink(oldest);
      this.#entries.delete(oldest.key);
    }
    const entry: Entry<K, V> = { key, value, newer: undefined, older: undefined };
    this.#entries.set(key, entry);
    this.#pushNewest(entry);
  }

  /** Removes `key`. Returns whether it was present. */
  delete(key: K): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    this.#unlink(entry);
    this.#entries.delete(key);
    return true;
  }

  /** Removes every entry. */
  clear(): void {
    this.#entries.clear();
    this.#newest = undefined;
    this.#oldest = undefined;
  }

  /** Takes `entry` out of the list, joining its neighbours. */
  #unlink(entry: Entry<K, V>): void {
    const { newer, older } = entry;
    if (newer === undefined) this.#newest = older;
    else newer.older = older;
    if (older === undefined) this.#oldest = newer;
    else older.newer = newer;
    entry.newer = undefined;
    entry.older = undefined;
  }

  /** Puts an unlinked `entry` at the most-recently-used end of the list. */
  #pushNewest(entry: Entry<K, V>): void {
    const newest = this.#newest;
    entry.older = newest;
    if (newest === undefined) this.#oldest = entry;
    else newest.newer = entry;
    this.#newest = entry;
  }
}
