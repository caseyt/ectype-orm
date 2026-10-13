# Step 14 — Associations: querying and preloading

**Depends on:** 12. **Parallel with:** 13.
**Owns:** `packages/core/src/repo/preload.ts`, `packages/core/src/query/assoc.ts`,
`packages/core/test/conformance/preload/`, `benchmarks/e2e/preload.bench.ts`,
`docs/site/guide/associations.md`.

## Goal

Load associated data without N+1 queries, with result types that reflect exactly what was loaded.

## Public API

```ts
// 1. Short forms (separate queries per association, run after the main query)
repo.all(from(User, "u").preload("posts"));                          // Loaded<typeof User, "posts">[]
repo.all(from(User, "u").preload(["posts", "profile"]));
repo.all(from(User, "u").preload({ posts: ["comments", "tags"] }));   // nested
repo.all(from(User, "u").preload({ posts: { comments: "author" } }));

// 2. Callback form: one association name, and a function from query to query.
//    `q` is rooted at the target and its alias is the association's name.
from(User, "u")
  .preload("profile")
  .preload("posts", (q) =>
    q.where(({ posts }) => posts.published)
     .orderBy(({ posts }) => posts.createdAt.desc())
     .limit(3)                                                       // three PER USER
     .preload("comments", (q) => q.orderBy(({ comments }) => comments.createdAt).limit(5).preload("author")));

from(User, "u").preload("posts", onlyPublished);                     // any (q) => q function is a reusable scope

// 2b. A callback may select. The result is plain objects, and the association key must be selected.
from(User, "u").preload("posts", (q) =>
  q.select(({ posts }) => ({ authorId: posts.authorId, title: posts.title })));
// users[0].posts: { authorId: number; title: string }[]

// 3. From a join already in the query (one SQL statement)
from(User, "u").joinAssoc("u", "posts", "p").where(({ p }) => p.published)
  .preload({ posts: "p" });                                          // binding alias as the source

// 4. After the fact
const users2 = await repo.preload(users, "posts");                   // Loaded<...>[]; accepts one row, an array, or null
await repo.preload(users, "posts", (q) => q.limit(3));               // same callback form
await repo.preload(user, { posts: "comments" }, { force: true });

// 5. Query helpers
assoc(user, "posts")                         // Query for the associated rows of one or many parents
isLoaded(user, "posts")                      // type guard: narrows to Loaded<..., "posts">
```

There is **no custom-query form** (`{ posts: someQuery }`) and no `preloadQuery`: the
callback form covers both. Several `.preload()` calls on one query merge.

## Behaviour

1. **Strategy (separate queries).** For each association level, collect the distinct,
   non-null owner keys from the parent rows, run **one** query
   `WHERE fk = ANY($1)` (or `IN`), group children by key in a `Map`, and attach. So a
   three-level preload over any number of parents is exactly 1 + 3 queries.
   - `belongsTo`: collect foreign keys, fetch by referenced key, attach one or `null`.
   - `hasOne`: attach first match or `null`. `hasMany`: array (empty array when none).
   - `manyToMany`: one query joining the join table to the target, selecting the owner key alongside.
   - has-through: resolve by preloading the chain and flattening with de-duplication by primary key; intermediate associations are not exposed unless requested.
   - Composite keys: tuple matching.
   - Sibling associations at the same level run **one at a time by default**
     (`maxConcurrency: 1`, so one request holds one connection); a higher `maxConcurrency`
     runs them concurrently when a pool is available, and always sequentially inside a
     transaction (single connection).
   - Very large key sets are chunked (default 10,000 keys per query).
2. **Ordering.** Children keep the order returned by the association query: `orderBy`
   from the association definition, overridden by the callback's `orderBy`.
3. **Callback form.** `preload(name, fn)`: `fn` receives a `Query` rooted at the target
   schema whose alias is the association's name (each callback has its own scope, so a
   self-referencing association nested in itself does not clash) and returns a `Query`.
   Association-level `where` options always apply in addition.
   - `where`, `orderBy`, joins and nested `.preload(...)` behave as in any query.
   - **`limit` and `offset` are per parent.** When either is present the preload query ranks
     children with `row_number() OVER (PARTITION BY <owner key> ORDER BY ...)` and filters
     on the rank: still one query per level, on every dialect (no lateral join needed).
     They require an order (the callback's `orderBy`, else the association's); without
     one, throw `QueryError` at build time ("limit in preload \"posts\" needs an orderBy").
     Without `limit`/`offset` the query is the plain `WHERE fk = ANY($1)` form.
   - **`select` is allowed.** The association is then loaded as plain objects of the
     selected shape (never partial schema instances), and its type follows the select. As
     in Ecto, the caller must keep the key: the select **must contain the column the
     association is matched on, under its field name** (`authorId` for `User.posts`; `id`
     for `Post.author`). If it does not, throw `QueryError` when the query is built, naming
     the association and the missing field (and make it a compile error where the selected
     shape is visible to the types). Nothing is added to or stripped from the select.
     Exception: `manyToMany`, whose owner key lives in the join table; there the preload
     fetches the key itself, as Ecto does.
   - A selected shape is not rows: a nested `.preload()` under it needs the whole binding in
     the select (else `QueryError`), and `castAssoc` on it throws `NotLoadedError` (step 15).
   - The callback is run once, at build time, like every other callback.
4. **Join preloads.** `.preload({ posts: "p" })` adds `p`'s columns to the select. Tie-break
   with the nested short form: the string is a binding alias only when the query has a
   binding of that name that was joined through that association (`joinAssoc`); otherwise
   it is the name of a nested association. The
   per-row decoder builds each parent with that row's child in place; parents are then
   de-duplicated in the post-decode stage (step 12's `afterDecode` hook), which collects
   the children (by parent primary key, preserving first-seen order). A row decoder is
   stateless and cannot do this itself (`contracts/adapter.ts`, "Join preloads"). Nested join preloads (`{ posts: { $from: "p", comments: "c" } }`)
   are supported. Parents must be selected whole. Warn in docs about row multiplication.
5. **Attaching.** Preloaded associations are assigned as own properties on the row
   **in a fixed order after the fields**. To keep shapes monomorphic, rows produced by a
   plan that has preloads are created by a factory variant that pre-declares those
   properties (one hidden class per (schema, preload set)); `repo.preload` on existing rows
   returns **new** row objects (inputs are not mutated) built with that variant.
6. **Identity.** No identity map, with no exceptions (owner decision, 2026-10-13): every
   attached association value is its own object. When several parents point at the same
   `belongsTo` target, the preload fetches that row once and gives **each parent its own
   instance** (build one per parent from the fetched values), so mutating one never
   shows through another.
7. **`repo.preload(rows, spec, opts)`.** Skips associations already loaded unless
   `force: true`. Accepts `null`/empty input and returns it. Mixed schemas in one array throw.
8. **Types.** `preload(spec)` maps to the loaded type for strings, arrays, nested
   objects and alias strings, and `preload(name, fn)` to the callback's result type (whole
   rows, or the selected shape): `LoadedAs<S, K, E>`, with the callback's result
   intersected with `PreloadElement<S, K, E>` so that a select without the key does not
   compile (`contracts/schema.ts`). The argument is first mapped to a
   `PreloadSpec` (an alias becomes `true`, `$from` is dropped), then
   checked with `ValidPreload` and typed with `LoadedUnchecked` (`contracts/schema.ts`). `repo.preload` over `Loaded<S, A>` with `B`
   returns `Loaded<S, A | B>`. Unknown association names are compile errors at any depth.
9. **`assoc(parents, name)`** returns a typed `Query` rooted at the target, filtered by the
   parents' keys, usable as any other query (`repo.all(assoc(user, "posts").where(...))`).
10. **Streaming and `one`.** Preloads work with `all`, `one`, `get*`, `reload`; not with `stream`.

## Preload conformance suite

Each association kind: empty/one/many children, null foreign keys, composite keys, uuid
keys; nested three levels; sibling associations; callback with filter and order; per-parent
`limit`/`offset` (and the missing-order error); callback `select` with and without the key; join
preload with duplicates; has-through with de-duplication; many-to-many with join-table
`where`; preload inside a transaction; **query count assertions** via telemetry for every
case (the N+1 guard); 10k parents with chunking.

## Tests

- Unit (fake adapter): grouping and attachment for each kind; key chunking; ordering;
  `force`; non-mutation of inputs; join-preload de-duplication (property test: random
  parent/child sets flattened to join rows decode back to the original tree).
- Type tests: all spec forms, nested depth 3, the callback form (whole rows, selected shape,
  nested callbacks), alias form, cumulative `repo.preload`,
  `isLoaded` narrowing, required vs optional `belongsTo` nullability.
- Integration: the conformance suite on Postgres.
- Benchmarks: 100 users × 10 posts (separate vs join strategy, vs hand-written two queries
  + manual stitching; budget < 20% over hand-written); 3-level preload.

## Docs (`guide/associations.md`)

Defining associations (recap), `joinAssoc` vs preload, the three preload strategies and
when to use each, nested preloads, the callback form (filters, per-parent limits, selecting
columns and the key rule), typing
with `Loaded`, `assoc()` queries, how to avoid N+1 and how to assert query counts in tests.

## Acceptance

- [ ] All API forms above work and are typed; conformance suite green on Postgres.
- [ ] Query-count assertions prove 1 + (number of association levels) queries in every case.
- [ ] Row shapes stay monomorphic per (schema, preload set) (shape test as in step 04).
- [ ] Budget met.

## Out of scope

Writing associations (15).
