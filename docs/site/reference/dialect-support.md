# Dialect support

Postgres supports everything in this documentation. SQLite and MySQL 8 run the same
schemas, changesets, queries and repo calls, with the differences below.

A query that needs an unsupported feature throws `QueryError`, naming the feature and the
database, when it is compiled.

## Queries

| Feature | Postgres | SQLite | MySQL 8 |
|---|---|---|---|
| Inner, left, right, cross joins | yes | yes | yes |
| Full join | yes | yes (3.39+) | no |
| `distinct(callback)` (`DISTINCT ON`) | yes | no | no |
| `ilike` | yes | as `LIKE`: case-insensitive for ASCII only | as `LIKE`: the column's collation decides |
| Array columns and operators | yes | no; use `t.json()` | no; use `t.json()` |
| JSON operators | yes | yes | yes |
| `in(list)` | one array parameter | expanded to `IN (?, ?, ...)` | expanded to `IN (?, ?, ...)` |
| Subqueries, CTEs, set operations | yes | yes | yes |
| Window functions | yes | yes | yes |
| Row locks | yes | ignored (single writer) | `"update"` and `"share"`, with `skipLocked` and `noWait` |
| `schema` option | a schema | an attached database | a database |

## Writes

| Feature | Postgres | SQLite | MySQL 8 |
|---|---|---|---|
| Rows returned from a write | yes | yes (3.35+) | no; the row is read back |
| `onConflict: "nothing"` | yes | yes | yes |
| `onConflict` with `update` | yes | yes | yes, without a `target` |
| `onConflict.target` | yes | yes | no |
| `.returning(...)` on bulk writes | yes | yes | no |
| Joins in `updateAll` / `deleteAll` | yes | no | yes |

## Transactions

| Feature | Postgres | SQLite | MySQL 8 |
|---|---|---|---|
| Savepoints (nested transactions) | yes | yes | yes |
| Isolation levels | yes | not applicable | yes |
| Streaming | server-side cursor | statement iteration | streaming result set |

## Constraint errors

| | Postgres | SQLite | MySQL 8 |
|---|---|---|---|
| Unique, foreign key, check | reported by name | unique is reported by columns; see below | reported by name |
| Exclusion constraints | yes | no | no |

SQLite reports a unique violation by its columns, not by an index name. The adapter turns
that into the default constraint name, so `uniqueConstraint("email")` works; a custom
`name` cannot be matched.

## Limits

| | Postgres | SQLite | MySQL 8 |
|---|---|---|---|
| Parameters per statement | 65,535 | 32,766 | 65,535 |

`insertAll` and large `in` lists are split to stay under these.
