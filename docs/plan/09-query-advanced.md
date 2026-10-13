# Step 09 — Advanced queries

**Depends on:** 08, 10. **Parallel with:** 12, 13.
**Owns:** `packages/core/src/query/advanced/`, the lowering of these features in
`packages/core/src/compiler/advanced/` (coordinate with step 10's owner through the
`lowerNode` extension point), `docs/site/guide/queries-advanced.md`.

## Goal

The rest of the query language: subqueries, CTEs, set operations, window functions,
dynamic expressions, bulk update/delete expressions, prepared queries.

**Deferred to future work by the owner (plan README §11), do not build:** lateral joins,
`VALUES` sources, table-valued fragments, index hints, data-modifying CTEs and named
server-side prepared statements. Their text below is kept for reference and marked.
Each feature is independent; implement and land them one at a time in the order below.

## Features

### 1. Subqueries (`subquery/1`)

```ts
const recent = from(Post, "p").where(({ p }) => p.createdAt.gt(val(since))).select(({ p }) => ({ authorId: p.authorId, n: count() })).groupBy(({ p }) => p.authorId);

from(subquery(recent), "r").where(({ r }) => r.n.gt(5));                    // as a source
from(User, "u").join(subquery(recent), "r", ({ u, r }) => r.authorId.eq(u.id));  // as a join
from(User, "u").where(({ u }) => u.id.in(from(Post, "p").select(({ p }) => p.authorId)));  // IN
from(User, "u").where(({ u }) => exists(from(Post, "p").where(({ p }) => p.authorId.eq(outerRef("u", User).id))));
from(User, "u").select(({ u }) => ({ u, posts: scalar(from(Post, "p").where(...).select(() => count())) }));
```

- A subquery source's binding exposes the subquery's **select keys** as columns, typed from `R`. The select must be an object of expressions (or a whole schema) — otherwise `QueryError`.
- Correlation uses the outer binding directly inside the inner callback when lexically available; `outerRef(alias, Schema)` (alias plus the schema for typing) exists for composed queries (Ecto `parent_as`).
- Named params and shape/params arrays of the inner query merge into the outer.

### 2. Common table expressions (`with_cte/3`, `recursive_ctes/2`)

```ts
const tree = from(Category, "c").where(({ c }) => c.parentId.isNull())
  .unionAll(from(Category, "c").join(cte("tree", Category), "t", ({ c, t }) => c.parentId.eq(t.id)));
from(cte("tree", Category), "t").withCte("tree", tree, { recursive: true });
```

`withCte(name, query, { recursive?, materialized? })` is a **query method only** (`from` is
the single entry point);
`cte(name, shape)` references it as a source, where `shape` is a schema class or the CTE
query itself (for typing). Data-modifying CTEs are deferred.

### 3. Set operations

`.union(q)`, `.unionAll(q)`, `.intersect(q)`, `.intersectAll(q)`, `.except(q)`, `.exceptAll(q)`.
Both sides must have equal result types (compile error otherwise). `orderBy`/`limit` on the
combined query apply to the whole, as in Ecto.

### 4. Windows

```ts
from(Post, "p")
  .windows({ w: ({ p }) => ({ partitionBy: [p.authorId], orderBy: [p.createdAt.desc()] }) })
  .select(({ p }) => ({ id: p.id, rank: rowNumber().over("w"), total: sum(p.views).over({ partitionBy: [p.authorId] }) }));
```

Functions: `rowNumber`, `rank`, `denseRank`, `percentRank`, `cumeDist`, `ntile`, `lag`,
`lead`, `firstValue`, `lastValue`, `nthValue`, and any aggregate with `.over()`. Frame
clause via `frame: fragment\`...\``. Window names are type-checked against declared windows.

### 5. Lateral joins and other sources (DEFERRED: future work)

`.joinLateral(q, "alias", on?)`, `.leftJoinLateral(...)` (capability-gated; `QueryError` on
SQLite). `from(values([{ id: 1, name: "a" }], { id: t.integer(), name: t.string() }), "v")`
for inline VALUES lists (all bound). `from(fragment\`generate_series(${a}, ${b})\`.asTable({ n: t.integer() }), "g")`.

### 6. Dynamic expressions (`dynamic/2`)

In Egon, expressions are already first-class values, so most uses of Ecto's `dynamic`
are just callbacks. Provide the missing piece: binding-agnostic, late-bound fragments.

```ts
const filter = dynamic<{ u: typeof User }>(({ u }) => u.age.gte(18));
const combined = filters.reduce((acc, f) => acc.and(f), dynamic.true());
q.where(combined);                  // compile error if q lacks binding "u" of the right schema
field(u, name)                      // column by runtime name, validated against the schema, typed as union
```

`dynamic` values are accepted by `where`, `having`, `orderBy`, `groupBy`, `select`, and join `on`.

### 7. Bulk update/delete expressions (for `repo.updateAll` / `deleteAll`)

```ts
from(Post, "p").where(({ p }) => p.authorId.eq(1))
  .set(({ p }) => ({ published: true, title: p.title.concat("!"), views: p.views.add(1), tags: p.tags.append("x") }))
  .returning(({ p }) => p.id);

from(Post, "p").where(({ p }) => p.authorId.eq(1)).set({ published: true });   // object form
```

`.set(...)` takes an object, or a callback returning one; values are literals or
expressions and are type-checked against the field. There is no `inc` / `push` / `pull`:
write `p.views.add(1)`, `p.tags.append("x")`, `p.tags.remove("y")`. `RETURNING` is declared
with `.returning(...)` on update and delete queries (same shapes as `select`); `.select()`
on such a query is a `QueryError`. `.set()` may be called more than once (later keys win). Joins in update/delete lower to `UPDATE ... FROM` / `DELETE ... USING` on
Postgres and are capability-gated elsewhere.

### 8. Prepared queries

```ts
const byEmail = prepare(from(User, "u").where(({ u }) => u.email.eq(param("email", t.string()))).limit(1));
await repo.one(byEmail, { email });   // params object typed from P
```

`prepare(q)` eagerly lowers and pins the compiled plan on the object (skips even the plan
cache lookup) (a named server-side prepared statement is deferred). Document it as the fastest path and
benchmark it against the cached path.

### 9. Small ones

`selectedAs(expr, "alias")` + `selectedAs("alias")` in order/group; `.hint(fragment)` is deferred; tuple comparison `tuple(u.a, u.b).gt(tuple(x, y))` for keyset pagination;
`asOf`-style helpers are out.

## Tests (per feature)

- Type tests: source binding typing from subquery/CTE; set-operation type equality;
  window-name checking; update expression typing; `dynamic` binding requirements; `prepare` params.
- SQL snapshots: Postgres for all; MySQL/SQLite added by step 17.
- Integration (Postgres): one realistic query per feature against the blog schema —
  top-N per group (window variant), recursive category tree, keyset
  pagination, "users with no posts" (`not exists`), bulk publish with returning.
- Errors: every capability-gated feature throws `QueryError` naming the feature and dialect.

## Docs (`guide/queries-advanced.md`)

One section per feature: when to use it, the example above, emitted SQL.
A "recipes" list: top-N per group, keyset pagination, recursive tree, upsert-with-CTE,
conditional filters with `dynamic`.

## Acceptance

- [ ] Each feature has type tests, SQL snapshots, one integration test, and a docs section.
- [ ] Inner-query params and named params merge correctly (test with params on both sides and plan-cache reuse across different values).
- [ ] No feature bypasses parameter binding.
- [ ] Features unsupported by Kysely's node set are lowered via raw nodes as recorded in ADR 0002, each with a snapshot test.

## Out of scope

Executing `updateAll`/`deleteAll` (13). Tier-2 dialect snapshots (17).
