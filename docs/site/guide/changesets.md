# Changesets

A changeset describes a change to one record before anything is written: which values
were accepted, what changed, what is wrong, and which database constraints to watch for.
It is immutable and synchronous, and it never touches the database.

```ts
import { cast, change } from "egon-orm";

const cs = cast(User, params, ["email", "name", "age"])
  .validateRequired(["email"])
  .validateFormat("email", /^[^@\s]+@[^@\s]+$/)
  .validateLength("name", { min: 2, max: 80 })
  .validateNumber("age", { greaterThanOrEqualTo: 13 })
  .uniqueConstraint("email");

cs.valid;            // boolean
cs.changes;          // { email?: string | null; name?: string | null; age?: number | null }
cs.errors;           // { [field]: ChangesetError[] }
cs.errorMessages();  // { email: ["can't be blank"] }
cs.data;             // the loaded row, or null for a new record
cs.model;            // the schema class
cs.action;           // null | "insert" | "update" | "delete" | "replace" | "ignore"
```

## Creating a changeset

| Function | For | Notes |
|---|---|---|
| `cast(target, params, permitted, opts?)` | Untrusted input | Keeps only the permitted keys and converts each value to the field's type. |
| `change(target, values?)` | Trusted values | Typed; no conversion. |

`target` is one of:

- **a schema class**, for a new record: `cast(User, params, [...])`;
- **a loaded row**, for an update: `cast(user, params, [...])`;
- **a changeset**, to add more input to it;
- **`{ data, types }`**, for a changeset with no schema (see [Without a schema](#without-a-schema)).

A changeset function is usually a static method that accepts both:

```ts
static changeset(user: User | typeof User, params: unknown) {
  return cast(user, params, ["email", "name"]).validateRequired(["email"]);
}

User.changeset(User, input);   // new record
User.changeset(user, input);   // existing row
```

### What `cast` does

- `params` must be a plain object, `null` or `undefined`. Anything else throws `CastError`.
- Keys that are not in `permitted` are ignored. This is the protection against a request
  setting fields it should not.
- Each value is converted by the field's type (`"42"` becomes `42`). A value the type
  rejects adds the error `is invalid` and records no change.
- Empty strings become `null` (`emptyValues`, default `[""]`).
- A value equal to the current one is not a change.
- `permitted` is type-checked; an unknown field name throws.

### Required fields

Fields are non-null by default, and the changeset enforces that:

- Setting a non-nullable field to `null` adds `can't be blank`.
- A required field with no value at all is reported by `repo.insert` with the same error,
  before any SQL runs. It is not an error earlier, because you may still set it with
  `putChange`.

`validateRequired` is for stricter rules: it also rejects whitespace-only strings, and
works on nullable fields.

## Validations

Each validation runs only when its field has a change, unless noted.

| Method | Default message |
|---|---|
| `validateRequired(fields?, opts?)` | `can't be blank` |
| `validateFormat(field, regex)` | `has invalid format` |
| `validateInclusion(field, values)` | `is invalid` |
| `validateExclusion(field, values)` | `is reserved` |
| `validateSubset(field, values)` | `has an invalid entry` |
| `validateLength(field, { is?, min?, max? })` | `should be at least {count} character(s)` and variants |
| `validateNumber(field, { lessThan?, greaterThan?, lessThanOrEqualTo?, greaterThanOrEqualTo?, equalTo?, notEqualTo? })` | `must be greater than {number}` and variants |
| `validateConfirmation(field, opts?)` | `does not match confirmation` |
| `validateAcceptance(field)` | `must be accepted` |
| `validateChange(field, fn)` | whatever `fn` returns |

- `validateRequired` checks the changes **and** the existing data. With no field list it
  checks every non-nullable field that has no default.
- `validateLength` counts grapheme clusters for strings (`count: "codepoints" | "bytes"`
  changes that) and items for arrays.
- `validateConfirmation("password")` compares with `passwordConfirmation` in the params.
- `validateChange(field, (value) => ...)` returns a message, an error object, an array of
  either, or nothing.
- Every validation takes `{ message }`.

For Zod and other schema validators, see [Validation](/guide/validation).

## Errors

```ts
type ChangesetError = {
  message: string;                       // may contain {placeholders}
  validation?: string;                   // "required", "length", "cast", ...
  constraint?: string;                   // "unique", "foreignKey", ...
  meta: Record<string, unknown>;         // { count: 12, kind: "min" }
};
```

- `cs.errors` holds the raw errors per field.
- `cs.errorMessages()` returns `{ field: string[] }` with placeholders filled in.
- `traverseErrors(cs, fn)` lets you format each error yourself (translation, plurals) and
  descends into [nested changesets](/guide/nested-changesets).
- `cs.addError(field, message, meta?)` adds one by hand.

Errors are plain, serialisable objects and never contain the value of a redacted field.

## Working with changes

| Method | Effect |
|---|---|
| `putChange(field, value)` | Set a change (ignored if equal to the current value). |
| `forceChange(field, value)` | Set a change even if equal. |
| `deleteChange(field)` | Remove a change. |
| `updateChange(field, fn)` | Transform an existing change. |
| `merge(other)` | Combine two changesets of the same record. |
| `pipe(fn)` | Apply `fn(cs)`; for your own reusable steps. |

| Read | Returns |
|---|---|
| `getField(field)` | The change if there is one, else the current value, else the field's default. |
| `getChange(field)` | The change, or `undefined`. |
| `fetchField(field)` | `{ from: "changes" \| "data"; value }`, or `undefined`. |
| `fetchChange(field)` | `{ value }` when the field has a change, else `undefined`. Tells a change to `undefined` apart from no change. |
| `fieldMissing(field)` | Whether the field has no value in the changes or the data. |
| `isChanged(field, { from?, to? })` | Whether the field has a change. |
| `applyChanges()` | The data with the changes applied, without validating. |
| `applyAction(cs, action)` | A [result](/guide/repo#writing): the data with the changes applied if the changeset is valid, else the changeset. No database. |

`applyChanges` and `applyAction` work on a changeset of a loaded row and on a changeset
[without a schema](#without-a-schema). They are not available on a new-record changeset:
a row that the database never returned cannot exist.

```ts
const normalizeEmail = (cs: Changeset<typeof User>) =>
  cs.updateChange("email", (email) => email.trim().toLowerCase());

cast(User, params, ["email"]).pipe(normalizeEmail);
```

## Constraints

Constraint declarations tell the repo how to report a database violation as a changeset
error. They are covered in [Constraints](/guide/constraints).

## Hooks for the repo

- `optimisticLock("lockVersion")` makes an update fail if the row changed since it was read.
- `prepareChanges(fn)` runs `fn` just before the write, inside its transaction.
- `validateUniqueAsync(fields, repo)` checks the database for an existing row. It returns
  a promise, is subject to races, and is only a convenience for early feedback: always
  pair it with `uniqueConstraint`.

## Without a schema

A changeset can validate input that has no table, such as a search form:

```ts
const cs = cast(
  { data: {}, types: { q: t.string(), page: t.integer() } },
  params,
  ["q", "page"],
).validateNumber("page", { greaterThan: 0 });
```

## Inspecting

`console.log(cs)` prints `Changeset<User> { action, changes, errors, valid }` with
redacted fields hidden. `cs.validations` lists the validations that ran, for tools that
generate forms.
