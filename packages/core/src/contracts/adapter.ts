/**
 * The adapter contract: everything the repo needs from a database, and nothing about how
 * it is provided. Kysely is the back end today (decision D12, ADR 0002), but no Kysely
 * type appears here, so it can be replaced without touching the repo.
 *
 * Implemented by step 10 (the `compile*` methods and the plan cache), step 11 (execution,
 * connections, errors, `@ectype/postgres`) and step 17 (SQLite, MySQL). Consumed by the
 * repo (12, 13, 14, 16) and by migrations (18).
 *
 * @module
 */
import type { FragmentNode, QueryAst } from "./query.js";
import type { FieldMeta, SchemaMeta } from "./schema.js";
import type { AnyEctoType, Codec } from "./type.js";

/**
 * The SQL dialects.
 *
 * @example
 * ```ts
 * const dialect: Dialect = "postgres";
 * ```
 */
export type Dialect = "postgres" | "mysql" | "sqlite";

/**
 * Where one placeholder of a compiled statement gets its value at execution time. A
 * compiled statement has one slot per placeholder, in placeholder order, so building the
 * driver's parameter array is one loop over the slots (`bindParams`, step 10).
 *
 * - `inline`: the value at `params[index]`.
 * - `list`: the array at `params[index]`, bound as **one** parameter (`= ANY($1)`).
 * - `element`: `params[index][element]`, one placeholder of a list that the dialect
 *   expands to `IN (?, ?, …)`. The list's length is then part of the plan-cache key.
 * - `named`: the value the caller supplied under `name`.
 *
 * For a query, `params` is `QueryAst.params`. For a row-level write it is the flat array
 * of values described on {@link Adapter.compileInsert} and its siblings.
 *
 * `dump` converts the application value to the driver value. `undefined` means "pass it
 * through" (the type's dump was the identity), so the hot path tests one property instead
 * of calling a function. It is never called with `null`. For `list` it is applied to
 * every element.
 *
 * The same parameter may fill several slots.
 *
 * @example
 * ```ts
 * // WHERE "u"."id" = ANY($1) AND "u"."age" >= $2
 * const slots: ParamSlot[] = [
 *   { kind: "list", index: 1, dump: undefined },
 *   { kind: "named", name: "minAge", dump: undefined },
 * ];
 * ```
 */
export type ParamSlot =
  | { readonly kind: "inline"; readonly index: number; readonly dump: Dump | undefined }
  | { readonly kind: "list"; readonly index: number; readonly dump: Dump | undefined }
  | {
      readonly kind: "element";
      readonly index: number;
      readonly element: number;
      readonly dump: Dump | undefined;
    }
  | { readonly kind: "named"; readonly name: string; readonly dump: Dump | undefined };

/**
 * Converts one non-null application value to what the driver takes.
 *
 * @example
 * ```ts
 * const dumpDate: Dump = (value) => (value as Date).toISOString();
 * ```
 */
export type Dump = (value: unknown) => unknown;

/**
 * How to turn one result row into what the query selected. It mirrors the query's
 * `SelectShape` with, at every leaf, the output column alias (`c0`, `c1`, …) to read.
 * Produced by the compiler (step 10); step 12 builds the {@link RowDecoder} from it.
 *
 * - `value`: one column; `type` loads it when present.
 * - `row`: a schema row; `aliases[i]` is the output column of `meta.persisted[i]`.
 * - `object` / `tuple`: an object or array of the nested plans.
 *
 * @example
 * ```ts
 * // select(({ u }) => ({ id: u.id, email: u.email }))
 * const plan: OutputPlan = {
 *   kind: "object",
 *   keys: ["id", "email"],
 *   values: [
 *     { kind: "value", alias: "c0", type: undefined },
 *     { kind: "value", alias: "c1", type: undefined },
 *   ],
 * };
 * ```
 */
export type OutputPlan =
  | { readonly kind: "value"; readonly alias: string; readonly type: AnyEctoType | undefined }
  | { readonly kind: "row"; readonly meta: SchemaMeta; readonly aliases: readonly string[] }
  | { readonly kind: "object"; readonly keys: readonly string[]; readonly values: readonly OutputPlan[] }
  | { readonly kind: "tuple"; readonly items: readonly OutputPlan[] };

/**
 * Turns one raw result row into the value the query selected. Generated once per plan.
 *
 * @example
 * ```ts
 * const decodeId: RowDecoder = (row) => row.c0;
 * ```
 */
export type RowDecoder = (row: Readonly<Record<string, unknown>>) => unknown;

/**
 * A compiled statement, as the plan cache holds it: SQL text, and the recipe for the
 * parameter array of each execution. It holds no values, so one plan serves every query
 * of the same shape.
 *
 * `decoder` is the one mutable member: the repo fills it in the first time the plan is
 * executed (the adapter always creates it as `undefined`), so that the decoder is built
 * once per plan and found without a lookup.
 *
 * Ecto equivalent: the prepared query that an adapter's `prepare/2` callback returns.
 *
 * @example
 * ```ts
 * const plan: CompiledQuery = {
 *   sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."age" >= $1',
 *   slots: [{ kind: "inline", index: 0, dump: undefined }],
 *   output: { kind: "value", alias: "c0", type: undefined },
 *   decoder: undefined,
 * };
 * ```
 */
export interface CompiledQuery {
  readonly sql: string;
  /** One per placeholder, in placeholder order. */
  readonly slots: readonly ParamSlot[];
  /** What the result rows hold; `undefined` when the statement returns no rows. */
  readonly output: OutputPlan | undefined;
  /** Set by the repo, not by the adapter. */
  decoder: RowDecoder | undefined;
}

/**
 * What a statement returned, exactly as the driver reported it.
 *
 * @example
 * ```ts
 * const result: RawResult = { rows: [{ c0: 1 }], rowCount: 1 };
 * ```
 */
export interface RawResult {
  readonly rows: readonly Record<string, unknown>[];
  /** Rows returned by a `SELECT`; rows affected by an `INSERT`, `UPDATE` or `DELETE`. */
  readonly rowCount: number;
}

/**
 * What a dialect supports. The compiler checks these before it lowers a feature and
 * throws `QueryError` naming the feature and the dialect, so that an unsupported query
 * fails when it is compiled and never reaches the database as a syntax error.
 * Conformance tests are skipped by these flags, never by dialect name.
 *
 * @example
 * ```ts
 * function supportsUpsert(capabilities: Capabilities): boolean {
 *   return capabilities.onConflict && capabilities.returning;
 * }
 * ```
 */
export interface Capabilities {
  /** `INSERT`/`UPDATE`/`DELETE … RETURNING`. */
  readonly returning: boolean;
  /** `ON CONFLICT` (or an equivalent upsert clause). */
  readonly onConflict: boolean;
  /** A conflict target can be named: columns, a constraint, or an index expression. */
  readonly conflictTarget: boolean;
  /** A native case-insensitive `ILIKE`. */
  readonly ilike: boolean;
  readonly lateralJoin: boolean;
  readonly fullJoin: boolean;
  readonly distinctOn: boolean;
  /** Array columns and the array operators. */
  readonly arrays: boolean;
  /** An array can be bound as one parameter (`= ANY($1)`); otherwise lists are expanded. */
  readonly arrayParams: boolean;
  /** A binary JSON column type with operators. */
  readonly jsonb: boolean;
  /** `ORDER BY … NULLS FIRST | NULLS LAST`. */
  readonly nullsOrder: boolean;
  /** `UPDATE … FROM` and `DELETE … USING`. */
  readonly updateJoin: boolean;
  /** `WITH … AS [NOT] MATERIALIZED`. */
  readonly cteMaterialized: boolean;
  /** `INSERT … DEFAULT VALUES`. */
  readonly insertDefaultValues: boolean;
  /** The lock clauses `lock()` accepts as plain strings, upper case: `"FOR UPDATE"`, … Empty when none. */
  readonly lockModes: readonly string[];
  /** The isolation levels `begin` accepts. Empty when the dialect has none to choose from. */
  readonly isolationLevels: readonly IsolationLevel[];
  readonly savepoints: boolean;
  /** DDL statements take part in transactions (false means an implicit commit). */
  readonly ddlTransactions: boolean;
  /** Rows can be streamed with a server-side cursor. */
  readonly stream: boolean;
  /** The largest number of bound parameters in one statement. */
  readonly maxParams: number;
}

/**
 * The transaction isolation levels.
 *
 * @example
 * ```ts
 * const level: IsolationLevel = "serializable";
 * ```
 */
export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

/**
 * Options for starting a transaction.
 *
 * @example
 * ```ts
 * const options: BeginOptions = { isolation: "serializable", readOnly: true };
 * ```
 */
export interface BeginOptions {
  readonly isolation?: IsolationLevel;
  readonly readOnly?: boolean;
  /** Postgres: `DEFERRABLE`, meaningful with `serializable` and `readOnly`. */
  readonly deferrable?: boolean;
}

/**
 * Options for one execution.
 *
 * @example
 * ```ts
 * const options: ExecuteOptions = { timeoutMs: 5_000, signal: AbortSignal.timeout(10_000) };
 * ```
 */
export interface ExecuteOptions {
  /** Aborting cancels the statement on the server; the call rejects with `AdapterError` (code `"aborted"`). */
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * Options for a streamed execution.
 *
 * @example
 * ```ts
 * const options: StreamOptions = { batchSize: 500 };
 * ```
 */
export interface StreamOptions extends ExecuteOptions {
  /** How many rows to fetch from the server at a time. */
  readonly batchSize?: number;
}

/**
 * Anything that can run SQL: an {@link Adapter} (on any pooled connection) or a
 * {@link Connection} (on that connection). The repo is written against this, which is
 * how a transaction-scoped repo is the same code as the root repo.
 *
 * Errors thrown by the driver are passed through {@link Adapter.normalizeError} first.
 *
 * @example
 * ```ts
 * async function countUsers(db: Executor): Promise<number> {
 *   const result = await db.execute('select count(*)::int as "c0" from "users"', []);
 *   return result.rows[0]?.c0 as number;
 * }
 * ```
 */
export interface Executor {
  /** Runs one statement and returns all of its rows. */
  execute(sql: string, params: readonly unknown[], options?: ExecuteOptions): Promise<RawResult>;
  /**
   * Runs one statement and yields its rows as they arrive. Leaving the loop early closes
   * the cursor and frees the connection.
   */
  stream(
    sql: string,
    params: readonly unknown[],
    options?: StreamOptions,
  ): AsyncIterable<Record<string, unknown>>;
}

/**
 * One checked-out database connection: the unit a transaction runs on. Every method
 * runs on this connection and nowhere else.
 *
 * A connection that fails fatally (socket closed, protocol error) is destroyed on
 * `release`, not returned to the pool.
 *
 * @example
 * ```ts
 * async function inTransaction(adapter: Adapter, work: (db: Executor) => Promise<void>): Promise<void> {
 *   const connection = await adapter.acquire();
 *   try {
 *     await connection.begin();
 *     await work(connection);
 *     await connection.commit();
 *   } catch (error) {
 *     await connection.rollback();
 *     throw error;
 *   } finally {
 *     await connection.release();
 *   }
 * }
 * ```
 */
export interface Connection extends Executor {
  begin(options?: BeginOptions): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /** `SAVEPOINT name`. The name is quoted as an identifier. */
  savepoint(name: string): Promise<void>;
  /** `ROLLBACK TO SAVEPOINT name`. */
  rollbackTo(name: string): Promise<void>;
  /** `RELEASE SAVEPOINT name`. */
  releaseSavepoint(name: string): Promise<void>;
  /** Returns the connection to the pool. Idempotent. */
  release(): Promise<void>;
}

/**
 * The conflict handling of a compiled insert.
 *
 * - `"raise"`: no clause; a conflict is an error.
 * - `"nothing"`: `DO NOTHING`.
 * - `"replaceAll"`: update every inserted column.
 * - `{ replace }`: update these fields.
 * - `{ replaceAllExcept }`: update every inserted column except these fields.
 * - `{ query }`: update as this `updateAll`-style query says.
 *
 * Ecto equivalent: the `:on_conflict` option of `Repo.insert/2`.
 *
 * @example
 * ```ts
 * declare const name: FieldMeta;
 * const onConflict: OnConflict = { replace: [name] };
 * ```
 */
export type OnConflict =
  | "raise"
  | "nothing"
  | "replaceAll"
  | { readonly replace: readonly FieldMeta[] }
  | { readonly replaceAllExcept: readonly FieldMeta[] }
  | { readonly query: QueryAst };

/**
 * Which conflict a compiled insert handles: the unique index on these fields, a named
 * constraint, or a fragment (an index expression, possibly with a predicate).
 *
 * Ecto equivalent: the `:conflict_target` option of `Repo.insert/2`.
 *
 * @example
 * ```ts
 * const target: ConflictTarget = { constraint: "users_email_index" };
 * ```
 */
export type ConflictTarget =
  | { readonly fields: readonly FieldMeta[] }
  | { readonly constraint: string }
  | { readonly fragment: FragmentNode };

/**
 * What a compiled insert does besides inserting.
 *
 * @example
 * ```ts
 * declare const id: FieldMeta;
 * const options: InsertPlanOptions = { rows: 1, returning: [id], onConflict: "raise", conflictTarget: undefined };
 * ```
 */
export interface InsertPlanOptions {
  /** How many rows the statement inserts. */
  readonly rows: number;
  /** The fields to return, in order; empty for none. */
  readonly returning: readonly FieldMeta[];
  readonly onConflict: OnConflict;
  readonly conflictTarget: ConflictTarget | undefined;
}

/**
 * The query-level operations {@link Adapter.compile} can compile a `QueryAst` for.
 *
 * Ecto equivalent: the `:all`, `:update_all` and `:delete_all` operations of an adapter's `prepare/2`.
 *
 * @example
 * ```ts
 * const operation: QueryOperation = "all";
 * ```
 */
export type QueryOperation = "all" | "updateAll" | "deleteAll";

/**
 * One executed statement, as reported to telemetry listeners. `params` is present only
 * when the adapter was configured to log parameters, and never includes the value of a
 * redacted field.
 *
 * @example
 * ```ts
 * function logSlow(event: QueryEvent): void {
 *   if (event.durationMs > 100) process.stderr.write(`slow query (${event.durationMs} ms): ${event.sql}\n`);
 * }
 * ```
 */
export interface QueryEvent {
  readonly sql: string;
  readonly paramCount: number;
  /** Time spent executing, in milliseconds. */
  readonly durationMs: number;
  /** Time spent waiting for a connection, in milliseconds. */
  readonly queueMs: number;
  readonly rowCount: number;
  /** The normalised error, when the statement failed. */
  readonly error: unknown;
  readonly params: readonly unknown[] | undefined;
}

/**
 * The state of the connection pool, reported with pool events.
 *
 * @example
 * ```ts
 * function isSaturated(event: PoolEvent): boolean {
 *   return event.idle === 0 && event.waiting > 0;
 * }
 * ```
 */
export interface PoolEvent {
  /** Open connections. */
  readonly size: number;
  /** Open connections that are not checked out. */
  readonly idle: number;
  /** Callers waiting for a connection. */
  readonly waiting: number;
}

/**
 * The events an adapter emits, by name.
 *
 * @example
 * ```ts
 * type Listener = (event: AdapterEvents["query"]) => void;
 * ```
 */
export interface AdapterEvents {
  readonly query: QueryEvent;
  readonly connect: PoolEvent;
  readonly disconnect: PoolEvent;
  readonly poolExhausted: PoolEvent;
}

/**
 * A database, as the repo sees it: compile statements, run them, hand out connections.
 *
 * `compile*` methods are synchronous and cached: the same query shape, or the same
 * (schema, operation, column set, options), returns the same {@link CompiledQuery}.
 *
 * Ecto equivalent: the `Ecto.Adapter` behaviours (`Queryable`, `Schema`, `Transaction`).
 *
 * @example
 * ```ts
 * async function all(adapter: Adapter, ast: QueryAst): Promise<readonly Record<string, unknown>[]> {
 *   const plan = adapter.compile(ast, "all");
 *   const params = plan.slots.map((slot) => (slot.kind === "inline" ? ast.params[slot.index] : undefined));
 *   return (await adapter.execute(plan.sql, params)).rows;
 * }
 * ```
 */
export interface Adapter extends Executor {
  readonly dialect: Dialect;
  readonly capabilities: Capabilities;

  /**
   * Compiles a query. Slots refer to `ast.params`.
   *
   * @throws QueryError when the query is invalid or uses a feature the dialect lacks.
   */
  compile(ast: QueryAst, operation: QueryOperation): CompiledQuery;

  /**
   * Compiles `INSERT INTO source (columns…) VALUES (…), … [ON CONFLICT …] [RETURNING …]`.
   * Slots refer to a flat array of the values row by row: the value of `columns[c]` for
   * row `r` is at index `r * columns.length + c`.
   */
  compileInsert(meta: SchemaMeta, columns: readonly FieldMeta[], options: InsertPlanOptions): CompiledQuery;

  /**
   * Compiles `UPDATE source SET set… WHERE where… [RETURNING …]`, where every `where`
   * field is compared for equality. Slots refer to the `set` values followed by the
   * `where` values.
   */
  compileUpdate(
    meta: SchemaMeta,
    set: readonly FieldMeta[],
    where: readonly FieldMeta[],
    returning: readonly FieldMeta[],
  ): CompiledQuery;

  /**
   * Compiles `DELETE FROM source WHERE where… [RETURNING …]`. Slots refer to the `where` values.
   */
  compileDelete(
    meta: SchemaMeta,
    where: readonly FieldMeta[],
    returning: readonly FieldMeta[],
  ): CompiledQuery;

  /** Checks a connection out of the pool. The caller must `release` it. */
  acquire(): Promise<Connection>;

  /**
   * Maps a driver error to an Ectype error (`ConstraintError`, `AdapterError`, …), keeping
   * the original as `cause`. Anything it does not recognise is returned unchanged.
   */
  normalizeError(error: unknown): unknown;

  /**
   * The driver conversions this dialect needs for `type`, replacing the type's own
   * `load` and `dump`; `undefined` when the type's own are right. For example Postgres
   * sends `int8` and `numeric` as text. `resolveCodec` (step 03) calls this once per type
   * and caches the answer.
   */
  readonly typeOverrides: (type: AnyEctoType) => Codec | undefined;

  /** Subscribes to an event. Returns the function that unsubscribes. */
  on<E extends keyof AdapterEvents>(event: E, listener: (payload: AdapterEvents[E]) => void): () => void;

  /** Closes the pool after the checked-out connections are released. Idempotent. */
  close(): Promise<void>;
}
