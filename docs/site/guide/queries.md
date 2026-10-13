# Queries

A query is an immutable value that describes what to read. Building one runs nothing; a
[repo](/guide/repo) runs it.

```ts
import { from, count } from "egon-orm";

const q = from(User, "u")
  .joinAssoc("u", "posts", "p")
  .where(({ u, p }) => u.age.gte(18).and(p.published))
  .groupBy(({ u }) => u.id)
  .having(({ p }) => count(p.id).gt(3))
  .orderBy(({ u }) => u.createdAt.desc())
  .limit(10)
  .select(({ u, p }) => ({ id: u.id, email: u.email, posts: count(p.id) }));

const rows = await repo.all(q); // { id: number; email: string; posts: number }[]
```

## Bindings

Every table in a query has a name, its **binding**. `from(User, "u")` names the first one
`u`, and each join adds another. Clause callbacks receive all of them as one object:

```ts
.where(({ u, p }) => p.authorId.eq(u.id))
```

- The alias is required.
- Using the same alias twice throws `QueryError`.
- The same schema can be joined twice under two aliases (a self-join).

## `from`

`from(source, alias)` starts a query. The source is a schema class, or one of the wrappers
described in [Advanced queries](/guide/queries-advanced): `subquery(q)` or `cte(...)`.

It does not accept a query. To continue a query, call more methods on it.

## Clauses

| Clause | Notes |
|---|---|
| `.where(callback)` | Several `where` calls are combined with `AND`. |
| `.where({ field: value })` | Object form on the first binding. See below. |
| `.orWhere(callback)` | Combined with `OR` against everything before it. |
| `.join(Schema, alias, on)` | Inner join. |
| `.leftJoin`, `.rightJoin`, `.fullJoin` | Outer joins. |
| `.crossJoin(Schema, alias)` | No condition. |
| `.joinAssoc(from, assoc, alias, on?)` | Inner join through an [association](/guide/associations#joining-through-an-association). |
| `.leftJoinAssoc(from, assoc, alias, on?)` | Left join through an association. |
| `.select(callback)` | What to return. See [Select](#select). |
| `.selectMerge(callback)` | Adds keys to an object select. |
| `.distinct()` | `SELECT DISTINCT`. |
| `.distinct(callback)` | `DISTINCT ON (...)`, Postgres only. |
| `.groupBy(callback)` | One expression or an array. |
| `.having(callback)` | Needs a `groupBy`. |
| `.orderBy(callback)` | One expression or an array. A bare column sorts ascending. |
| `.limit(n)`, `.offset(n)` | Bound parameters, so every page size shares one plan. |
| `.lock(mode, opts?)` | Row locks. See [Locks](#locks). |
| `.schema(name)` | The database schema for this query. |
| `.exclude(clause)` | Removes a clause, such as `"orderBy"` or `"limit"`. |
| `.reverseOrder()` | Flips every `orderBy`. |
| `.preload(...)` | Loads associations. See [Preloading](/guide/associations#preloading). |
| `.pipe(fn)` | `q.pipe(f)` is `f(q)`. |

### `where` and `orWhere`

```ts
from(User, "u")
  .where(({ u }) => u.age.gte(18))
  .where(({ u }) => u.role.eq("member"))
  .orWhere(({ u }) => u.role.eq("admin"));
// WHERE (u.age >= $1 AND u.role = $2) OR u.role = $3
```

`orWhere` applies to everything before it. For an `OR` inside one condition, use the
`or` function:

```ts
.where(({ u }) => or(u.role.eq("admin"), u.age.gte(65)))
```

### Object form

```ts
from(User, "u").where({ role: "admin", name: null, id: [1, 2, 3] });
// WHERE u.role = $1 AND u.name IS NULL AND u.id = ANY($2)
```

- A value means equals, `null` means `IS NULL`, an array means `IN`.
- `undefined` throws. A filter that silently disappears, and so matches every row, is a
  common bug. Add the clause conditionally instead:

```ts
let q = from(User, "u");
if (filters.role) q = q.where({ role: filters.role });
```

### Joins and nullability

A left join makes the joined binding's columns nullable in the types; right and full
joins also make the existing bindings nullable. Selecting a whole left-joined binding
gives `Row | null`.

### Select

`select` decides the result type.

```ts
.select(({ u }) => u.email)                              // string
.select(({ u }) => u)                                    // User
.select(({ u, p }) => ({ user: u, title: p.title }))     // { user: User; title: string }
.select(({ u, p }) => [u.id, count(p.id)] as const)      // [number, number]
.select(({ u }) => ({ id: u.id, kind: "user" }))         // plain values are returned as they are
```

With no `select`, a query returns rows of its first binding.

### Locks

```ts
.lock("update")
.lock("update", { skipLocked: true })
.lock("share", { noWait: true })
.lock(fragment`FOR UPDATE OF ${fragment.ident("u")}`)
```

The modes are `"update"`, `"share"`, `"noKeyUpdate"` and `"keyShare"`. SQLite has a single
writer and ignores locks.

## Queries are values

Every method returns a new query. A base query can be kept and extended without changing
it:

```ts
const active = from(User, "u").where(({ u }) => u.deletedAt.isNull());

const admins = active.where({ role: "admin" });
const recent = active.orderBy(({ u }) => u.createdAt.desc()).limit(10);
```

Callbacks run once, when the clause is added. They must not have side effects.

## Reusable pieces

A function from query to query is a reusable scope. `QueryWith` types it:

```ts
import type { QueryWith } from "egon-orm";

const published = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) =>
  q.where(({ p }) => p.published);

const paginate = <Q extends QueryWith<{}>>(q: Q, page: number, size = 20) =>
  q.limit(size).offset((page - 1) * size);

from(Post, "p").pipe(published).pipe((q) => paginate(q, 2));
```

The scope is a compile error on a query that has no binding `p` for `Post`.

`hasNamedBinding(q, "p")` is the runtime check, and narrows the query's type, for code
that receives a query it did not build.

## Named parameters

`param(name, type)` leaves a placeholder that is filled in when the query runs:

```ts
import { param, t } from "egon-orm";

const adults = from(User, "u").where(({ u }) => u.age.gte(param("minAge", t.integer())));

await repo.all(adults, { minAge: 18 });   // the params object is required and typed
```

## Debugging

- `q.toString()` prints a compact rendering without values.
- `repo.toSql(q)` returns the SQL and the parameters.
- `repo.explain(q)` asks the database for its plan.

## Errors

A mistake in a query throws `QueryError` when the clause is added, not when the query
runs. The message names the clause and the binding or field involved.
