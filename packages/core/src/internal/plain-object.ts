/**
 * Telling a plain object from every other kind of object, in any realm.
 *
 * @module
 */

const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Whether `value` is a plain object: one whose prototype is `null`, or the
 * `Object.prototype` of this realm or of another one (an object made by a literal or by
 * `JSON.parse` in a `vm` context or a test environment).
 *
 * The `Object.prototype` of another realm cannot be compared by identity. It is
 * recognised as an object without a prototype that has its own `hasOwnProperty` function,
 * which rules out an object created over a bare null-prototype object and an instance of
 * `class extends null`.
 *
 * @example
 * ```ts
 * isPlainObject({ a: 1 }); // true
 * isPlainObject(Object.create(null)); // true
 * isPlainObject(new Date()); // false
 * isPlainObject(Object.create({ inherited: 1 })); // false
 * ```
 */
export function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null || prototype === Object.prototype) return true;
  return (
    Object.getPrototypeOf(prototype) === null &&
    hasOwn.call(prototype, "hasOwnProperty") &&
    typeof prototype.hasOwnProperty === "function"
  );
}
