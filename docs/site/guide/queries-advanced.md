# Advanced queries

## Subqueries

A query can be used inside another: as a source, in a join, with `in`, with `exists`, or
as a single value.

```ts
import { from, subquery, exists, scalar, count } from "egon-orm";

const postCounts = from(Post, "p")
  .groupBy(({ p }) => p.authorId)
  .select(({ p }) => ({ authorId: p.authorId, n: count() }));

// As a source: the binding exposes the subquery's select keys
from(subquery(postCounts), "c").where(({ c }) => c.n.gt(5));

// In a join
from(User, "u").join(subquery(postCounts), "c", ({ u, c }) => c.authorId.eq(u.id));

// IN
from(User, "u").where(({ u }) => u.id.in(from(Post, "p").select(({ p }) => p.authorId)));

// EXISTS, referring to the outer query
from(User, "u").where(({ u }) =>
  exists(from(Post, "p").where(({ p }) => p.authorId.eq(u.id))));

// A single value in the select
from(User, "u").select(({ u }) => ({
  user: u,
  posts: scalar(from(Post, "p").where(({ p }) => p.authorId.eq(u.id)).select(() => count())),
}));
```

- A subquery used as a source must select an object of expressions, or a whole schema.
- An inner callback can use the outer binding directly, as `u` is used above.
- When the inner query is built elsewhere and has no access to `u`, refer to it by alias
  with `outerRef`:

```ts
import { outerRef } from "egon-orm";

const byThisUser = from(Post, "p").where(({ p }) => p.authorId.eq(outerRef("u", User).id));
from(User, "u").where(() => exists(byThisUser));
```

## Common table expressions

```ts
import { cte } from "egon-orm";

const roots = from(Category, "c").where(({ c }) => c.parentId.isNull());
const children = from(Category, "c").join(cte("tree", Category), "t", ({ c, t }) => c.parentId.eq(t.id));

const tree = from(cte("tree", Category), "t")
  .withCte("tree", roots.unionAll(children), { recursive: true });
```

- `.withCte(name, query, { recursive?, materialized? })` attaches a CTE to a query.
- `cte(name, shape)` refers to it as a source. `shape` is a schema class, or the CTE's own
  query, and gives the binding its type.

## Set operations

```ts
a.union(b)      a.unionAll(b)
a.intersect(b)  a.intersectAll(b)
a.except(b)     a.exceptAll(b)
```

Both sides must have the same result type; a mismatch is a compile error. `orderBy` and
`limit` after the operation apply to the combined result.

## Window functions

```ts
import { rowNumber, sum } from "egon-orm";

from(Post, "p")
  .windows({ w: ({ p }) => ({ partitionBy: [p.authorId], orderBy: [p.createdAt.desc()] }) })
  .select(({ p }) => ({
    id: p.id,
    rank: rowNumber().over("w"),
    total: sum(p.views).over({ partitionBy: [p.authorId] }),
  }));
```

- Functions: `rowNumber`, `rank`, `denseRank`, `percentRank`, `cumeDist`, `ntile`, `lag`,
  `lead`, `firstValue`, `lastValue`, `nthValue`, and any aggregate with `.over()`.
- `.over("w")` uses a named window; the name is type-checked against `.windows(...)`.
- `.over({ partitionBy, orderBy, frame })` defines one inline. `frame` is a `fragment`.

## Conditions built at runtime

Clause callbacks already cover most dynamic queries. `dynamic` is for a condition that is
built before the query it will be used in:

```ts
import { dynamic } from "egon-orm";

const filters = [
  dynamic<{ u: typeof User }>(({ u }) => u.age.gte(18)),
  dynamic<{ u: typeof User }>(({ u }) => u.role.eq("member")),
];

const all = filters.reduce((acc, f) => acc.and(f), dynamic.true());
from(User, "u").where(all);
```

Using it on a query that has no binding `u` for `User` is a compile error. `dynamic`
values are accepted by `where`, `having`, `orderBy`, `groupBy`, `select` and join
conditions.

`field(binding, name)` picks a column by a name known only at runtime. The name is checked
against the schema, and anything else throws:

```ts
.orderBy(({ u }) => field(u, sortColumn).asc())
```

## Bulk updates and deletes

A query with `.set(...)` describes an `UPDATE`, run with
[`repo.updateAll`](/guide/repo#bulk-writes). A query without it can be run with
`repo.deleteAll`.

```ts
// Plain values
from(Post, "p").where(({ p }) => p.authorId.eq(1)).set({ published: true });

// Expressions
from(Post, "p")
  .where(({ p }) => p.authorId.eq(1))
  .set(({ p }) => ({ views: p.views.add(1), tags: p.tags.append("featured") }))
  .returning(({ p }) => p.id);
```

- `.set` takes an object, or a callback returning one. Values are type-checked against
  the fields.
- `.returning(...)` takes the same shapes as `select` and makes the repo return rows.
- Joins become `UPDATE ... FROM` and `DELETE ... USING` on Postgres.

## Prepared queries

`prepare(q)` compiles a query once and keeps the result on the returned object. It is the
fastest way to run a query many times.

```ts
import { prepare, param, t } from "egon-orm";

const byEmail = prepare(
  from(User, "u").where(({ u }) => u.email.eq(param("email", t.string()))).limit(1),
);

await repo.one(byEmail, { email });
```

Queries defined at module level are compiled once anyway; `prepare` also skips the cache
lookup.

## Other tools

- **Ordering by a select alias.** `selectedAs(expr, "total")` names a selected expression,
  and `selectedAs("total")` refers to it in `orderBy` or `groupBy`.
- **Tuple comparison**, for keyset pagination:

```ts
import { tuple } from "egon-orm";

.where(({ p }) => tuple(p.createdAt, p.id).lt(tuple(cursor.createdAt, cursor.id)))
.orderBy(({ p }) => [p.createdAt.desc(), p.id.desc()])
.limit(20)
```

## Recipes

### Top N per group

```ts
const ranked = from(Post, "p").select(({ p }) => ({
  id: p.id,
  rn: rowNumber().over({ partitionBy: [p.authorId], orderBy: [p.createdAt.desc()] }),
}));

from(Post, "p").where(({ p }) =>
  p.id.in(from(subquery(ranked), "r").where(({ r }) => r.rn.lte(3)).select(({ r }) => r.id)));
```

When the groups are the parents of an association, a preload does this for you:
`preload("posts", (q) => q.orderBy(...).limit(3))`. See
[Preloading](/guide/associations#callback-form).

### Rows with no match

```ts
from(User, "u").where(({ u }) => not(exists(from(Post, "p").where(({ p }) => p.authorId.eq(u.id)))));
```

## Not in the first release

Lateral joins, `VALUES` lists as a source, table-valued fragments, index hints and
data-modifying CTEs are planned. See the [Roadmap](/reference/roadmap).
