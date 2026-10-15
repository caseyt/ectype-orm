/**
 * The error for a bound value that has no type, in a place where nothing else gives it
 * one (a select list, a `RETURNING` list, a values cell). Only a string or `null` may be
 * left untyped there, since the database reads such a placeholder as text (owner decision
 * of 2026-10-15). The compiler raises it when it makes a plan, and `bindParams` when a plan
 * is bound with other values.
 *
 * @module
 */
import { QueryError } from "../errors.js";

/** What to call a JavaScript value's kind in an error, and the field type to suggest for it. */
function typeHint(value: unknown): string {
  if (typeof value === "number")
    return "a number: give it a type, val(value, t.integer()) or val(value, t.float())";
  if (typeof value === "boolean") return "a boolean: give it a type, val(value, t.boolean())";
  if (typeof value === "bigint") return "a bigint: give it a type, val(value, t.bigint())";
  if (value instanceof Date) return "a Date: give it a type, val(value, t.timestamp())";
  if (value instanceof Uint8Array) return "bytes: give it a type, val(value, t.binary())";
  return "an object or array: give it a type, val(value, t.json())";
}

/**
 * The `QueryError` for an untyped value that is not text in `where`. The message names the
 * place and the value's kind, never the value itself.
 *
 * @example
 * ```ts
 * throw untypedValue("the select list", 5);
 * ```
 */
export function untypedValue(where: string, value: unknown): QueryError {
  return new QueryError(
    `A value without a type is in ${where}, where nothing gives it one, so the database would return it as text. It is ${typeHint(value)}.`,
  );
}
