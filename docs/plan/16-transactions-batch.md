# Step 16 — Transactions, Batch (formerly Multi), and the test sandbox

**Depends on:** 13. **Parallel with:** 14, 15.
**Owns:** `packages/core/src/repo/transaction.ts`, `packages/core/src/batch/`,
`packages/core/src/repo/sandbox.ts`, `packages/core/test/conformance/transaction/`,
`docs/site/guide/transactions.md`, `docs/site/guide/batch.md`, `docs/site/guide/testing.md`.

## Goal

Explicit transactions with savepoint nesting, `Batch` for composing atomic pipelines as
data, and a sandbox that makes integration tests fast and isolated.

## Public API

```ts
// Transactions
const out = await repo.transaction(async (tx) => {       // tx: Repo, bound to one connection
  const user = await tx.insertOrThrow(User.changeset(User, input));
  await tx.insertOrThrow(change(Profile, { userId: user.id }));
  if (bad) tx.rollback("reason");                        // throws a private signal; never returns
  return user;
}, { isolation: "serializable", readOnly: false, retries: 0, timeoutMs: undefined });
// -> Result<User, unknown>: { success: true, data } | { success: false, error: rollbackReason }

repo.transactionOrThrow(fn, opts)       // returns value; rollback(reason) throws RollbackError(reason)
tx.inTransaction                        // boolean (false on the root repo)
repo.checkout(async (r) => { ... })     // one connection, no transaction (Ecto checkout/2)

// Batch
const batch = createBatch()
  .insert("user", User.changeset(User, input))
  .insert("profile", ({ user }) => change(Profile, { userId: user.id }))
  .updateAll("bump", ({ user }) => from(Org, "o").where(...).set(...))
  .run("welcome", async (tx, { user }) => success(await sendWelcome(user)))     // must return Result: success(data) | failure(error)
  .merge(({ user }) => auditBatch(user));

const res = await repo.transaction(batch);   // repo.transaction takes a callback OR a batch; there is no repo.transact
// { success: true,  data: { user: User, profile: Profile, bump: { count: number, rows: null }, welcome: ... } }
// { success: false, error: { step: "profile", error: Changeset<Profile>, completed: { user: User } } }
```

Batch operations: `insert`, `update`, `delete`, `insertOrUpdate`, `insertAll`, `updateAll`,
`deleteAll`, `one`, `all`, `exists`, `run`, `put(name, value)`, `inspect(name?, fn)`,
`merge(fn)`, `append(batch)`, `prepend(batch)`, `Batch.toList(batch)`. A batch is created with
`createBatch()` (there is no `Batch.new()`).

```ts
// Sandbox (import from "egon-orm/testing")
const sandbox = await createSandbox(repo);
beforeEach(() => sandbox.begin());      // returns a Repo; also swaps `repo`'s executor so app code using `repo` is sandboxed
afterEach(() => sandbox.rollback());
```

## Behaviour

### Transactions

1. `repo.transaction(fn)` acquires one connection, `BEGIN`s with the options, and calls
   `fn(tx)` where `tx` implements `Repo` with every operation pinned to that connection.
   Resolve → `COMMIT` → `success(value)`. `tx.rollback(reason)` → `ROLLBACK` → `failure(reason)`.
   Any other throw → `ROLLBACK` → rethrow the original error (if `ROLLBACK` itself fails,
   attach that failure as `suppressed` and destroy the connection).
2. **Nesting.** `tx.transaction(fn)` uses a savepoint (`SAVEPOINT egon_<depth>`):
   success releases it; rollback/throw rolls back to it, leaving the outer transaction
   usable. Isolation/readOnly options on a nested call throw.
3. **No ambient context.** Using the root `repo` inside the callback runs on a *different*
   connection, outside the transaction. This is the main foot-gun of explicit
   transactions: state it prominently in the docs, and provide a development-mode warning
   (`createRepo({ warnOnRootUseInTransaction: true })`). It is implemented with
   `AsyncLocalStorage` and exists **only in development** (never installed when
   `NODE_ENV` is `production`): a depth counter cannot tell one request's transaction
   from another's and would warn falsely on any concurrent server. The store is used for
   this warning only; it never propagates a transaction (plan README §1 non-goal stands).
4. **Concurrency inside a transaction.** A connection runs one statement at a time.
   Queries issued concurrently on `tx` are serialised through an internal queue (never interleaved protocol errors).
5. **Use after completion.** Any call on `tx` after its transaction ended throws
   `QueryError("transaction already completed")` (catches leaked promises).
6. **Retries.** `retries: n` re-runs `fn` on `DatabaseError.retryable`
   (serialization failure, deadlock) with jittered backoff; `fn` must be idempotent (documented).
7. **Timeout.** `timeoutMs` aborts the in-flight statement and rolls back.
8. **Streams** require a transaction on Postgres; `repo.stream` outside one opens its own.
9. Steps 13 (bulk chunking) and 15 (nested writes) switch to this primitive.

### Batch

1. A `Batch` is an immutable value: a list of named operations. Names are unique
   (duplicate → throw at build time). Its **type accumulates** the name → result map, so
   function-form operations receive correctly typed prior results and the final `data` value is fully typed.
2. `repo.transaction(batch)` runs operations in order inside one transaction. Before opening
   the transaction, operations given as **static changesets** are checked; if any is
   invalid the result is a failure immediately with no database round trip (as Ecto).
3. First failure rolls back and returns
   `failure({ step, error, completed })` with `step` the failed operation's name and
   `completed` holding everything that finished before it.
   `run` callbacks signal failure by returning `failure(x)`; a throw propagates as a throw after rollback.
4. `merge` evaluates lazily at that point in the sequence and splices the produced batch.
5. Works on `tx` too (nested → savepoint).

### Sandbox

1. `sandbox.begin()` checks out one connection, opens a transaction, and routes **all**
   operations of the wrapped repo through it; `repo.transaction` inside becomes a savepoint.
   `sandbox.rollback()` rolls everything back and restores the repo. Nothing is ever committed.
2. Because Vitest runs test files in separate workers, each file gets its own sandbox and
   connection: tests are isolated and parallel across files. Within one file, tests are
   serial. Document the limitation that code holding its own
   pool bypasses the sandbox. (There is no `mode: "shared"`.)
3. Replace step 01's truncate helper in the test support with the sandbox; measure and
   record the suite speed-up.
4. Ship helpers in `egon-orm/testing`: `createSandbox`, `expectQueries(repo, fn)` (returns
   the telemetry events emitted during `fn`; used for N+1 assertions), `factory` helper is out of scope.

## Conformance suite (`conformance/transaction`)

Commit, explicit rollback, throw rollback; nested savepoints three deep with inner
rollback preserving outer work; isolation levels (a serialisation failure reproduced with
two connections, then retried successfully); use-after-completion; concurrent calls on
`tx`; connection returned to pool in every outcome (pool stats asserted); Batch success,
each failure mode, pre-validation short circuit (zero queries), merge; sandbox isolation
across two files writing the same unique email.

## Tests

- Unit (fake adapter recording statements): exact statement sequences for every path,
  including failures of `COMMIT` and `ROLLBACK`.
- Type tests: `transaction` result types; Batch accumulation across 5 heterogeneous
  operations; duplicate-name rejection where expressible at type level; the failure shape as a
  discriminated union over step names.
- Integration: the conformance suite on Postgres.
- Benchmarks: empty transaction overhead vs raw `BEGIN`/`COMMIT`; Batch with 3 inserts vs hand-written.

## Docs

`transactions.md` (API, nesting, the explicit-`tx` rule with a wrong/right example, retries,
isolation), `batch.md` (why, each operation, error handling by `switch` on `step`,
composition), `testing.md` (sandbox setup for Vitest and Jest, query-count assertions,
running against Docker).

## Acceptance

- [ ] Statement sequences verified for all paths; no connection leak in any outcome.
- [ ] Batch's result and error types are fully inferred (no annotations in the tests).
- [ ] Sandbox adopted by the core integration suites; before/after timings in the status note.
- [ ] Conformance suite green on Postgres.

## Out of scope

Implicit transaction propagation. Distributed transactions. Test data factories.

## Carried over from steps 01 and 02

Requests that the (now removed) status notes of steps 01 and 02 addressed to this step.

- `RollbackError` is not defined yet. `errors.ts` is this step's to extend; add its code to `ErrorCode`.
