# Nested changesets

A parent changeset can carry changes to its associated records, so a post and its
comments are validated together and saved in one transaction.

```ts
// From untrusted input
cast(post, params, ["title"]).castAssoc("comments", { with: Comment.changeset });

// From trusted data
change(post).putAssoc("tags", [tagA, tagB]);
change(comment).putAssoc("post", post);
```

For nested objects stored in a JSON column, see [Embeds](/guide/embeds).

## `castAssoc`

`castAssoc(name, { with?, required? })` reads the association's data from the params and
builds a child changeset for each item.

- **`with`** is the child's changeset function, called as `with(target, item, index)`.
  It defaults to the target schema's static `changeset` method.
- **`required: true`** adds `can't be blank` when the result is empty.
- **Params** are an object or `null` for a to-one association, and an **array** of objects
  for a to-many association.
- **The association must be preloaded** on a loaded parent, as whole rows. Otherwise
  `castAssoc` throws `NotLoadedError`. A new parent is treated as having no children.

### How items are matched

Each incoming item is compared with the existing children by primary key:

| Incoming item | Existing child | Result |
|---|---|---|
| has an id | with that id | `with(existingChild, item)`, an update |
| has no id, or an unknown id | none | `with(ChildClass, item)`, an insert |
| not in the params | exists | decided by `onReplace` |

For a to-one association, an item whose id matches updates the existing row; otherwise
the existing row is replaced according to `onReplace` and a new one is inserted.

### `onReplace`

`onReplace` is set on the association and decides what happens to an existing child that
the new data leaves out.

| Value | Effect |
|---|---|
| `"error"` | Throw. The default: nothing is removed unless you said how. |
| `"invalid"` | Add `is invalid` to the parent's field. |
| `"setNull"` | Set the child's foreign key to `null`. |
| `"update"` | To-one only: reuse the existing row and update it, whatever its id. |
| `"delete"` | Delete the child. |
| `"deleteIfExists"` | Delete the child, and do not fail if it is already gone. |

```ts
static items = hasMany(() => LineItem, { foreignKey: "orderId", onReplace: "delete" });
```

## `putAssoc`

`putAssoc(name, value)` sets an association from data you trust. Each value is one of:

- a **loaded row**: kept as it is;
- a **changeset**: inserted if it is for a new record, updated otherwise;
- a **plain object**: a new record, or an update when it carries the primary key of an
  existing child.

Children that are replaced follow `onReplace`. Putting the rows that are already there
changes nothing.

`buildAssoc(parent, name, values)` returns a changeset for a new child with its foreign
key already set:

```ts
const cs = buildAssoc(user, "posts", { title: "Hello" });   // Changeset<Post>, authorId = user.id
await repo.insert(cs);
```

## Errors

Child errors stay on the child changesets. The parent is invalid when any child is.

```ts
cs.changes.comments;   // Changeset<Comment>[]
cs.errorMessages();    // { comments: [{}, { body: ["can't be blank"] }] }
```

An issue from a schema validator whose path leads into an association is placed on the
matching child, so one nested Zod schema can validate the whole payload.

## Saving

`repo.insert` and `repo.update` save the whole tree:

1. Everything runs in **one transaction**, joining the current one if there is one.
2. **Order:** `belongsTo` targets first (their keys go into the parent), then the parent,
   then `hasOne` and `hasMany` children (which receive the parent's key), then
   `manyToMany` targets and their join rows.
3. Each child goes through the normal insert, update or delete path, so its own nested
   changes, constraints and optimistic locking apply.
4. **If any child fails, everything is rolled back** and the result is the parent
   changeset, with the failing child in place carrying its errors.
5. On success, the returned parent has the association loaded with the saved children.

Removing a many-to-many association deletes the join row only, unless `onReplace` is
`"delete"`.

## Recipes

- **A form with rows that can be added, edited and removed:** `castAssoc` with
  `onReplace: "delete"` on the association. Rows left out of the submitted array are
  deleted.
- **A tag picker:** `putAssoc("tags", tags)` with rows you looked up or created first,
  inside a [batch](/guide/batch).
