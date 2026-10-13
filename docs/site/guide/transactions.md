# Transactions

```ts
const result = await repo.transaction(async (tx) => {
  const user = await tx.insertOrThrow(User.changeset(User, input));
  await tx.insertOrThrow(change(Profile, { userId: user.id }));
  return user;
});

if (result.success) result.data; // User
```

`repo.transaction(fn, opts?)` takes one connection, begins a transaction, and calls `fn`
with `tx`, a repo bound to that connection. `tx` has every repo method.

| What happens in `fn` | Outcome | `repo.transaction` returns |
|---|---|---|
| It returns a value | `COMMIT` | `{ success: true, data: value }` |
| It calls `tx.rollback(reason)` | `ROLLBACK` | `{ success: false, error: reason }` |
| It throws | `ROLLBACK` | the error is rethrown |

`tx.rollback(reason)` stops the callback; nothing after it runs.

`repo.transactionOrThrow(fn, opts?)` returns the value directly, and a rollback throws
`RollbackError` carrying the reason.

## The explicit rule

**Only calls on `tx` are inside the transaction.** The outer `repo` uses a different
connection:

```ts
await repo.transaction(async (tx) => {
  await tx.insertOrThrow(a);     // inside
  await repo.insertOrThrow(b);   // NOT inside: committed even if the transaction rolls back
});
```

Pass `tx` to the functions you call, in place of the repo. Because `tx` is a repo, code
that takes a repo argument works either way.

In development, `createRepo({ warnOnRootUseInTransaction: true })` logs a warning when the
outer repo is used inside a transaction callback. It has no effect in production.

## Use the throwing methods

Inside a transaction, prefer `insertOrThrow` and its siblings. A failed
[result](/guide/repo#writing) that nobody checks does not roll anything back, and the
transaction would commit the rest. A throw rolls back by itself.

When you do want to handle a failure, roll back explicitly:

```ts
const result = await repo.transaction(async (tx) => {
  const created = await tx.insert(User.changeset(User, input));
  if (!created.success) tx.rollback(created.error);
  return created.data;
});
```

## Options

| Option | Effect |
|---|---|
| `isolation` | `"read committed"`, `"repeatable read"` or `"serializable"`. |
| `readOnly` | Begins a read-only transaction. |
| `retries` | Runs `fn` again, up to this many times, after a serialisation failure or a deadlock. `fn` must be safe to repeat. |
| `timeoutMs` | Cancels the running statement and rolls back. |

## Nesting

`tx.transaction(fn)` inside a transaction uses a savepoint. If the inner callback rolls
back or throws, only its work is undone and the outer transaction continues.

```ts
await repo.transaction(async (tx) => {
  await tx.insertOrThrow(order);
  const gift = await tx.transaction(async (inner) => inner.insertOrThrow(giftNote));
  // if the gift note failed, the order is still there
});
```

`isolation` and `readOnly` cannot be set on a nested transaction.

## Things to know

- **One statement at a time.** A connection cannot run two queries at once. Queries issued
  together on `tx`, for example with `Promise.all`, are queued and run in order.
- **`tx` ends with its callback.** Using it afterwards throws `QueryError`. This catches
  promises that escaped the callback.
- **`tx.inTransaction`** is `true`; on the outer repo it is `false`.
- **Writes that span several statements** (nested changesets, large `insertAll`) open a
  transaction themselves, or join the current one.

## A connection without a transaction

`repo.checkout(fn)` gives `fn` a repo bound to one connection, with no transaction. Use it
for session settings or advisory locks that must run on the same connection as the
queries that follow.

```ts
await repo.checkout(async (r) => {
  await r.raw(fragment`set local statement_timeout = ${5000}`);
  return r.all(slowQuery);
});
```

## See also

- [Batch](/guide/batch) builds a transaction as a list of named steps.
- [Testing](/guide/testing) runs each test in a transaction that is rolled back.
