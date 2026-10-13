# Validation

Besides the [built-in validations](/guide/changesets#validations), a changeset can be
validated by Zod, by any other [Standard Schema](https://standardschema.dev) library
(Valibot, ArkType, recent Yup), or by a plain function. The core package depends on none
of them.

```ts
cs.validate(validator, opts?)             // synchronous
cs.validateAsync(validator, opts?)        // returns Promise<Changeset>
cs.validateField("email", validator)      // one field; runs only when it changed
cs.validateFieldAsync("email", validator)
```

## With Zod

```ts
import { z } from "zod";

const UserInput = z.object({
  email: z.string().email(),
  age: z.number().int().min(13).nullish(),
});

cast(User, params, ["email", "age"]).validate(UserInput);
```

Each issue becomes a changeset error on the field named by the first segment of its path,
with `validation: "schema"`. An issue with an empty path, or for a key that is not a
field, is stored under the key `BASE` (`"$base"`).

Cross-field rules work the same way:

```ts
cs.validate(
  z.object({ startsAt: z.date(), endsAt: z.date() })
    .refine((v) => v.endsAt > v.startsAt, { path: ["endsAt"], message: "must be after start" }),
);
```

## With a function

```ts
cs.validate((values, { isChanged }) =>
  isChanged("endsAt") && values.endsAt <= values.startsAt
    ? [{ path: "endsAt", message: "must be after start" }]
    : [],
);
```

```ts
type ValidatorFn<T> = (
  values: Readonly<T>,
  ctx: { changes: Readonly<Partial<T>>; data: Readonly<T>; isChanged(field: keyof T): boolean; action: Action | null },
) => ValidationIssue[] | void | Promise<ValidationIssue[] | void>;

type ValidationIssue = { path: PropertyKey | readonly PropertyKey[]; message: string; meta?: Record<string, unknown> };
```

`ctx.data` is the record before the changes. For a new record it holds the field defaults.

## What the validator receives

A plain object of **every field with the changes applied**: the current data, overlaid
with the changes, using the converted values (`Date`, numbers, enum strings). Virtual
fields are included.

## Options

| Option | Default | Effect |
|---|---|---|
| `scope` | `"all"` | `"all"` keeps every issue. `"changed"` keeps only issues on fields that have a change. |
| `apply` | `false` | When `true` and there are no issues, the validator's output is written back as changes, so transforms such as `.trim()` take effect. |
| `only` | all fields | Restrict the object, and the issues, to these fields. |

`scope: "all"` is the default so that a cross-field rule is never dropped because the
field it reports on happened not to change. Use `"changed"` when existing rows may hold
data that would no longer pass and should not block unrelated updates.

## Async validation

A changeset is synchronous. `validate` throws if the validator returns a promise; use
`validateAsync` and await it.

```ts
const checked = await cs.validateAsync(async (v) =>
  (await isDisposable(v.email)) ? [{ path: "email", message: "is not allowed" }] : [],
);
```

A validator that throws is a bug in the validator: the exception propagates and is not
turned into a validation error.

## Other libraries

Any object with a Standard Schema `~standard` property works: Valibot, ArkType, and Yup
versions that implement it. For a library that does not, wrap it in a function that
returns issues.

## Deriving Zod schemas from a schema class

`@egon-orm/zod` builds a Zod schema from a schema class, so the shape is written once.

```ts
import { toZod } from "@egon-orm/zod";

const UserZ = toZod(User);                                   // matches Row<typeof User>
const CreateUser = toZod(User, { mode: "insert", pick: ["email", "name", "age"] })
  .extend({ email: z.string().email() });
type CreateUser = z.infer<typeof CreateUser>;                // { email: string; name?: string | null; age?: number | null }
```

| Mode | Shape |
|---|---|
| `"row"` | Every field, exactly as in a row. The default. |
| `"insert"` | Fields are optional where an insert does not need them. |
| `"update"` | Every field optional. |

`pick` and `omit` are typed. `castWith(target, params, zodSchema)` is shorthand for `cast`
with the schema's keys as the permitted list, followed by `.validate(zodSchema)`.

## Choosing

- **Built-in validations** for single-field rules with standard messages.
- **A Zod schema** when you already have one, or want one definition shared with a client.
- **A function** for rules that need more than one field or outside state.
