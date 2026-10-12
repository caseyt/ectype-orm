# Step 01 — Foundation

**Depends on:** nothing. **Blocks:** everything.
**Owns:** repository root config, `.github/`, `packages/*/package.json` and build config,
`packages/core/test/support/`, `benchmarks/` skeleton, `docs/site/` skeleton, `docker-compose.yml`.

## Goal

A repository in which any later worker can run one command to lint, type-check, test,
build, benchmark and preview docs, and in which CI enforces the standards in the README.
No library code is written in this step beyond placeholder exports.

## Deliverables

1. **Git and workspace.** The repository already exists (`main`, remote `origin` =
   `https://github.com/caseyt/ectype-orm.git`). Add a PR template mirroring the PR body in
   plan README §9, branch protection notes in `CONTRIBUTING.md` (CI green + one approval
   before merge), `.gitignore`, `.editorconfig`, `.nvmrc` (20),
   `pnpm-workspace.yaml` covering `packages/*`, `benchmarks`, `examples/*`, `docs/site`.
   Root `package.json` with `"packageManager"` pinned and `engines.node >= 20`.
2. **TypeScript.** `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`,
   `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`,
   `isolatedModules`, `isolatedDeclarations` if it does not fight the schema API (try it;
   record the outcome), `target: ES2022`, `module: NodeNext`. Project references between packages.
3. **Packages.** Create `core`, `postgres`, `zod`, `cli` (and empty `sqlite`, `mysql`
   marked `private` until step 17) with `package.json`, `tsconfig.json`, `src/index.ts`.
   `exports` map with `import`/`require`/`types` conditions; `sideEffects: false`;
   `files: ["dist"]`. Core's only runtime dependency is `kysely` (pin the current stable
   minor; record the version in the status note).
4. **Build.** `tsup` (or `tsdown`) producing ESM + CJS + `.d.ts` with source maps. Verify
   output with `publint` and `@arethetypeswrong/cli` in CI.
5. **Lint and format.** Biome with rules: no default exports, no `any` (error), no
   non-null assertion outside tests, import sorting, no `console` in `packages/`.
6. **Tests.** Vitest workspace with three projects per package:
   `unit` (`*.test.ts`), `types` (`*.test-d.ts`, typecheck mode), `integration`
   (`*.itest.ts`, serial per file, needs databases). Coverage via v8 with thresholds
   95% lines/branches for `packages/core` and `packages/postgres`. Add `fast-check`.
7. **Databases.** `docker-compose.yml` with Postgres 16 (tier 1), plus MySQL 8 under a
   `tier2` profile. Fixed non-default host ports, healthchecks, tmpfs data dirs for speed.
   `pnpm db:up` / `db:down` / `db:reset`.
8. **Test support** in `packages/core/test/support/`:
   - `env.ts`: reads connection settings from env with defaults matching compose.
   - `db.ts`: `withDatabase(dialect, fn)` that creates a uniquely named database/schema per
     test file and drops it after, so integration files can run in parallel.
   - `truncate.ts`: truncate-all helper (used until the sandbox exists in step 16).
   - `sql.ts`: `expectSql(compiled).toMatchInlineSnapshot()` helper that normalises whitespace.
   - `fixtures/blog.sql`: DDL for the reference schema below.
9. **Reference schema.** The blog domain used by all tests, docs and benchmarks. DDL only in
   this step (schema classes arrive in step 04 at `packages/core/test/support/blog.ts`):
   - `users(id bigserial pk, email text unique not null, name text, age int, role text not null default 'member', password_hash text, settings jsonb, lock_version int not null default 1, inserted_at, updated_at)`
   - `profiles(id, user_id fk unique, bio text, avatar_url text)` — has_one
   - `posts(id, author_id fk, title text not null, body text, published boolean default false, views int default 0, tags text[], published_at timestamptz, inserted_at, updated_at)`
   - `comments(id, post_id fk on delete cascade, author_id fk, body text not null, inserted_at)`
   - `tags(id, name text unique)`, `posts_tags(post_id, tag_id, pk(post_id, tag_id))` — many_to_many
   - `orgs(id uuid pk default gen_random_uuid(), name)`, `memberships(org_id, user_id, role, pk(org_id, user_id))` — uuid and composite keys
10. **Benchmarks skeleton.** `benchmarks/` package using `mitata` (or `tinybench`), a
    `pnpm bench` script, a `benchmarks/micro/_example.bench.ts`, and a JSON reporter that
    writes `benchmarks/results/<git-sha>.json`. Regression gating comes in step 19.
11. **Docs skeleton.** VitePress site at `docs/site` with nav stubs for Guide, API,
    Ecto cheat sheet; `pnpm docs:dev` / `docs:build`.
12. **CI** (GitHub Actions): jobs `lint`, `typecheck`, `unit+types` (Node 20 and 22),
    `integration` (Postgres service), `build+publint+attw`, `docs:build`. Cache pnpm store.
13. **Root scripts.** `pnpm check` = lint + typecheck + unit + type tests + build.
    `pnpm test:integration`, `pnpm bench`, `pnpm docs:dev`.
14. **Repo docs.** `README.md` (short), `CONTRIBUTING.md` (how to run everything; points
    at `docs/plan/README.md` §9), `CLAUDE.md` (commands, layout, the hot-path rules from
    plan README §7, "read docs/plan/README.md first"), `LICENSE` (MIT unless told otherwise),
    `docs/adr/0000-template.md`, and `docs/adr/0001-schema-classes.md` recording decision D1
    with links to the spike files.
15. **Release plumbing.** `@changesets/cli` configured (fixed versioning across packages).
    No publishing yet.

## Acceptance

- [ ] Fresh clone: `pnpm i && pnpm db:up && pnpm check && pnpm test:integration` passes.
- [ ] A deliberately failing type test, unit test, lint error and coverage drop each fail CI
      (demonstrate once, then remove).
- [ ] `import { VERSION } from "ectype"` works from an ESM and a CJS consumer script in `examples/smoke/`.
- [ ] `docs/plan/spikes/schema-typing.ts` is type-checked in CI (it is the regression test for D1).
- [ ] Two integration test files run in parallel without interfering.
- [ ] `pnpm bench` runs the example benchmark and writes a results file.

## Out of scope

Any library behaviour. The sandbox. Benchmark regression gating. Publishing.
