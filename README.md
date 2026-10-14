# Egon ORM

A TypeScript ORM with **schemas**, **changesets**, a composable **query builder** and a
**repo**, typed end to end with no code generation.

> **Status: under construction.** Nothing is published yet, and the examples below show
> the API being built. The design and build plan live in
> [`docs/plan/README.md`](docs/plan/README.md).

## At a glance

### Define a schema

A schema is a class that describes one table. Its instances are the rows you get back.

```ts
import { Schema, t, timestamps, hasMany, belongsTo, cast, change } from "egon-orm";
import { z } from "zod";

export class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),                     // non-null unless you say otherwise
  name: t.string().nullable(),
  age: t.integer().nullable(),
  ...timestamps(),                       // createdAt, updatedAt
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });

  // A changeset function says what this form may change, and how to check it.
  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name", "age"])
      .validateRequired(["email"])
      .validate(z.object({ email: z.string().email() }))
      .validateLength("name", { min: 2, max: 80 })
      .validateNumber("age", { greaterThanOrEqualTo: 13 })
      .uniqueConstraint("email");
  }
}

export class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
  published: t.boolean().default(false),
  authorId: t.integer(),
  ...timestamps(),
}) {
  static author = belongsTo(() => User, { foreignKey: "authorId" });
}
```

### Write through a changeset

```ts
import { createRepo } from "egon-orm";
import { postgres } from "@egon-orm/postgres";

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

const result = await repo.insert(User.changeset(User, input));

if (!result.success) {
  // Validation errors and database constraint violations come back the same way:
  result.error.errorMessages(); // { age: ["must be greater than or equal to 13"] }
  //                               { email: ["has already been taken"] }
} else {
  result.data; // User, with its id and timestamps filled in
}
```

### Read with a query

```ts
import { from, count, type Loaded } from "egon-orm";

const q = from(User, "u")
  .joinAssoc("u", "posts", "p")
  .where(({ u, p }) => u.age.gte(18).and(p.published))
  .groupBy(({ u }) => u.id)
  .orderBy(({ u }) => u.createdAt.desc())
  .select(({ u, p }) => ({ id: u.id, email: u.email, posts: count(p.id) }));

const rows = await repo.all(q); // { id: number; email: string; posts: number }[]
```

### Load associations up front

```ts
const authors = await repo.all(
  from(User, "u").preload("posts", (q) => q.orderBy(({ posts }) => posts.createdAt.desc()).limit(3)),
);
authors[0].posts[0].title; // string

const plain = await repo.getOrThrow(User, 1);
plain.posts; // compile error: "posts" was not preloaded
```

## Why Egon ORM

### Changesets, not mutable models

Most ORMs have you assign properties to a model and then ask whether it is valid. In Egon,
a change is a value of its own: a **changeset** holds the permitted input, converted to
the right types, the validation errors, and the database constraints to watch for.

- Each form is a function that permits its own fields, so a sign-up form cannot set `role`
  and a profile form is not rejected because of a field it never touched.
- A unique index or a foreign key violated at write time comes back as a field error
  (`email: ["has already been taken"]`), not as a driver exception to parse.
- Writes return `{ success: true, data } | { success: false, error }`. A rejected input is
  an expected, typed outcome; every write also has an `...OrThrow` twin.

### Immutable all the way through

- **Rows are data.** There is no `user.save()` and no dirty tracking. A row comes only from
  the database, and nothing changes it behind your back.
- **Changesets are immutable.** Every method returns a new changeset; the row you started
  from is never modified.
- **Queries are immutable values.** Building one runs nothing, so you can make one in a
  function, extend it somewhere else and reuse it safely:

```ts
const published = from(Post, "p").where(({ p }) => p.published);
const recent = published.orderBy(({ p }) => p.createdAt.desc()).limit(10); // `published` is unchanged
```

### Nothing implicit

- **No hidden queries.** The SQL that runs is the SQL your query describes.
- **Explicit transactions.** Only calls on the transaction object run inside it; there is
  no ambient transaction picked up from somewhere else.

```ts
await repo.transaction(async (tx) => {
  const user = await tx.insertOrThrow(User.changeset(User, input));
  await tx.insertOrThrow(change(Post, { title: "Hello", authorId: user.id }));
});
```

- **No raw SQL strings.** Every value is a bound parameter. The one way to write SQL by
  hand is the `fragment` template, and its interpolations are bound too.
- **Non-null by default.** A field is nullable only when it says `.nullable()`, and the
  row type says so.

### No lazy loading, enforced by the compiler

An association is on a row only if you preloaded it, and the row's type records which
ones you did. Reading one you did not load does not trigger a surprise query (the N+1
problem) and does not return `undefined` at runtime: it fails to compile.

```ts
function render(user: Loaded<typeof User, "posts">) {
  return user.posts.map((p) => p.title); // fine: the type requires posts
}

render(await repo.getOrThrow(User, 1)); // compile error: posts not loaded
```

### Validation where the data comes in

- Built-in checks for the common cases: `validateRequired`, `validateLength`,
  `validateFormat`, `validateNumber`, `validateInclusion` and more.
- Bring your own validator: Zod, Valibot, ArkType or any other
  [Standard Schema](https://standardschema.dev) library, or a plain function. The core
  package depends on none of them.
- The built-in checks look at what changed, so an update is not rejected because of an old
  value it never touched.
- Types come from the schema: rows, preloaded associations and `select` results are all
  inferred, with no code generation step.

## Packages

| Package | Purpose | State |
|---|---|---|
| `egon-orm` | Schemas, types, changesets, queries, Repo | placeholder |
| `@egon-orm/postgres` | PostgreSQL adapter (tier 1) | placeholder |
| `@egon-orm/zod` | Derive Zod schemas from Egon ORM schemas | placeholder |
| `@egon-orm/sqlite`, `@egon-orm/mysql` | Tier 2 adapters | private placeholders |
| `@egon-orm/cli` | Migrations and generators | private placeholder (follow-up) |

## Development

Requires Node.js 22.12 or newer, pnpm 12 and Docker.

```sh
pnpm i
pnpm db:up              # Postgres 16 on localhost:54329
pnpm check              # lint + typecheck + unit tests + type tests + build
pnpm test:integration   # needs the database
pnpm bench              # micro-benchmarks
pnpm docs:dev           # documentation site
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for everything else.

## License

[MIT](LICENSE)
