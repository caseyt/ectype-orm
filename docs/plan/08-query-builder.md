# Step 08 — Query builder (Ecto.Query)

**Depends on:** 04, 07. **Parallel with:** 05, 10, 11.
**Owns:** `packages/core/src/query/builder.ts`, `packages/core/src/query/bindings.ts`,
`packages/core/src/query/select.ts`, `benchmarks/micro/builder.bench.ts`,
`docs/site/guide/queries.md`.

## Goal

The immutable, composable, fully typed `Query` value and its core clauses. The typing
skeleton is proven in `spikes/schema-typing.ts` (`Query<B, R>`, `Binding<S>`, `Sel<X>`,
`joinAssoc` target inference); build on it.

## Public API

```ts
type Query<B, R, P = {}>      // B: named bindings, R: result row type, P: required named params
type Queryable<...> = SchemaClass | Query

from(User, "u")                               // alias defaults to "root" when omitted
  .join(Post, "p", ({ u, p }) => p.authorId.eq(u.id))      // inner
  .leftJoin(Profile, "pr", ({ u, pr }) => pr.userId.eq(u.id))
  .rightJoin(...) .fullJoin(...) .crossJoin(Tag, "t")
  .joinAssoc("u", "posts", "p")                // inner join via association metadata
  .leftJoinAssoc("p", "comments", "c", ({ c }) => c.body.isNotNull())   // optional extra ON
  .where(({ u }) => u.age.gte(18))             // multiple where calls are ANDed
  .where({ role: "admin", name: null })        // object form on the root binding: eq / IS NULL / IN for arrays
  .orWhere(({ u }) => u.role.eq("admin"))
  .select(({ u, p }) => ({ id: u.id, title: p.title, author: u }))
  .selectMerge(({ p }) => ({ views: p.views }))
  .distinct()                                  // or .distinct(({ u }) => [u.email])  -> DISTINCT ON
  .groupBy(({ u }) => [u.id])
  .having(({ p }) => count(p.id).gt(3))
  .orderBy(({ u }) => [u.insertedAt.desc(), u.id])         // bare column = asc
  .limit(10).offset(20)
  .lock("FOR UPDATE")                          // typed union of standard modes; lock(fragment`...`) for others
  .prefix("tenant_1")
  .exclude("orderBy")                          // Ecto exclude/2
  .first() / .last() / .reverseOrder()         // Ecto first/last/reverse_order
  .preload("posts")                            // declared here, typed here, executed in step 14
  .pipe(fn)                                    // q.pipe(onlyPublished) === onlyPublished(q)

hasNamedBinding(q, "p")                        // type guard
```

Left/right/full joins make the joined binding's columns nullable in `B` (and, for
right/full, the existing bindings). Selecting a whole left-joined binding yields `Row<S> | null`.

## Behaviour

1. **Immutability and cost.** `Query` is a class wrapping a `QueryAst`. Every method
   returns a new `Query` with a new AST object that shares all untouched arrays
   (`wheres` gets a new array, everything else is the same reference). The `shape` hash and
   the params array are extended incrementally: O(size of the added clause), never a
   re-walk. Both are **canonical** (`contracts/query.ts`): they depend on the query's
   structure, not on the order its clauses were added. So the `Query` keeps, outside the
   AST, a param count, a list count and a hash per top-level `QueryAst` property; a new
   clause's params are spliced in at the offset those counts give, and `shape` is
   recombined from the per-property hashes. Budget: 3-clause query < 1.5 µs.
2. **Bindings.** For each `(schema, alias)` pair build the binding object once
   (`{ [field]: Col, $schema, $alias }`, plain object, own data properties) and cache it in
   a `Map` on the schema's metadata. The object passed to callbacks is assembled per query
   from cached bindings and cached on the `Query` instance, so repeated clause calls do not
   rebuild it. Nullable-by-join is a type-level concern only.
3. **Callbacks run once**, at build time. They must be pure. Returning a non-`Expr` where
   one is required throws `QueryError` with the clause name.
4. **`from`.** Accepts a schema class or a `Query` (then acts as identity/aliasing for the
   root, so that `from(baseQuery, "u")` rebinds nothing and merely continues it; if the
   aliases conflict, throw). Subquery and other sources are step 09. Duplicate alias
   anywhere in a query throws.
5. **`joinAssoc`.** Resolves association metadata to an ON condition:
   belongsTo/hasOne/hasMany → key equality; manyToMany → two joins (join table gets an
   internal alias); has-through → the chain of joins. Association `where` options are ANDed
   into ON. The target binding type comes from the association (spike-proven).
6. **`where` object form.** Keys are root-binding fields; value `null` → `IS NULL`; array →
   `IN`; anything else → `eq` with the field's type. `undefined` values throw (a classic
   accidental-full-table bug) with a message suggesting conditional composition.
7. **`select` typing (`Sel<X>`).** Allowed shapes: an `Expr`, a binding (whole row), an
   object or tuple of those (nested arbitrarily), and plain literals (returned as-is, not
   sent to the database). With no `select`, `R` is the root row (`Row<S>`, or
   `Loaded<S, P>` once `preload` is used). `selectMerge` requires an object select and merges types.
   Record a `SelectNode` describing the output tree so step 10/12 can build a decoder.
8. **Aggregation sanity.** No static GROUP BY validation (the database reports it), but
   `having` without `groupBy` and `selectMerge` over a non-object select throw early.
9. **`limit`/`offset`** take a non-negative integer or a `param(...)`; they are bound
   parameters, so different page sizes share one plan.
10. **Composition.** Queries compose by function: `const published = <B extends { p: Binding<typeof Post> }, R, P>(q: Query<B, R, P>) => q.where(({ p }) => p.published)`.
    Provide the helper types that make such signatures short (`QueryWith<{ p: typeof Post }>`),
    and test that composition preserves `R` and `P`.
11. **Named params.** `P` accumulates `{ name: Type }` from every `param(...)` used in any
    clause. Repo methods require `params: P` when `P` is non-empty (enforced in step 12).
12. **Preload declaration.** `.preload(spec)` validates the path against association
    metadata at build time and updates `R` to the loaded type. It is declared
    `preload<const P>(spec: P & ValidPreload<S, P>)` and returns `LoadedUnchecked<S, P>`
    (`contracts/schema.ts`), so that an unknown key is a compile error. Only valid when the select
    is the root row (or a binding marked for join-preload, step 14).
13. **Inspection.** `q.toString()` / inspect prints an Ecto-like rendering
    (`from u in User, where: u.age >= ?, ...`) for debugging; no values, respects redaction.

## Use cases to cover in tests and docs

- Filtering with optional criteria (`if (filters.role) q = q.where(...)`) keeps types.
- Pagination helper as a composable function.
- Join + aggregate + having (posts per author).
- Selecting a DTO, a tuple, a single column, a whole row plus computed fields.
- Reusing a base query in two different final queries (immutability check).
- Self-join with two aliases of the same schema.

## Tests

- Type tests: result type for each select shape; nullable propagation per join kind;
  unknown binding/field/association rejected; `P` accumulation; composition helpers;
  preload result types; getters on schema subclasses visible on results.
- Unit: AST snapshot per clause; immutability (original query unchanged, shared arrays
  identical by reference); alias collision; object-where rules; every `QueryError`.
- Integration smoke (once step 10 exists): each clause compiles; otherwise leave to step 10.
- Benchmarks: 3-clause build; 2 joins + select object; binding cache hit; `where` object form.

## Docs (`guide/queries.md`)

Building queries; bindings; each clause with Ecto side-by-side; composition patterns;
dynamic filters; select shapes and their result types; debugging with `toString`.

## Acceptance

- [ ] All listed methods implemented and typed; type tests cover each.
- [ ] Build budget met; binding objects provably cached (identity test).
- [ ] No mutation of any `Query` or AST after construction (tests run with deep-frozen ASTs in dev mode).
- [ ] Every error message names the clause and the offending binding/field.

## Out of scope

Subqueries, CTEs, set operations, windows, lateral joins, `dynamic`, update/delete
expressions (09). SQL generation (10). Executing preloads (14).
