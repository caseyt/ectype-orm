# Step 06 — Validators: Zod, Standard Schema, custom functions

**Depends on:** 05. **Parallel with:** 08–12.
**Owns:** `packages/core/src/changeset/validators/`, `packages/zod/`,
`benchmarks/micro/validators.bench.ts`, `docs/site/guide/validation.md`.

## Goal

Let a changeset be validated by Zod (the documented default), by any other Standard Schema
library, or by a plain function, with one mechanism and no dependency in core.

## Public API

```ts
// Whole-changeset validation
cs.validate(validator, opts?)          // sync; throws if the validator returns a Promise
cs.validateAsync(validator, opts?)     // Promise<Changeset>

// Single-field validation; runs only when the field has a change (Ecto validate_change semantics)
cs.validateField("email", z.string().email())
cs.validateFieldAsync("email", validator)

type Validator<T> = StandardSchemaV1<unknown, unknown> | ValidatorFn<T>;

type ValidatorFn<T> = (
  values: Readonly<T>,                           // data with changes applied (see "Input")
  ctx: { changes: Readonly<Partial<T>>; data: Readonly<T>; isChanged(field: keyof T): boolean; action: Action | null },
) => ValidationIssue[] | void | Promise<ValidationIssue[] | void>;

type ValidationIssue = { path: PropertyKey | readonly PropertyKey[]; message: string; meta?: Record<string, unknown> };

type ValidateOptions = {
  scope?: "auto" | "changed" | "all";   // default "auto"
  apply?: boolean;                      // default false: write validator output back as changes
  only?: string[];                      // restrict to these top-level fields
};
```

Examples that must work verbatim (they become doc examples and tests):

```ts
// Zod
const UserInput = z.object({
  email: z.string().email(),
  age: z.number().int().min(13).nullish(),
});
cast(user, params, ["email", "age"]).validate(UserInput);

// Cross-field rule with Zod
cs.validate(z.object({ startsAt: z.date(), endsAt: z.date() })
  .refine((v) => v.endsAt > v.startsAt, { path: ["endsAt"], message: "must be after start" }));

// Plain function
cs.validate((v, { isChanged }) =>
  isChanged("endsAt") && v.endsAt <= v.startsAt ? [{ path: "endsAt", message: "must be after start" }] : []);

// Yup (Standard Schema in recent versions; otherwise the documented 10-line adapter using the function form)
cs.validate(yup.object({ email: yup.string().email().required() }));

// Async (e.g. a remote check)
await cs.validateAsync(async (v) => (await isDisposable(v.email)) ? [{ path: "email", message: "is not allowed" }] : []);
```

## Behaviour

1. **Dispatch.** A function is a `ValidatorFn`. An object with a `"~standard"` property
   whose `version === 1` is a Standard Schema; call `validator["~standard"].validate(input)`.
   Anything else throws a `TypeError` naming what was received.
2. **Input.** The validator receives a plain object of **all fields with changes applied**
   (`applyChanges`-like, without constructing a row instance), using app-level values
   (already cast: `Date`, numbers, enums). Virtual fields are included. `only` narrows the
   object to those keys. Build the object once per call, in field order.
3. **Scope** decides which issues are kept, by `path[0]`:
   - `"changed"`: only issues on fields that have a change (Ecto's rule: unchanged data is not re-validated).
   - `"all"`: every issue.
   - `"auto"` (default): `"all"` when `data` is in state `built` (an insert, where "missing" must be reported), `"changed"` when `loaded`.
   Issues with an empty path are always kept and stored under the exported key `BASE` (`"$base"`).
4. **Issue mapping.** `path[0]` selects the field; the error is
   `{ message, validation: "schema", meta: { path: rest, ...issue.meta } }`. A path into an
   association or embed that has a nested changeset (step 15) is routed into that nested
   changeset's errors; until step 15 lands, the remainder stays in `meta.path`.
   Standard Schema path segments may be `{ key }` objects; normalise them. Issues for
   unknown top-level keys go to `BASE` with the original path in meta.
5. **Ordering.** Errors are appended in the validator's issue order, after existing errors.
   A failing validator never removes changes.
6. **`apply: true`.** On success, for each key in the validator's output that is a schema
   field: if it differs (type `equal`) from the current field value, record it as a change.
   This lets Zod transforms (`.trim()`, `.toLowerCase()`) feed back. Output keys that are not
   fields are ignored. Not applied when there are issues.
7. **Sync vs async.** `validate`/`validateField` throw
   `"validator returned a Promise; use validateAsync"` if the result is thenable.
   The async variants accept both. A validator that throws: the exception propagates
   (it is a bug in the validator, not a validation failure).
8. **`validateField`.** Skipped when the field has no change. Input is the changed value
   alone. All issues map to that field; `issue.path` goes to `meta.path`.
9. **Introspection.** Each call appends `["$schema", { validator, opts }]` (or
   `[field, { schema: validator }]`) to `cs.validations`.

## `@ectype/zod`

Peer dependency on Zod (support the current major; state the range). Derives Zod schemas
from Ectype schemas so users do not write the shape twice:

```ts
import { toZod } from "@ectype/zod";

const UserZ = toZod(User);                      // z.object matching Row<User> (virtual included, redacted included)
const CreateUser = toZod(User, { mode: "insert", pick: ["email", "name", "age"] })
  .extend({ email: z.string().email() });
type CreateUser = z.infer<typeof CreateUser>;   // { email: string; name?: string | null; age?: number | null }
```

- Mapping: string→`z.string()`, integer/id→`z.number().int()`, bigint→`z.bigint()`,
  float→`z.number()`, decimal→`z.string()`, boolean, uuid→`z.string().uuid()` (or `z.uuid()`),
  date→string date, datetimes→`z.date()`, enum→`z.enum`, array→`z.array(inner)`,
  json/map→`z.unknown()`/`z.record`, embeds→nested object/array, custom types→`z.custom()`
  unless the type exposes a `zod` hint (define the hint interface here).
- Modes: `"row"` (exact row), `"insert"` (optional where `InsertShape` is optional),
  `"update"` (all optional). `pick`/`omit` are typed.
- The inferred Zod type must equal `Row<S>` / `InsertShape<S>` (type tests with `expectTypeOf().toEqualTypeOf`).
- Optional sugar: `castWith(data, params, zodSchema)` = `cast` with permitted keys taken from the schema's keys, then `.validate(schema)`.

## Tests

- Unit: dispatch; each scope against built and loaded data; path normalisation; `BASE`;
  `apply`; sync-with-promise error; thrown validator propagates; `only`.
- Compatibility matrix (dev dependencies only, one test file each): Zod, Valibot, ArkType,
  Yup. Each runs the same six scenarios. If Yup's installed version lacks Standard Schema,
  test and document the function adapter instead and say so in the status note.
- Type tests: `ValidatorFn<Row<User>>` parameter typing; `toZod` inference per mode.
- Property: for random params, `cast(...).validate(toZod(S, {mode:"insert"}))` in scope
  `"all"` reports an issue on a field exactly when that field's value violates its declared type/nullability.
- Benchmarks: `validate` with a 10-field Zod object (report overhead over calling Zod directly; target < 20%); function validator path (< 300 ns overhead).

## Docs (`guide/validation.md`)

Choosing between built-in validations, Zod schemas and functions; the scope rule with a
worked insert vs update example; cross-field rules; transforms with `apply`; async
validation and why it is separate; using Valibot/ArkType/Yup; deriving schemas with
`@ectype/zod`; writing a reusable validator.

## Acceptance

- [ ] All verbatim examples above compile and pass as tests.
- [ ] Core has no runtime or type dependency on Zod.
- [ ] Compatibility matrix green for four libraries (or adapter documented for Yup).
- [ ] `toZod` types equal the schema-derived types in all three modes.
- [ ] Overhead targets met.

## Out of scope

Routing issues into nested changesets beyond the hook described in item 4 (finished in 15).
