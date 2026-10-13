/**
 * `Result`: the return type of every write operation (decision D10).
 *
 * Implemented here (it is two tiny functions). Consumed by the changeset (05), repo
 * writes (13), nested writes (15) and transactions and Batch (16).
 *
 * @module
 */

/**
 * The success half of a {@link Result}.
 *
 * @example
 * ```ts
 * const done: Success<number> = { success: true, data: 1 };
 * ```
 */
export interface Success<T> {
  readonly success: true;
  readonly data: T;
}

/**
 * The failure half of a {@link Result}.
 *
 * @example
 * ```ts
 * const failed: Failure<string> = { success: false, error: "nope" };
 * ```
 */
export interface Failure<E> {
  readonly success: false;
  readonly error: E;
}

/**
 * Either data or an error, discriminated by `success`. Narrow it with
 * `if (result.success)`. The shape is the one Zod's `safeParse` returns.
 *
 * @example
 * ```ts
 * function parsePort(text: string): Result<number, string> {
 *   const port = Number(text);
 *   return Number.isInteger(port) ? success(port) : failure(`not a port: ${text}`);
 * }
 *
 * const result = parsePort("5432");
 * if (result.success) result.data; // number
 * else result.error; // string
 * ```
 */
export type Result<T, E> = Success<T> | Failure<E>;

/**
 * Builds a successful {@link Result}.
 *
 * @example
 * ```ts
 * const result = success(42); // { success: true, data: 42 }
 * ```
 */
export function success<T>(data: T): Success<T> {
  return { success: true, data };
}

/**
 * Builds a failed {@link Result}.
 *
 * @example
 * ```ts
 * const result = failure("not found"); // { success: false, error: "not found" }
 * ```
 */
export function failure<E>(error: E): Failure<E> {
  return { success: false, error };
}
