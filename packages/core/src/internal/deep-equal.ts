/**
 * Structural equality for JSON-like values: what the `json` type uses to decide whether
 * a value changed.
 *
 * @module
 */

import { isPlainObject } from "./plain-object.js";

const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Whether two values are structurally equal.
 *
 * - Primitives compare with `===`, and `NaN` equals `NaN`. `0` equals `-0`, because JSON
 *   cannot tell them apart.
 * - Arrays compare element by element.
 * - `Date`s compare by timestamp.
 * - Plain objects compare by their own enumerable string keys, in any order. It does not
 *   matter whether one has no prototype, or was made in another realm.
 * - Anything else (a `Map`, a `Set`, a class instance) is equal only to itself.
 *
 * It does not serialise anything and allocates only the key lists of the objects it
 * walks. It does not detect cycles: a value that contains itself is not JSON.
 *
 * @example
 * ```ts
 * deepEqual({ theme: "dark", tags: ["a", "b"] }, { tags: ["a", "b"], theme: "dark" }); // true
 * deepEqual({ tags: ["a", "b"] }, { tags: ["b", "a"] }); // false
 * ```
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    // Different primitives, or a primitive and an object. `NaN` is the one value that is
    // not `===` to itself.
    return Number.isNaN(a) && Number.isNaN(b);
  }

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const left = a as readonly unknown[];
    const right = b as readonly unknown[];
    const length = left.length;
    if (length !== right.length) return false;
    for (let i = 0; i < length; i++) {
      if (!deepEqual(left[i], right[i])) return false;
    }
    return true;
  }

  // Only plain objects are compared by their keys, whichever realm each was made in. A
  // Map, a Set or a class instance keeps its content where keys do not show it, so two of
  // them are equal only when identical.
  if (!isPlainObject(a) || !isPlainObject(b)) {
    return (
      a instanceof Date &&
      Object.getPrototypeOf(a) === Object.getPrototypeOf(b) &&
      a.getTime() === (b as Date).getTime()
    );
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  const length = keys.length;
  if (length !== Object.keys(right).length) return false;
  for (let i = 0; i < length; i++) {
    const key = keys[i] as string;
    if (!hasOwn.call(right, key) || !deepEqual(left[key], right[key])) return false;
  }
  return true;
}
