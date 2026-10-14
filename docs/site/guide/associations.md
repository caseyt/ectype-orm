# Associations and preloading

An association says how two schemas are connected. It is used for three things: joining
in a query, loading related rows (preloading), and saving related rows through a parent
([Nested changesets](/guide/nested-changesets)).

Other libraries call these relations. In Postgres a "relation" is a table, so this
library says association.

## Defining associations

Associations are `static` members of the schema class. Each takes a function returning
the target class, so two schemas can refer to each other.

```ts
import { Schema, t, hasOne, hasMany, belongsTo, manyToMany } from "egon-orm";

export class User extends Schema("users", { id: t.integer().primaryKey().dbGenerated(), email: t.string() }) {
  static profile  = hasOne(() => Profile, { foreignKey: "userId" });
  static posts    = hasMany(() => Post, { foreignKey: "authorId", orderBy: ["createdAt"] });
  static comments = hasMany(() => Comment, { through: ["posts", "comments"] });
  static tags     = manyToMany(() => Tag, {
    joinThrough: "users_tags",
    joinKeys: { owner: "user_id", target: "tag_id" },
  });
}

export class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  authorId: t.integer(),
  title: t.string(),
}) {
  static author   = belongsTo(() => User, { foreignKey: "authorId" });
  static comments = hasMany(() => Comment, { foreignKey: "postId" });
}
```

| Function | Meaning | Loaded as |
|---|---|---|
| `belongsTo(() => T, opts?)` | This table holds the foreign key. | `T`, or `T \| null` when the foreign-key field is nullable |
| `hasOne(() => T, opts)` | The other table holds the foreign key; at most one row. | `T \| null` |
| `hasMany(() => T, opts)` | The other table holds the foreign key; any number of rows. | `T[]` |
| `manyToMany(() => T, opts)` | Connected through a join table. | `T[]` |

Rules:

- **The foreign-key column is an ordinary field.** `belongsTo` does not create `authorId`;
  you declare it, and the association refers to it by **field name**.
- **`foreignKey` is required on `hasOne` and `hasMany`.** On `belongsTo` it defaults to
  the property name plus `Id` (`author` gives `authorId`).
- **`references`** is the key on the other side and defaults to the primary key.
- **`manyToMany` with a table name requires `joinKeys`**, holding the join table's column
  names: `owner` points at this schema, `target` at the other. `joinThrough` may instead
  be a function returning a join schema class.
- **`through: ["posts", "comments"]`** follows a chain of associations. It is read-only.

### Options

| Option | On | Effect |
|---|---|---|
| `foreignKey` | all but `manyToMany` | The field holding the key. |
| `references` | all but `manyToMany` | The field the key points at. Defaults to the primary key. |
| `where` | `hasOne`, `hasMany`, `manyToMany` | A condition always applied when joining or preloading. |
| `orderBy` | `hasMany`, `manyToMany` | The default order of preloaded rows. |
| `onReplace` | all | What a nested write does with children that were left out. See [Nested changesets](/guide/nested-changesets#onreplace). |
| `through` | `hasOne`, `hasMany` | A chain of association names. |
| `joinThrough`, `joinKeys`, `joinWhere`, `unique` | `manyToMany` | The join table, its columns, a condition on it, and whether pairs are unique. |

Deleting a parent never touches its children. Use `ON DELETE` in the database.

Associations are checked the first time one is used. A wrong field name or a path that
does not resolve throws `SchemaDefinitionError` naming the schema, the association and
the fix.

## Joining through an association

`joinAssoc(from, name, alias)` is an ordinary SQL join whose `ON` condition is written
from the association. These two are the same query:

```ts
from(User, "u").joinAssoc("u", "posts", "p");
from(User, "u").join(Post, "p", ({ u, p }) => p.authorId.eq(u.id));
```

It reads: starting from the binding `u`, follow its `posts` association, and call the
joined table `p`. Beyond saving typing, it adds the join table for a many-to-many, the
whole chain for a `through`, and the association's `where`. `leftJoinAssoc` is the
left-join form. Both take an optional extra condition as a fourth argument.

A join does not load anything onto the parent rows. That is what preloading is for.

## Preloading

Nothing is loaded lazily. An association is on a row only when you ask for it, and the
row's type changes to say so.

### Short forms

```ts
repo.all(from(User, "u").preload("posts"));                        // one association
repo.all(from(User, "u").preload(["posts", "profile"]));           // several
repo.all(from(User, "u").preload({ posts: "comments" }));          // posts, then their comments
repo.all(from(User, "u").preload({ posts: ["comments", "tags"] }));
repo.all(from(User, "u").preload({ posts: { comments: "author" } }));
```

Each level is **one** extra query, whatever the number of rows: three nested levels over
ten thousand users is four queries.

### Callback form

To filter, order, limit or select, pass one association name and a function. The function
receives a query for the associated table, whose binding is named after the association,
and returns a query.

```ts
from(User, "u")
  .preload("profile")
  .preload("posts", (q) =>
    q.where(({ posts }) => posts.published)
     .orderBy(({ posts }) => posts.createdAt.desc())
     .limit(3)
     .preload("comments", (q) =>
       q.orderBy(({ comments }) => comments.createdAt).limit(5).preload("author")));
```

- **`limit` and `offset` are per parent.** The example loads the three newest published
  posts of *each* user. They need an order: the callback's `orderBy`, or the association's
  own. Without one the query throws `QueryError`.
- **Any function from query to query works**, so scopes are reusable:
  `.preload("posts", onlyPublished)`.
- **Several `.preload()` calls merge.**

### Selecting columns in a preload

A callback may `select`. The association is then loaded as plain objects of that shape:

```ts
const users = await repo.all(
  from(User, "u").preload("posts", (q) =>
    q.select(({ posts }) => ({ authorId: posts.authorId, title: posts.title }))),
);
users[0].posts; // { authorId: number; title: string }[]
```

**The select must include the association's key, under its field name**: the field the
association is matched on (`authorId` for `User.posts`, `id` for `Post.author`). Nothing
is added for you. If it is missing, the query throws when it is built:

```
QueryError: preload "posts" selects without its key. Add `authorId: posts.authorId` to the select.
```

Many-to-many is the exception: its key is in the join table, so the library fetches it.

A selected shape is not rows. To preload further below it, or to use the association in a
nested write, load whole rows.

### From a join

When the query already joins the association, the join can fill it in the same SQL
statement. Give the binding's alias:

```ts
from(User, "u")
  .joinAssoc("u", "posts", "p")
  .where(({ p }) => p.published)
  .preload({ posts: "p" });
```

A string is read as a binding alias only when the query has a binding of that name joined
through that association. Otherwise it is the name of a nested association.

Join preloads nest: `{ posts: { $from: "p", comments: "c" } }` fills `posts` from the
binding `p` and each post's `comments` from the binding `c`.

A join returns one row per parent-child pair, so a parent with many children is sent
many times. Prefer the separate-query forms unless you are filtering on the join anyway.

### After the fact

```ts
const loaded = await repo.preload(users, "posts");
const top3 = await repo.preload(users, "posts", (q) => q.limit(3));
await repo.preload(user, { posts: "comments" }, { force: true });
```

`repo.preload` takes one row, an array or `null`, and returns **new** objects: the inputs
are not changed, because their type is. It skips associations that are already loaded
unless `force: true`.

### The `Loaded` type

```ts
import type { Loaded } from "egon-orm";

function render(user: Loaded<typeof User, "posts">) {
  user.posts.map((p) => p.title);
}

type Deep = Loaded<typeof User, { posts: { comments: "author" } }>;
```

On a plain `User`, `user.posts` does not exist and is a compile error. `isLoaded(user,
"posts")` is the runtime check, and narrows the type.

### Things to know

- **No identity map.** The same record reached through two parents is two objects. Ten
  posts by the same author each get their own `User` object.
- **Sibling associations load one at a time.** `maxConcurrency` on the repo call raises
  that; inside a transaction they are always sequential.
- **Streams do not support preloads.** Load in batches instead.

## Querying an association directly

`assoc(parents, name)` returns a query for the associated rows of one or many parents. It
composes like any other query:

```ts
import { assoc } from "egon-orm";

const drafts = await repo.all(assoc(user, "posts").where(({ posts }) => posts.published.eq(false)));
```
