# Constraints

Some rules can only be enforced by the database. Two requests can both check that an
email is free and both find that it is; only a unique index decides which one wins.

A constraint declaration on a changeset tells the repo: if the database rejects this write
for that reason, report it as an error on this field instead of throwing.

```ts
const cs = cast(User, params, ["email", "orgId"])
  .uniqueConstraint("email")
  .foreignKeyConstraint("orgId");

const result = await repo.insert(cs);
if (!result.success) result.error.errorMessages(); // { email: ["has already been taken"] }
```

## Declarations

| Method | Database constraint | Default message |
|---|---|---|
| `uniqueConstraint(field \| fields, opts?)` | unique index or constraint | `has already been taken` |
| `foreignKeyConstraint(field, opts?)` | foreign key, on insert or update | `does not exist` |
| `assocConstraint(assoc, opts?)` | the foreign key of a `belongsTo` | `does not exist` |
| `noAssocConstraint(assoc, opts?)` | foreign key, when deleting a parent that still has children | `is still associated with this entry` |
| `checkConstraint(field, { name, ... })` | check constraint | `is invalid` |
| `exclusionConstraint(field, opts?)` | exclusion constraint | `violates an exclusion constraint` |

Options: `name`, `match` (`"exact"`, `"suffix"` or `"prefix"`), `message`, and `errorKey`
(the field the error is reported on).

## How a violation is matched

The database reports the **name** of the constraint that failed. The declaration must
match that name.

With no `name`, one default is used:

| Declaration | Name matched |
|---|---|
| `uniqueConstraint("email")` on `users` | `users_email_key` |
| `uniqueConstraint(["orgId", "slug"])` on `projects` | `projects_org_id_slug_key` |
| `foreignKeyConstraint("orgId")` on `users` | `users_org_id_fkey` |

These are the names Postgres gives a constraint when you do not name it, and the ones
Prisma generates. Drizzle names unique constraints `users_email_unique`, and a unique
*index* is often named `users_email_index`. For any other name, pass it:

```ts
.uniqueConstraint("email", { name: "uq_users_email" })
```

A `checkConstraint` always needs a `name`.

## When a constraint was not declared

The repo throws a `ConstraintError` whose message says what to add:

```
unique constraint "users_email_key" violated on insert into "users".
The changeset has not defined this constraint. Add: .uniqueConstraint("email")
(or .uniqueConstraint("email", { name: "users_email_key" }))
```

## One error per attempt

The database stops at the first violation, so a write reports at most one constraint
error, even if several would fail. Validations, by contrast, all run and all report.

## Not-null

A `NOT NULL` violation is never converted. The repo checks required fields itself before
sending SQL; see [Required fields](/guide/changesets#required-fields).

## Early feedback

`validateUniqueAsync(fields, repo)` queries for an existing row and adds `has already been
taken` before the write is attempted. It cannot replace the constraint, because another
request can insert between the check and the write. Declare both.

## SQLite

SQLite reports a unique violation by its columns, not by an index name. The adapter turns
that into the default name, so `uniqueConstraint("email")` works. A custom `name` cannot be
matched there.
