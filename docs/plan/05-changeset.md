# Step 05 — Changeset core

**Depends on:** 04. **Parallel with:** 08, 10, 11.
**Owns:** `packages/core/src/changeset/` (except `validators/` → step 06 and `nested/` → step 15),
`benchmarks/micro/changeset.bench.ts`, `docs/site/guide/changesets.md`.

## Goal

The `Changeset` value: filtering and casting external params, tracking changes against
existing data, built-in validations, constraint declarations, and error handling. Pure,
synchronous, immutable, no database.

## Public API

```ts
import { cast, change, Changeset, applyAction, traverseErrors } from "egon-orm";

const cs = cast(User, params, ["email", "name", "age"], { emptyValues: [""] })   // new record: pass the class
  .validateRequired(["email"])
  .validateFormat("email", /^[^@\s]+@[^@\s]+$/)
  .validateLength("name", { min: 2, max: 80 })
  .validateNumber("age", { greaterThanOrEqualTo: 13 })
  .uniqueConstraint("email");

cs.valid;            // boolean
cs.changes;          // { email?: string | null, name?: string | null, age?: number | null }
cs.errors;           // { [field]: ChangesetError[] }
cs.data;             // the loaded User, or null for a new record
cs.model;            // the schema class (User)
cs.action;           // null | "insert" | "update" | "delete" | "replace" | "ignore"
```

### Constructors

| Function | Ecto | Notes |
|---|---|---|
| `cast(target, params, permitted, opts?)` | `cast/4` | `target` is a **schema class** (new record), a loaded row (update), a changeset (re-cast, merges), or `{ data, types }` for schemaless changesets. |
| `change(target, changes?)` | `change/2` | `target` as for `cast`. Trusted, typed changes (`Partial<InsertShape>` for a class); no casting; only values that differ are recorded. |

### Instance methods (all return a new `Changeset`)

Changes: `putChange(field, value)`, `forceChange(field, value)`, `deleteChange(field)`,
`updateChange(field, fn)`, `merge(other)`, `pipe(fn)` (applies `fn(cs)`, for user-defined steps).

Reads (not chainable): `getField(field, default?)`, `getChange(field, default?)`,
`fetchField(field)` → `{ from: "changes" | "data"; value } | undefined`, `fetchChange(field)`,
`isChanged(field, { from?, to? })`, `applyChanges()` → row with changes applied (no validation;
**only on a changeset of a loaded row**: a compile error and a runtime `QueryError` on a
new-record changeset, because a partial row must never exist),
`fieldMissing(field)`.

Validations — each runs **only if the field has a change** unless noted:

| Method | Default message | Notes |
|---|---|---|
| `validateRequired(fields?, opts?)` | `can't be blank` | Checks changes **and** data. Missing = `undefined`, `null`, or whitespace-only string (`trim` option, default true). With no `fields` argument: every non-nullable persisted field without a default or generator (Egon addition). |
| `validateFormat(field, regex)` | `has invalid format` | |
| `validateInclusion(field, values)` / `validateExclusion` | `is invalid` / `is reserved` | |
| `validateSubset(field, values)` | `has an invalid entry` | arrays |
| `validateLength(field, { is?, min?, max?, count? })` | `should be at least {count} character(s)` etc. | Strings count grapheme clusters by default (`count: "graphemes" \| "codepoints" \| "bytes"`); arrays say `item(s)`. Message variants exactly as Ecto. |
| `validateNumber(field, { lessThan?, greaterThan?, lessThanOrEqualTo?, greaterThanOrEqualTo?, equalTo?, notEqualTo? })` | `must be greater than {number}` etc. | |
| `validateConfirmation(field, opts?)` | `does not match confirmation` | Reads `<field>Confirmation` from **params**; error is added to the confirmation key. `required` option. |
| `validateAcceptance(field)` | `must be accepted` | Reads params; field need not exist on the schema. |
| `validateChange(field, fn)` | — | `fn(value, field)` returns `string \| ChangesetError \| (string \| ChangesetError)[] \| void`. |

Every validation accepts `{ message }` (string, or function receiving meta) and records
itself in `cs.validations` (`[field, descriptor]`) for introspection (e.g. form generators).

Errors: `addError(field, message, meta?)`, `traverseErrors(cs, fn)` (recursive into nested
changesets, interpolates `{key}` via `fn`), `cs.errorMessages()` (convenience: interpolated
`{ field: string[] }`).

Constraints (declarations only; step 13 enforces them): `uniqueConstraint(field | fields, { name?, match?, message?, errorKey? })`,
`foreignKeyConstraint(field, opts)`, `assocConstraint(assoc, opts)`, `noAssocConstraint(assoc, opts)`,
`checkConstraint(field, { name, ... })`, `exclusionConstraint(field, opts)`.
Default names: a unique constraint with no `name` matches any of `<source>_<column(s)>_key`
(Postgres and Prisma), `<source>_<column(s)>_unique` (Drizzle) and
`<source>_<column(s)>_index`; a foreign key matches `<source>_<column>_fkey`. So the
`Constraint` contract carries a list of candidate names (a contract refinement; record it).
Messages: `has already been taken`, `does not exist`, `is still associated with this entry`, `is invalid`, `violates an exclusion constraint`.

Repo integration hooks (stored, used by step 13): `optimisticLock(field, incrementer?)`,
`prepareChanges(fn)`, `validateUniqueAsync(fields, repo, opts)` (returns a Promise; documented
as racy, lives here for API parity but is implemented in step 13).

Actions: `applyAction(cs, action)` → `Result<Row, Changeset>` (sets `action`; no database).

## Behaviour

0. **New records.** A changeset built from a class has `data === null` and `model` set.
   `getField`/`fetchField` fall back to the field's default (calling function defaults)
   and then to `undefined`. "Differs from the current value" compares with that default.
   A changeset of a loaded row has `data` set and `model` equal to its class.
1. **`cast`.**
   - `params` must be a plain object or `null`/`undefined` (treated as `{}`); anything else throws `CastError`. Keys are field names; unknown and non-permitted keys are ignored silently. Symbol keys ignored. Never read from the prototype chain (`Object.hasOwn`).
   - `permitted` is typed as `(keyof Row)[]` and checked at runtime; an unknown field throws.
   - For each permitted key present: values in `emptyValues` (default `[""]`) become `null`; `null` is recorded as a change to `null` without calling the type; otherwise `field.type.cast(value)`. Failure adds `{ message: "is invalid", validation: "cast", meta: { type } }` (plus any message/meta the type returned) and records **no** change.
   - A cast value `equal` to the current data value is not a change (`forceChanges: true` overrides). Uses the type's `equal`.
   - Casting a field declared as an association or embed throws, pointing at `castAssoc`/`castEmbed`.
   - Re-casting an existing changeset merges params and changes and keeps errors.
2. **Immutability, cheaply.** Each method returns a new `Changeset` sharing every unchanged
   member with its predecessor (copy-on-write for `changes`, `errors`, lists). A validation
   that passes must allocate at most the new wrapper and its `validations` entry.
   `valid` is a stored boolean, not recomputed.
3. **Types.** `Changeset<S>` is generic over the schema; `field` arguments are constrained
   to field names (validations of the wrong value type, e.g. `validateLength` on a number
   field, are compile errors). `changes` is `{ [K]?: Row<S>[K] | null }`.
4. **Null and required.** Fields are non-null by default (D3), and the changeset enforces
   it without extra calls: `cast` (and `change`, `putChange`) adds `can't be blank`
   (`validation: "required"`) when a **non-nullable** field is set to `null`, and records
   no change. A required field that is merely *absent* is not an error here (it may be
   set later with `putChange`); step 13 reports it at insert time with the same message.
   `validateRequired` remains for stricter rules (blank strings, nullable fields).
5. **Error identity.** `ChangesetError` objects are plain, serialisable, and contain no
   values from redacted fields.
6. **`toJSON` / inspect.** A changeset inspects as `Changeset<User> { action, changes, errors, valid }` with redaction applied:
   `changes` is a plain object, so it is formatted with `formatStruct` and the schema's
   redacted field names (`internal/inspect.ts` redacts rows by itself, not plain objects).

## Use cases to cover in tests and docs

- Registration form: cast + required + format + length + confirmation + acceptance.
- Partial update of a loaded row: only changed fields appear in `changes`; no-op update yields empty `changes`.
- Schemaless changeset for a search form (`{ data: {}, types: { q: t.string(), page: t.integer() } }`).
- Multiple changeset functions on one schema (registration vs profile update).
- Custom reusable step via `pipe` (`cs.pipe(normalizeEmail)`).
- Error rendering with `traverseErrors` and pluralisation of `{count}`.

## Tests

- Unit: one describe block per method with accept/reject tables; Ecto's own
  `changeset_test.exs` is the behavioural oracle — port its cases for cast, change,
  each validation and each message variant.
- Property: `cast` never throws on arbitrary JSON params; `change(row, applyChanges-derived values)` round-trips (loaded rows); applying the same validation twice is idempotent on `valid`; `cs.valid === (no errors anywhere)`.
- Type tests: field-name constraints, value-type constraints per validation, `changes` type, schemaless inference.
- Benchmarks: `cast` 10 fields; cast + 5 validations (budget < 3 µs); a passing validation's allocation count (assert via `--expose-gc` heap delta or by structural-sharing identity checks).

## Docs (`guide/changesets.md`)

Concept (why changesets), `cast` vs `change`, each validation with its message, custom
validations, error format and i18n, constraints overview (detail in the Repo guide),
schemaless changesets, a "Good to know" box (no constructor: pass the class; non-null by default).

## Acceptance

- [ ] Every function in the Public API implemented with Ecto's default message texts, `{count}`-style placeholders and camelCase meta keys.
- [ ] Ported Ecto test cases pass (list the ported sections in the status note).
- [ ] Structural sharing verified by tests (`cs2.changes === cs1.changes` after a passing validation).
- [ ] Budget met.
- [ ] No database or adapter import anywhere in this module.

## Out of scope

Standard Schema / Zod / function validators (06). `castAssoc`, `putAssoc`, `castEmbed` (15).
Constraint enforcement and `validateUniqueAsync` execution (13).
