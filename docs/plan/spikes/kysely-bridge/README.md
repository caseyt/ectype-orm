# Kysely bridge spike (step 02)

The evidence for [ADR 0002](../../../adr/0002-kysely-backend.md), which decides plan
decision D12: is Kysely usable as Egon's hidden SQL back end?

The spike is the smallest code that answers the five questions of
[`02-core-contracts.md`](../../02-core-contracts.md), part B. It is not the compiler
(step 10) or the adapter (step 11), and nothing imports it.

| Script | Question | Needs Postgres |
|---|---|---|
| `01-lowering.ts` | 1. Can a hand-built AST be lowered to Kysely `OperationNode`s directly and compiled by `PostgresQueryCompiler`? | yes: every statement is executed and compared with a hand-written one |
| `02-param-slots.ts` | 2. Can the order of the parameters in the compiled SQL be recovered, for `$n` and `?`, including arrays, with parameters numbered in the contract's canonical order? | yes for `$n`; the `?` dialects are compile-only |
| `03-execution.ts` | 3. Can a cached `{ sql, slots }` run through Kysely's driver API without a query builder, with transactions and savepoints? | yes |
| `04-cost.ts` | 4. What does it cost: cold lower + compile, and cached execution versus `pg`? | parts A and C no, part B yes |
| `05-gaps.ts` | 5. What can Kysely's node set not express that Ecto queries need? | yes: every case is executed |

Supporting files: `ast.ts` (a small AST in the shape of `packages/core/src/contracts/query.ts`),
`queries.ts` (the statements, as ASTs), `bridge.ts` (lowering, compilation, slot recovery,
`bindParams`), `db.ts` (a throwaway database on the Compose Postgres and the driver wrapper).

## Running

```sh
pnpm db:up                                              # Postgres 16 from docker-compose.yml
pnpm --filter @egon-orm/spike-kysely-bridge run spike     # all five; stops at the first failure
pnpm --filter @egon-orm/spike-kysely-bridge run spike:cost   # one of them (also :lowering, :slots, :execution, :gaps)
```

Every script creates its own database (named so that the test-support sweep removes it if
the script is killed), loads `packages/core/test/support/fixtures/blog.sql`, seeds it, and
drops it afterwards. There is no fallback to any other database: without the Compose
Postgres the scripts fail. Connection settings come from the same `EGON_PG_*` variables
as the integration tests.

`spike:cost` takes about three minutes. `SPIKE_COST_QUICK=1` shortens it to a smoke run
whose numbers mean nothing.

Running the scripts changes no committed file: the benchmark writes its report to
`results/04-cost.local.json`, which is git-ignored. To replace the committed evidence
(`results/04-cost.json`, and the `.txt` outputs, which are captured by hand), run the full
benchmark with `SPIKE_COST_RECORD=1` and update ADR 0002 to the new numbers in the same
change.

The scripts are type-checked by `pnpm typecheck` (the root `tsconfig.json` references this
directory), so a Kysely upgrade that breaks the technique fails CI. CI does not **run**
them.

## Results

`results/` holds the output of the run that ADR 0002 quotes: one `.txt` per script and
`04-cost.json` with the benchmark numbers and the machine they were measured on.

## The technique in one paragraph

Lowering creates Kysely nodes with Kysely's own node factories. Wherever the query has a
value, the lowering puts a `ValueNode` whose "value" is not the value but a **slot
object** (`{ kind: "inline", index: 0 }`). The index is the parameter's position in the
canonical walk of the AST (the order of `QueryAst.params` in the contract); the lowering
visits the AST in that order and counts. Kysely's compiler copies node values into its
`parameters` array untouched, in the order the placeholders appear in the SQL text. So
after compilation `parameters` is exactly the list of slots in placeholder order: the
recipe for building the parameter array of any later execution, obtained without parsing
SQL. The plan `{ sql, slots }` holds no values, which is what makes it cacheable. Executing
it means one loop over the slots and one call to the driver connection Kysely already
provides.
