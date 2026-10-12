# Step 17 — SQLite and MySQL (tier 2)

**Depends on:** 12–16. **Parallel with:** 18.
**Owns:** `packages/sqlite/`, `packages/mysql/`, per-dialect expected output in the
compiler snapshot matrices, `docs/site/guide/adapters.md` (dialect sections),
`docs/site/reference/dialect-support.md`.

The two dialects are independent; they can be two workers and two PRs.

## Goal

Run the same schemas, changesets, queries and Repo API on SQLite and MySQL through
Kysely's dialects, with every gap either bridged or reported by a clear error, and a
published support matrix.

## Public API

```ts
import { sqlite } from "@ectype/sqlite";     // peer: better-sqlite3
const adapter = sqlite({ filename: ":memory:", pragmas: { journal_mode: "WAL", foreign_keys: "ON" } });

import { mysql } from "@ectype/mysql";       // peer: mysql2
const adapter = mysql({ uri: process.env.DATABASE_URL, pool: { max: 10 }, timezone: "Z" });
```

## Work per dialect

1. **Adapter wiring** on `kysely-adapter.ts` (step 11): dialect, capabilities, lock modes,
   identifier quoting, parameter limit (SQLite 32,766; MySQL 65,535).
2. **Capabilities table.** Fill in honestly; every `false` gets a compile-time `QueryError`
   test. Expected starting point:

   | Capability | SQLite | MySQL 8 |
   |---|---|---|
   | `RETURNING` | yes (3.35+) | **no** → read-back path (step 13 item 7) |
   | `ON CONFLICT` | yes | `ON DUPLICATE KEY UPDATE` (no conflict target; `conflictTarget` throws) |
   | `ILIKE` | lowered to `LIKE` (case-insensitive for ASCII; documented) | lowered to `LIKE` with collation note |
   | Array columns and operators | no → `QueryError`; suggest json | no |
   | `jsonb` | JSON text functions | native JSON |
   | Lateral join | no | yes (8.0.14+) |
   | Full join | yes (3.39+) | no |
   | `DISTINCT ON` | no | no |
   | Lock clauses | none (ignored with a one-time warning, or error — choose, document) | `FOR UPDATE`/`FOR SHARE` (+ `SKIP LOCKED`, `NOWAIT`) |
   | Savepoints | yes | yes |
   | DDL in transactions | yes | **no** (implicit commit; matters to step 18) |
   | Array params (`= ANY`) | no → `IN` expansion | no → `IN` expansion |
   | Server cursors / stream | iterate statement | streaming result set |
   | Isolation levels | n/a (serialised writer) | yes |

3. **Type overrides.** SQLite: boolean ↔ 0/1; dates/datetimes ↔ ISO-8601 text (UTC);
   json ↔ text; bigint ↔ integer (use `safeIntegers` path for `t.bigint()`); uuid ↔ text;
   decimal ↔ text. MySQL: boolean ↔ tinyint(1); datetime with forced UTC session time
   zone; json parsed by driver; bigint and decimal as strings → codecs; uuid ↔ char(36)
   (binary(16) as an option); binary ↔ Buffer.
4. **Error normalisation.** SQLite extended result codes (`SQLITE_CONSTRAINT_UNIQUE`,
   `_FOREIGNKEY`, `_CHECK`, `_NOTNULL`, `SQLITE_BUSY` → retryable). SQLite reports unique
   violations by **column list, not index name**: synthesise the conventional constraint
   name (`<table>_<cols>_index`) so default `uniqueConstraint("email")` matching works, and
   document the limitation for custom-named indexes. MySQL `ER_DUP_ENTRY` (parse the key
   name from the message), `ER_NO_REFERENCED_ROW_2`, `ER_ROW_IS_REFERENCED_2`,
   `ER_CHECK_CONSTRAINT_VIOLATED`, `ER_LOCK_DEADLOCK` → retryable.
5. **Compiler expected output.** Add the dialect column to every SQL snapshot matrix from
   steps 09 and 10. Where lowering needs a dialect branch (list expansion, `ILIKE`,
   json path syntax, `push`/`pull` unsupported, boolean literals), implement it in the
   lowering layer behind capabilities, not with `if (dialect === ...)` scattered through builders.
6. **Plan cache keys** include list lengths on these dialects (step 10); add a test that
   lists of different lengths do not share a plan and lists of equal length do.
7. **Fixtures.** Port `fixtures/blog.sql` per dialect (uuid default, arrays replaced by
   json, serials). Keep the logical schema identical so the conformance suites run unchanged.
8. **Run all conformance suites** (adapter, read, write, preload, nested, transaction)
   against the dialect. Tests for unsupported capabilities are skipped **by capability
   flag**, never by dialect name, and each skip is listed in the support matrix.
9. **SQLite specifics.** `better-sqlite3` is synchronous: keep the `Promise` API, and
   confirm transactions cannot interleave (single connection; serialise). Provide
   `sqlite({ filename: ":memory:" })` as the documented fastest way to run a test suite
   and add it as a second target for core's own unit-level integration tests if it speeds CI.
10. **CI.** Add jobs: SQLite (no service), MySQL 8 (service). Tier-2 jobs are required checks.

## Tests

- All conformance suites per dialect, with the skip list asserted against the capabilities table (a test fails if a skipped capability is actually `true`).
- Dialect-specific: type round trips at boundaries (MySQL datetime precision, SQLite
  integer range, time zones), error normalisation from real violations, read-back insert
  path on MySQL including composite keys and client-generated uuid keys, `IN` expansion at
  the parameter limit (chunking), `ON DUPLICATE KEY` forms.
- Benchmarks: the e2e read/write benchmarks per dialect versus the raw driver; record, no gating for tier 2.

## Docs

`reference/dialect-support.md`: the full feature × dialect matrix generated from the
capabilities tables (a script, so it cannot drift), with notes per gap and the workaround.
Dialect sections in `adapters.md`: install, options, type mapping table, caveats.

## Acceptance

- [ ] Conformance suites green on SQLite and MySQL 8, with skips equal to the documented gaps.
- [ ] Every unsupported feature throws `QueryError` naming feature and dialect at compile time (tested), never a database syntax error.
- [ ] Support matrix generated and published; CI jobs added and required.
- [ ] No dialect-name conditionals outside `adapter/`, `compiler/` and the dialect packages (lint rule or grep test).

## Out of scope

MSSQL, CockroachDB, PlanetScale/serverless drivers (note as future work; the
`fromKyselyDialect` escape hatch covers adventurous users).
