# Contributing

Ectype is built step by step from a written plan. **Read
[`docs/plan/README.md`](docs/plan/README.md) first**: it holds the goals, the settled
decisions, the testing, performance and documentation standards, and (§9) the worker
protocol and the pull request and review loop that every change follows.

## Prerequisites

- Node.js >= 20 (`.nvmrc` pins 20; CI also runs Node 22)
- pnpm 8.15.5 (pinned in `package.json` `"packageManager"`; `corepack enable` picks it up)
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
and tests never need a build. `examples/smoke` and the benchmarks use the built `dist/`.

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

Test support (`packages/core/test/support`):

| Module | Provides |
|---|---|
| `env.ts` | `connectionSettings(dialect)`, `connectionUrl`, `tier2Enabled` |
| `db.ts` | `withDatabase`, `createTestDatabase`, `loadFixture`, `uniqueDatabaseName` |
| `truncate.ts` | `truncateAll(db, { except })` |
| `sql.ts` | `expectSql(compiled).toMatchInlineSnapshot()`, `normalizeSql` |
| `fixtures/blog.sql` | The reference blog schema (PostgreSQL DDL) |

### Databases

`docker-compose.yml` starts Postgres 16 on **localhost:54329** (user `ectype`, password
`ectype`, database `ectype_dev`) and, with the `tier2` profile, MySQL 8.4 on
**localhost:33069** (user `root`, password `ectype`). Data lives on tmpfs and is discarded
when the containers stop. To point the tests elsewhere, set `ECTYPE_PG_HOST`,
`ECTYPE_PG_PORT`, `ECTYPE_PG_USER`, `ECTYPE_PG_PASSWORD`, `ECTYPE_PG_DATABASE` (and the
`ECTYPE_MYSQL_*` equivalents). MySQL tests run only with `ECTYPE_TEST_TIER2=1`.

## Code rules the tools enforce

- No default exports (config files excepted), no `any`, no non-null assertions outside
  tests, sorted imports, no `console` under `packages/`.
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

### Dependency versions

Runtime support starts at Node 20 (decision D14), and the toolchain must run on it, so a
few tools are deliberately held below their latest major: Kysely `0.28` (0.29 needs Node
22), Vitest `4` with Vite `6` (Vitest 5 and Vite 7+ need newer Node), `@changesets/cli` `2`
(3 needs Node 22), TypeScript `6` (tsup cannot bundle declarations with TypeScript 7).
`docs/plan/status/01.md` has the details. Do not bump these without checking Node 20.

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
  green only when every CI job (`lint`, `typecheck`, `unit+types` on Node 20 and 22,
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
