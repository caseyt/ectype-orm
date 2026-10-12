/**
 * `Result`: the return type of every write operation (decision D10).
 *
 * Implemented here (it is two tiny functions). Consumed by the changeset (05), repo
 * writes (13), nested writes (15) and transactions and Multi (16).
 *
 * @module
 */

/**
 * The success half of a {@link Result}.
 *
 * @example
 * ```ts
 * const done: Ok<number> = { ok: true, value: 1 };
 * ```
 */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/**
 * The failure half of a {@link Result}.
 *
 * @example
 * ```ts
 * const failed: Err<string> = { ok: false, error: "nope" };
 * ```
 */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/**
 * Either a value or an error, discriminated by `ok`. Narrow it with `if (result.ok)`.
 *
 * Ecto equivalent: `{:ok, value} | {:error, reason}`.
 *
 * @example
 * ```ts
 * function parsePort(text: string): Result<number, string> {
 *   const port = Number(text);
 *   return Number.isInteger(port) ? ok(port) : err(`not a port: ${text}`);
 * }
 *
 * const result = parsePort("5432");
 * if (result.ok) result.value; // number
 * else result.error; // string
 * ```
 */
export type Result<T, E> = Ok<T> | Err<E>;

/**
 * Builds a successful {@link Result}.
 *
 * Ecto equivalent: `{:ok, value}`.
 *
 * @example
 * ```ts
 * const result = ok(42); // { ok: true, value: 42 }
 * ```
 */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/**
 * Builds a failed {@link Result}.
 *
 * Ecto equivalent: `{:error, reason}`.
 *
 * @example
 * ```ts
 * const result = err("not found"); // { ok: false, error: "not found" }
 * ```
 */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}
