# Step 11 — Adapter and the Postgres package

**Depends on:** 02. **Parallel with:** 03–10.
**Owns:** `packages/core/src/adapter/`, `packages/postgres/`,
`packages/core/test/conformance/adapter/`, `docs/site/guide/getting-started.md` (connection part),
`docs/site/guide/adapters.md`.

Read ADR 0002 first; this spec assumes Kysely is the back end (D12).

## Goal

Implement the `Adapter` contract on top of Kysely's dialect/driver layer, and ship
`@ectype/postgres`: connection pooling, execution, streaming, transactions primitives,
type overrides, error normalisation, telemetry.

## Public API

```ts
import { postgres } from "@ectype/postgres";

const adapter = postgres({
  connectionString: process.env.DATABASE_URL,     // or host/port/user/password/database/ssl
  pool: { max: 10, idleTimeoutMs: 30_000, connectionTimeoutMs: 5_000 },
  // or bring your own: pool: existingPgPool
  types: { bigint: "bigint" | "number" | "string", numeric: "string", date: "string" },
  statementTimeoutMs: undefined,
  applicationName: "my-app",
});

// Escape hatch for any Kysely dialect (documented as advanced):
import { fromKyselyDialect } from "ectype/adapter";
```

`createRepo({ adapter, ... })` is step 12; this step delivers everything beneath it.

## Behaviour

1. **Core adapter (`core/src/adapter/kysely-adapter.ts`).** A generic implementation
   parameterised by: a Kysely `Dialect`, a `Capabilities` table, type overrides, an error
   normaliser, and lock-mode/identifier specifics. It owns the driver lifecycle
   (`init`, `acquireConnection`, `releaseConnection`, `destroy`), calls the dialect's query
   compiler for step 10, and executes `{ sql, params }` through the driver connection
   without constructing Kysely builders. Lazy init on first use; `close()` is idempotent
   and waits for checked-out connections.
2. **Connections.** `acquire()` returns a `Connection` with `execute`, `stream`, `begin(opts)`,
   `commit`, `rollback`, `savepoint(name)`, `rollbackTo(name)`, `releaseSavepoint(name)`, `release()`.
   `begin` options: `isolation` (`"read committed" | "repeatable read" | "serializable"`),
   `readOnly`, `deferrable`. A connection that errors fatally (socket closed, protocol
   error) is destroyed, not returned to the pool.
3. **`execute` without a connection** checks one out, runs, and releases in `finally`.
4. **Streaming.** `stream(sql, params, { batchSize })` yields rows using a server-side
   cursor (`pg-cursor` through Kysely's stream support or directly). Early `break`/`return`
   closes the cursor and releases the connection; tested.
5. **Type overrides (Postgres).** Supply codecs for logical types where `pg` does not
   already return the app representation: `bigint` (int8 text → `bigint`; default
   `"bigint"`), `decimal` (stays string), `date` (stay string; disable `pg`'s Date parsing
   for OID 1082 on **our pool only**, never by mutating global `pg.types`), `time`,
   `binary` (Buffer → Uint8Array view), arrays of these. Everything else `IDENTITY`.
   `types.id()` columns (bigserial) load as `number` when within safe range; values beyond
   it throw `CastError` suggesting `t.bigint()`.
6. **Error normalisation.** Map SQLSTATE to errors from `core/errors.ts`:
   `23505` unique, `23503` foreign key, `23514` check, `23P01` exclusion, `23502` not-null →
   `ConstraintError { type, constraint, table, column, detail }`; `40001`/`40P01` →
   `AdapterError` with `retryable: true` and `code: "serialization_failure" | "deadlock"`;
   connection failures → `AdapterError` with `code: "connection"`. Always keep the driver
   error as `cause`, and attach the SQL (never the params, unless `debug: true`).
7. **Capabilities (Postgres):** everything true; lock modes listed; `ddlTransactions: true`.
8. **Telemetry.** Adapter emits events through a tiny synchronous emitter (no
   EventEmitter overhead when there are no listeners; check a boolean first):
   `query` `{ sql, paramCount, durationMs, queueMs, rowCount, source?, error? }`,
   `connect`, `disconnect`, `poolExhausted`. Step 12 exposes `repo.on("query", fn)` and a
   `log: true | LoggerFn` option. Parameters are included only when `logParams: true`, and
   redacted fields are never logged.
9. **Timeouts and cancellation.** `execute(..., { signal?: AbortSignal, timeoutMs? })`:
   abort issues a Postgres cancel request and rejects with `AdapterError { code: "aborted" }`.
10. **Health.** `adapter.ping()`; pool stats (`size`, `idle`, `waiting`).
11. **Driver choice.** Use `pg` (peer dependency) via Kysely's `PostgresDialect`. Check
    whether a maintained postgres.js dialect is viable and, if so, expose
    `postgres({ driver: "postgres.js" })` behind the same options; otherwise note it as future work.

## Adapter conformance suite

`packages/core/test/conformance/adapter/` exports `runAdapterConformance(makeAdapter)`:
connect/close; parameter round trip for every logical type including nulls, arrays, large
ints, unicode, binary, dates at DST boundaries and year 1/9999; error normalisation for
each constraint type; transaction commit/rollback/savepoints; isolation options;
concurrent queries up to pool size and beyond (queueing); stream with early exit; abort;
fatal connection eviction (terminate a backend with `pg_terminate_backend`). The Postgres
package runs it; step 17 runs it for SQLite and MySQL.

## Tests

- Unit: capabilities table; error mapping from fabricated driver errors; telemetry
  emits/does not emit; option validation.
- Integration: the conformance suite; pool exhaustion and timeout; `close()` during
  in-flight queries; no global `pg.types` mutation (assert another raw `pg` client in the
  same process still parses dates the default way).
- Benchmarks: `adapter.execute("select 1")` versus raw `pg` (overhead target < 5%);
  1,000-row select versus raw `pg`; telemetry on vs off.

## Docs

`getting-started.md` (install, connect, first query — shared with step 12), `adapters.md`
(options, pooling, bigint/numeric/date handling and why, errors, telemetry and logging,
cancellation, bring-your-own pool, using another Kysely dialect).

## Acceptance

- [ ] `Adapter` contract fully implemented with no Kysely types in its public signatures.
- [ ] Conformance suite passes on Postgres 14 and 16.
- [ ] Execution overhead target met; numbers in the status note.
- [ ] Every normalised error keeps `cause` and carries constraint name/table where the driver provides them.
- [ ] No leaked connections: after the whole integration suite, pool reports zero checked out (asserted in a global teardown).

## Out of scope

Repo API, hydration (12). Transactions API and sandbox (16). Other dialects (17). DDL (18).
