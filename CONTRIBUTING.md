# Contributing

Ectype is built step by step from a written plan. **Read
[`docs/plan/README.md`](docs/plan/README.md) first**: it holds the goals, the settled
decisions, the testing, performance and documentation standards, and (§9) the worker
protocol and the pull request and review loop that every change follows.

## Prerequisites

- Node.js >= 22 (`.nvmrc` pins 22; CI also runs Node 24)
- pnpm 12.11.2, pinned in `package.json` `"packageManager"`. Corepack (`corepack enable`) and
  pnpm 9 or newer switch to the pinned version by themselves. An older global pnpm does
  not; `engines.pnpm` makes it stop with an "unsupported engine" error instead of running.
- Docker with Compose v2, for the test databases

## Everyday commands

| Command | What it does |
|---|---|
| `pnpm i` | Install dependencies |
| `pnpm check` | `lint` + `typecheck` + `test:unit` + `test:types` + `build`. Must pass before a PR. |
| `pnpm lint` / `pnpm format` | Biome: check / fix formatting, import order and lint rules |
| `pnpm typecheck` | `tsc -b` over every project, plus the design spikes (see below) |
| `pnpm test:unit` | Unit tests (`*.test.ts`) with coverage; fails under 95% lines or branches in `packages/core` or `packages/postgres` |
| `pnpm test:types` | Type tests (`*.test-d.ts`) |
| `pnpm test:integration` | Integration tests (`*.itest.ts`) against real databases |
| `pnpm test:watch` | Unit tests in watch mode |
| `pnpm build` | ESM + CJS + declarations for every package (`tsup`) |
| `pnpm lint:packages` | `publint` and `@arethetypeswrong/cli` on the built packages |
| `pnpm smoke` | Loads the built packages from an ESM and a CommonJS script (`examples/smoke`) |
| `pnpm bench [filter]` | Builds, runs the benchmarks, writes `benchmarks/results/<git-sha>.json` |
| `pnpm docs:dev` / `pnpm docs:build` | VitePress site in `docs/site` |
| `pnpm db:up` / `db:down` / `db:reset` | Start / stop / recreate Postgres (`db:up:tier2` adds MySQL) |
| `pnpm changeset` | Add a release note for a change to a published package |

To run one Vitest project or file:

```sh
pnpm vitest run --project core:unit
pnpm vitest run --project core:integration packages/core/test/support/db.itest.ts
```

## Layout

```
packages/core        "ectype"            the library
packages/postgres    "@ectype/postgres"
packages/zod         "@ectype/zod"
packages/sqlite, mysql, cli              private placeholders until steps 17 / 18
packages/core/test/support               shared test helpers, importable as "@ectype/test-support"
benchmarks/          micro/<area>.bench.ts, harness in src/
examples/smoke       ESM + CJS consumers of the built packages
docs/plan            the plan (frozen; workers add only status/NN.md)
docs/adr             architecture decision records
docs/site            VitePress site; docs/site/examples holds the type-checked example sources
```

Inside the workspace, `ectype` and `@ectype/*` imports resolve to package **sources**
(TypeScript `paths` in `tsconfig.base.json`, aliases in `vitest.config.ts`), so type-checking
and tests never need a build.

`examples/smoke` and the benchmarks are the exceptions: they load the built `dist/`, because
that is what users install. Benchmark processes are started with `benchmarks/tsconfig.run.json`,
which has no source `paths`; the runner and every benchmark file refuse to run unless
`ectype` resolves into the package's own `dist/` directory, and the report records the resolved file
(`ectypeEntry`). `pnpm bench` builds first. `scripts/check-bench-dist-guard.mjs` (run by CI
before the build) proves the refusal.

Code that is not public API cannot be imported from `ectype`. `packages/core` therefore has
a second build entry, `dist/internal.js` (the utilities of `src/internal`), which is not in
the package's `exports`; `benchmarks/micro/internal.bench.ts` shows how a benchmark loads
it from `dist/` while taking its types from the sources.

## Tests

Each package has three Vitest projects, named `<package>:unit`, `<package>:types` and
`<package>:integration`:

- **Unit**, `*.test.ts` beside the source: no database, no network.
- **Types**, `*.test-d.ts`: `expectTypeOf` and `// @ts-expect-error`. Include
  `expectTypeOf(x).not.toBeAny()` on inferred results.
- **Integration**, `*.itest.ts`: real databases. Files run in parallel, tests inside a file
  run serially. Never share a database between files: take one with `withDatabase` or
  `createTestDatabase` from `@ectype/test-support`, and reset it between tests with
  `truncateAll` (until the sandbox of step 16 exists).

Test databases are named `ectype_<label>_<run id>_<creation time>_<random>` and are cleaned
up at three levels: `withDatabase` drops its database when the callback settles **and**
through Vitest's `onTestFinished`, so a test that times out does not leak it; after the run
`global-setup.ts` drops everything the run still owns; before the run it drops databases
older than 30 minutes (`ECTYPE_TEST_STALE_MINUTES`) that a killed run left behind. Several
runs can share one server: a run never drops a younger database of another run, nor one
that has open connections (checked on Postgres and MySQL). A run that is interrupted
(Ctrl-C) or killed skips its own cleanup, so its databases stay until the start-up sweep
of a later run finds them stale, or until `pnpm db:reset`. With `createTestDatabase` you call `drop()`
yourself, in `afterAll`.

The proof that integration files really run concurrently without interfering is the pair
`parallel-a.pair.ts` / `parallel-b.pair.ts`, which only pass when they overlap in time.
`parallel.itest.ts` runs them in a nested Vitest process with exactly two workers, so
`pnpm test:integration` works with any worker count, including `--maxWorkers=1`.

Test support (`packages/core/test/support`):

| Module | Provides |
|---|---|
| `env.ts` | `connectionSettings(dialect)`, `connectionUrl`, `tier2Enabled` |
| `db.ts` | `withDatabase`, `createTestDatabase`, `loadFixture`, `uniqueDatabaseName`, `parseDatabaseName` |
| `sweep.ts`, `global-setup.ts` | `sweepTestDatabases`; the Vitest global setup that sweeps leaked databases |
| `truncate.ts` | `truncateAll(db, { except })` |
| `sql.ts` | `expectSql(compiled).toMatchInlineSnapshot()`, `normalizeSql` |
| `fixtures/blog.sql` | The reference blog schema (PostgreSQL DDL) |

### Databases

`docker-compose.yml` starts Postgres 16 on **127.0.0.1:54329** (user `ectype`, password
`ectype`, database `ectype_dev`) and, with the `tier2` profile, MySQL 8.4 on
**127.0.0.1:33069** (user `root`, password `ectype`). Both ports are published on the
loopback interface only. Data lives on tmpfs and is discarded when the containers stop. To point the tests elsewhere, set `ECTYPE_PG_HOST`,
`ECTYPE_PG_PORT`, `ECTYPE_PG_USER`, `ECTYPE_PG_PASSWORD`, `ECTYPE_PG_DATABASE` (and the
`ECTYPE_MYSQL_*` equivalents). MySQL tests run only with `ECTYPE_TEST_TIER2=1`.

## Code rules the tools enforce

- No default exports (config files excepted), no `any`, no `@ts-ignore`, no non-null
  assertions outside tests, sorted imports, no `console` under `packages/`. Biome warnings
  fail `pnpm lint` too (`--error-on-warnings`).
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
  `verbatimModuleSyntax`. Relative imports carry the `.js` extension (`module: NodeNext`).
- `packages/core/src/index.ts` is the only public entry point of `ectype`.
- Hot-path rules (no `Proxy`, no per-row `defineProperty`, monomorphic shapes, …) are in
  plan README §7 and summarised in [`CLAUDE.md`](CLAUDE.md).

### Design spikes

`docs/plan/spikes/schema-typing.ts` is the regression test for decision D1 (schemas are
classes) and is type-checked by `pnpm typecheck` through `tsconfig.spikes.json`.
`docs/plan/spikes/rejected-const-thunks.ts` intentionally does **not** compile; it is
excluded from every tsconfig and from Biome, and `scripts/check-rejected-spike.mjs` asserts
that it still fails with TS7022 and TS2506.

`docs/plan/spikes/kysely-bridge/` is the evidence for ADR 0002 (Kysely as the SQL back
end): five scripts that lower a hand-built query AST to Kysely nodes and run it against
the Compose Postgres. It is a private workspace package, type-checked by `pnpm typecheck`
but not run by CI. To run it: `pnpm db:up`, then
`pnpm --filter @ectype/spike-kysely-bridge run spike` (see its `README.md`).

### Dependency versions

pnpm refuses releases younger than its minimum release age. **Never add
`minimumReleaseAgeExclude` to `pnpm-workspace.yaml`**, and keep `minimumReleaseAgeStrict: true`:
without strict mode, `pnpm add pkg@<too-new exact version>` succeeds and pnpm writes the
exclusion into the file by itself, with one log line as the only notice. If a release is
too new, pin the newest one that passes and say so in your status note. `pnpm lint` runs
`scripts/check-workspace-policy.mjs`, which fails on an exclusion or on strict mode being
off. Read the diff of `pnpm-workspace.yaml` and `package.json` before committing a
dependency change.

Runtime support starts at Node 22 (decision D14) and every tool is on its current stable
release, with one exception: TypeScript is held at `6` because tsup's declaration bundler
does not work with TypeScript 7. `docs/plan/status/01.md` has the details. Kysely is
pinned to one minor (`~0.29`), because the compiler in step 10 depends on its internals;
bump it deliberately, not as routine maintenance.

## Pull requests

The full loop is in plan README §9. In short:

1. Work on `step/NN-short-name`; touch only the paths your step owns.
2. `pnpm check` (and `pnpm test:integration` where relevant) must pass locally.
3. Write `docs/plan/status/NN.md`, push, and open a PR against `main` titled
   `Step NN: <name>`. The PR template mirrors the required body.
4. Wait for CI. A **different** agent or person reviews; never review your own PR.
5. Address every comment with follow-up commits (no force-push during review).
6. Squash-merge after approval and green CI, then delete the branch.

### Branch protection for `main`

These settings are expected on the GitHub repository (they need admin rights and are not
stored in the repo):

- Require a pull request before merging, with **1 approving review**; dismiss stale
  approvals when new commits are pushed.
- Require status checks to pass, branch up to date: require the **`ci`** check, which is
  green only when every CI job (`lint`, `typecheck`, `unit+types` on Node 22 and 24,
  `integration`, `integration (tier 2)`, `build+publint+attw`, `docs:build`) is green.
- Allow squash merging only; delete head branches automatically.
- No force pushes and no deletion of `main`.

## Architecture decisions

Changing a decision in plan README §2 or a frozen contract needs an ADR: copy
`docs/adr/0000-template.md` to `docs/adr/NNNN-title.md`, fill it in, and open a PR. The
affected work waits until the ADR is accepted.

## Releases

Versions and changelogs are managed with changesets (`.changeset/`); every `ectype` and
`@ectype/*` package shares one version. Nothing is published yet (step 21).
