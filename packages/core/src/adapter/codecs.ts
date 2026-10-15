/**
 * Type overrides from a dialect's driver fixes.
 *
 * Every type converts between its application value and one **canonical driver value**
 * per column kind (a `bigint` for `bigint`, a `Uint8Array` for `binary`, the parsed value
 * for `json`, ...). A driver that gives or takes something else for a kind declares a
 * {@link DriverCodec} for it, and the adapter composes that fix with each type's own
 * conversions. The composition happens here, once per type, so that a dialect package
 * never has to know which type it is looking at: `t.bigint()` and
 * `t.bigint({ mode: "number" })` share a kind and both get the fix before their own
 * `fromDb`.
 *
 * @module
 */
import type { AnyFieldType, Codec, DbTypeKind } from "../contracts/type.js";
import { IDENTITY } from "../contracts/type.js";
import { detached } from "../types/define.js";

/**
 * How one driver's values for a column kind differ from the canonical driver values the
 * types expect. Either member may be left out when that direction needs nothing.
 *
 * @example
 * ```ts
 * // The driver sends int8 as text; the types expect a bigint.
 * const int8: DriverCodec = { fromDb: (value) => (typeof value === "string" ? BigInt(value) : value) };
 * ```
 */
export interface DriverCodec {
  /** The driver's value to the canonical value. Never called with `null`. */
  readonly fromDb?: (value: unknown) => unknown;
  /** The canonical value to what the driver takes. Never called with `null`. */
  readonly toDb?: (value: unknown) => unknown;
}

/**
 * The fixes of one driver, by column kind. Kinds that are not listed (and `array` and
 * `custom` always) need none: an array's elements are fixed by their own kind.
 *
 * @example
 * ```ts
 * const fixes: DriverCodecs = { json: { toDb: (value) => JSON.stringify(value) } };
 * ```
 */
export type DriverCodecs = Readonly<Partial<Record<Exclude<DbTypeKind, "array" | "custom">, DriverCodec>>>;

function composeFromDb(
  fix: ((value: unknown) => unknown) | undefined,
  own: (value: unknown) => unknown,
): (value: unknown) => unknown {
  if (fix === undefined) return own;
  if (own === IDENTITY) return fix;
  return (value) => own(fix(value));
}

function composeToDb(
  fix: ((value: unknown) => unknown) | undefined,
  own: (value: unknown) => unknown,
): (value: unknown) => unknown {
  if (fix === undefined) return own;
  if (own === IDENTITY) return fix;
  return (value) => fix(own(value));
}

/**
 * The `typeOverrides` function of an adapter whose driver needs `fixes`: for a type of a
 * listed kind, the type's own conversions wrapped by the fix; `undefined` otherwise, so
 * that the type's own conversions are used as they are (and `resolveCodec` applies the
 * element's override to each element of an array).
 */
export function typeOverridesFrom(fixes: DriverCodecs): (type: AnyFieldType) => Codec | undefined {
  return (type) => {
    const kind = type.db.kind;
    if (kind === "array" || kind === "custom") return undefined;
    const fix = fixes[kind];
    if (fix === undefined) return undefined;
    return Object.freeze({
      fromDb: composeFromDb(fix.fromDb, detached(type, "fromDb") as (value: unknown) => unknown),
      toDb: composeToDb(fix.toDb, detached(type, "toDb") as (value: unknown) => unknown),
    });
  };
}
