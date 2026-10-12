# Step 20 — Documentation

**Depends on:** 01 for part A (start early); 17 for the final pass.
**Owns:** `docs/site/` structure, theme, tooling and every page not owned by a feature
step; `examples/`; root `README.md`. Edits other steps' guide pages for consistency in the
final pass (content changes that alter meaning go back to the owning step as review comments).

## Goal

Documentation good enough that someone who knows Ecto is productive in ten minutes and
someone who has never heard of it is productive in thirty, with every example guaranteed to compile.

## Part A — Tooling (right after step 01)

1. **Site.** VitePress with local search, dark mode, edit links, versioned base path.
2. **Checked examples.** Code blocks are never typed into Markdown by hand. They are
   regions of real files under `docs/site/examples/**.ts`, included with VitePress's
   snippet import (`<<< @/examples/changesets.ts#register`). `docs/site/examples` is a
   workspace package that depends on the local packages and is covered by
   `pnpm typecheck`; files with a `// @run` header are also executed in CI against
   Postgres with their output asserted (`// =>` comments compared to actual values).
   Add [Twoslash](https://twoslash.netlify.app/) so hovering shows inferred types — the
   library's main selling point should be visible in the docs.
3. **API reference.** TypeDoc (markdown plugin) generated from TSDoc into `docs/site/api/`,
   grouped by module (Schema, Types, Changeset, Query, Repo, Multi, Migration, Testing,
   Errors). CI fails on exported symbols without a summary and `@example`.
4. **Lint.** Dead-link check, a spell checker with a project dictionary, and a check that
   every guide page listed in the step files exists.
5. **Page template** for feature steps: Overview → Quick example → Reference sections →
   Recipes → Differences from Ecto → See also. Publish it in `CONTRIBUTING.md`.
6. **Deployment.** Build on every PR (preview artifact), deploy `main` to GitHub Pages.

## Part B — Pages owned by this step

- **Home:** what it is, a 30-line example covering schema → changeset → query → repo, key
  properties (typed end to end, Ecto semantics, fast), install line.
- **Introduction / Why Ectype:** the four concepts and why they are separate; how it
  differs in philosophy from Prisma, Drizzle, TypeORM (no active record, no lazy loading,
  explicit changes, queries as values). Honest about trade-offs.
- **Getting started** (with steps 11/12): from `pnpm add` to a working query in under five minutes.
- **Tutorial:** build the blog step by step (schemas, SQL fixtures until step 18 ships migrations, registration changeset
  with Zod, queries, preloads, nested comment form, Multi for publish-and-notify, tests
  with the sandbox). Its code is `examples/blog`, a runnable app with its own test suite in CI.
- **Coming from Ecto:** the complete mapping table (every `Ecto.Schema`, `Ecto.Changeset`,
  `Ecto.Query`, `Ecto.Repo`, `Ecto.Multi`, `Ecto.Migration` function → Ectype equivalent or
  "not supported, because…"), assembled from each step's rows; side-by-side Elixir/TypeScript
  snippets for the twenty most common operations; the list of deliberate differences (D3, D4, D5, explicit transactions, datetime precision).
- **Coming from Prisma / Drizzle / TypeORM:** one page each, task-oriented ("how do I do X").
- **Recipes:** pagination (offset and keyset), soft deletes, multi-tenancy with prefixes,
  optimistic locking, upserts, full-text search with fragments, enums, money/decimal custom
  type, auditing with Multi, find-or-create, per-parent top-N, dynamic filters from a query string, i18n of errors, form error rendering (React example).
- **Framework integration:** Express/Fastify/Hono request lifecycle, Next.js (connection
  reuse in dev, server actions returning changeset errors), graceful shutdown, serverless caveats.
- **Reference:** errors (every error class, code, cause, how to fix), configuration
  options, dialect support matrix (from step 17), CLI (from step 18, once it ships), benchmarks (from step 19).
- **Internals** (for contributors): architecture overview with a diagram of the pipeline,
  the AST, the compiler and cache, hydration, how to add a type/operator/dialect; links to ADRs.
- **FAQ and troubleshooting:** type errors users will actually hit (circular schema
  imports, "property does not exist" on a non-preloaded association, comparison with null,
  missing constraint declaration) with the exact error text and the fix.
- **Root README:** short pitch, install, the 30-line example, links, status badges.
- **Changelog and migration guide** scaffolding (filled by step 21).

## Part C — Final pass (after step 17)

1. Read every feature-step page against the page template; fix structure, terminology
   (one glossary: row, schema, changeset, binding, queryable, preload, adapter), tone and cross-links.
2. Verify every public export appears in at least one guide page and in the API reference
   (script: compare `index.ts` exports against doc mentions; fail CI on gaps).
3. Verify every Ecto function in the mapping table is either implemented or explicitly marked.
4. Run a fresh-eyes test: a new agent (no project context) follows Getting started and the
   Tutorial literally, in a clean directory, and reports every point of confusion or
   failure; fix all of them. Repeat once with the "Coming from Ecto" page and three recipes.
5. Accessibility and mobile check of the site; search returns sensible results for the top 30 terms.

## Tests

- Typecheck and execution of all examples (part A item 2) in CI.
- `examples/blog` test suite (it doubles as the project's end-to-end test).
- Export-coverage and link checks.

## Acceptance

- [ ] No hand-written code block anywhere in the docs (lint: fenced `ts` blocks are only allowed via snippet import or with an explicit `<!-- illustrative -->` marker for intentionally invalid code).
- [ ] 100% of public exports documented in API reference and referenced from a guide.
- [ ] Mapping table complete for all six Ecto modules.
- [ ] Fresh-eyes test passes with no unresolved findings; its transcript summarised in the status note.
- [ ] Site builds with zero warnings and deploys from `main`.

## Out of scope

Marketing site, logo, videos. Translations.
