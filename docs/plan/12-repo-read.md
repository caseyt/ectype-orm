# Step 12 — Repo: reads and hydration

**Depends on:** 08, 10, 11. **Parallel with:** 05, 06, 09.
**Owns:** `packages/core/src/repo/repo.ts`, `repo/read.ts`, `repo/hydrate.ts`, `repo/options.ts`,
`packages/core/test/conformance/read/`, `benchmarks/micro/hydrate.bench.ts`,
`benchmarks/e2e/read.bench.ts`, `docs/site/guide/repo.md` (read half), `getting-started.md`.

## Goal

`createRepo` and every read operation, with the fastest row hydration we can build.

## Public API

```ts
const repo = createRepo({
  adapter,
  schema?: string,                    // default database schema (Postgres schema / MySQL database); was `prefix`
  log?: boolean | ((event: QueryEvent) => void) | { params: true },   // { params: true } also logs parameter values
  warnOnRootUseInTransaction?: boolean,   // development only; see step 16
  codegen?: boolean,                  // default true; false disables new Function (CSP)
});

repo.all(queryable, params?, opts?)            // R[]
repo.one(queryable, params?, opts?)            // R | null       throws MultipleResultsError if > 1
repo.first(queryable, params?, opts?)          // R | null       adds LIMIT 1; never throws for extra rows
repo.oneOrThrow(queryable, params?, opts?)     // R              throws NoResultsError
repo.get(Schema, id, opts?)                    // Row | null     id: scalar, or object for composite keys
repo.getOrThrow(Schema, id, opts?)
repo.getBy(queryable, clauses, opts?)          // clauses: { email: "a@b.c" }
repo.getByOrThrow(queryable, clauses, opts?)
repo.exists(queryable, params?, opts?)         // boolean
repo.count(queryable, params?, opts?)          // number         shorthand for aggregate(q, "count")
repo.aggregate(queryable, "count" | "sum" | "avg" | "min" | "max", field?, opts?)
repo.stream(queryable, params?, { batchSize = 500, ...opts })   // AsyncIterable<R>; needs a transaction on Postgres
repo.reload(row | rows, opts?)                 // fresh copy or null if gone
repo.reloadOrThrow(row)
repo.toSql(queryable, params?)                 // { sql, params }
repo.explain(queryable, { analyze?, format? })
repo.raw(fragment`select ...`)               // raw escape hatch -> { rows, rowCount }; bound params only
repo.on("query", listener)                     // also "connect" | "disconnect" | "poolExhausted", forwarded from the adapter
repo.ping()                                    // pass-through to the adapter
repo.poolStats()                               // { size, idle, waiting }
repo.close()

type ReadOptions = { schema?: string; timeoutMs?: number; signal?: AbortSignal; context?: Record<string, unknown> };
```

`queryable` is a schema class or a `Query`. Named parameters and options stay **separate
arguments** (owner decision): when the query's `P` is non-empty the call is
`repo.all(q, params, opts?)` with `params` required and typed; when it is empty the
parameter does not exist and the call is `repo.all(q, opts?)` (overloads). There is no
`planCacheSize` here: the plan cache belongs to the adapter (step 11). `Repo` is an
interface so that the transaction-scoped repo (step 16) is the same type.

## Behaviour

1. **Pipeline for `all`:** normalise queryable → `adapter.compile` (plan cache) →
   `bindParams` → `adapter.execute` → decode rows → (preloads, step 14 hook) → return.
   The array returned is a fresh mutable array of fresh rows.
2. **Row decoder (`hydrate.ts`).** Built once per compiled plan from its `OutputPlan` and
   stored on the plan:
   - The decoder is called with `(row, constants)`; a `constant` leaf yields `constants[index]`.
   - Whole-row leaf → `meta.create([r.c0, fromDb3(r.c3), …], rowMeta)`, applying `fromDb` only for
     non-`IDENTITY` codecs and passing `null` through untouched.
   - Object/tuple select → an object literal / array with fixed key order.
   - Single expression → the value itself.
   - A whole-row leaf from an outer join yields `null` when all its primary-key columns are `null`.
   - Generated with `new Function` when `codegen` is on (straight-line code, no loops, no
     closures per row); interpreter fallback otherwise. Both must produce identical output
     (differential property test). Budget: < 150 ns for a 10-column row.
   - Loaded rows get `[ROW] = { state: "loaded", source, schema }`. Share one frozen meta
     object per (schema class, database schema) instead of allocating per row.
3. **`one`.** Does not add `LIMIT`; fetching more than one row is an error by design (as
   Ecto). `getBy` likewise. `get` filters on the primary key and throws `QueryError` if the
   schema has none or the id shape is wrong; `get(User, undefined | null)` throws (Ecto raises) —
   a frequent bug source, so the message is explicit.
4. **`exists`** rewrites to `SELECT 1 ... LIMIT 1` and drops select/order/preloads.
   **`aggregate`** wraps queries that have `limit`/`offset`/`distinct`/combinations in a
   subquery, as Ecto does; `count` with no field counts rows. Result type follows step 07's
   aggregate typing.
5. **`stream`.** Uses `adapter.stream`; decodes lazily; honours early exit. Preloads are
   not supported in streams (throw with the suggestion to batch).
6. **Options precedence.** The query's `.schema()` > the per-call `schema` option > the repo's
   `schema`: a per-call value does not override a query's own, and neither overrides a
   per-source schema or a schema class's own database schema (the full order is in step 10).
7. **Errors.** Adapter errors pass through normalised. `NoResultsError` and
   `MultipleResultsError` carry the query's `toString()` rendering.
8. **Telemetry.** Forward adapter events, adding `source` (root schema), `operation`
   (`"all"`, `"one"`, …), `decodeMs`, and the caller's `context` option. Parameter values are
   included only with `log: { params: true }`.
9. **Zero-overhead checks.** No per-call option object allocation when no options are
   passed; no `async` wrapper layers that add microtask hops beyond what is needed
   (measure: at most N awaits per `all`, document N).

## Read conformance suite

`packages/core/test/conformance/read/` — dialect-independent integration tests over the
blog schema, run by each adapter package: every method above; every select shape; all
join kinds with null handling; every logical type round-tripped through real columns;
ordering, limit/offset, distinct; aggregates over empty sets; composite and uuid keys;
database schema; 0 / 1 / many rows for `one` and `first`; a 50k-row stream with early exit; concurrent reads.

## Tests

- Unit (fake adapter returning canned rows): decoder generation for each `OutputPlan`
  shape; codegen/interpreter equivalence (property test over random plans and rows);
  options precedence; overload typing.
- Type tests: return type of each method for schema, plain query, select query, preload
  query; `params` required exactly when `P` is non-empty; `get` id typing for scalar and composite keys.
- Integration: the conformance suite on Postgres.
- Benchmarks: decoder per row (10 columns; with and without non-identity codecs);
  `repo.all` 1 / 100 / 1,000 / 10,000 rows versus raw `pg` + manual mapping (budget < 15%
  at 1,000); `repo.get` hot loop; `prepare`d versus cached versus rebuilt-per-call query.

## Docs

`getting-started.md`: install, define two schemas, connect, insert (stub link), query.
`repo.md` read half: each function with an example, `one` vs `first` vs `all`
semantics, streaming, raw queries, logging and telemetry, `toSql`/`explain`.

## Acceptance

- [ ] All methods implemented and typed; conformance suite green on Postgres.
- [ ] Hydration and end-to-end budgets met, numbers recorded.
- [ ] Codegen and fallback paths both at full coverage and proven equivalent.
- [ ] `repo.raw` cannot be called with a plain string (compile error and runtime guard).

## Out of scope

Writes (13). Preload execution (14) — provide the hook `afterDecode(rows, plan, ctx)` it plugs into.
Transactions (16).
