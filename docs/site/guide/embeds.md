# Embeds

An embed is a structured object, or a list of them, stored inside one JSON column of its
parent. It has fields, types and validations like a schema, but no table.

```ts
import { EmbeddedSchema, Schema, t, cast } from "egon-orm";

class Address extends EmbeddedSchema({
  street: t.string(),
  city: t.string(),
  postCode: t.string().nullable(),
}) {
  static changeset(address: Address | typeof Address, params: unknown) {
    return cast(address, params, ["street", "city", "postCode"]).validateRequired(["street", "city"]);
  }
}

class Phone extends EmbeddedSchema({
  id: t.uuid().primaryKey().autogenerate(),
  label: t.string(),
  number: t.string(),
}) {}

class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  address: t.embedOne(() => Address).nullable(),
  phones: t.embedMany(() => Phone),
}) {}
```

- `t.embedOne(() => E)` is one object; `t.embedMany(() => E)` is an array.
- Both are stored as `jsonb` on Postgres, and as JSON text or native JSON elsewhere.
- Loaded embeds are instances of their class, so getters and methods work.
- Embeds can contain embeds.

## Changing embeds

```ts
// From untrusted input
cast(user, params, ["email"]).castEmbed("address", { with: Address.changeset, required: true });

// From trusted data
change(user).putEmbed("address", { street: "Karl Johans gate 1", city: "Oslo" });
```

`castEmbed` and `putEmbed` work like
[`castAssoc` and `putAssoc`](/guide/nested-changesets): child changesets, nested errors,
and `with` defaulting to the embed's static `changeset`.

- **Matching in a list** needs a primary key on the embed, as `Phone` has. Items are then
  matched by id and updated in place. Without a key, `castEmbed` replaces the whole list.
- **`onReplace`** is passed to the field: `t.embedOne(() => Address, { onReplace: "update" })`.
  The values are `"error"` (the default), `"invalid"`, `"update"` (one only) and `"delete"`.
- **Any change inside an embed rewrites the whole column.** The parent field counts as
  changed.

## Stored form

Each embedded field is written with its own type, so a `timestamp` is stored as an ISO
string and read back as a `Date`. When reading, keys that are not fields are ignored and
missing keys get the field's default.

The JSON keys are the field names as written: `postCode` is stored as `"postCode"`, not
`"post_code"`. `.column("pc")` renames one key, and `EmbeddedSchema(fields, { naming: "snake_case" })`
switches the whole embed to snake_case keys.

## Querying inside an embed

```ts
from(User, "u").where(({ u }) => u.address.field("city").eq("Oslo"));
```

`field(name)` is typed from the embed. The general JSON operators `path` and `pathText`
also work; see [Expressions](/guide/query-expressions#json).

## When to use an embed

Use an embed for data that belongs to exactly one parent and is always read with it: an
address, preferences, a list of phone numbers. Use an
[association](/guide/associations) when the data is shared, queried by itself, or large.
