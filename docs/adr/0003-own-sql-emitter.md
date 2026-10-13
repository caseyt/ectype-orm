# 0003 — Our own SQL emitter and drivers; Kysely is removed

- **Status:** accepted (2026-10-13, by the owner)
- **Date:** 2026-10-13
- **Step:** none (a review of ADR 0002 before steps 10 and 11 start)
- **Affects:** decision D12 and the rationale of D14 (plan README §2); steps 01, 09, 10,
  11, 17, 18, 19 and 21; `packages/core/package.json`. Supersedes
  [0002](0002-kysely-backend.md).

## Context

ADR 0002 accepted Kysely as the hidden SQL back end, "with raw-node escapes". Its spike
showed that the technique works and that its run-time cost is negligible. Neither finding
is disputed here. What was not weighed was how much the dependency saves against what it
costs to carry, and that is decided now because steps 10 and 11 have not started: nothing
outside the spike imports Kysely yet.

**What Kysely would save.** Measured in the installed `kysely@0.29.6` (`dist/`, lines of
built JavaScript):

| Part | Lines |
|---|---|
| `default-query-compiler.js`: every statement kind, DDL included | 1,452 |
| Postgres, MySQL and SQLite query compilers (subclasses of the above) | 8, 77, 38 |
| Postgres, MySQL and SQLite drivers | 198, 252, 84 |

The dialect compilers are small because they change quoting, placeholders and a few
keywords. They do not translate one dialect's semantics into another's: capability
checks, list expansion, lock tables and the other dialect branches were already the work
of step 10's lowering (step 17, item 5).

**What we would write anyway.** Step 10 needed one lowering function per AST node kind
that builds Kysely nodes. An emitter is one function per AST node kind that appends text
instead. The spike's lowering is 428 lines for a subset of the node kinds.

**What Kysely costs.**

- The plan used it against the grain: its node factories and the compiler's pass-through
  of `ValueNode.value`, which are exported but not documented as API (ADR 0002, "Other
  facts"). It is pre-1.0 and was pinned to one minor.
- Nine constructs needed a raw node or a rewrite; named windows had to be expanded at
  each use.
- The injection rule (decision D9) depended on knowing which Kysely node fields are
  appended unquoted.
- Two trees for every query: ours and Kysely's.
- Byte-identical SQL (step 10, "Determinism") and every SQL snapshot depended on another
  project's formatting.
- It was the stated reason for the Node floor and the ESM-only build (D14).

## Options

1. **Keep Kysely** (ADR 0002). Works; carries the costs above for a saving of about the
   size of the table above.
2. **Knex.** It has no node layer, so every query would go through its fluent builder; it
   is a CommonJS package with its own pool and weaker types. Worse than option 1 on every
   point that matters here.
3. **Our own emitter and drivers.** One SQL emitter in core with a dialect table, and one
   thin driver wrapper per dialect package over `pg`, `mysql2` and `better-sqlite3`.
   Estimated at 1,500 to 2,000 lines over the three dialects (an estimate from the table
   above, not a measurement).

## Decision

**Option 3.** Egon emits its own SQL and talks to the database drivers directly. Kysely is
not a dependency of any published package.

The rules (they replace the five rules of ADR 0002):

1. **Raw SQL text has three sources and no others:**
   1. the emitter's own code and tables (keywords, operators, function names, lock and
      join keywords, sort directions);
   2. the static strings of a `fragment` template, which are program text;
   3. the `sql` of a `custom` `DbType` (`{ kind: "custom", sql }`), used as a type name in
      `CAST` and in DDL. This is **trusted input**: it is written by the developer who
      defines the type and must never be derived from user data. It is a stated exception
      to D9. As a second line of defence the emitter writes it only if it matches
      `CUSTOM_SQL_TYPE` (`packages/core/src/contracts/type.ts`).

   Names that originate outside the emitter (function names, `fragment.ident`) are
   validated against an identifier pattern first.
2. **A value is a placeholder and a slot.** Emitting a `param`, `list` or `namedParam`
   node writes the dialect's placeholder and appends that node's `ParamSlot` to the plan's
   slot list in the same call, so the slot list is in placeholder order by construction.
   There is no other way for the emitter to write a value.
3. **Every identifier is quoted** by the dialect's quote function, which doubles the quote
   character. No identifier is written bare.
4. **Parentheses are the emitter's job**, decided by operator precedence.
5. **One emitter, one dialect table.** A dialect is a plain object (quote character,
   placeholder style, capabilities, lock modes, the few clause variants). There is no
   compiler subclass per dialect, and no dialect-name conditional outside `compiler/`,
   `adapter/` and the dialect packages.
6. **Drivers are wrapped directly** by each dialect package behind the `Adapter`
   contract. Core has no runtime dependency.

## Consequences

- **README D12** is rewritten. **D14** keeps its decision (Node >= 22.12, ESM only); its
  rationale no longer rests on Kysely. Whether to relax D14 is a separate question for
  the owner and is not decided here.
- **`packages/core`** drops the `kysely` dependency.
- **Step 10** emits SQL text (`emit.ts`, `emitNode` registry). Named windows get a real
  `WINDOW` clause; window frames, `VALUES` aliases, `TABLESAMPLE` and the JSON path
  operators are ordinary emitter cases, not escapes.
- **Step 11** wraps `pg` directly: pooling through `pg.Pool`, transactions and savepoints
  as statements, streaming through `pg-cursor`.
- **Step 17** adds the dialect tables and wraps `mysql2` and `better-sqlite3`.
- **Step 18** emits its own DDL through the same dialect tables.
- **Lost:** Kysely's years of fixes to its emitter, and its community dialects (D1,
  libsql, PlanetScale, MSSQL). The first is covered by a rule the plan already had: every
  snapshot query is also executed against a real database. The second means each further
  database needs a small driver wrapper of ours; `fromKyselyDialect` is dropped from the
  future-work list.
- **The spike stays** in `docs/plan/spikes/kysely-bridge/` as the record behind ADR 0002.
  It is a private workspace package with its own `kysely` dependency and is still
  type-checked. Two of its results carry over: the 40 constructs of `05-gaps.ts`, with
  their expected SQL, are a checklist for the emitter, and `04-cost.ts` gives the numbers
  to beat (a hand-written emitter for the reference query: 2.18 µs; a stub driver called
  directly: 122 ns).

### Not verified

- The size estimate for the emitter and the drivers.
- Everything ADR 0002 listed as not verified still is: the `?` dialects executed against
  MySQL and SQLite, streaming, cancellation.

Revisit this decision if the emitter or the drivers grow far beyond the estimate, or if a
database we need has no usable Node driver of its own.
