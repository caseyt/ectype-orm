# Adapters

An adapter connects a [repo](/guide/repo) to a database. Postgres supports every feature;
SQLite and MySQL support most, and the gaps are listed in
[Dialect support](/reference/dialect-support).

## Postgres

```sh
pnpm add @egon-orm/postgres pg
```

```ts
import { postgres } from "@egon-orm/postgres";

const adapter = postgres({
  connectionString: process.env.DATABASE_URL,
  pool: { max: 10, idleTimeoutMs: 30_000, connectionTimeoutMs: 5_000 },
});
```

| Option | Default | Effect |
|---|---|---|
| `connectionString` | none | Or `host`, `port`, `user`, `password`, `database`, `ssl`. |
| `pool` | `{ max: 10 }` | Pool settings, or an existing `pg.Pool` to use as it is. |
| `planCacheSize` | `1000` | How many compiled query shapes to keep. |
| `statementTimeoutMs` | none | A server-side limit for every statement. |
| `applicationName` | none | Shown in `pg_stat_activity`. |

The adapter connects on first use. Postgres 14 and later are supported.

## SQLite

```sh
pnpm add @egon-orm/sqlite better-sqlite3
```

```ts
import { sqlite } from "@egon-orm/sqlite";

const adapter = sqlite({ filename: "app.db", pragmas: { journal_mode: "WAL" } });
const memory = sqlite({ filename: ":memory:" });
```

- Foreign keys are **on** by default. SQLite itself ships with them off; set
  `pragmas: { foreign_keys: "OFF" }` to get that back.
- `:memory:` is the fastest way to run a test suite.
- SQLite has one writer at a time. Row locks are ignored.

## MySQL

```sh
pnpm add @egon-orm/mysql mysql2
```

```ts
import { mysql } from "@egon-orm/mysql";

const adapter = mysql({ connectionString: process.env.DATABASE_URL, pool: { max: 10 } });
```

- The session time zone is always UTC, so timestamps mean the same thing everywhere.
- MySQL cannot return rows from a write. The adapter reads the row back after an insert.
- DDL is not transactional in MySQL.

## How values are stored

The TypeScript type of a field is the same on every database. The adapter converts where
the driver differs:

| Type | Postgres | SQLite | MySQL |
|---|---|---|---|
| `boolean` | `boolean` | `0` / `1` | `tinyint(1)` |
| `bigint` | `bigint` | integer | `bigint` |
| `decimal` | `numeric` | text | `decimal` |
| `uuid` | `uuid` | text | `char(36)` |
| `date`, `timestamp` | native | ISO-8601 text, UTC | native, UTC |
| `json` | `jsonb` | text | `json` |
| `array` | native | not supported | not supported |

On Postgres, a `date` column is read as a string without changing how the rest of your
process uses `pg`: the setting applies to this adapter's pool only.

## Errors

Driver errors are converted to the library's [error classes](/reference/errors), with the
original error kept as `cause`:

- a constraint violation becomes a changeset error when it was
  [declared](/guide/constraints), otherwise a `ConstraintError`;
- a serialisation failure or deadlock becomes a `DatabaseError` with `retryable: true`;
- a connection failure becomes a `DatabaseError` with the code `"connection"`.

The SQL is attached to the error. Parameter values are attached only when the repo has
`log: { params: true }`.

## Pool behaviour

- A query waits for a free connection when the pool is busy. `connectionTimeoutMs` bounds
  the wait, and the `poolExhausted` event fires when a query has to queue.
- A connection that fails at the protocol level is discarded, not reused.
- `repo.close()` waits for checked-out connections and can be called more than once.

## Capabilities

Each adapter states what its database can do. A query that needs something missing throws
`QueryError` naming the feature and the database when it is compiled, never a syntax
error from the database:

```
QueryError: FULL JOIN is not supported by mysql
```
