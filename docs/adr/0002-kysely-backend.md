# 0002 — Kysely as the SQL back end

- **Status:** proposed (verdict: **accept with raw-node escapes**; the owner decides whether that changes any step)
- **Date:** 2026-10-12
- **Step:** 02 (the Kysely bridge spike, part B of `docs/plan/02-core-contracts.md`)
- **Affects:** decision D12 (plan README §2); the `Adapter` contract; steps 09, 10, 11, 17 and 21

## Context

Decision D12 says that Kysely is Ectype's hidden SQL back end: the query AST is lowered to
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
- spike code at commit `07f845f`, working tree clean.

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

The technique: the "value" of every `ValueNode` is not a value but the **slot object**
that says where the value will come from (`{ kind: "inline", index: 0 }`). Kysely's
compiler copies node values into `parameters` untouched and in placeholder order, so after
compilation `parameters` **is** the slot list. No placeholder parsing, no mapping step.
`02-param-slots.ts` shows:

- parameters out of order, one parameter used twice, a named parameter and a list in one
  statement: slots come back in placeholder order;
- one cached plan executed against Postgres with five different sets of values, each
  compared with a hand-written statement;
- on Postgres a list is one array parameter (`= any($1)`), and lists of length 0, 1, 7 and
  500 compile to identical SQL;
- for MySQL and SQLite (`?` placeholders) a list is expanded to `in (?, ?, ?)`, with one
  slot per `?`, and a list of another length gives another SQL text (so the length belongs
  in the plan-cache key);
- 500 rounds × 3 statements × 3 dialects: a plan compiled with values A and bound with
  values B equals a cold compile with B;
- a `ValueNode` holding anything that is not a slot is detected after compilation, so a
  value cannot be bound by accident.

Kysely emits a new placeholder for every value node, also on Postgres. A parameter used
twice is therefore sent twice (`$3` and `$4` for the same value). That is harmless.

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
| Reference query: lower AST to Kysely nodes | 2.26 µs |
| Reference query: Kysely compile + slot recovery | 3.31 µs |
| **Reference query: cold compile, total** | **5.70 µs** |
| CTE + join, cold compile | 7.78 µs |
| `INSERT … ON CONFLICT … RETURNING`, cold compile | 4.55 µs |
| `UPDATE … RETURNING`, cold compile | 4.71 µs |
| `SELECT` of 10 columns by id, cold compile | 7.21 µs |
| For scale: a hand-written string emitter for the reference query | 1.97 µs |
| `bindParams`, 2 slots | 9.7 ns |
| Plan lookup (`WeakMap`) + `bindParams` + the `CompiledQuery` object | 19.5 ns |
| `new PostgresQueryCompiler()` | 257 ns |
| `ValueNode.create(x)` (factory, frozen) versus an object literal | 25.1 ns versus 1.5 ns |

Cached execution through Kysely's driver versus `pg` directly, against Postgres. Both
sides use the same `pg.Pool` with one connection (the same backend) and run byte-identical
SQL; they alternate within each of 40 rounds (1,500 calls per round for 1 row, 150 for
1,000 rows). "Overhead" is the median over rounds of the per-round ratio, with its
interquartile range:

| Query | Mode | `pg` | Bridge | Overhead (IQR) |
|---|---|---|---|---|
| 1 row | pool checkout per call | 343.0 µs | 341.6 µs | +0.47% (−1.73% … +1.88%) |
| 1 row | held connection | 342.1 µs | 340.3 µs | −0.43% (−1.58% … +1.50%) |
| 1,000 rows | pool checkout per call | 2,415.3 µs | 2,426.3 µs | +0.27% (−1.50% … +3.08%) |
| 1,000 rows | held connection | 2,404.9 µs | 2,398.2 µs | −0.70% (−3.06% … +3.57%) |

**The overhead cannot be told apart from zero at this noise level.** The interquartile
ranges straddle zero in all four cases, and two earlier full runs of the same script
(outputs not kept) gave medians between −0.25% and +1.06%. What the measurement does establish is an upper bound
of a few percent.

To put an absolute number on it, part C of the script removes the network: with a stub
pool whose client answers immediately (this is **not** a database measurement), one
checkout + execute + release costs 120.8 ns directly and 293.4 ns through `PostgresDriver`,
so Kysely's driver layer adds about **173 ns per call**. That is 0.05% of the 340 µs round
trip measured here; on a link with a 50 µs round trip it would be 0.35%.

Against the budgets of plan README §7:

| Budget | Limit | Measured share of the bridge |
|---|---|---|
| Compile, cold | < 40 µs | 5.70 µs for the reference query (14% of the budget); 4.55 to 7.78 µs for the others |
| Compile, plan-cache hit | < 0.3 µs | Kysely is not involved; lookup + bind + object is 19.5 ns in the spike |
| `repo.all` of 1,000 rows over the raw driver | < 15% | +0.27% and −0.70% (within noise); 173 ns absolute |
| `repo.insert` of one row over the raw driver | < 20% | +0.47% and −0.43% for a one-row statement (within noise); 173 ns absolute |
| Step 11's own target, `adapter.execute` over raw `pg` | < 5% | as above |
| Build a query, hydrate a row, cast a changeset | | not touched by Kysely; not measured here |

Limits of these numbers: the spike's lowering handles a subset of the node kinds and
builds no output plan, does no capability checks and resolves no types, so step 10's cold
compile will cost more than 5.70 µs. There is a factor of seven of headroom. The figures
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

- **Kysely 0.29 is ESM-only** and declares `engines.node >= 22.0.0`. Ectype ships a
  CommonJS build, which will `require("kysely")` once steps 10 and 11 import it. That
  works on Node 22.23.1 and 24.14.1 (checked). It relies on Node loading ES modules with
  `require`, which older Node 22 releases did not do without a flag (from memory: before
  22.12; not checked here). Ectype declares `engines.node >= 22`.
- **A compiler instance must be reused.** Constructing one costs 257 ns (about a hundred
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
   10 (it is easy to state and to test), and Ectype depends on Kysely internals, pinned to
   one minor version.
3. **Reject.** Step 10 writes its own Postgres compiler behind the same `Adapter`
   interface; steps 11 and 17 are re-scoped to own drivers, pooling, savepoints and two
   more compilers; D12 is rewritten. What it would buy, measured: at most 3.7 µs per cold
   compile (5.70 µs against the 1.97 µs of a hand-written emitter; paid once per query
   shape) and about 173 ns per execution. What it would cost: three SQL compilers, three
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
2. **Raw text is constant.** A `RawNode`'s text, and every node field Kysely appends
   unquoted (function names, operators, data types, lock and join keywords), comes from a
   table in the lowering code or from the static strings of a `fragment` template. Names
   that originate outside the lowering (function names, `fragment.ident`) are validated
   against an identifier pattern first.
3. **Parentheses are the lowering's job.**
4. **One compiler instance per adapter**, reused for every compilation.
5. **No Kysely type leaves `compiler/` and `adapter/`**, and none appears in `contracts/`
   (a test checks the latter).

This ADR is marked *proposed* because the verdict is not the plain "accept" that the step
files assume. Nothing in other steps was changed on the strength of it.

## Consequences

For the owner to confirm or redirect. No plan file was edited.

- **README D12:** no change needed. Optionally add "with raw nodes where Kysely has no
  node for a construct (ADR 0002)".
- **Step 10 (compiler):** follows the five rules above. It must also expand named windows
  inline, wrap frames and expression partitions in raw `OVER (…)`, and cast parameters that
  are selected. Its spec says `ast.params` is in "clause-append order"; the contract fixes
  a canonical order instead (see `docs/plan/status/02.md`, decision 6).
- **Step 09 (advanced queries):** window frames, named windows, `VALUES` sources and
  hints work, through the escapes listed. No feature has to be dropped.
- **Step 11 (adapter):** executes through Kysely's `Driver` and `DatabaseConnection`
  without a `Kysely` instance, as the spike does. Still to prove there: streaming
  (`pg-cursor`), cancellation, and that the root node handed to the driver can be a shared
  constant instead of the compiled tree (our `CompiledQuery` keeps no node).
- **Step 17 (SQLite, MySQL):** the `?` path was compiled, not executed. List expansion puts
  list lengths in the plan-cache key, as the step already expects. The drivers' use of
  `CompiledQuery.query` needs checking.
- **Step 21 (release):** decide what the CommonJS build promises on Node 22 versions that
  cannot `require` an ES module: raise `engines.node`, or document the limit.
- **Maintenance:** a Kysely minor upgrade is a deliberate change. The spike is type-checked
  by `pnpm typecheck`, so an upgrade that breaks the node API fails CI; step 10's SQL
  snapshots will catch a change in output.

Revisit this decision if a Kysely release removes the node factories or stops passing
node values through to `parameters`, or if step 10's measured cold compile approaches the
40 µs budget and profiling attributes it to Kysely.
