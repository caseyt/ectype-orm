# Step 14 — Associations: querying and preloading

**Depends on:** 12. **Parallel with:** 13.
**Owns:** `packages/core/src/repo/preload.ts`, `packages/core/src/query/assoc.ts`,
`packages/core/test/conformance/preload/`, `benchmarks/e2e/preload.bench.ts`,
`docs/site/guide/associations.md`.

## Goal

Load associated data without N+1 queries, with result types that reflect exactly what was loaded.

## Public API

```ts
// 1. In a query (separate queries per association, run after the main query)
repo.all(from(User, "u").preload("posts"));                          // Loaded<typeof User, "posts">[]
repo.all(from(User, "u").preload({ posts: ["comments", "tags"] }));   // nested
repo.all(from(User, "u").preload({ posts: { comments: "author" } }));

// 2. With a custom query per association
const published = from(Post, "p").where(({ p }) => p.published).orderBy(({ p }) => p.insertedAt.desc());
from(User, "u").preload({ posts: published });
from(User, "u").preload({ posts: preloadQuery(published, { comments: "author" }) });

// 3. From a join already in the query (one SQL statement)
from(User, "u").joinAssoc("u", "posts", "p").where(({ p }) => p.published)
  .preload({ posts: "p" });                                          // binding alias as the source

// 4. After the fact
const users2 = await repo.preload(users, "posts");                   // Loaded<...>[]; accepts one row, an array, or null
await repo.preload(user, { posts: "comments" }, { force: true });

// 5. Query helpers
assoc(user, "posts")                         // Query for the associated rows of one or many parents (Ecto.assoc/2)
assocLoaded(user, "posts")                   // type guard: narrows to Loaded<..., "posts">
```

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
   - Sibling associations at the same level run concurrently when a pool is available
     (`Promise.all`, capped by `maxConcurrency`, default 4) and sequentially inside a
     transaction (single connection).
   - Very large key sets are chunked (default 10,000 keys per query).
2. **Ordering.** Children keep the order returned by the association query: `preloadOrder`
   from the association definition, overridden by a custom query's `orderBy`.
3. **Custom queries.** Must select the whole target row. Their `where`/`orderBy`/joins
   apply; `limit` applies to the whole query (not per parent) — document it and point to the
   lateral-join recipe for "top N per parent". Association-level `where` options always apply.
4. **Join preloads.** `.preload({ posts: "p" })` adds `p`'s columns to the select. The
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
6. **Identity.** No identity map: the same post reached through two parents is two
   objects unless loaded by the same preload query, in which case children of a
   `belongsTo` share one instance per key (documented).
7. **`repo.preload(rows, spec, opts)`.** Skips associations already loaded unless
   `force: true`. Accepts `null`/empty input and returns it. Mixed schemas in one array throw.
8. **Types.** `preload(spec)` maps to the loaded type for strings, arrays, nested
   objects, custom queries, and alias strings: the argument is first mapped to a
   `PreloadSpec` (a custom query or an alias becomes `true`, `$from` is dropped), then
   checked with `ValidPreload` and typed with `LoadedUnchecked` (`contracts/schema.ts`). `repo.preload` over `Loaded<S, A>` with `B`
   returns `Loaded<S, A | B>`. Unknown association names are compile errors at any depth.
9. **`assoc(parents, name)`** returns a typed `Query` rooted at the target, filtered by the
   parents' keys, usable as any other query (`repo.all(assoc(user, "posts").where(...))`).
10. **Streaming and `one`.** Preloads work with `all`, `one`, `get*`, `reload`; not with `stream`.

## Preload conformance suite

Each association kind: empty/one/many children, null foreign keys, composite keys, uuid
keys; nested three levels; sibling associations; custom query with filter and order; join
preload with duplicates; has-through with de-duplication; many-to-many with join-table
`where`; preload inside a transaction; **query count assertions** via telemetry for every
case (the N+1 guard); 10k parents with chunking.

## Tests

- Unit (fake adapter): grouping and attachment for each kind; key chunking; ordering;
  `force`; non-mutation of inputs; join-preload de-duplication (property test: random
  parent/child sets flattened to join rows decode back to the original tree).
- Type tests: all spec forms, nested depth 3, alias form, cumulative `repo.preload`,
  `assocLoaded` narrowing, required vs optional `belongsTo` nullability.
- Integration: the conformance suite on Postgres.
- Benchmarks: 100 users × 10 posts (separate vs join strategy, vs hand-written two queries
  + manual stitching; budget < 20% over hand-written); 3-level preload.

## Docs (`guide/associations.md`)

Defining associations (recap), `joinAssoc` vs preload, the three preload strategies and
when to use each, nested preloads, custom queries and the per-parent-limit caveat, typing
with `Loaded`, `assoc()` queries, how to avoid N+1 and how to assert query counts in tests.

## Acceptance

- [ ] All five API forms work and are typed; conformance suite green on Postgres.
- [ ] Query-count assertions prove 1 + (number of association levels) queries in every case.
- [ ] Row shapes stay monomorphic per (schema, preload set) (shape test as in step 04).
- [ ] Budget met.

## Out of scope

Writing associations (15).
