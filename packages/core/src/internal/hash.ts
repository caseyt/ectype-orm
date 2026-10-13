/**
 * Incremental 32-bit hashing (FNV-1a) for the query `shape` hash.
 *
 * A hash is built by threading a number through the functions below, starting from
 * {@link HASH_SEED}: `hashString(hashInt(HASH_SEED, 3), "users")`. Every function is pure
 * and allocation-free, and every result is a signed 32-bit integer, which V8 keeps as a
 * small integer (no heap number) on 64-bit builds.
 *
 * The hash is for cache keys. It is not cryptographic, and two different inputs can
 * collide, so a cache hit must be confirmed by comparing the keys' structure.
 *
 * @module
 */

/**
 * The value an incremental hash starts from (the FNV-1a 32-bit offset basis).
 *
 * @example
 * ```ts
 * let hash = HASH_SEED;
 * hash = hashString(hash, "where");
 * ```
 */
export const HASH_SEED: number = 0x811c9dc5 | 0;

/** The FNV 32-bit prime. */
const PRIME = 0x01000193;

/**
 * Mixes a string into a hash, one UTF-16 code unit at a time. The length is mixed in
 * first, so that `("ab", "c")` and `("a", "bc")` hash differently.
 *
 * @example
 * ```ts
 * const hash = hashString(HASH_SEED, "inserted_at");
 * ```
 */
export function hashString(hash: number, value: string): number {
  let h = hashInt(hash, value.length);
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    h = Math.imul(h ^ (unit & 0xff), PRIME);
    h = Math.imul(h ^ (unit >>> 8), PRIME);
  }
  return h;
}

/**
 * Mixes an integer into a hash: its low 32 bits, one byte at a time. Use it for counts,
 * indexes, enum ordinals and for combining with another hash.
 *
 * @example
 * ```ts
 * const childHash = hashString(HASH_SEED, "u.age");
 * const hash = hashInt(hashInt(HASH_SEED, 2), childHash);
 * ```
 */
export function hashInt(hash: number, value: number): number {
  let h = Math.imul(hash ^ (value & 0xff), PRIME);
  h = Math.imul(h ^ ((value >>> 8) & 0xff), PRIME);
  h = Math.imul(h ^ ((value >>> 16) & 0xff), PRIME);
  return Math.imul(h ^ (value >>> 24), PRIME);
}
