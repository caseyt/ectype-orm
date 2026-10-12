/**
 * A small least-recently-used cache.
 *
 * @module
 */

/**
 * A bounded map that evicts the entry that was used least recently. `get` and `set` are
 * O(1): the cache is a `Map`, whose iteration order is insertion order, and using an
 * entry moves it to the end.
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
  readonly #entries = new Map<K, V>();
  readonly #capacity: number;

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
    const entries = this.#entries;
    const value = entries.get(key);
    if (value === undefined) return undefined;
    entries.delete(key);
    entries.set(key, value);
    return value;
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
    const entries = this.#entries;
    if (entries.delete(key)) {
      entries.set(key, value);
      return;
    }
    if (entries.size >= this.#capacity) {
      // The first key in iteration order is the least recently used.
      for (const oldest of entries.keys()) {
        entries.delete(oldest);
        break;
      }
    }
    entries.set(key, value);
  }

  /** Removes `key`. Returns whether it was present. */
  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  /** Removes every entry. */
  clear(): void {
    this.#entries.clear();
  }
}
