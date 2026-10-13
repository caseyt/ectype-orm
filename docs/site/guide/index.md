# Introduction

::: warning Work in progress
Egon ORM is under construction and nothing is published yet.
:::

Egon ORM is a TypeScript ORM for Postgres, SQLite and MySQL. It keeps four things apart
that most ORMs blend together:

| Concept | What it is | Page |
|---|---|---|
| **Schema** | A class that describes a table: its fields, types and associations. Rows are instances of it. | [Schemas](/guide/schemas) |
| **Changeset** | A description of a change to one record: the filtered input, the validation errors, the constraints to check. | [Changesets](/guide/changesets) |
| **Query** | An immutable value that describes what to read or bulk-write. Nothing runs when you build one. | [Queries](/guide/queries) |
| **Repo** | The only thing that talks to the database. It runs queries and persists changesets. | [Repo](/guide/repo) |

```ts
import { Schema, t, timestamps, hasMany, cast, from, createRepo } from "egon-orm";
import { postgres } from "@egon-orm/postgres";

class User extends Schema("users", {
  id: t.integer().primaryKey(),
  email: t.string(),
  name: t.string().nullable(),
  ...timestamps(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });

  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name"]).validateRequired(["email"]).uniqueConstraint("email");
  }
}

const repo = createRepo({ adapter: postgres({ connectionString: process.env.DATABASE_URL }) });

const result = await repo.insert(User.changeset(User, { email: "a@b.c" }));
if (result.success) console.log(result.data.id);

const users = await repo.all(from(User, "u").where(({ u }) => u.name.isNotNull()).preload("posts"));
users[0].posts; // Post[]
```

## What to expect if you come from another ORM

- **No lazy loading.** An association is on a row only if you preloaded it, and the type
  says so. `user.posts` on a row loaded without it is a compile error.
- **Rows are data.** There is no `user.save()`. You describe a change with a changeset and
  hand it to the repo.
- **New records are changesets, not objects.** You never write `new User()`. A `User`
  object exists only after the database returned one.
- **Writes return a result.** `repo.insert` returns `{ success: true, data }` or
  `{ success: false, error }`, where `error` is the changeset with its errors.
  `repo.insertOrThrow` throws instead.
- **Fields are non-null by default.** `.nullable()` opts in.
- **Transactions are explicit.** Only calls on the transaction object are inside it.
- **Every value is a bound parameter.** Raw SQL is possible only through the `fragment`
  template, whose interpolations are bound too.

## Naming conventions

- Functions and options are camelCase.
- A method that returns `null` or a result has a throwing twin ending in `OrThrow`:
  `get` / `getOrThrow`, `insert` / `insertOrThrow`.
- Field names are camelCase in TypeScript and snake_case in the database (`createdAt` is
  the column `created_at`), unless a field says otherwise with `.column("...")`.
