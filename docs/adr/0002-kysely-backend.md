# 0002 — Kysely as the SQL back end

- **Status:** accepted (2026-10-12, by the owner, after review round 1 of PR #2): **accept with raw-node escapes**
- **Date:** 2026-10-12
- **Step:** 02 (the Kysely bridge spike, part B of `docs/plan/02-core-contracts.md`)
- **Affects:** decisions D12 and D14 (plan README §2); the `Adapter` contract; steps 09, 10, 11, 17 and 21

## Context

Decision D12 says that Kysely is Egon's hidden SQL back end: the query AST is lowered to
Kysely `OperationNode` trees, compiled by Kysely's dialect compilers and executed through
Kysely's drivers, all behind our own `Adapter` interface. D12 was made on expectation.
Step 02 had to prove or disprove it before steps 10, 11 and 17 depend on it, by answering
five questions with running code against real Postgres.

The spike is in [`docs/plan/spikes/kysely-bridge/`](../plan/spikes/kysely-bridge/README.md).
Its outputs, including the benchmark report, are in `results/` there. Everything below was
measured, on:

- Kysely 0.29.6, `pg` 8.23.1, Node 22.23.1, Apple M2 (8 cores), macOS;
- PostgreSQL 16.15 from the repository's `docker-compose.yml` (Docker through Colima, so
  every round trip crosses a VM boundary: about 340 µs for a one-row query);
- spike code at commit `4df1c33`, working tree clean.

### 1. Lowering: yes

A hand-built AST (plain objects, values in a separate array) is lowered to Kysely nodes
with Kysely's node factories, with no `Kysely` instance, no fluent builder and no `sql`
template, and compiled by one long-lived `PostgresQueryCompiler`. `01-lowering.ts` checks
the SQL text and then executes each statement and compares its rows with an independently
hand-written statement run through `pg` alone:

| Statement | Result |
|---|---|
| The reference `SELECT` (join, where, group by, order by, limit) | exact SQL as specified; rows equal |
| `INSERT … ON CONFLICT (…) DO UPDATE … RETURNING` | exact SQL; insert, conflict and stored row verified |
| `UPDATE … RETURNING` | exact SQL; row returned; stale `lock_version` updates nothing |
| A CTE (`WITH … AS MATERIALIZED`) | exact SQL; rows equal |
| A window function | exact SQL; rows equal |
| A raw fragment with a column and a value interpolated | exact SQL; rows equal |
| `(a OR b) AND c` | parentheses kept; rows equal |

The reference query compiles to exactly:

```sql
select "u"."id" as "c0", count("p"."id") as "c1" from "users" as "u" inner join "posts" as "p" on "p"."author_id" = "u"."id" where "u"."age" >= $1 and "p"."published" group by "u"."id" order by "u"."inserted_at" desc limit $2
```

Two properties of Kysely's compiler that the lowering has to respect:

- **It adds no parentheses of its own** around `and`/`or` or binary operations. Precedence
  is the lowering's job (`ParensNode`).
- **Some node fields are appended to the SQL unquoted**: function names
  (`FunctionNode.func`, `AggregateFunctionNode.func`), operators, data types, join types.
  They must come from the lowering's own tables or be validated; a user string must never
  reach them. Identifiers (`IdentifierNode`) and values (`ValueNode`) are safe.

### 2. Parameter slots: yes

Two things have to hold for a cached plan to be re-executed with other values.

**Slot recovery.** The "value" of every `ValueNode` is not a value but the **slot object**
that says where the value will come from (`{ kind: "inline", index: 0 }`). Kysely's
compiler copies node values into `parameters` untouched and in placeholder order, so after
compilation `parameters` **is** the slot list. No placeholder parsing, no mapping step.

**Canonical numbering.** A slot's `index` is a position in the contract's canonical
parameter order (`QueryAst.params`: a depth-first walk in interface declaration order),
which is not placeholder order and is the same for every AST of one shape. The spike's
parameter nodes carry values and no index, as the contract's do. The lowering visits the
AST in canonical order, whatever order SQL emits the clauses in, and numbers the
parameters with a counter; `collectParams` is an independent walk that produces the
values. (The first version of the spike used pre-assigned indexes and so did not test
this; review finding 13.)

`02-param-slots.ts` uses one statement with a CTE (a `WHERE` and a `HAVING` parameter), a
join on a subquery containing `EXISTS … = ANY(list)`, a second list inside another
`EXISTS`, a parameter in the select list, a named parameter used in two places,
`UNION ALL`, `LIMIT` and `OFFSET`. Its placeholders appear in the order
`0, 1, 5, 2, 3, minAge, 4, 8, minAge, 6, 7`. It shows:

- the slots equal the order worked out by hand from the SQL text;
- **one plan, compiled from an AST holding dummy values, executed against Postgres with
  the values of 60 other ASTs** (via `collectParams`), each result equal to a hand-written
  statement run through `pg` with hand-ordered parameters (40 rounds return rows, 39 more
  than one, 19 rows from both `UNION` branches);
- the check is not a tautology: with two indexes swapped in the slots, the result changes
  in 13 of the 18 rounds that return rows (the other five return rows from the `UNION`
  branch only, which uses neither parameter);
- on Postgres a list is one array parameter (`= any($1)`), and lists of length 0, 1, 7 and
  500 compile to identical SQL;
- for MySQL and SQLite (`?` placeholders) a list is expanded to `in (?, ?, ?)`, with one
  slot per `?`; a cached plan bound with 200 other value sets equals an array assembled by
  hand in the order of the `?`s; and a list of another length gives another SQL text (so
  the lengths belong in the plan-cache key: `QueryAst.listLengths`);
- a `ValueNode` holding anything that is not a slot is detected after compilation, so a
  value cannot be bound by accident.

Kysely emits a new placeholder for every value node, also on Postgres. A parameter used
twice is therefore sent twice. That is harmless.

**Not verified:** the `?` dialects were compiled, not executed. Positional binding follows
directly from the compile output, but step 17 should confirm it against MySQL and SQLite.

### 3. Execution: yes

`03-execution.ts` uses one Kysely `PostgresDriver` and its connections directly, typed as
Kysely's dialect-independent `Driver` and `DatabaseConnection`. Per execution it allocates
the parameter array, one object literal in the shape of Kysely's `CompiledQuery`, and one
lazy query id. Verified against Postgres:

- 25 concurrent executions of one cached plan on a pool of 4: all correct, pool never grew past 4;
- `begin` / `commit` and `begin` / `rollback`, with visibility checked from a second connection;
- savepoints on the same connection (`savepoint`, `rollbackTo`, `releaseSavepoint`),
  including a savepoint name that needs quoting;
- the same backend process and transaction id throughout a transaction;
- a failing statement surfaces the `pg` error with `code`, `table` and `column` intact,
  and the connection is usable after `rollback`;
- no connection leaked.

**Not exercised:** streaming (Kysely's Postgres driver needs `pg-cursor` for it),
cancellation, and the MySQL and SQLite drivers.

### 4. Cost: far inside the budgets

Cold path, CPU only (mitata, mean per call):

| Operation | Time |
|---|---|
| Reference query: lower AST to Kysely nodes | 2.31 µs |
| Reference query: Kysely compile + slot recovery | 3.32 µs |
| **Reference query: cold compile, total** | **5.67 µs** |
| CTE + join, cold compile | 7.99 µs |
| `INSERT … ON CONFLICT … RETURNING`, cold compile | 4.48 µs |
| `UPDATE … RETURNING`, cold compile | 4.76 µs |
| `SELECT` of 10 columns by id, cold compile | 7.23 µs |
| For scale: a hand-written string emitter for the reference query | 2.18 µs |
| `bindParams`, 2 slots | 9.7 ns |
| Plan lookup (`WeakMap`) + `bindParams` + the `CompiledQuery` object | 19.7 ns |
| `new PostgresQueryCompiler()` | 253 ns |
| `ValueNode.create(x)` (factory, frozen) versus an object literal | 25.0 ns versus 1.5 ns |

Cached execution through Kysely's driver versus `pg` directly, against Postgres. Both
sides use the same `pg.Pool` with one connection (the same backend) and run byte-identical
SQL; they alternate within each of 40 rounds (1,500 calls per round for 1 row, 150 for
1,000 rows). "Overhead" is the median over rounds of the per-round ratio, with its
interquartile range:

| Query | Mode | `pg` | Bridge | Overhead (IQR) |
|---|---|---|---|---|
| 1 row | pool checkout per call | 340.9 µs | 340.3 µs | +0.42% (−1.04% … +1.29%) |
| 1 row | held connection | 358.6 µs | 362.5 µs | −0.04% (−1.22% … +2.15%) |
| 1,000 rows | pool checkout per call | 2,313.3 µs | 2,294.8 µs | −0.20% (−1.47% … +1.50%) |
| 1,000 rows | held connection | 2,386.6 µs | 2,388.0 µs | +0.09% (−1.10% … +1.48%) |

The two time columns and the overhead column are different statistics, which is why they
can point in opposite directions: each time is the median over the 40 rounds of that
side's mean time per call, while the overhead is the median of the 40 per-round ratios
(bridge over `pg`, within one round). With differences this small the sign of either is
not meaningful.

**The overhead cannot be told apart from zero at this noise level.** The interquartile
ranges straddle zero in all four cases; three earlier full runs of the same script
(outputs not kept) gave medians between −0.70% and +1.06%, and the reviewer's own run
between −1.43% and +0.78%. What the measurement does establish is an upper bound
of a few percent.

To put an absolute number on it, part C of the script removes the network: with a stub
pool whose client answers immediately (this is **not** a database measurement), one
checkout + execute + release costs 122.1 ns directly and 294.3 ns through `PostgresDriver`,
so Kysely's driver layer adds about **172 ns per call**. That is 0.05% of the 340 µs round
trip measured here; on a link with a 50 µs round trip it would be 0.35%.

Against the budgets of plan README §7:

| Budget | Limit | Measured share of the bridge |
|---|---|---|
| Compile, cold | < 40 µs | 5.67 µs for the reference query (14% of the budget); 4.48 to 7.99 µs for the others |
| Compile, plan-cache hit | < 0.3 µs | Kysely is not involved; lookup + bind + object is 19.7 ns in the spike |
| `repo.all` of 1,000 rows over the raw driver | < 15% | −0.20% and +0.09% (within noise); 172 ns absolute |
| `repo.insert` of one row over the raw driver | < 20% | +0.42% and −0.04% for a one-row statement (within noise); 172 ns absolute |
| Step 11's own target, `adapter.execute` over raw `pg` | < 5% | as above |
| Build a query, hydrate a row, cast a changeset | | not touched by Kysely; not measured here |

Limits of these numbers: the spike's lowering handles a subset of the node kinds and
builds no output plan, does no capability checks and resolves no types, so step 10's cold
compile will cost more than 5.67 µs. There is a factor of seven of headroom. The figures
come from one machine.

### 5. Gaps: nothing is out of reach; a few constructs need a raw node

`05-gaps.ts` builds 40 constructs with Kysely's node factories, compares each with the
expected SQL and **executes** it against Postgres (13 of them are also compared, row for
row, with a hand-written statement). 31 use only nodes that model the construct; the other
nine are listed here in full.

**Raw glue** (no node models the construct; a `RawNode` supplies fixed SQL text while
every identifier and value inside stays a real, quoted or bound, node):

| Construct | Why | How |
|---|---|---|
| Window frame (`ROWS BETWEEN …`) | `OverNode` has only `partitionBy` and `orderBy` | the whole `OVER (…)` is a `RawNode` around the function, partition and order nodes |
| `PARTITION BY` an expression | `PartitionByItemNode` is typed for column references only | as for frames |
| `VALUES` list as a source with a column alias list (`AS v(a, b)`) | no node for an alias with columns | `ValuesNode` in parentheses; the alias is a `RawNode` over `IdentifierNode`s |
| `TABLESAMPLE` (Ecto hints) | no node | `RawNode` around the aliased table |
| A lock clause outside the standard modes (Ecto `lock: fragment`) | by design | `SelectModifierNode.createWithExpression(RawNode)` |

**Keyword** (a node models the construct; one fixed keyword, operator or type name is
supplied as a `RawNode` because Kysely's typed list lacks it):

| Construct | How |
|---|---|
| JSON `#>` / `#>>` | the operator is a `RawNode` |
| `CAST(x AS type)` for types Kysely does not list (`int8[]`, `citext`, …) | `CastNode` with a `RawNode` type from an allowlist |
| `EXPLAIN (ANALYZE, …)` options | `ExplainNode` with the option list as a `RawNode` |

**Rewritten by the lowering** (no node and no raw text):

| Construct | How |
|---|---|
| Named windows (`WINDOW w AS (…)`, `OVER w`) | `SelectQueryNode` has no `WINDOW` clause and no position to put one, so the definition is expanded at each use. Verified to return the same rows as the `WINDOW` form. |

In every one of the nine, the raw text is a constant of the lowering code. None needs a
user value or a user-supplied identifier in SQL text, so decision D9 holds.

The nine are constructs. They are not every `RawNode` the lowering creates: Kysely takes
the sort direction of an `ORDER BY` item as a node, and the spike supplies `asc` and
`desc` as two constant `RawNode`s (`bridge.ts`, `05-gaps.ts`). That is routine use of a
field Kysely types as a node, with constant text, and is not counted as a gap.

Native, among the things the step file asked about: lock clauses (`FOR UPDATE`,
`FOR NO KEY UPDATE`, `FOR KEY SHARE`, `OF`, `NOWAIT`, `SKIP LOCKED`), `DISTINCT ON`,
`LATERAL` joins, aggregate `FILTER`, array operators and `= ANY($1)`, every `ON CONFLICT`
target (columns, `ON CONSTRAINT`, an index expression with a predicate, none) and
`[NOT] MATERIALIZED`. Also native: full and cross joins, schema prefixes, recursive CTEs,
set operations, tuples, `CASE`, `EXISTS` and other subqueries, `NULLS LAST`,
`INSERT … SELECT`, `DEFAULT` cells and `DEFAULT VALUES`, `UPDATE … FROM`, `DELETE … USING`.

Not run individually, because they are the same node with another enum value: `FOR SHARE`,
right joins, `INNER JOIN LATERAL`, `<@`, `INTERSECT`, `UNION` without `ALL`, `NULLS FIRST`,
`RANGE` frames.

One finding that is not about Kysely: a bare parameter in a select list has no type and
Postgres takes it as `text` (`select $1 as "i"` then fails on `"i" + 1`). A selected
parameter has to be cast, which the lowering can do because it knows the parameter's type.

### Other facts found on the way

- **Kysely 0.29 is ESM-only** and declares `engines.node >= 22.0.0`. A CommonJS build of
  Egon would have to `require("kysely")`, which only works where Node loads ES modules
  with `require`. Checked with real binaries: Node 22.11.0 fails with `ERR_REQUIRE_ESM`;
  22.12.0 works, with an `ExperimentalWarning`; 22.23.1 and 24.14.1 work silently. See
  the decision on CommonJS below.
- **A compiler instance must be reused.** Constructing one costs 253 ns (about a hundred
  bound methods), and `compileQuery` resets its state and is synchronous, so one instance
  per adapter is safe.
- **Kysely's node factories freeze every node** (`Object.freeze`): 25 ns per node against
  1.5 ns for an object literal. The cold compile above already includes this.
- **Kysely's Postgres driver reads only `sql`, `parameters` and `queryId`** from the query
  it is given. Its `CompiledQuery` type also requires `query` (a root node); the spike
  passes the compiled tree. Whether the MySQL and SQLite drivers read more was not checked.
- The technique depends on Kysely behaviour that is exported but not documented as API:
  the node factories and node shapes, and the compiler passing `ValueNode.value` through
  untouched. Kysely is pre-1.0 and pinned to `~0.29`; several of its exports are already
  marked for removal in 0.30.

## Options

1. **Accept.** Use Kysely as D12 says, with no qualification. Not accurate: five constructs
   Ecto needs have no Kysely node.
2. **Accept with raw-node escapes.** Use Kysely as D12 says; for the nine constructs above
   the lowering uses a `RawNode` (or rewrites the construct), under the rule that raw text
   is always a constant of the lowering code. Costs: the rule has to be enforced in step
   10 (it is easy to state and to test), and Egon depends on Kysely internals, pinned to
   one minor version.
3. **Reject.** Step 10 writes its own Postgres compiler behind the same `Adapter`
   interface; steps 11 and 17 are re-scoped to own drivers, pooling, savepoints and two
   more compilers; D12 is rewritten. What it would buy, measured: at most 3.7 µs per cold
   compile (5.67 µs against the 2.18 µs of a hand-written emitter; paid once per query
   shape) and about 172 ns per execution. What it would cost: three SQL compilers, three
   driver integrations and DDL, written and maintained by this project.

## Decision

**Option 2: accept, with raw-node escapes.**

Kysely stays the hidden back end (D12 stands as written: a `RawNode` is a Kysely
`OperationNode`). All five questions are answered positively against real Postgres; the
measured cost is 14% of the cold-compile budget and indistinguishable from zero on the
execution path; and every gap is covered by a raw node whose text is a constant, so
decision D9 is untouched.

The rules that come with it:

1. **Slots.** A value is lowered to a `ValueNode` whose value is the `ParamSlot` object.
   After compiling, every entry of `parameters` must be one of the slots created by that
   lowering; anything else is an error. (`ParamSlot` is defined in
   `packages/core/src/contracts/adapter.ts`.)
2. **Raw text is constant or trusted.** A `RawNode`'s text, and every node field Kysely
   appends unquoted (function names, operators, data types, sort directions, lock and join
   keywords), comes from one of exactly three sources:
   1. a table in the lowering code;
   2. the static strings of a `fragment` template, which are program text;
   3. the `sql` of a `custom` `DbType` (`{ kind: "custom", sql }`), used as a type name in
      `CAST` and in DDL. This is **trusted input**: it is written by the developer who
      defines the type (or assembled by a parameterized type from developer-written
      options) and must never be derived from user data. It is a stated exception to
      D9's "the only way to emit raw SQL text is `fragment`". As a second line of defence
      the compiler emits it only if it matches `CUSTOM_SQL_TYPE`
      (`packages/core/src/contracts/type.ts`): a plain type name, with no quotes,
      semicolons, comments or operators.

   Names that originate outside the lowering (function names, `fragment.ident`) are
   validated against an identifier pattern first.
3. **Parentheses are the lowering's job.**
4. **One compiler instance per adapter**, reused for every compilation.
5. **No Kysely type leaves `compiler/` and `adapter/`**, and none appears in `contracts/`
   (a test checks the latter).

### CommonJS (decision D14)

Decided with this ADR by the owner: **the packages are ESM only; there is no CommonJS
build.** A CommonJS build could not load the ESM-only Kysely on every Node the packages
claimed to support, and two builds of one package are two copies of every class and
symbol. A CommonJS project uses the packages through `require()` of the ES module, which
Node supports from 22.12, so `engines.node` is `>=22.12` (it was `>=22`).
`examples/smoke/require-esm.cjs` proves it on the Node that runs CI.

## Consequences

- **README D12:** unchanged (a `RawNode` is a Kysely `OperationNode`). **D14** now reads
  "Node >= 22.12, ESM only"; steps 01 and 21 were edited where they mentioned a CommonJS
  build. All six packages build ESM only, with `types` and `default` export conditions.
- **Step 10 (compiler):** follows the five rules above, including the `CUSTOM_SQL_TYPE`
  check. It must also expand named windows inline, wrap frames and expression partitions
  in raw `OVER (…)`, and cast parameters that are selected. Parameters are numbered in
  canonical order (the contract; `docs/plan/10-sql-compiler.md` was edited to agree), as
  the spike's lowering does: visit in canonical order and count.
- **Step 09 (advanced queries):** window frames, named windows, `VALUES` sources and
  hints work, through the escapes listed. No feature has to be dropped.
- **Step 11 (adapter):** executes through Kysely's `Driver` and `DatabaseConnection`
  without a `Kysely` instance, as the spike does. Still to prove there: streaming
  (`pg-cursor`), cancellation, and that the root node handed to the driver can be a shared
  constant instead of the compiled tree (our `CompiledQuery` keeps no node).
- **Step 17 (SQLite, MySQL):** the `?` path was compiled, not executed. List expansion puts
  the list lengths in the plan-cache key (`QueryAst.listLengths`). The drivers' use of
  `CompiledQuery.query` needs checking.
- **Maintenance:** a Kysely minor upgrade is a deliberate change. The spike is type-checked
  by `pnpm typecheck`, so an upgrade that breaks the node API fails CI; it is not run by
  CI (owner decision). Step 10's SQL snapshots and execution tests take over as the
  behavioural guard.

### Not verified by the spike

- The `?` dialects: compiled only, never executed against MySQL or SQLite.
- Streaming, cancellation, and Kysely's MySQL and SQLite drivers.
- The node kinds the spike's small AST does not have. Canonical numbering is verified for
  the kinds it has (see question 2), not for the contract's full node set.
- Which Node 22 release first loads ES modules with `require` **without** a warning
  (22.12.0 warns, 22.23.1 does not; the releases between were not tried).

Revisit this decision if a Kysely release removes the node factories or stops passing
node values through to `parameters`, or if step 10's measured cold compile approaches the
40 µs budget and profiling attributes it to Kysely.
