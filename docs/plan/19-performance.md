# Step 19 — Performance

**Depends on:** 01 for part A (start early); 16 for parts B–D.
**Owns:** `benchmarks/` (harness, comparative suites, CI gating), `docs/site/guide/performance.md`,
`docs/site/reference/benchmarks.md`. May open PRs against any package for optimisations
(each one small, with before/after numbers, reviewed like any other PR).

## Goal

Make performance measurable, visible, and protected from regression; then use the
measurements to meet or beat the budgets in plan README §7.

## Part A — Harness (right after step 01, before feature work piles up)

1. **Runner.** `benchmarks/` with `mitata` (or `tinybench`), one process per benchmark file,
   pinned Node flags, warm-up, and enough samples to report median, p75, p99 and the
   relative margin of error. Reject a run whose margin exceeds a threshold (noisy machine).
2. **Layout.** `micro/<area>.bench.ts` (owned by each feature step, harness provides the
   helpers), `e2e/*.bench.ts` (against real Postgres with seeded data), `compare/*.bench.ts`
   (other libraries), `memory/*.bench.ts`.
3. **Seeding.** Deterministic dataset generator for the blog schema: small (1k users),
   medium (100k posts), large (1M comments) — created once per run in a dedicated database.
4. **Results.** JSON per run in `benchmarks/results/` with machine fingerprint, Node
   version, git SHA. A `pnpm bench:compare <base> <head>` script prints a table of deltas
   with significance (non-overlapping confidence intervals).
5. **CI gate.** On PRs: run the micro suite on base and head **on the same runner in the
   same job** (interleaved, to cancel machine noise); fail if any gated benchmark regresses
   by more than 10% with significance; post the table as a PR comment. E2E and comparative
   suites run nightly and on release branches, not per PR.
6. **Budget file.** `benchmarks/budgets.json` maps benchmark names to the README §7 budgets;
   a test fails if a gated budget is exceeded on the reference runner. Calibrate budgets
   once real numbers exist and record the calibration in an ADR if any README number changes.

## Part B — Comparative suite (after step 16)

Same schema, same data, same queries, same pool size, against: raw `pg` with hand-written
mapping (the floor), Kysely, Drizzle, Prisma, TypeORM, MikroORM. Scenarios:

| # | Scenario |
|---|---|
| 1 | Find one by primary key |
| 2 | Select 10 / 1,000 / 10,000 rows, 10 columns |
| 3 | Filter + order + limit with 3 parameters (query rebuilt per call, as in a request handler) |
| 4 | Two joins + aggregate + group by |
| 5 | Users with posts and comments (nested load of 100 × 10 × 5) |
| 6 | Insert one row with validation; insert 1,000 rows in bulk |
| 7 | Update one field by primary key |
| 8 | Transaction with 3 writes |
| 9 | Query construction only (no database): build + compile, cold and warm |
| 10 | Changeset: cast + validate 10 fields (vs Zod alone, vs class-validator) |

Report throughput, latency percentiles, and allocated bytes per operation
(`process.memoryUsage()` deltas over many iterations, with `--expose-gc`). Be fair: each
library used the way its docs recommend, versions pinned and listed, the suite published
so others can reproduce it. Results that make Egon look bad are published too, with an issue filed.

## Part C — Optimisation pass

Work from profiles, not intuition. For each hot path (query build, compile-cache hit,
param binding, hydration, changeset cast, insert, preload stitching):

1. Capture a CPU profile (`--cpu-prof`) and an allocation profile on the relevant benchmark.
2. Check for the usual suspects: megamorphic call sites (`--trace-ic` / deopt logs via
   `--trace-deopt`), hidden-class transitions in row objects, closures allocated per call,
   intermediate arrays, `arguments`/rest in hot functions, `try/catch` or `async` layers
   that add microtask hops, `Map` lookups that could be array indexes, string concatenation in loops.
3. Fix, re-measure, and land as a small PR with before/after numbers. Keep changes that
   win ≥ 3% with significance; revert those that do not (complexity is a cost).
4. Specific investigations to run and write up:
   - Kysely bridge overhead on cold compile and on execution (from ADR 0002); whether to
     bypass any Kysely layer on the hot execution path.
   - Hydration codegen vs interpreter across row widths (5/10/30/100 columns).
   - Whether asking the driver for array-mode rows is reachable through Kysely and worth it.
   - Server-side prepared statements for `prepare`d queries (latency and plan-cache effects).
   - Cost of `Result` object allocation on writes; cost of copy-on-write changesets.
   - Startup cost: time to define 100 schemas and resolve associations; import time of `egon-orm` (target < 30 ms cold).
5. **Memory.** Per-row retained size for a 10-column row (target: within 1.2× of a plain
   object literal); no growth over 1M iterations of each e2e scenario (leak check); plan
   cache bounded under a workload of unique query shapes.
6. **Bundle.** Size of `egon-orm` minified+gzipped with and without tree-shaking a
   changeset-only import; track in CI with a size budget; verify `sideEffects: false` holds.

## Part D — Guidance

`guide/performance.md` for users: define queries at module level; `prepare` for hot paths;
select only what is needed; preload strategy choice; bulk operations; streaming; pool
sizing; reading telemetry; what the plan cache does and its metrics; `codegen: false`
trade-off. `reference/benchmarks.md`: methodology, hardware, versions, full comparative
results, how to reproduce, generated from the latest results JSON.

## Tests

- The harness itself: `bench:compare` on synthetic results (regression detected, noise
  ignored); budget checker; seeding determinism.
- Shape/monomorphism guard tests (V8 natives) for rows and bindings, run in a dedicated CI job.
- Leak tests under `--expose-gc` for each e2e scenario.

## Acceptance

- [ ] Part A merged before step 05 starts; CI gate demonstrably catches an injected 20% regression and ignores a no-op change (run it 10 times: zero false positives).
- [ ] Every budget in README §7 has a gated benchmark; all pass on the reference runner (or an ADR adjusts the budget with justification).
- [ ] Comparative suite runs reproducibly from one command; results published in docs.
- [ ] Each optimisation PR carries before/after numbers; investigations in Part C item 4 written up in `docs/site/internals/performance-notes.md`.
- [ ] Memory, leak and bundle-size targets met and gated.

## Out of scope

Optimising other libraries' usage beyond their documented best practice. Database tuning.

## Carried over from steps 01 and 02

Requests that the (now removed) status notes of steps 01 and 02 addressed to this step.

- `benchmarks/src/harness.ts` and `run.ts` are this step's to replace; feature steps only need `bench`, `group`, `doNotOptimize` and `runBenchmarks()` to keep working.
- `benchmarks/micro/internal.bench.ts` shows how to benchmark non-public code from `dist/internal.js`.
- The step 02 cost numbers came from one machine, with Postgres behind a VM boundary.
