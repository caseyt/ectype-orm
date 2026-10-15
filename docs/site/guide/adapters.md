# Adapters

An adapter connects a [repo](/guide/repo) to a database. Postgres supports every feature;
SQLite and MySQL support most, and the gaps are listed in
[Dialect support](/reference/dialect-support).

## Postgres

```sh
pnpm add @egon-orm/postgres pg
pnpm add pg-cursor   # optional: only needed for repo.stream
```

<<< @/examples/adapters.ts#connect

| Option | Default | Effect |
|---|---|---|
| `connectionString` | none | A `postgres://` URL. Or `host`, `port`, `user`, `password`, `database`, `ssl`; with both, the separate settings win. With neither, `pg` reads the `PG*` environment variables. |
| `pool` | `{ max: 10 }` | Pool settings (`max`, `idleTimeoutMs`, `connectionTimeoutMs`), or an existing `pg.Pool` to use as it is. |
| `planCacheSize` | `1000` | How many compiled query shapes to keep. |
| `statementTimeoutMs` | none | A server-side limit for every statement (Postgres `statement_timeout`). |
| `applicationName` | none | Shown in `pg_stat_activity`. |

An option given as `undefined` counts as left out, so `process.env.DATABASE_URL` can be
passed as it is. An unknown option, or a value of the wrong type, throws a `TypeError`
when `postgres()` is called. There is no option for type parsing: the field in the
schema decides what a column becomes (see [How values are stored](#how-values-are-stored)).

<<< @/examples/adapters.ts#settings

The adapter connects on first use. Postgres 14 and later are supported.

### Bringing your own pool

<<< @/examples/adapters.ts#own-pool

A pool you pass in stays yours. The adapter does not change its settings or its type
parsers, so the connection options above (`connectionString`, `host`, ...,
`statementTimeoutMs`, `applicationName`) cannot be combined with it: set them on the pool.
`close()` waits for the adapter's own connections to come back and leaves the pool open.

The adapter adds no `error` listener to a pool you bring. `pg` emits `error` on the pool
when an idle connection fails (the server restarts, or ends the session), and an `error`
event without a listener ends the Node.js process, so add one yourself:
`pool.on("error", (error) => logger.warn(error))`. A pool the adapter creates has one.

### Health

<<< @/examples/adapters.ts#health

`repo.ping()` and `repo.poolStats()` pass through to these.

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

On Postgres:

- **`bigint`** columns arrive as text and become a `bigint` for `t.bigint()`, or a
  `number` for `t.bigint({ mode: "number" })`, which throws `CastError` for a value
  beyond `Number.MAX_SAFE_INTEGER` rather than return a neighbouring number. The same
  holds for `count(...)` and `sum(...)`, which Postgres returns as `bigint` and `numeric`.
- **`decimal`** (`numeric`) stays a string, so no digit is lost to floating point.
- **`date`** is read as the `"YYYY-MM-DD"` string Postgres sends. `pg` would otherwise
  build a `Date` at local midnight, which is the day before in time zones west of UTC.
- **`timestamp`** values are written as UTC text and read exactly, whatever the time zone
  of your process or of the database session. A `localTimestamp` (`timestamp without
  time zone`) is read and written by its UTC fields: `getUTCHours()` is the hour stored.
- **`binary`** (`bytea`) arrives as a plain `Uint8Array` over the bytes `pg` read.
- **`json`** is serialised by the adapter, so an array or a string is stored as JSON and
  not as a Postgres array or as text.

These settings apply to this adapter's statements only. The process-wide `pg.types`
registry is never changed, so other code in your process that uses `pg` sees its usual
values.

## Errors

Driver errors are converted to the library's [error classes](/reference/errors), with the
original error kept as `cause`:

- a constraint violation becomes a changeset error when it was
  [declared](/guide/constraints), otherwise a `ConstraintError` with the `type`
  (`unique`, `foreignKey`, `check`, `exclusion`, `notNull`), and the `constraint`,
  `table` and `column` the database reports;
- a serialisation failure or deadlock becomes a `DatabaseError` with `retryable: true`
  and the code `"serializationFailure"` or `"deadlock"`;
- a statement stopped by `statementTimeoutMs` becomes a `DatabaseError` with the code
  `"timeout"`;
- a connection failure (refused, lost, terminated by the server, wrong credentials, no
  free connection within `connectionTimeoutMs`) becomes a `DatabaseError` with the code
  `"connection"`;
- any other database error becomes a `DatabaseError` with the code `"database"`.

<<< @/examples/adapters.ts#errors

The SQL is attached to the error as `sql`. Parameter values are never attached, and a
database message that may quote a value (a data error such as `invalid input syntax`) is
left out of the error's own message; it is still on `cause`.

## Cancellation and timeouts

`timeoutMs` and `signal` (see [Parameters and options](/guide/repo#parameters-and-options))
cancel a statement **on the server**. The adapter sends Postgres's own cancel request, the
same one `psql` sends on Ctrl-C: a short message on a new socket, which needs no login and
no free connection slot, and which PgBouncer passes on to the right
server process. The call rejects with a `DatabaseError` whose code is `"timeout"` or
`"aborted"` once the statement has stopped, and the connection goes back to the pool
ready for the next statement.

`timeoutMs` is one budget for the whole call: the wait for a free connection counts, and
a call that waits longer than `timeoutMs` rejects with `"timeout"` without running. An
abort while waiting stops the wait the same way. (For a stream, `timeoutMs` bounds the
wait and then each fetch of a batch.)

A statement that had already finished when the cancel arrived is not undone; the call
still rejects. Postgres does not say whether a cancel request stopped anything, and a
request that cannot be delivered (the server unreachable within `connectionTimeoutMs`,
10 seconds without one) lets the statement run to its end before the call rejects.
Inside a transaction, a cancelled statement aborts the transaction, as any failed
statement does.

`statementTimeoutMs` is the same limit set once for every statement, enforced by
Postgres itself.

## Logging and events

The adapter reports every statement, and the pool's `connect`, `disconnect` and
`poolExhausted` events, to the repo, which exposes them through `repo.on(...)` and its
`log` option (see [Logging and events](/guide/repo#logging-and-events)). A `query`
event carries the SQL, the number of parameters, the time spent waiting for a connection
(`queueMs`) and running (`durationMs`), the row count and the error, if any. Parameter
values are included only with `log: { params: true }`, and the value of a redacted field
is always replaced by `**redacted**`.

When nobody listens, the adapter does not measure anything. A listener that throws does
not fail the statement, but its error is rethrown as an uncaught exception, which ends the
process unless you handle `uncaughtException`: catch errors inside your listener.

## Pool behaviour

- A query waits for a free connection when the pool is busy. `connectionTimeoutMs` bounds
  the wait, and the `poolExhausted` event fires when a query has to queue.
- A connection that fails at the protocol level (lost, or terminated by the server) is
  discarded, not reused. So is a connection that is returned while still inside a
  transaction.
- An idle connection that the server closes is dropped from the pool without an error;
  the next query opens a new one. A checked-out connection that the server closes fails
  its next statement with the code `"connection"` and is discarded when it is released.
- While a stream is open on a connection, another statement on that connection throws
  `QueryError`: finish the stream, or leave its loop, first.
- `repo.close()` waits for running queries and checked-out connections, and can be called
  more than once. Calls made after it reject with a `DatabaseError` (code `"connection"`).

::: tip Good to know
- Nothing connects until the first query, so creating an adapter never fails because the
  database is down. Use `repo.ping()` at start-up to check.
- `pg-cursor` is only loaded the first time you stream. Without it, `repo.stream` throws a
  `QueryError` telling you to install it.
- A statement list without parameters (`"select 1; select 2"`) runs in one round trip and
  returns the last statement's rows.
:::

## Capabilities

Each adapter states what its database can do. A query that needs something missing throws
`QueryError` naming the feature and the database when it is compiled, never a syntax
error from the database:

```
QueryError: FULL JOIN is not supported by mysql
```
