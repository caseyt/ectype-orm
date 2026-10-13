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
import type { ExprNode, FragmentNode, QueryAst, QueryOperation } from "./query.js";
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
 *   expands to `IN (?, ?, …)`. The list's length is then part of the plan-cache key
 *   (`QueryAst.listLengths`).
 * - `named`: the value the caller supplied under `name`.
 *
 * `params` is the array the compiled statement was defined over: `QueryAst.params` for
 * {@link Adapter.compile}, and the arrays described on {@link Adapter.compileInsert},
 * {@link Adapter.compileUpdate}, {@link Adapter.compileDelete} and
 * {@link Adapter.compileFragment} for those.
 *
 * `dump` converts the application value to the driver value. `undefined` means "pass it
 * through" (the type's dump was the identity), so the hot path tests one property instead
 * of calling a function. It is never called with `null`. For `list` it is applied to
 * every element.
 *
 * `redact` is true when the value belongs to a redacted field (`FieldMeta.redact`, or a
 * parameter node marked `redact`). Telemetry and logs show `**redacted**` in its place.
 *
 * The same parameter may fill several slots.
 *
 * @example
 * ```ts
 * // WHERE "u"."id" = ANY($1) AND "u"."age" >= $2
 * const slots: ParamSlot[] = [
 *   { kind: "list", index: 1, dump: undefined, redact: false },
 *   { kind: "named", name: "minAge", dump: undefined, redact: false },
 * ];
 * ```
 */
export type ParamSlot =
  | {
      readonly kind: "inline";
      readonly index: number;
      readonly dump: Dump | undefined;
      readonly redact: boolean;
    }
  | {
      readonly kind: "list";
      readonly index: number;
      readonly dump: Dump | undefined;
      readonly redact: boolean;
    }
  | {
      readonly kind: "element";
      readonly index: number;
      readonly element: number;
      readonly dump: Dump | undefined;
      readonly redact: boolean;
    }
  | {
      readonly kind: "named";
      readonly name: string;
      readonly dump: Dump | undefined;
      readonly redact: boolean;
    };

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
 * A preloaded association that a `row` leaf of an {@link OutputPlan} carries (step 14).
 * The compiler lists every association the query preloads on that row, taken from
 * `QueryAst.preloads` (preload names are part of `shape`, so they belong to the plan).
 *
 * - With `row`, it is a **join preload**: the child is built from columns of the same
 *   result row, as `row` says.
 * - With `row` undefined, the association is loaded by a **separate query** after
 *   decoding; the plan only reserves the property.
 *
 * @example
 * ```ts
 * declare const posts: OutputPlan & { kind: "row" };
 * const joined: OutputPreload = { assoc: "posts", cardinality: "many", row: posts };
 * const separate: OutputPreload = { assoc: "profile", cardinality: "one", row: undefined };
 * ```
 */
export interface OutputPreload {
  /** The association name: the property the children are stored under. */
  readonly assoc: string;
  /** `"many"` holds an array of children; `"one"` holds a child or `null`. */
  readonly cardinality: "one" | "many";
  /** How to build one child from the result row (a `row` leaf, which may nest further); `undefined` for a separate-query preload. */
  readonly row: OutputPlan | undefined;
}

/**
 * How to turn one result row into what the query selected. It mirrors the query's
 * `SelectShape` with, at every leaf, the output column alias (`c0`, `c1`, …) to read.
 * Produced by the compiler (step 10); step 12 builds the {@link RowDecoder} from it.
 *
 * - `value`: one column; `type` loads it when present.
 * - `row`: a schema row; `aliases[i]` is the output column of `meta.persisted[i]`.
 *   `nullable` is true when the binding can be absent from a result row (it is on the
 *   optional side of an outer join): the decoder then yields `null` instead of a row
 *   when every `key` column is `null`. For a schema without a primary key `key` is empty
 *   and proves nothing, so the test is then that every column in `aliases` is `null`
 *   (the compiler always lists them all; a real row of such a schema whose columns are
 *   all `NULL` cannot be told from an absent one, which is a limit of keyless schemas).
 *   `key` holds the output columns of the primary key, in `meta.primaryKey` order
 *   (empty for a schema without one): what identifies the row in the result.
 *   `prefix` is the resolved prefix of the table source the rows originate from, or the
 *   schema's declared prefix when they have no single origin ("Prefixes" on
 *   {@link Adapter}, rule 2). The decoder stamps each row from its own leaf:
 *   `leaf.meta.rowMeta("loaded", leaf.prefix)`.
 *   `preloads` lists the associations the row carries (empty for an ordinary row). A row
 *   with preloads is built with `meta.createWith(preloads.map((p) => p.assoc))`.
 * - `constant`: no column. The value is `constants[index]` of the query's `SelectNode`,
 *   returned as it is; it was never sent to the database.
 * - `object` / `tuple`: an object or array of the nested plans.
 *
 * ## Join preloads: who does what
 *
 * A {@link RowDecoder} sees one result row, is generated once per plan and is shared by
 * every execution of it, so it holds no state and **cannot de-duplicate parents**. With a
 * join preload several result rows describe one parent, and the work is split:
 *
 * 1. **The decoder, per result row,** builds the parent with the child of *that* row in
 *    place: for a join preload with cardinality `many`, an array holding the one child
 *    (empty when the child's `key` columns are all `null`); with cardinality `one`, the
 *    child or `null`. A separate-query preload starts as an empty array or `null`.
 * 2. **The repo's post-decode stage** (step 12's `afterDecode(rows, plan, ctx)` hook,
 *    implemented by step 14) merges the decoded values: parents with equal primary keys
 *    become the first one seen, in first-seen order; their `many` children are
 *    concatenated and de-duplicated by the child's primary key; the same is applied to
 *    each child's own join preloads. It needs nothing but the plan: the `row` leaves say
 *    where parents and children are, `meta.primaryKey` names the key fields to compare on
 *    the decoded rows, and `preloads` names the properties and their cardinality.
 *
 * @example
 * ```ts
 * // select(({ u }) => ({ id: u.id, email: u.email, kind: "user" }))
 * const plan: OutputPlan = {
 *   kind: "object",
 *   keys: ["id", "email", "kind"],
 *   values: [
 *     { kind: "value", alias: "c0", type: undefined },
 *     { kind: "value", alias: "c1", type: undefined },
 *     { kind: "constant", index: 0 },
 *   ],
 * };
 * ```
 */
export type OutputPlan =
  | { readonly kind: "value"; readonly alias: string; readonly type: AnyEctoType | undefined }
  | {
      readonly kind: "row";
      readonly meta: SchemaMeta;
      readonly aliases: readonly string[];
      readonly key: readonly string[];
      readonly prefix: string | undefined;
      readonly nullable: boolean;
      readonly preloads: readonly OutputPreload[];
    }
  | { readonly kind: "constant"; readonly index: number }
  | { readonly kind: "object"; readonly keys: readonly string[]; readonly values: readonly OutputPlan[] }
  | { readonly kind: "tuple"; readonly items: readonly OutputPlan[] };

/**
 * Turns one raw result row into the value the query selected. Generated once per plan and
 * shared by every execution of it, so it is a pure function of its arguments: it keeps no
 * state between rows. Anything that spans rows (merging the parents of a join preload) is
 * done after decoding; see {@link OutputPlan}.
 * `constants` is the `constants` array of the executed query's `SelectNode` (an empty
 * array when it has none): a plan is shared by every query of one shape, so the values
 * of selected constants come from the query, never from the plan.
 *
 * @example
 * ```ts
 * const decode: RowDecoder = (row, constants) => ({ id: row.c0, kind: constants[0] });
 * ```
 */
export type RowDecoder = (row: Readonly<Record<string, unknown>>, constants: readonly unknown[]) => unknown;

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
 *   slots: [{ kind: "inline", index: 0, dump: undefined, redact: false }],
 *   output: { kind: "value", alias: "c0", type: undefined },
 *   prefix: undefined,
 *   decoder: undefined,
 * };
 * ```
 */
export interface CompiledQuery {
  readonly sql: string;
  /** One per placeholder, in placeholder order. */
  readonly slots: readonly ParamSlot[];
  /** What the result rows hold; `undefined` when the rows are returned raw or there are none. */
  readonly output: OutputPlan | undefined;
  /**
   * The prefix the statement's **target or root table** resolved to (see "Prefixes" on
   * {@link Adapter}): the table written by a row-level write, an `updateAll` or a
   * `deleteAll`; the root source of a query when that is a table; `undefined` otherwise
   * (a fragment, or a root that is a subquery, a CTE or a values list).
   *
   * It is what the repo stamps on the row it returns from a **row-level write**
   * (`meta.rowMeta("loaded", plan.prefix)`), where there is one table and no output-plan
   * leaf to ask, and what telemetry reports. Rows decoded from a query's
   * {@link OutputPlan} are **not** stamped with it: each takes the prefix of its own
   * `row` leaf, because a joined table can resolve to another prefix than the root. For a
   * query whose root is a table it equals the root leaf's `prefix`; it is kept, although
   * redundant there, so that writes and queries report their table the same way.
   */
  readonly prefix: string | undefined;
  /** Set by the repo, not by the adapter. */
  decoder: RowDecoder | undefined;
}

/**
 * What a statement returned, exactly as the driver reported it.
 *
 * @example
 * ```ts
 * const result: RawResult = { rows: [{ c0: 1 }], rowCount: 1, insertId: undefined };
 * ```
 */
export interface RawResult {
  readonly rows: readonly Record<string, unknown>[];
  /** Rows returned by a `SELECT`; rows affected by an `INSERT`, `UPDATE` or `DELETE`. */
  readonly rowCount: number;
  /**
   * The key the database generated for the last inserted row, on dialects that report it
   * with the result (MySQL's `insertId`, SQLite's `lastInsertRowid`); `undefined`
   * otherwise, and always on Postgres. It is what the insert path reads back on a dialect
   * without `RETURNING` (step 13).
   */
  readonly insertId: bigint | number | undefined;
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
 * declare const plan: CompiledQuery;
 * const options: ExecuteOptions = {
 *   timeoutMs: 5_000,
 *   slots: plan.slots,
 *   context: { operation: "all", source: "users" },
 * };
 * ```
 */
export interface ExecuteOptions {
  /** Aborting cancels the statement on the server; the call rejects with `AdapterError` (code `"aborted"`). */
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /**
   * Runs the statement as a named server-side prepared statement, where the dialect has
   * them (step 09, `prepare(query, { name })`). The same name must always go with the
   * same SQL text. Ignored by dialects without named statements.
   */
  readonly statementName?: string;
  /**
   * The slots of the plan being executed (`plan.slots`, no copy). The adapter needs them
   * for one thing: `params[i]` is replaced by `**redacted**` in a {@link QueryEvent} when
   * `slots[i].redact` is true. Without them an adapter that reports parameters must
   * treat every parameter as redacted.
   */
  readonly slots?: readonly ParamSlot[];
  /**
   * Anything the caller wants back: it is handed, untouched, to the listeners as
   * {@link QueryEvent.context} of the event for this execution. This is how the repo
   * attaches its own facts (operation, source schema, the caller's `telemetry` option) to
   * the right event when executions overlap.
   */
  readonly context?: unknown;
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
 * `release`, not returned to the pool. The caller can force that with `destroy`, for a
 * connection whose state it can no longer trust (step 16: a `ROLLBACK` that failed).
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
 *     try {
 *       await connection.rollback();
 *     } catch {
 *       await connection.destroy();
 *     }
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
  /** Returns the connection to the pool. Idempotent, and a no-op after `destroy`. */
  release(): Promise<void>;
  /** Closes the connection and removes it from the pool instead of returning it. Idempotent. */
  destroy(): Promise<void>;
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
 * One cell of an insert whose rows are not all plain values.
 *
 * - `value`: a bound value, taken from the insert's parameter array.
 * - `default`: the keyword `DEFAULT`: the column's database default applies. This is how
 *   rows with different sets of fields ("ragged" rows) share one statement.
 * - `expr`: an expression, which may be a subquery (`{ kind: "subquery", … }`) or a
 *   fragment. Its parameter nodes carry their values, as in a query.
 * - `placeholder`: a value supplied by name and shared by many cells; it compiles to a
 *   `named` slot.
 *
 * Ecto equivalent: the values `Repo.insert_all/3` accepts for a field (a value, a query,
 * `{:placeholder, key}`).
 *
 * @example
 * ```ts
 * const cells: InsertCell[] = [{ kind: "value" }, { kind: "default" }, { kind: "placeholder", name: "now" }];
 * ```
 */
export type InsertCell =
  | { readonly kind: "value" }
  | { readonly kind: "default" }
  | { readonly kind: "expr"; readonly expr: ExprNode }
  | { readonly kind: "placeholder"; readonly name: string };

/**
 * What an insert inserts.
 *
 * - `values`: `rows` rows, each a bound value for every column. The common case, and the
 *   one whose plan depends on nothing but the column list and the row count.
 * - `cells`: rows spelled out cell by cell (see {@link InsertCell}); every row has one
 *   cell per column.
 * - `query`: `INSERT INTO … (columns) SELECT …`; the query's select list supplies the
 *   columns, in order.
 *
 * @example
 * ```ts
 * const single: InsertSource = { kind: "values", rows: 1 };
 * const ragged: InsertSource = {
 *   kind: "cells",
 *   rows: [
 *     [{ kind: "value" }, { kind: "value" }],
 *     [{ kind: "value" }, { kind: "default" }],
 *   ],
 * };
 * ```
 */
export type InsertSource =
  | { readonly kind: "values"; readonly rows: number }
  | { readonly kind: "cells"; readonly rows: readonly (readonly InsertCell[])[] }
  | { readonly kind: "query"; readonly query: QueryAst };

/**
 * Everything about a compiled insert besides the table and the columns.
 *
 * @example
 * ```ts
 * declare const id: FieldMeta;
 * const options: InsertPlanOptions = {
 *   source: { kind: "values", rows: 1 },
 *   returning: [id],
 *   onConflict: "raise",
 *   conflictTarget: undefined,
 * };
 * ```
 */
export interface InsertPlanOptions {
  readonly source: InsertSource;
  /** The fields to return, in order; empty for none. */
  readonly returning: readonly FieldMeta[];
  readonly onConflict: OnConflict;
  readonly conflictTarget: ConflictTarget | undefined;
}

/**
 * Options for {@link Adapter.compileExplain}.
 *
 * @example
 * ```ts
 * const options: ExplainOptions = { analyze: true, format: "json" };
 * ```
 */
export interface ExplainOptions {
  /** Executes the statement and reports actual timings. A write really happens. */
  readonly analyze?: boolean;
  readonly format?: "text" | "json";
}

/**
 * One executed statement, as reported to telemetry listeners. `params` is present only
 * when the adapter was configured to log parameters. A parameter that fills a slot marked
 * `redact` appears as `**redacted**`; when the execution was not given its slots
 * (`ExecuteOptions.slots`), every parameter does.
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
  /** The `context` the caller passed in `ExecuteOptions`, untouched; `undefined` when it passed none. */
  readonly context: unknown;
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
 * `compile*` methods are synchronous and cached per adapter instance: the same query
 * shape, or the same (schema, operation, column set, options), with the same prefix,
 * returns the same {@link CompiledQuery}.
 *
 * ## Prefixes
 *
 * A prefix is the schema (Postgres) or database (MySQL) a table lives in. Two rules
 * decide every prefix; everything after them is a consequence.
 *
 * **Rule 1, resolution.** A prefix is decided in exactly one place: where a table source
 * is lowered. It is the first that is set of, in Ecto's order,
 *
 * `source.prefix ?? schemaMeta.prefix ?? query.prefix ?? argument`
 *
 * where `source.prefix` is the prefix given to that `from` or join, `schemaMeta.prefix`
 * the one the schema declares, `query.prefix` that of the query the source sits in, and
 * `argument` the `prefix` parameter of the `compile*` call. Nothing else in the compiler
 * decides a prefix.
 *
 * **Rule 2, provenance.** A `row` leaf of the {@link OutputPlan} carries the resolved
 * prefix of the table source its rows originate from. The value travels upward unchanged
 * through whatever wraps that source (a subquery, a CTE, a join preload, `RETURNING`),
 * because an outer leaf is built from the inner leaf and never resolved again. A row with
 * no single originating table source has no provenance, and its leaf takes the prefix
 * its schema declares: the value a newly built row holds (`RowMeta.prefix`).
 *
 * **To step 10:** implement this as one resolve function, called where a table source is
 * lowered, plus propagation of the leaf's value; there must be no prefix logic per node
 * kind.
 *
 * ### What the repo passes
 *
 * - **A query** (`compile`, `compileExplain`): `argument` is the per-call `prefix` option,
 *   else the repo default. It is the weakest position.
 * - **A row-level write** (`compileInsert`, `compileUpdate`, `compileDelete`): the
 *   statement has one table source and no query, and its `prefix` parameter is that
 *   source's own prefix, the strongest position. The repo passes the per-call option,
 *   else the row's `RowMeta.prefix`, else its default. (`insertAll` has no row and uses
 *   the schema's declared prefix in the row's place, which is what a built row holds.)
 *
 * A decoded row is stamped from its leaf: `leaf.meta.rowMeta("loaded", leaf.prefix)`.
 * The repo never rewrites an AST to apply a prefix.
 *
 * ### Consequences
 *
 * - A schema that declares a prefix keeps it whatever the query, the call or the repo
 *   say; a per-call prefix on a read does not override a query's own; a per-call prefix
 *   on a write overrides everything.
 * - A row is written back, and reloaded, where it was read: a write passes the row's own
 *   prefix in the strongest position, and `reload` puts it on its query's source.
 * - The tables of one statement can resolve differently, so rows of one result can carry
 *   different prefixes (second table below). Children of a join preload carry theirs.
 * - A row read through a subquery or a CTE carries the prefix of the inner table (third
 *   table below). A CTE reference (`CteSourceNode`) is not a table source: rule 1 does
 *   not apply to it, and its leaf is the CTE's own, including inside a recursive CTE,
 *   where the self-reference adds nothing to the anchor's provenance.
 * - A set operation has provenance when all its branches agree on the prefix, and none
 *   when they differ. Rows built from expressions, from a values list or from a fragment
 *   have none. With no provenance the row holds its schema's declared prefix and is
 *   written back like a built row; select the prefix as a column to do otherwise.
 * - A separate-query preload (step 14) is a query of its own: its children are stamped
 *   from its own leaves. Its `argument` is the parents' `RowMeta.prefix`, with parents of
 *   different prefixes loaded in separate queries.
 * - `updateAll` and `deleteAll` are queries: every table resolves by rule 1, `RETURNING`
 *   rows are stamped from their leaves, and {@link CompiledQuery.prefix} is the target's.
 *   `compileExplain` resolves as `compile` does. Streams use the same decoder.
 * - The plan cache key is the query's structure plus the `prefix` parameter. The
 *   per-source prefixes, the query prefix and each schema (its name and declared prefix)
 *   are part of the structure; see "Shape" in `query.ts`.
 *
 * ### Checks
 *
 * One table, no per-call option. Every operation lands on the same table:
 *
 * | Schema declares | Repo default | insert | get / all | update | delete |
 * |---|---|---|---|---|---|
 * | `auth` | none | `auth` (built row) | `auth` (schema) | `auth` (the row's) | `auth` |
 * | none | `tenant_1` | `tenant_1` (repo default) | `tenant_1` (argument) | `tenant_1` (the row's) | `tenant_1` |
 * | `auth` | `tenant_1` | `auth` (built row) | `auth` (schema before argument) | `auth` (the row's) | `auth` |
 *
 * Several tables. Repo default `tenant_1`; `User` declares none; `Org` declares `global`;
 * `Post` is joined with the per-source prefix `archive`; all three bindings selected:
 *
 * | Binding | Rule 1 stops at | Read from | Row's `RowMeta.prefix` | `update` / `delete` of that row |
 * |---|---|---|---|---|
 * | `u` (`User`) | the argument | `tenant_1.users` | `tenant_1` | `tenant_1.users` |
 * | `o` (`Org`) | the schema | `global.orgs` | `global` | `global.orgs` |
 * | `p` (`Post`) | the source | `archive.posts` | `archive` | `archive.posts` |
 *
 * Through a subquery. Repo default `tenant_1`; `Post` declares none; a subquery over
 * `Post` whose source has the per-source prefix `archive` (or whose query prefix is
 * `archive`), used as the source of an outer binding `s` that is selected whole:
 *
 * | Binding | Rule 1, at the inner source | Rule 2 | Read from | Row's prefix | `update` / `delete` | `reload` |
 * |---|---|---|---|---|---|---|
 * | `s` | `archive` | the outer leaf is the inner leaf's | `archive.posts` | `archive` | `archive.posts` | `archive.posts` |
 *
 * Ecto equivalent of the order: "Query prefix" in the `Ecto.Query` documentation.
 *
 * Ecto equivalent: the `Ecto.Adapter` behaviours (`Queryable`, `Schema`, `Transaction`).
 *
 * @example
 * ```ts
 * async function all(adapter: Adapter, ast: QueryAst): Promise<readonly Record<string, unknown>[]> {
 *   const plan = adapter.compile(ast, "all", undefined);
 *   const params = plan.slots.map((slot) => (slot.kind === "inline" ? ast.params[slot.index] : undefined));
 *   return (await adapter.execute(plan.sql, params, { slots: plan.slots })).rows;
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
  compile(ast: QueryAst, operation: QueryOperation, prefix: string | undefined): CompiledQuery;

  /**
   * Compiles the statement that asks the database for the plan of a query: what
   * `repo.explain` runs. The `EXPLAIN` syntax and its options are the dialect's. Slots
   * refer to `ast.params`; `output` is `undefined` (the rows are the database's report).
   *
   * @throws QueryError when the dialect lacks an option that was asked for.
   */
  compileExplain(
    ast: QueryAst,
    operation: QueryOperation,
    prefix: string | undefined,
    options: ExplainOptions,
  ): CompiledQuery;

  /**
   * Compiles a bare fragment as a whole statement: what `repo.query(fragment\`…\`)` runs.
   * The static strings are emitted as written, values are bound, and `fragment.ident`
   * names are quoted for the dialect. Slots refer to the values of the fragment's
   * parameter nodes in canonical order (`collectParams(fragment)`). `output` is
   * `undefined`: the rows are returned raw.
   */
  compileFragment(fragment: FragmentNode): CompiledQuery;

  /**
   * Compiles `INSERT INTO source (columns…) … [ON CONFLICT …] [RETURNING …]`.
   *
   * Slots refer to one flat parameter array, which the repo builds in three sections:
   *
   * 1. **The source.**
   *    - `values`: row by row; the value of `columns[c]` for row `r` is at index
   *      `r * columns.length + c`.
   *    - `cells`: row by row and cell by cell; a `value` cell takes one entry, an `expr`
   *      cell takes the values of its parameter nodes in canonical order, a `default` or
   *      `placeholder` cell takes none.
   *    - `query`: `query.params`.
   * 2. **The conflict target**, when it is a fragment: the values of its parameter nodes
   *    in canonical order.
   * 3. **The conflict action**, when it is `{ query }`: `query.params`.
   *
   * `placeholder` cells and named parameter nodes compile to `named` slots.
   *
   * @throws QueryError when a form is used that the dialect lacks (`capabilities`).
   */
  compileInsert(
    meta: SchemaMeta,
    columns: readonly FieldMeta[],
    options: InsertPlanOptions,
    prefix: string | undefined,
  ): CompiledQuery;

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
    prefix: string | undefined,
  ): CompiledQuery;

  /**
   * Compiles `DELETE FROM source WHERE where… [RETURNING …]`. Slots refer to the `where` values.
   */
  compileDelete(
    meta: SchemaMeta,
    where: readonly FieldMeta[],
    returning: readonly FieldMeta[],
    prefix: string | undefined,
  ): CompiledQuery;

  /** Checks a connection out of the pool. The caller must `release` it. */
  acquire(): Promise<Connection>;

  /**
   * Maps a driver error to an Ectype error (`ConstraintError`, `AdapterError`, …), keeping
   * the original as `cause`. Anything it does not recognise is returned unchanged.
   */
  normalizeError(error: unknown): unknown;

  /**
   * The driver conversions this adapter needs for `type`, replacing the type's own
   * `load` and `dump`; `undefined` when the type's own are right. For example Postgres
   * sends `int8` and `numeric` as text. The answer depends on this adapter's options
   * (two Postgres adapters may load `int8` differently), so `resolveCodec` (step 03)
   * caches it per (type, adapter instance), not per dialect.
   */
  readonly typeOverrides: (type: AnyEctoType) => Codec | undefined;

  /** Subscribes to an event. Returns the function that unsubscribes. */
  on<E extends keyof AdapterEvents>(event: E, listener: (payload: AdapterEvents[E]) => void): () => void;

  /** Closes the pool after the checked-out connections are released. Idempotent. */
  close(): Promise<void>;
}
