# Step 11 — Adapter and the Postgres package

**Depends on:** 02. **Parallel with:** 03–10.
**Owns:** `packages/core/src/adapter/`, `packages/postgres/`,
`packages/core/test/conformance/adapter/`, `docs/site/guide/getting-started.md` (connection part),
`docs/site/guide/adapters.md`.

Read ADR 0002 first; this spec assumes Kysely is the back end (D12).

## Goal

Implement the `Adapter` contract on top of Kysely's dialect/driver layer, and ship
`@egon-orm/postgres`: connection pooling, execution, streaming, transactions primitives,
type overrides, error normalisation, telemetry.

## Public API

```ts
import { postgres } from "@egon-orm/postgres";

const adapter = postgres({
  connectionString: process.env.DATABASE_URL,     // or host/port/user/password/database/ssl
  pool: { max: 10, idleTimeoutMs: 30_000, connectionTimeoutMs: 5_000 },
  // or bring your own: pool: existingPgPool
  planCacheSize: 1000,                            // the plan cache lives in the adapter
  statementTimeoutMs: undefined,
  applicationName: "my-app",
});

// There is no `types` option: the schema field decides the runtime type (t.bigint() vs
// t.bigint({ mode: "number" })). `fromKyselyDialect` is future work (plan README §11):
// Kysely does not appear in the public API, and there is no "egon-orm/adapter" entry point.
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
   `commit`, `rollback`, `savepoint(name)`, `rollbackTo(name)`, `releaseSavepoint(name)`, `release()`,
   `destroy()`. `execute` options also carry `slots`, `context` and `statementName` (`contracts/adapter.ts`).
   `begin` options: `isolation` (`"read committed" | "repeatable read" | "serializable"`),
   `readOnly`, `deferrable`. A connection that errors fatally (socket closed, protocol
   error) is destroyed, not returned to the pool.
3. **`execute` without a connection** checks one out, runs, and releases in `finally`.
4. **Streaming.** `stream(sql, params, { batchSize })` yields rows using a server-side
   cursor (`pg-cursor` through Kysely's stream support or directly). Early `break`/`return`
   closes the cursor and releases the connection; tested.
5. **Type overrides (Postgres).** Supply codecs for logical types where `pg` does not
   already return the app representation: `bigint` (int8 text → `bigint`, or → `number` for
   `t.bigint({ mode: "number" })`, throwing `CastError` beyond the safe range), `decimal` (stays string), `date` (stay string; disable `pg`'s Date parsing
   for OID 1082 on **our pool only**, never by mutating global `pg.types`), `time`,
   `binary` (Buffer → Uint8Array view), arrays of these. Everything else `IDENTITY`.
   There is no `id` type: an `int4` key is `t.integer()`, a `bigserial` key is
   `t.bigint({ mode: "number" })`.
6. **Error normalisation.** Map SQLSTATE to errors from `core/errors.ts`:
   `23505` unique, `23503` foreign key, `23514` check, `23P01` exclusion, `23502` not-null →
   `ConstraintError { type, constraint, table, column, detail }`; `40001`/`40P01` →
   `DatabaseError` with `retryable: true` and `code: "serializationFailure" | "deadlock"`;
   connection failures → `DatabaseError` with `code: "connection"`. Always keep the driver
   error as `cause`, and attach the SQL (never the params, unless the repo has `log: { params: true }`).
7. **Capabilities (Postgres):** everything true; lock modes listed; `ddlTransactions: true`.
8. **Telemetry.** Adapter emits events through a tiny synchronous emitter (no
   EventEmitter overhead when there are no listeners; check a boolean first):
   `query` `{ sql, paramCount, durationMs, queueMs, rowCount, error, params, context }` (no
   `source`: the repo adds it, using the `context` it passed to `execute`),
   `connect`, `disconnect`, `poolExhausted`. Step 12 exposes `repo.on(event, fn)` for all four events and a
   `log: true | LoggerFn | { params: true }` option. Parameters are included only with
   `log: { params: true }` (there is no separate `logParams` or `debug` switch), and
   redacted fields are never logged.
9. **Timeouts and cancellation.** `execute(..., { signal?: AbortSignal, timeoutMs? })`:
   abort issues a Postgres cancel request and rejects with `DatabaseError { code: "aborted" }`.
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
cancellation, bring-your-own pool).

## Acceptance

- [ ] `Adapter` contract fully implemented with no Kysely types in its public signatures.
- [ ] Conformance suite passes on Postgres 14 and 16.
- [ ] Execution overhead target met; numbers in the status note.
- [ ] Every normalised error keeps `cause` and carries constraint name/table where the driver provides them.
- [ ] No leaked connections: after the whole integration suite, pool reports zero checked out (asserted in a global teardown).

## Out of scope

Repo API, hydration (12). Transactions API and sandbox (16). Other dialects (17). DDL (18).

## Carried over from steps 01 and 02

Requests that the (now removed) status notes of steps 01 and 02 addressed to this step.

- In the contract already: `Executor` / `Connection` (with `destroy`), `typeOverrides`, `on(event)`, `ExecuteOptions.slots` / `context` / `statementName`, `RawResult.insertId`, the `DatabaseError` codes and the `ConstraintError` fields.
- Not in the contract: `ping()` and pool statistics. Add them to the concrete adapter.
- The spike did not exercise streaming or cancellation through Kysely's Postgres driver (streaming needs `pg-cursor`).
- `@egon-orm/postgres` builds ESM only.
