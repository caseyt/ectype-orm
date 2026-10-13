# Batch

A batch is a list of named steps that run in one transaction. It is a value: you can
build it in one place, add to it in another, inspect it in a test, and run it later.

```ts
import { createBatch, change, success } from "egon-orm";

const signUp = createBatch()
  .insert("user", User.changeset(User, input))
  .insert("profile", ({ user }) => change(Profile, { userId: user.id }))
  .run("welcome", async (tx, { user }) => success(await queueWelcomeEmail(tx, user)));

const result = await repo.transaction(signUp);

if (result.success) {
  result.data.user;      // User
  result.data.profile;   // Profile
} else {
  result.error.step;       // "user" | "profile" | "welcome"
  result.error.error;      // what that step failed with
  result.error.completed;  // the results of the steps before it
}
```

## Steps

Each step has a unique name. A step is given either a value, or a function that receives
the results of the earlier steps by name, fully typed.

| Step | Result under its name |
|---|---|
| `insert`, `update`, `delete`, `insertOrUpdate` | the row |
| `insertAll`, `updateAll`, `deleteAll` | `{ count, rows }` |
| `one`, `all`, `exists` | the query's result |
| `run(name, fn)` | whatever `fn` returns inside `success(...)` |
| `put(name, value)` | the value |
| `inspect(name?, fn)` | nothing; calls `fn` with the results so far |

`run(name, async (tx, results) => ...)` is for anything else. It must return
`success(data)` or `failure(error)`. Use the `tx` it is given for database work.

## Composing

| Method | Effect |
|---|---|
| `merge((results) => batch)` | Builds more steps from the results so far, at that point in the sequence. |
| `append(batch)`, `prepend(batch)` | Joins two batches. |
| `Batch.toList(batch)` | The steps as data, for tests. |

A batch is immutable: every method returns a new one. A duplicate step name throws when
the batch is built.

```ts
const audit = (action: string) => (results: { user: User }) =>
  createBatch().insert("audit", change(AuditLog, { userId: results.user.id, action }));

const withAudit = signUp.merge(audit("signed_up"));
```

## Running

`repo.transaction(batch)` runs the steps in order.

- **Checked first.** Steps given a ready-made changeset are checked before the
  transaction opens. If one is invalid, the batch fails at once with no queries.
- **The first failure stops it.** Everything is rolled back, and the result names the
  step, its error, and what had completed.
- **A throw is a throw.** If a step throws, the transaction is rolled back and the error
  propagates.
- **Inside a transaction** (`tx.transaction(batch)`) the batch runs in a savepoint.

## Handling a failure

`step` is typed as the union of the step names, so a `switch` narrows `error`:

```ts
if (!result.success) {
  switch (result.error.step) {
    case "user":
      return result.error.error.errorMessages();   // Changeset<User>
    case "profile":
      return result.error.error.errorMessages();   // Changeset<Profile>
    case "welcome":
      return { email: ["could not be queued"] };
  }
}
```

## Batch or transaction callback?

- Use a **transaction callback** for a one-off sequence with ordinary control flow.
- Use a **batch** when the steps are assembled from parts, reused, or when you want to
  know exactly which step failed without `try`/`catch` around each one.
