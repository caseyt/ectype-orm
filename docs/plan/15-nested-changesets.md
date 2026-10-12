# Step 15 — Nested changesets and embeds

**Depends on:** 13, 14. **Parallel with:** 16 (needs 16's transaction primitive; if 16 has
not landed, use `adapter.acquire()` + `begin` directly behind a small internal helper and
switch over afterwards).
**Owns:** `packages/core/src/changeset/nested/`, `packages/core/src/repo/nested.ts`,
`packages/core/src/types/embed.ts`, `packages/core/test/conformance/nested/`,
`docs/site/guide/nested-changesets.md`, `docs/site/guide/embeds.md`.

## Goal

Cast, validate and persist associations and embedded schemas through a parent changeset,
with Ecto's semantics for matching, replacing and ordering.

## Public API

```ts
// Associations from external params
cast(post, params, ["title"])
  .castAssoc("comments", { with: Comment.changeset, required: false, sortParam?: "commentsSort", dropParam?: "commentsDrop" })

// Associations from trusted data (rows, changesets, or plain objects)
change(post).putAssoc("tags", [tagA, tagB])
change(comment).putAssoc("post", post)

// Embeds
cast(user, params, ["email"]).castEmbed("address", { with: Address.changeset, required: true })
change(user).putEmbed("address", new Address({ city: "Oslo" }))

// Convenience
buildAssoc(user, "posts", { title: "Hi" })      // new Post with authorId set (Ecto.build_assoc/3)
```

`onReplace` is declared on the association/embed (step 04):
`"raise"` (default) | `"markAsInvalid"` | `"nilify"` | `"update"` (to-one only) | `"delete"` | `"deleteIfExists"`.

## Behaviour

### Casting (`castAssoc` / `castEmbed`)

1. The association must be **loaded** on the parent data when the parent is `loaded`
   (otherwise throw `NotLoadedError` telling the user to preload). `built` parents are treated as empty.
2. Params for to-one: an object or `null`. For to-many: an array of objects, or an object
   whose values are objects keyed by index (HTML forms), sorted by numeric key.
3. **Matching** (to-many): each param item is matched to an existing child by primary key
   (cast with the key's type). Match → `with(existingChild, item)` → action `update`.
   No match or no id → `with(new Child(), item)` → action `insert`.
   Existing children absent from params → handled per `onReplace`:
   `raise` throws; `markAsInvalid` adds `"is invalid"` on the parent field; `nilify` produces an
   update changeset setting the foreign key to `null`; `delete` produces a changeset with action `delete`.
4. To-one: params with matching id → update; otherwise the old one is replaced per
   `onReplace` (`update` reuses the existing row regardless of id) and a new one is inserted.
5. `with` defaults to the target's static `changeset` function if one exists; otherwise it
   is required (compile error where detectable, runtime error otherwise). It may take a
   third argument, the item's position.
6. `required: true` adds `"can't be blank"` when the result is empty/null.
   `sortParam`/`dropParam` behave as in Ecto 3.10+.
7. Result: `cs.changes[assoc]` holds a child changeset (to-one) or an array of child
   changesets (to-many). The parent's `valid` is false if any child is invalid. Child
   errors stay on the children; `traverseErrors` descends into them and produces nested
   output (`{ comments: [{}, { body: ["can't be blank"] }] }`).
8. Standard Schema issues with paths into a nested association/embed (step 06 item 4) are
   routed to the matching child changeset by index/key.

### `putAssoc` / `putEmbed`

Accepts rows (`built` → insert, `loaded` → kept as-is, or update if wrapped in a
changeset), changesets, or plain objects (→ `change(new Target(), obj)`; for objects with
a primary key of an existing child → update). Replacement of existing children follows
`onReplace`. Putting the same loaded rows that are already there is a no-op.

### Persistence (`repo/nested.ts`, plugged into step 13's hook)

1. Any write whose changeset contains nested changes runs in a transaction (joins the
   current one if already inside `repo.transaction`).
2. Order: **parent `belongsTo` children first** (so their keys can be written into the
   parent's foreign key) → the parent row → `hasOne`/`hasMany` children (foreign key set
   from the parent) → `manyToMany` (target rows, then join rows; removed associations
   delete join rows only, unless `onReplace: "delete"`).
3. Each child goes through the normal insert/update/delete path, so its own nested
   changes, `prepareChanges`, constraints and optimistic locking all apply recursively.
4. If any child fails (invalid, or a handled constraint), roll back and return
   `err(parentChangeset)` with the failing child changeset in place carrying its errors
   and `action`. Nothing is partially written.
5. On success the returned parent row has the association loaded with the persisted
   children (deleted ones removed).
6. Deleting a parent does not touch children; that is the database's `ON DELETE` (documented).

### Embeds

- `t.embedOne`/`t.embedMany` fields are stored in one `jsonb` column. The embed type
  (`types/embed.ts`) dumps each embedded row by dumping its fields with their own types
  (dates as ISO strings, etc.) and loads by constructing embedded rows through the embedded
  schema's factory. Nested embeds supported. Unknown keys in stored JSON are ignored;
  missing keys get defaults.
- Embedded schemas may declare `id: t.uuid().primaryKey().autogenerate()` to enable
  matching in `embedMany`; without a key, `castEmbed` on `embedMany` replaces the whole list.
- `onReplace` for embeds: `raise` | `markAsInvalid` | `update` (one) | `delete`.
- Any change inside an embed marks the parent field as changed and rewrites the whole column.
- Querying inside embeds uses the JSON path operators from step 07
  (`u.address.path("city")`); add typed sugar `u.address.field("city")` → `Expr<string>`.

## Use cases to cover in tests and docs

- Blog post form with dynamic comment rows: add, edit, delete in one submit.
- Tag picker: `putAssoc` with existing tags and find-or-create new ones inside a `Multi`.
- User with an embedded address and a list of embedded phone numbers.
- Order with line items where removing an item deletes it (`onReplace: "delete"`).
- API payload validated by one nested Zod schema, errors landing on the right child.

## Tests

- Unit: matching table (id present/absent/unknown/duplicate × existing/none) for each
  `onReplace`; form-style indexed params; `required`; error traversal shape; put variants;
  embed dump/load round trip (property test) including nested embeds and dates.
- Type tests: `castAssoc`/`putAssoc` names and value types; `with` signature; embed field
  types in `Row`, `InsertShape`, and query expressions.
- Integration (conformance/nested, Postgres): each association kind inserted and updated
  through the parent; replace semantics verified in the database; rollback on child
  failure leaves no rows; belongsTo-first ordering; many-to-many join rows; recursive depth 3; embeds stored and queried.

## Docs

`nested-changesets.md` (cast vs put, matching rules with a table, `onReplace` options with
consequences, persistence order, error shapes, forms recipe) and `embeds.md`.

## Acceptance

- [ ] All matching/replacement combinations behave as Ecto documents; table-driven tests cover them.
- [ ] Failed nested writes are atomic (verified against the database).
- [ ] Nested validator issue routing completed (closes step 06 item 4).
- [ ] Embed round-trip property test passes; embedded rows are instances of their schema class.

## Out of scope

Polymorphic associations. Cascading deletes in application code.
