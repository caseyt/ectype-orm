# 0001 — Schemas are classes with static association thunks

- **Status:** accepted
- **Date:** 2026-10-11
- **Step:** 01 (records decision D1 of the plan; the decision predates the step)
- **Affects:** D1 and D2 in plan README §2; the schema API (step 04) and everything typed from it

## Context

Egon infers row types, preloaded association types and `select` result types from the
schema definition, with no code generation. Associations are routinely circular: a `User`
has many `Post`s and each `Post` belongs to a `User`. The schema API therefore has to let
two definitions refer to each other while TypeScript still infers both of their types.

Three shapes were tried. The evidence is kept in the repository:

- [`docs/plan/spikes/schema-typing.ts`](../plan/spikes/schema-typing.ts) compiles under
  `--strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes`.
- [`docs/plan/spikes/rejected-const-thunks.ts`](../plan/spikes/rejected-const-thunks.ts)
  intentionally does not compile.

## Options

1. **`const` object with association thunks (candidate A).**
   `const User = schema("users", { id, posts: hasMany(() => Post) })`. Closest to how
   other TypeScript ORMs look. Fails on any circular association with **TS7022**: the
   constant "implicitly has type 'any' because it … is referenced directly or indirectly
   in its own initializer". The thunk does not help, because inferring the type of the
   initialiser needs the thunk's return type.
2. **Class with association thunks inside the `extends` expression (candidate C).**
   `class User extends Schema("users", { id, posts: hasMany(() => Post) }) {}`. Fails with
   **TS2506**: the class "is referenced directly or indirectly in its own base expression".
3. **Class mixin for fields, `static` members for associations (accepted).**
   `class User extends Schema("users", { id, name }) { static posts = hasMany(() => Post) }`.
   The base expression mentions only fields, so it is never circular; static initialisers
   are resolved lazily by the checker, so mutually recursive classes type-check. The spike
   also shows that preload typing (`Loaded<S, K>`), named query bindings, `joinAssoc`
   target inference and `select` inference all work from this shape.

## Decision

Schemas are classes built with `class User extends Schema("users", { ...fields }) {}`.
Fields go in the object passed to `Schema`; associations are `static` members holding
thunks (`static posts = hasMany(() => Post)`). Rows are instances of the schema class (D2).

## Consequences

- Row types have names (`User`), and users can add getters and methods to them.
- Fields and associations are declared in two places. In particular `belongsTo` cannot
  define its foreign-key field; the field is declared in the fields object (D5).
- `isolatedDeclarations` cannot be enabled for code that declares schemas: an `extends`
  clause containing a call is error TS9021 and an un-annotated static is TS9012 (16 errors
  on the spike file). It is therefore off in `tsconfig.base.json`.
- CI keeps the evidence honest. `pnpm typecheck` type-checks the accepted spike
  (`tsconfig.spikes.json`) and runs `scripts/check-rejected-spike.mjs`, which fails if the
  rejected file ever starts compiling or stops reporting TS7022 and TS2506. If a future
  TypeScript accepts candidate A or C, that check fails and this ADR should be revisited.
