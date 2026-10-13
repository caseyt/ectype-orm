# Step 02 — Core contracts and the Kysely bridge spike

> **Merged before the API review.** This file is edited to the names decided in plan
> README §11, and PR #4 brought the merged code into line with them.
>
> **Part B's verdict is superseded.** ADR 0002 accepted Kysely; ADR 0003 (2026-10-13)
> replaced it with our own SQL emitter and driver wrappers. Part B below is kept as the
> record of what the spike was asked.

**Depends on:** 01. **Blocks:** everything else.
**Owns:** `packages/core/src/contracts/`, `packages/core/src/errors.ts`,
`packages/core/src/internal/`, `docs/adr/0002-kysely-backend.md`, `docs/plan/spikes/kysely-bridge/`.

## Goal

Freeze the interfaces that steps 03–18 code against, so they can be built in parallel
without colliding, and prove (or disprove) decision D12 before anything depends on it.

This step produces **types, constants, errors and two spikes**. It produces almost no
behaviour. Keep it small and get it right; a change here later costs every other step.

## Part A — Contracts

Write each as a TypeScript file under `contracts/` with full TSDoc. The shapes below are
normative for names and semantics; refine field details as needed and record refinements.

### `contracts/type.ts`

```ts
export type CastResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly message?: string; readonly meta?: Readonly<Record<string, unknown>> };

/** Ecto.Type. TApp is the value in application code, TDb what the driver sends/receives. */
export interface FieldType<TApp, TDb = unknown> {
  readonly name: string;                 // "string", "integer", "timestamp", ...
  readonly db: DbType;                   // logical column type; used by casts and migrations
  cast(input: unknown): CastResult<TApp>;  // untrusted external input -> app value (changesets)
  fromDb(value: TDb): TApp;                  // driver value -> app value (hot path)
  toDb(value: TApp): TDb;                  // app value -> driver parameter
  equal(a: TApp, b: TApp): boolean;        // change detection
}
export declare const IDENTITY: <T>(v: T) => T;   // fromDb/toDb === IDENTITY means "skip the call"
export type DbType =
  | { kind: "integer" | "bigint" | "float" | "decimal" | "boolean" | "text" | "uuid" | "binary"
          | "date" | "time" | "timestamp" | "timestamptz" | "json" | "jsonb" }
  | { kind: "array"; of: DbType }
  | { kind: "custom"; sql: string };
```

`null` never reaches `cast`/`fromDb`/`toDb`; nullability is handled by the caller.

### `contracts/schema.ts`

```ts
export interface FieldMeta {
  readonly name: string;            // "createdAt"
  readonly column: string;          // "created_at"
  readonly type: FieldType<any, any>;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  readonly virtual: boolean;        // never read from or written to the database
  readonly redact: boolean;         // hidden from inspect/toJSON/logs
  readonly writable: "always" | "insert" | "never";
  readonly dbGenerated: boolean;   // database generates it; RETURNING it
  readonly default: undefined | { kind: "value"; value: unknown } | { kind: "fn"; fn: () => unknown };
  readonly autogenerate: undefined | { on: "insert" | "insertAndUpdate"; fn: () => unknown };
  readonly index: number;           // position in SchemaMeta.fields
}
export type AssocKind = "belongsTo" | "hasOne" | "hasMany" | "manyToMany";
export interface AssocMeta { /* name, kind, owner, target(): SchemaClass, ownerKey, relatedKey,
  joinThrough?, joinKeys?, through?, onReplace, where?, orderBy?, defaults? */ }
export interface EmbedMeta { /* name, cardinality: "one" | "many", schema(), onReplace, column */ }
export interface SchemaMeta {
  readonly name: string;                         // class name, for errors
  readonly source: string | null;                // null for embedded schemas
  readonly schema: string | undefined;           // database schema (was `prefix`)
  readonly fields: readonly FieldMeta[];         // declaration order; defines the row shape
  readonly fieldsByName: ReadonlyMap<string, FieldMeta>;
  readonly persisted: readonly FieldMeta[];      // non-virtual
  readonly primaryKey: readonly FieldMeta[];
  readonly embeds: readonly EmbedMeta[];
  assocs(): ReadonlyMap<string, AssocMeta>;      // lazy: resolved on first call, then cached
  readonly create: (values: readonly unknown[]) => object;   // generated row factory (D2)
}
export declare const META: unique symbol;        // SchemaClass[META]: SchemaMeta
export declare const ROW: unique symbol;         // row[ROW]: RowMeta
export interface RowMeta { state: "built" | "loaded" | "deleted"; source: string; schema: string | undefined }
```

Also define the **type-level** contract, lifted from `spikes/schema-typing.ts`:
`AnySchema`, `FieldBuilder<T, Flags>`, `Row<S>`, `InsertShape<S>`, `Assoc<Kind, Target>`,
`AssocKeys<S>`, `Target<S, K>`, `Loaded<S, K>` (supporting nested paths, see step 14).

### `contracts/query.ts`

The query AST as plain readonly discriminated unions. Step 07 fills in the complete node
list; this step fixes the top level and the rules:

```ts
export interface QueryAst {
  readonly from: SourceNode;                       // table | subquery | values | fragment
  readonly joins: readonly JoinNode[];
  readonly wheres: readonly BoolNode[];            // each tagged and/or with the previous
  readonly select: SelectNode | undefined;         // undefined = whole root row
  readonly distinct, groupBys, havings, orderBys, limit, offset, lock, combinations,
           ctes, windows, preloads, updates, schema, hints; // typed in step 07
  readonly shape: number;                          // incremental structural hash (plan cache key)
}
export type ExprNode = /* column | param | named param | literal(null/true/false) | op | fn | fragment
                         | subquery | cast | case | json path | aggregate | window | selectedAs ... */;
```

Rules: nodes are frozen-by-convention plain objects (no classes, no `Object.freeze` cost
in production builds); every node has a string `kind`; values are carried in `param`
nodes, never embedded (D9); builders return new `QueryAst` objects that structurally
share unchanged arrays.

### `contracts/adapter.ts`

```ts
export interface CompiledQuery {
  readonly sql: string;
  readonly slots: readonly ParamSlot[];    // how to build the params array for each execution
  readonly decoder: RowDecoder | undefined; // set by repo/hydration, not by the adapter
}
export type ParamSlot = { kind: "inline"; index: number } | { kind: "named"; name: string };
export interface RawResult { readonly rows: readonly Record<string, unknown>[]; readonly rowCount: number }
export interface Capabilities { returning, onConflict, ilike, lateralJoin, fullJoin, arrays, jsonb,
  lockModes, ddlTransactions, savepoints, insertDefaultValues, cteMaterialized, ... : boolean | string[] }
export interface Adapter {
  readonly dialect: "postgres" | "mysql" | "sqlite";
  readonly capabilities: Capabilities;
  compile(ast: QueryAst, op: "all" | "updateAll" | "deleteAll"): CompiledQuery;
  compileInsert/compileUpdate/compileDelete(...): CompiledQuery;   // row-level writes
  execute(sql: string, params: readonly unknown[], conn?: Connection): Promise<RawResult>;
  stream(sql, params, opts, conn?): AsyncIterable<Record<string, unknown>>;
  acquire(): Promise<Connection>;          // Connection has release(), begin/commit/rollback, savepoint ops
  normalizeError(e: unknown): unknown;     // maps driver errors to ConstraintError etc.
  typeOverrides: ...;                      // per-dialect fromDb/toDb adjustments (e.g. int8, numeric)
  close(): Promise<void>;
}
```

### `contracts/changeset.ts`, `contracts/result.ts`, `contracts/standard-schema.ts`

- `Result<T, E>` = `{ success: true; data: T } | { success: false; error: E }`, with the
  helpers `success(data)` and `failure(error)`. The word `ok` is not used anywhere.
- `ChangesetError = { message: string; validation?: string; constraint?: string; meta: Record<string, unknown> }`
  where `message` may contain `{count}`-style placeholders filled from `meta` (Ecto's design, enables i18n).
- `Constraint = { type: "unique" | "foreignKey" | "check" | "exclusion" | "noAssoc"; name: string; match: "exact" | "suffix" | "prefix"; field: string; message: string }`.
- Vendored `StandardSchemaV1` interface (types only, per the spec's own guidance).
- `ValidatorFn<T>` (see step 06).

### `errors.ts`

`EgonError` base, each with a stable `code`: `NoResultsError`, `MultipleResultsError`,
`InvalidChangesetError` (carries the changeset), `StaleEntryError`, `ConstraintError`
(unhandled constraint; carries type, name, table, column), `QueryError` (bad query,
detected at build or compile), `CastError`, `NotLoadedError`, `DatabaseError` (wraps
driver errors, keeps `cause`), `SchemaDefinitionError`. (`MigrationError` is added and
exported by step 18, `RollbackError` by step 16.)
Messages say what happened, what was expected, and how to fix it.

### `internal/`

Small shared utilities with benchmarks: `hash.ts` (incremental FNV-1a or similar for
`shape`), `lru.ts`, `naming.ts` (camel ↔ snake, memoised), `inspect.ts` (redaction-aware).

## Part B — Kysely bridge spike (decides D12)

In `docs/plan/spikes/kysely-bridge/`, against real Postgres, build the smallest thing that answers:

1. **Lowering.** Can a hand-built AST for
   `SELECT u.id AS c0, count(p.id) AS c1 FROM users u JOIN posts p ON p.author_id = u.id WHERE u.age >= $1 AND p.published GROUP BY u.id ORDER BY u.inserted_at DESC LIMIT $2`
   be turned into Kysely `OperationNode`s **directly** (not through Kysely's fluent
   builder) and compiled by `PostgresQueryCompiler`? Same for one `INSERT ... ON CONFLICT ... RETURNING`,
   one `UPDATE ... RETURNING`, one CTE, one window function, one raw fragment.
2. **Parameter slots.** Compiled SQL must be cached and re-executed with different values.
   Show that parameter order in the compiled output can be recovered (e.g. each `ValueNode`
   carries a unique sentinel object; after compile, map `parameters[i]` back to a slot).
   Must also hold for MySQL/SQLite `?` placeholders and for arrays (`IN`/`= ANY`).
3. **Execution.** Run a cached `{ sql, params }` through the Kysely driver/connection
   API without constructing a Kysely query builder per call. Transactions and savepoints
   through the same connection.
4. **Cost.** Micro-benchmarks: (a) cold lower+compile, (b) cached execution overhead versus
   calling `pg` directly, for 1 row and 1,000 rows. Compare to the README §7 budgets.
5. **Gaps.** List anything Kysely's node set cannot express that Ecto queries need
   (lock clauses, `DISTINCT ON`, `LATERAL`, `FILTER`, array ops, `ON CONFLICT` targets,
   `MATERIALIZED`) and whether a raw node covers it.

Write `docs/adr/0002-kysely-backend.md` with the numbers and one of:
**accept** (expected), **accept with raw-node escapes** (list them), or **reject** (then
step 10 writes its own Postgres compiler behind the same `Adapter` interface, steps 11 and
17 are re-scoped, and the README decision table is updated). Either way the `Adapter`
contract above must not mention Kysely types.

## Part C — Contract tests

- Type tests proving the `Loaded`, `Row`, `InsertShape`, `AssocKeys` contracts on a
  hand-written fake schema type (port the assertions from `spikes/schema-typing.ts`).
- Unit tests and benchmarks for `internal/`.
- A `contracts/README.md` that states, per file, which step implements it and which steps consume it.

## Acceptance

- [ ] All contract files compile, are exported from an internal barrel, and have TSDoc.
- [ ] No Kysely type appears in `contracts/`.
- [ ] ADR 0002 written with benchmark numbers and a clear verdict; README decision D12 updated if needed.
- [ ] Spike code answers all five questions with runnable scripts.
- [ ] Error classes have unit tests for `code`, message and `cause` chaining.
- [ ] `internal/` utilities at 100% coverage with benchmarks recorded.

## Out of scope

Implementing types, schemas, builders, compilers or repos. Anything not needed to freeze
an interface or answer the spike.
