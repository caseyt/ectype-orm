# Repo: setup, reads, writes

The repo is the only thing that talks to the database. It runs [queries](/guide/queries)
and persists [changesets](/guide/changesets).

## Creating a repo

```ts
import { createRepo } from "egon-orm";
import { postgres } from "@egon-orm/postgres";

export const repo = createRepo({
  adapter: postgres({ connectionString: process.env.DATABASE_URL }),
});
```

A repo is an ordinary value: export it and import it where it is needed. A second database
or a read replica is a second repo.

| Option | Default | Effect |
|---|---|---|
| `adapter` | required | The database connection. See [Adapters](/guide/adapters). |
| `schema` | none | The default database schema (a Postgres schema, a MySQL database). |
| `log` | `false` | `true`, a function receiving each query event, or `{ params: true }` to include parameter values. |
| `codegen` | `true` | `false` avoids `new Function`, for environments with a strict content security policy. Slower. |
| `warnOnRootUseInTransaction` | `false` | Development only. See [Transactions](/guide/transactions#the-explicit-rule). |

```ts
await repo.ping();        // checks the connection
repo.poolStats();         // { size, idle, waiting }
await repo.close();       // waits for running queries, then closes the pool
```

## Reading

A **queryable** is a schema class or a query. `repo.all(User)` returns every user.

| Method | Returns | Notes |
|---|---|---|
| `all(queryable)` | `R[]` | |
| `one(queryable)` | `R \| null` | Throws `MultipleResultsError` if more than one row matches. |
| `oneOrThrow(queryable)` | `R` | Also throws `NoResultsError` if none matches. |
| `first(queryable)` | `R \| null` | Adds `LIMIT 1`. Never throws for extra rows. |
| `get(Schema, id)` | `Row \| null` | By primary key. |
| `getOrThrow(Schema, id)` | `Row` | |
| `getBy(queryable, clauses)` | `Row \| null` | `clauses` is the [object form](/guide/queries#object-form) of `where`. Strict, like `one`. |
| `getByOrThrow(queryable, clauses)` | `Row` | |
| `exists(queryable)` | `boolean` | |
| `count(queryable)` | `number` | |
| `aggregate(queryable, fn, field?)` | `number \| null` | `fn` is `"count"`, `"sum"`, `"avg"`, `"min"` or `"max"`. |
| `stream(queryable)` | `AsyncIterable<R>` | See [Streaming](#streaming). |
| `reload(row)` | `Row \| null` | A fresh copy; `null` if it was deleted. Also takes an array. |
| `reloadOrThrow(row)` | `Row` | |
| `preload(rows, spec)` | loaded rows | See [Preloading](/guide/associations#after-the-fact). |

```ts
const user = await repo.get(User, 1);
const member = await repo.get(Membership, { orgId, userId });     // composite key
const ada = await repo.getBy(User, { email: "ada@example.com" });
const newest = await repo.first(from(Post, "p").orderBy(({ p }) => p.createdAt.desc()));
const total = await repo.count(from(Post, "p").where({ published: true }));
```

- **`one` is strict.** It adds no `LIMIT`. A second row means the query is wrong, and you
  are told. Use `first` when "any one" is what you want.
- **`get` with `null` or `undefined` throws.** That is almost always a missing id.

### Parameters and options

A query with [named parameters](/guide/queries#named-parameters) takes them as the second
argument; options come last. A query without named parameters takes options second.

```ts
await repo.all(q, { timeoutMs: 500 });                 // no named parameters
await repo.all(adults, { minAge: 18 });                // named parameters
await repo.all(adults, { minAge: 18 }, { timeoutMs: 500 });
```

| Option | Effect |
|---|---|
| `schema` | The database schema for this call. A query's own `.schema()` wins over it. |
| `timeoutMs` | Cancels the query after this long. |
| `signal` | An `AbortSignal` that cancels the query. |
| `context` | Any object. It is passed through to the query event, for request ids and the like. |

A cancelled or timed-out query rejects with `DatabaseError` and the code `"aborted"`.

### Streaming

```ts
for await (const user of repo.stream(from(User, "u"), { batchSize: 500 })) {
  // ...
}
```

Rows are fetched in batches with a server-side cursor. Leaving the loop early closes the
cursor. Streams do not support preloads.

### Raw SQL

```ts
repo.toSql(q);                                              // { sql, params }
await repo.explain(q, { analyze: true });
await repo.raw(fragment`select now() as now`);               // { rows, rowCount }
```

`repo.raw` takes a [`fragment`](/guide/query-expressions#fragments) only. Passing a string
is a compile error and throws.

## Writing

Writes take a changeset and return a **result**:

```ts
const result = await repo.insert(User.changeset(User, input));

if (!result.success) {
  return result.error.errorMessages();    // result.error is the changeset
}
const user = result.data;                 // User
```

```ts
type Result<T, E> = { success: true; data: T } | { success: false; error: E };
```

| Method | Returns | Throwing twin |
|---|---|---|
| `insert(changeset, opts?)` | `Result<Row, Changeset>` | `insertOrThrow` |
| `update(changeset, opts?)` | `Result<Row, Changeset>` | `updateOrThrow` |
| `delete(rowOrChangeset, opts?)` | `Result<Row, Changeset>` | `deleteOrThrow` |
| `insertOrUpdate(changeset, opts?)` | `Result<Row, Changeset>` | `insertOrUpdateOrThrow` |

The `OrThrow` methods return the row and throw `InvalidChangesetError`, which carries the
changeset.

A result is returned for the failures you should expect: invalid input and declared
[constraints](/guide/constraints). Everything else throws: a lost connection, an
undeclared constraint, a stale row.

### Insert

- An invalid changeset is returned as a failure **without touching the database**.
- A required field with no value is reported as `can't be blank`.
- Values written: the changes, then field defaults, then generated values (`createdAt`,
  `updatedAt`, UUID keys). A field with no value is left out of the statement, so a
  database default applies.
- The returned row includes what the database generated.

### Update

- Needs a changeset of a loaded row.
- Writes only the columns that changed. **With no changes it runs no query** and returns
  the row; pass `{ force: true }` to update anyway.
- If no row matched, because it was deleted or because an
  [optimistic lock](/guide/changesets#hooks-for-the-repo) failed, it throws
  `StaleEntryError`. `{ allowStale: true }` ignores that, and
  `{ staleError: { field: "lockVersion" } }` reports it on the changeset instead.

### Delete

Deletes by primary key and returns the row. Pass a changeset when you want to declare a
constraint, such as `noAssocConstraint`.

### Insert or update

`insertOrUpdate` chooses from the changeset: one built from a class is inserted, one built
from a loaded row is updated. It is **not** an upsert; the database is not asked whether
the row exists.

### Upserts

`onConflict` tells the database what to do when the insert collides with an existing row.
Without it, a conflict is an error.

```ts
repo.insert(cs, { onConflict: "nothing" });
repo.insert(cs, { onConflict: { target: ["email"], update: "all" } });
repo.insert(cs, { onConflict: { target: ["email"], update: ["name"] } });
repo.insert(cs, { onConflict: { target: { constraint: "users_email_key" }, update: { except: ["createdAt"] } } });
```

- `target` is the conflicting columns, a constraint name, or a `fragment`. MySQL cannot
  take one, so leave it out there.
- `update` is `"all"`, a list of fields, or `{ except: [...] }`.
- With `"nothing"`, a conflict means no row was inserted: the result is
  `{ success: true, data: null }`.

### Bulk writes

Bulk writes skip changesets and validation.

```ts
const { count, rows } = await repo.insertAll(User, [{ email: "a@b.c" }, { email: "d@e.f" }], { returning: true });

await repo.updateAll(from(Post, "p").where({ authorId: 1 }).set({ published: true }));

await repo.deleteAll(from(Post, "p").where({ published: false }));
```

- **`insertAll(Schema, rows, opts?)`** applies field defaults, timestamps and generated
  values to every row, and splits large inserts under the database's parameter limit
  inside one transaction. It accepts `onConflict` and `returning` (`true` or a list of
  fields), and a query in place of `rows` for `INSERT ... SELECT`.
- **`updateAll(query)`** needs a query with [`.set(...)`](/guide/queries-advanced#bulk-updates-and-deletes).
- **`deleteAll(queryable)`** deletes every row the query matches. `repo.deleteAll(User)`
  deletes every user; there is no guard.
- All three return `{ count, rows }`. `rows` is `null` unless the write asked for rows
  back, with `returning` or `.returning(...)`.

## Logging and events

```ts
const repo = createRepo({ adapter, log: true });

repo.on("query", (e) => {
  // e.sql, e.durationMs, e.queueMs, e.decodeMs, e.rowCount,
  // e.operation, e.source, e.context, e.error
});
repo.on("poolExhausted", () => { /* ... */ });
```

- Events: `query`, `connect`, `disconnect`, `poolExhausted`.
- Parameter values are included only with `log: { params: true }`.
- Values of [redacted](/guide/schemas#fields) fields are never logged.
- `context` is whatever the call passed as its `context` option.
