# Step 10 — SQL compiler and plan cache

**Depends on:** 07 (and 08 for integration; start against hand-built ASTs). **Parallel with:** 05, 08, 11.
**Owns:** `packages/core/src/compiler/` (except `advanced/`), `benchmarks/micro/compiler.bench.ts`,
`docs/site/internals/compiler.md`.

Read ADR 0002 first. This spec assumes the verdict was "accept" (D12). If it was
"reject", the public surface below is unchanged and "lower to Kysely nodes" becomes
"emit SQL text with a hand-written Postgres compiler".

## Goal

Turn a `QueryAst` (and row-level insert/update/delete descriptions) into a
`CompiledQuery` — SQL text plus a recipe for building the parameter array — and make the
second and later compilations of the same query shape nearly free.

## Design

```
QueryAst ──lower──▶ Kysely OperationNode tree ──dialect QueryCompiler──▶ { sql, parameters[] }
                                                             │
                             slot recovery ◀─────────────────┘
                                   ▼
                         CompiledQuery { sql, slots, output }  ──▶  plan cache
```

### Lowering (`lower.ts`)

- One function per AST node kind producing Kysely nodes directly (no fluent Kysely builder,
  no `Kysely` instance per call). A `lowerNode` registry lets step 09 add node kinds.
- Identifiers: table = `meta.source` (+ `prefix`), alias = the binding alias, column =
  `FieldMeta.column`. All identifiers go through Kysely's identifier nodes (quoted by the dialect).
- **Select list and output aliases.** Every selected expression gets a short alias
  `c0, c1, …` in output order. A whole-binding select expands to that schema's persisted
  columns in `meta.persisted` order (virtual fields skipped). Never `SELECT *`. The lowering
  returns an `OutputPlan` — a tree mirroring the user's select shape with, at each leaf,
  the alias and the `EctoType` to load with — which step 12 turns into a row decoder. It
  also has a `constant` leaf (an index into `SelectNode.constants`; no column), and its row
  leaf carries `key`, `nullable` and `preloads` (`contracts/adapter.ts`).
- Params: each `param`/`list`/`namedParam` node lowers to a Kysely value node carrying a
  **slot sentinel** (technique fixed by ADR 0002). After compile, `parameters[i]` is mapped
  back to `ParamSlot`s. For dialects with positional `?`, a slot may appear more than once.
- `list` params: Postgres → `= ANY($n)` with one array parameter (shape is independent of
  length). Dialects without array params → expand to `IN (?, ?, …)`; the list length then
  becomes part of the cache key.
- Booleans: adjacent `wheres` fold into one AND/OR tree respecting `orWhere` precedence
  exactly as Ecto does (`a and b or c` = `(a and b) or c`). Parenthesise by precedence; snapshot-test tricky cases.
- Capability checks happen here: lowering a feature the adapter lacks throws `QueryError`
  (`"FULL JOIN is not supported by sqlite"`).

### Row-level writes (`write.ts`)

`compileInsert(meta, columns, { source, returning, onConflict, conflictTarget }, prefix)`,
`compileUpdate(meta, setColumns, whereColumns, returning, prefix)`,
`compileDelete(meta, whereColumns, returning, prefix)`; `compile(ast, op, prefix)` likewise
takes the prefix, and there are `compileFragment(fragment)` and
`compileExplain(ast, op, prefix, options)` (`contracts/adapter.ts`). Keyed in the plan cache by
(schema, operation, column-set bitmask, options), so inserting the same set of fields
reuses one plan. Multi-row insert plans are cached per row count up to a threshold
(e.g. 1, 2, 4, 8, … chunks) — choose a strategy, benchmark it, document it.
`onConflict` forms as Ecto: `"raise"`, `"nothing"`, `"replaceAll"`, `{ replace: fields }`,
`{ replaceAllExcept: fields }`, or an update query; `conflictTarget`: fields, `{ constraint }`, or a fragment.

### Plan cache (`cache.ts`)

Two levels, per adapter instance:

1. **L1 identity:** per (`QueryAst`, prefix): a `WeakMap` on the AST, then the prefix. A
   module-level query constant compiles once per prefix, ever. Budget for a hit: < 0.3 µs.
2. **L2 shape:** bounded LRU (default 1,000 entries, configurable) keyed by the AST's
   `shape` hash. Because a hash can collide, a hit is confirmed by a structural comparison
   `sameShape(a, b)` that ignores param values; on mismatch, treat as a miss and count it
   (`cache.collisions` metric must stay 0 in the test suite). A query rebuilt per request
   with different values pays build + L2 lookup, not lowering.

`compile(ast, op)` returns the cached plan; the caller builds params with
`bindParams(plan.slots, ast.params, namedValues)` — a tight loop with no allocation beyond
the output array. `dump` functions are applied here, skipped when `IDENTITY`.
Missing or extra named params throw `QueryError` listing the names.

Expose `repo.toSql(queryable, params?)` → `{ sql, params }` (Ecto `Repo.to_sql`) and
cache statistics (`hits`, `misses`, `collisions`, `size`) for telemetry.

## Behaviour details

- **Determinism.** Same AST → byte-identical SQL. No timestamps, counters or random names.
- **Param ordering contract with steps 07–09:** `ast.params` is in **canonical order** (a
  depth-first walk of the AST in interface declaration order, as defined in
  `contracts/query.ts`; it equals `collectParams(ast)`), not in the order clauses were
  appended. Slots refer to indexes in it: the lowering visits the AST in canonical order
  and counts the parameter nodes it meets. Verify with a property test: compile via the
  cache with the AST of values A, bind with `params` of another AST of the same shape
  holding values B, and compare against a cold compile of B. `shape` is canonical too, so
  two structurally identical queries share one plan however they were built.
- **Null/boolean literals** from `lit()` are inlined; everything else is bound.
- **`limit`/`offset`** are bound parameters where the dialect allows.
- **Prefix:** resolved per table with Ecto's precedence: per-source prefix (`from`/`join`)
  > the schema's declared prefix > the query prefix > the `prefix` argument of `compile`
  (the per-call option, else the repo default). A query or repo prefix never overrides a
  schema's declared prefix. Row-level writes (insert, update and delete alike) have one
  table source and no query: their `prefix` parameter is that source's own prefix, the
  strongest position, and the repo passes the per-call option, else the row's
  `RowMeta.prefix` (a built row holds its schema's declared prefix), else its default.
- **Lock:** rendered last; string modes validated against a per-dialect allowlist.
- **Debug:** `explain` support hook (`repo.explain(queryable, opts)` implemented in step 12 uses `compile` + prefix).

## Tests

- SQL snapshots (inline) for every clause and operator from steps 07–08: a matrix file per
  area (`select.sql.test.ts`, `joins.sql.test.ts`, `where.sql.test.ts`, …). Postgres here;
  the same test tables are parameterised by dialect so step 17 only adds expected output.
- Precedence: and/or/not nesting; arithmetic; mixed `where`/`orWhere`.
- Injection property test (fast-check): for arbitrary strings used as values in every value
  position (comparisons, `in`, `like`, `limit`, json path keys, `val`), the string never
  appears in `sql` and does appear in `params`. For identifier positions
  (`fragment.ident`, `field()`), arbitrary strings are rejected or quoted.
- Cache: L1/L2 hit and miss; different values share a plan; different list lengths share a
  plan on Postgres; LRU eviction; forced-collision test (inject a constant hash) proves the
  structural check prevents a wrong-plan hit.
- Param-binding equivalence property test (above).
- Integration: every snapshot query is also **executed** against Postgres to prove it is
  valid SQL (results need not be asserted here).
- Benchmarks: cold compile of small/medium/large queries; L1 hit; L2 hit; `bindParams` with 5 params; insert plan lookup.

## Docs (`internals/compiler.md`)

How a query becomes SQL, the cache levels and how to get the most from them (module-level
queries, `prepare`), reading `toSql` output, cache metrics. Written for contributors and
performance-minded users.

## Acceptance

- [ ] Every AST node kind from step 07 lowers, with a snapshot and an execution test.
- [ ] Budgets met: L1 hit < 0.3 µs, cold < 40 µs for the reference 3-clause query.
- [ ] Zero collisions across the whole test suite; forced-collision test passes.
- [ ] Injection property test passes with 10,000 runs.
- [ ] No Kysely type escapes `compiler/` and `adapter/`.

## Out of scope

Executing queries, decoding rows (12). Advanced node kinds (09). Tier-2 expected output (17).
