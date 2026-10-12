# Ectype — master plan

A TypeScript ORM modelled on Elixir's Ecto: **schemas**, **changesets**, an Ecto-style
**query builder**, and a **Repo**. Heavily tested, performance-first, fully documented.

> `ectype` is a working name (Ecto + type; also an English word meaning "a copy of an
> original"). It appears only in package names and imports, so renaming is mechanical.

This file is the shared context for every step. **Every worker reads this file in full,
then their own step file.** Step files do not repeat what is here.

---

## 1. Goals and non-goals

**Goals**

1. Ecto's mental model, faithfully: data (schema structs) is separate from change tracking
   (changesets), from query description (immutable query values), from execution (Repo).
2. End-to-end type inference with no codegen: row types, preloaded association types, and
   `select` result types all come from the schema definition.
3. Validation through any [Standard Schema](https://standardschema.dev) validator (Zod is
   the documented default; Valibot, ArkType and recent Yup also implement it) or a plain
   user function.
4. Overhead over the raw driver small enough to measure in microseconds (budgets in §7).
5. Every public API documented with runnable, type-checked examples.

**Non-goals for 1.0**

- Active-record style (`user.save()`), lazy loading, identity map, unit of work.
- Implicit transaction propagation via `AsyncLocalStorage` (transactions are explicit).
- Schema-diffing auto-migrations. Migrations are hand-written (step 18).
- Non-SQL stores.

---

## 2. Decisions already made

These are settled. Changing one requires an ADR (§9), not a unilateral edit.

| # | Decision | Why |
|---|---|---|
| D1 | **Schemas are classes** built with `class User extends Schema("users", {...fields}) {}`; associations are `static` members holding thunks. | Verified by spike. `const User = schema({ posts: hasMany(() => Post) })` and the same thing in a class `extends` clause both fail with TS7022/TS2506 on any circular association. Static initialisers resolve lazily. See `spikes/schema-typing.ts` (compiles under `--strict`) and `spikes/rejected-const-thunks.ts`. |
| D2 | Rows are **instances of the schema class**, created by a generated factory that never runs user constructors. `new User({...})` is the equivalent of `%User{}`. | Named row types (`User`), user-defined getters/methods, stable hidden classes. |
| D3 | Fields are **non-null by default**; `.nullable()` opts in. | Deviates from Ecto (everything nullable) because it is what TS users expect and gives better types. |
| D4 | Field names are camelCase in TS and snake_case in the database by default; `.source("col")` overrides per field, `naming` option per schema. | Convention on both sides. |
| D5 | `belongsTo` does **not** define the foreign-key field; declare it in the fields object. | Fields and associations live in different places because of D1. |
| D6 | Query bindings are **named** and passed to callbacks as one object: `.where(({ u, p }) => ...)`. | Ecto named bindings; positional bindings do not type well. |
| D7 | Operators are methods on expressions (`u.age.gt(18)`), with free functions for n-ary and aggregate forms (`and`, `or`, `not`, `count`, `fragment`). | No operator overloading in TS; methods are discoverable. |
| D8 | Binding objects are **prebuilt per (schema, alias) and cached**. No `Proxy` anywhere on a hot path. | Performance. |
| D9 | Every literal in a query is a **bound parameter**. The only way to emit raw SQL text is the `fragment` tagged template, whose interpolations are also bound. | Injection safety by construction. |
| D10 | Write operations return `Result<T, Changeset<T>>` (`{ ok: true, value } \| { ok: false, error }`); each has an `...OrThrow` twin. | Ecto's `{:ok, _} \| {:error, _}` and bang functions. |
| D11 | Changesets are immutable and synchronous. Async validation is a separate, explicit `validateAsync`. | Keeps the common path allocation-light and predictable. |
| D12 | **Kysely is the SQL back end**: our query AST is lowered to Kysely `OperationNode` trees, compiled by Kysely's dialect compilers, and executed through Kysely drivers. Kysely is never exposed in the public API and sits behind our own `Adapter` interface. | Postgres, MySQL and SQLite support, pooling and DDL without writing three compilers. Hidden behind `Adapter` so it can be replaced if step 02's spike shows unacceptable overhead. |
| D13 | Postgres is tier 1 (every feature, every test). SQLite and MySQL are tier 2 (conformance suite, documented capability gaps). | Scope control. |
| D14 | Node >= 22, TypeScript >= 5.5, ESM-first with a CJS build. pnpm workspace. Vitest. Biome. | Current baseline. |
| D15 | Validators are consumed through the Standard Schema interface (types vendored, no dependency). Zod is a dev/peer dependency of `@ectype/zod` only. | "Zod by default, anything else allowed" with zero coupling in core. |

---

## 3. Packages and layout

```
packages/
  core/            -> "ectype"            schema, types, changeset, query, repo, adapter interface, Kysely bridge
  postgres/        -> "@ectype/postgres"  Kysely PostgresDialect wiring, pg type mapping, error normalisation
  sqlite/          -> "@ectype/sqlite"    (step 17)
  mysql/           -> "@ectype/mysql"     (step 17)
  zod/             -> "@ectype/zod"       derive Zod schemas from Ectype schemas (step 06)
  cli/             -> "@ectype/cli"       migration runner and generators (step 18)
benchmarks/        comparative and micro benchmarks (step 19)
examples/          blog (reference app used by docs and e2e tests)
docs/
  plan/            this plan; status/ holds completion notes; spikes/ holds proofs
  adr/             architecture decision records
  site/            VitePress documentation site (step 20)
```

`packages/core/src`:

```
contracts/     frozen shared interfaces (step 02)
types/         EctoType implementations (03)
schema/        Schema(), field builder, associations, metadata (04)
changeset/     changeset core (05), validators (06), nested (15)
query/         ast.ts, expr.ts (07); builder.ts (08); advanced/ (09)
compiler/      AST -> Kysely nodes, plan cache (10)
adapter/       Adapter implementation over Kysely, telemetry (11)
repo/          read (12), write (13), preload (14), transaction + sandbox (16)
multi/         Multi (16)
errors.ts
index.ts       the only public entry point; everything else is internal
```

Each step file lists the paths it **owns**. Do not edit files outside your owned paths
except to add an export line to `index.ts`. If you need a change elsewhere, write it in
your status note under "Requests".

---

## 4. The API at a glance

This is the target surface. Step files specify each part exactly; this section exists so
that every worker has the same picture.

```ts
import { Schema, t, hasMany, belongsTo, timestamps, cast, from, count, createRepo } from "ectype";
import { postgres } from "@ectype/postgres";
import { z } from "zod";

// --- Schema (Ecto.Schema) --------------------------------------------------
export class User extends Schema("users", {
  id: t.id(),
  email: t.string(),
  name: t.string().nullable(),
  age: t.integer().nullable(),
  role: t.enum(["admin", "member"]).default("member"),
  password: t.string().virtual(),
  passwordHash: t.string().redact(),
  ...timestamps(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });

  // Changeset functions are ordinary static methods, as in Ecto.
  static changeset(user: User, params: unknown) {
    return cast(user, params, ["email", "name", "age", "password"])
      .validateRequired(["email"])
      .validate(z.object({ email: z.string().email(), age: z.number().int().min(13).nullish() }))
      .validateLength("password", { min: 12 })
      .uniqueConstraint("email");
  }
}

export class Post extends Schema("posts", {
  id: t.id(),
  title: t.string(),
  published: t.boolean().default(false),
  authorId: t.id(),
  ...timestamps(),
}) {
  static author = belongsTo(() => User, { foreignKey: "authorId" });
}

// --- Repo (Ecto.Repo) ------------------------------------------------------
const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

const result = await repo.insert(User.changeset(new User(), input));
if (!result.ok) return result.error.errors;        // { email: [{ message: "has already been taken", ... }] }
const user = result.value;                          // User

// --- Query (Ecto.Query) ----------------------------------------------------
const q = from(User, "u")
  .joinAssoc("u", "posts", "p")
  .where(({ u, p }) => u.age.gte(18).and(p.published))
  .groupBy(({ u }) => u.id)
  .orderBy(({ u }) => u.insertedAt.desc())
  .select(({ u, p }) => ({ id: u.id, email: u.email, posts: count(p.id) }));

const rows = await repo.all(q);                     // { id: number; email: string; posts: number }[]

const withPosts = await repo.all(from(User, "u").preload("posts"));
withPosts[0].posts[0].title;                        // typed: Loaded<typeof User, "posts">

await repo.transaction(async (tx) => {
  const u = await tx.getOrThrow(User, 1);
  await tx.updateOrThrow(User.changeset(u, { name: "New" }));
});
```

Ecto to Ectype naming is mechanical: `snake_case` functions become `camelCase`, `fun!`
becomes `funOrThrow`, `fun?` becomes `isFun`/`hasFun`. The full mapping table is a
deliverable of step 20 and each step contributes its rows.

---

## 5. Steps and dependency graph

| Step | File | Depends on | Can run in parallel with |
|---|---|---|---|
| 01 Foundation | `01-foundation.md` | — | — |
| 02 Core contracts and Kysely spike | `02-core-contracts.md` | 01 | — |
| 03 Type system | `03-types.md` | 02 | 07, 11 |
| 04 Schema | `04-schema.md` | 03 | 07, 11 |
| 05 Changeset core | `05-changeset.md` | 04 | 08, 10, 11 |
| 06 Validators (Zod / Standard Schema / custom) | `06-changeset-validators.md` | 05 | 08–12 |
| 07 Query AST and expressions | `07-query-expressions.md` | 02 | 03, 04, 11 |
| 08 Query builder | `08-query-builder.md` | 04, 07 | 05, 10, 11 |
| 09 Advanced queries | `09-query-advanced.md` | 08, 10 | 12, 13 |
| 10 SQL compiler and plan cache | `10-sql-compiler.md` | 07 (08 for integration) | 05, 08, 11 |
| 11 Adapter and Postgres package | `11-adapter.md` | 02 | 03–10 |
| 12 Repo: reads | `12-repo-read.md` | 08, 10, 11 | 05, 06, 09 |
| 13 Repo: writes | `13-repo-write.md` | 05, 12 | 09, 14 |
| 14 Associations and preload | `14-associations-preload.md` | 12 | 13 |
| 15 Nested changesets and embeds | `15-nested-changesets.md` | 13, 14 | 16 |
| 16 Transactions, Multi, sandbox | `16-transactions-multi.md` | 13 | 14, 15 |
| 17 SQLite and MySQL | `17-dialects.md` | 12–16 | 18 |
| 18 Migrations and CLI (**follow-up, after 21**) | `18-migrations-cli.md` | 11, 21 | — |
| 19 Performance | `19-performance.md` | harness after 01; final pass after 16 | — |
| 20 Documentation | `20-documentation.md` | skeleton after 01; final pass after 17 | — |
| 21 Release hardening | `21-release.md` | all | — |

Suggested waves: **A** 01 → **B** 02 → **C** 03, 07, 11 → **D** 04, 10 → **E** 05, 08 →
**F** 06, 12 → **G** 09, 13, 14 → **H** 15, 16 → **I** 17 → **J** 19, 20, 21 → **follow-up** 18.

Steps 01 and 02 are deliberately sequential and small: they freeze the interfaces that let
everything after them proceed independently.

---

## 6. Testing standards

All of these apply to every step. Step files add specifics.

- **Unit tests** (`*.test.ts` beside the source): no database, no network. Target: 100%
  of branches in owned code; CI enforces 95% lines and branches per package.
- **Type tests** (`*.test-d.ts`, Vitest `expectTypeOf` plus `// @ts-expect-error`): every
  public generic has positive and negative cases. A type that silently degrades to `any`
  or `unknown` is a bug; include `expectTypeOf(x).not.toBeAny()` on inferred results.
- **SQL snapshot tests**: query in, `{ sql, params }` out, inline snapshots, one per
  feature per dialect. No database needed.
- **Integration tests** (`*.itest.ts`): real databases from `docker compose`. Each test
  runs inside the sandbox (step 16; before that, a truncate helper from step 01).
- **Property tests** (fast-check) where the input space is large: type cast/dump/load
  round trips, changeset invariants, and "no user-supplied string ever appears in emitted
  SQL text".
- **Conformance suite** (`packages/core/test/conformance`): dialect-independent
  integration tests that every adapter package runs against itself.
- Tests are named for the behaviour, not the function: `"cast ignores keys that are not permitted"`.
- A bug fix lands with a test that fails without it.

---

## 7. Performance standards

Performance is a feature with tests. Step 19 owns the harness; **every step that touches a
hot path adds its own micro-benchmarks** under `benchmarks/micro/<area>.bench.ts`.

Budgets (Node 20, Apple M-series or CI reference runner; step 19 calibrates and records
the reference numbers, then CI fails on a regression of more than 10%):

| Operation | Budget |
|---|---|
| Build a 3-clause query (`from`/`where`/`orderBy`/`limit`) | < 1.5 µs |
| Compile, plan-cache hit | < 0.3 µs |
| Compile, cold | < 40 µs |
| Hydrate one 10-column row into a schema instance | < 150 ns |
| `cast` + 5 built-in validations on a 10-field changeset | < 3 µs |
| `repo.all` of 1,000 rows, end to end, over raw driver with manual mapping | < 15% overhead |
| `repo.insert` of one row over raw driver | < 20% overhead |

Rules that follow from the budgets:

- No `Proxy`, no `Object.defineProperty` per row, no `delete`, no spread of row objects on
  hot paths. Keep object shapes monomorphic: assign every field in the same order, always.
- No per-call closures or arrays where a precomputed table on schema metadata will do.
- Identity `load`/`dump` functions are skipped by reference check, not called.
- Anything derivable from a schema or a query shape is computed once and cached on it.
- Do not optimise without a benchmark that shows the win; commit the benchmark.

---

## 8. Documentation standards

- Every exported symbol has TSDoc: one-sentence summary, `@example`, `@throws` where
  relevant, and "Ecto equivalent: `Ecto.Changeset.cast/4`" where one exists.
- Each step delivers its guide page(s) under `docs/site/guide/` as listed in its file.
  Step 20 assembles, edits and cross-links; it does not write other steps' content from scratch.
- Every code block in the docs is extracted and type-checked in CI (step 20 builds the
  extractor; until then keep examples as real files under `docs/site/examples/` and
  include them by reference).
- Deviations from Ecto are stated explicitly in a "Differences from Ecto" box on the page.

---

## 9. Worker protocol

1. Read this file, then your step file, then the step files you depend on (their "Public
   API" sections are your inputs) and `packages/core/src/contracts/`.
2. Work on branch `step/NN-short-name`. Touch only your owned paths.
3. Build in this order: types and signatures, type tests, unit tests, implementation,
   integration tests, benchmarks, docs.
4. If the spec is wrong, ambiguous, or blocked by another step: do not guess silently.
   Choose the option closest to Ecto's documented behaviour, implement it, and record it
   under "Decisions" in your status note. If it changes a frozen contract or a decision in
   §2, write `docs/adr/NNNN-title.md` (context, options, decision, consequences) and stop
   that part of the work until it is accepted.
5. Done means every box in your step's **Acceptance** list is true and `pnpm check`
   (lint, typecheck, unit, type tests, build) passes, plus `pnpm test:integration` for
   steps that have integration tests.
6. Write `docs/plan/status/NN.md`: what shipped, decisions made, deviations from the spec,
   benchmark numbers, known gaps, requests to other steps. Report failures and skipped
   items plainly; a status note that hides a gap is worse than the gap.
7. Open a pull request and take it through the review loop below. A step is finished when
   its PR is approved and merged, not when the code is written.

### Pull request and review loop

Remote: `https://github.com/caseyt/ectype-orm.git`, default branch `main`.

**Author (the worker that implemented the step)**

1. Push `step/NN-short-name` and open a PR against `main` with `gh pr create`.
   Title: `Step NN: <name>`. Body: summary, the step's Acceptance list as checkboxes with
   their real state, benchmark numbers, deviations and decisions, and how to verify locally.
2. Wait for CI. Do not request review on a red PR.
3. Hand the PR to a **different agent** for review (a fresh agent with no memory of the
   implementation; never review your own PR).
4. When the review arrives, address every comment: fix it, or reply with a concrete reason
   it should stay. Push follow-up commits (no force-push during review, so the reviewer
   can see what changed) and reply on each thread saying what was done.
5. Request re-review. Repeat until the reviewer approves with no remaining suggestions.
6. Squash-merge after approval and green CI, then delete the branch.

**Reviewer (a separate agent, started fresh for each round or continued across rounds)**

Reads `docs/plan/README.md`, the step file, and the PR diff — then checks out the branch
and runs it. Reviews against, in order:

1. **Spec conformance:** every Acceptance box is actually true (verify, do not trust the
   checklist); public API matches the step file; nothing outside the owned paths changed.
2. **Correctness:** hunt for bugs, especially edge cases the spec lists, null handling,
   error paths, and anything that could put a user value into SQL text.
3. **Types:** no `any`/`unknown` leaking from public generics; negative type tests exist.
4. **Tests:** they fail when the behaviour is broken (spot-check by mutating the code),
   cover the listed use cases, and are not snapshot-only where behaviour matters.
5. **Performance:** hot-path rules in §7 followed; benchmarks present; budgets met.
6. **Docs:** TSDoc and the guide page exist, examples compile.

Posts findings with `gh pr review`: `--request-changes` with specific, located comments
(file, line, what is wrong, a failing input where possible) while anything remains;
`--approve` only when there is nothing left to suggest. Reviewers do not push commits to
the PR. Style preferences the linter does not enforce are not grounds for requesting changes.

If author and reviewer disagree for two rounds on the same point, stop and escalate it to
the project owner in the PR rather than looping.

Definition of done, common to all steps:

- [ ] Acceptance list complete; no `TODO` without an issue reference; no `any` in public types.
- [ ] No `@ts-ignore`; `@ts-expect-error` only in type tests.
- [ ] Unit, type, and (where applicable) integration tests pass; coverage thresholds met.
- [ ] Benchmarks added for hot paths, numbers recorded in the status note.
- [ ] TSDoc on all exports; guide page delivered.
- [ ] `index.ts` exports updated; nothing internal exported.
- [ ] Status note written.

---

## 10. Owner decisions (2026-10-11)

1. **Name:** `ectype` / `@ectype/*` for now. npm availability still unchecked (step 21 confirms).
2. **Database tiers:** Postgres first (D13 stands). SQLite and MySQL follow in step 17.
3. **Migrations and CLI:** wanted, but as a **follow-up**. Step 18 is not part of the first
   release; it starts after step 21. Until then tests and examples use plain SQL fixtures.
4. **Nullable default (D3):** pending owner confirmation; non-null by default stands until told otherwise.
