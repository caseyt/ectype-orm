# Step 03 — Type system

**Depends on:** 02. **Parallel with:** 07, 11.
**Owns:** `packages/core/src/types/`, `benchmarks/micro/types.bench.ts`, `docs/site/guide/types.md`.

## Goal

Implement every built-in `FieldType` and the mechanism for user-defined types. A type
answers three questions: how to **cast** untrusted input, how to read a driver value (**`fromDb`**),
how to write an application value (**`toDb`**); plus equality for change detection.

## Public API

```ts
import { t, defineType, parameterized } from "egon-orm";

// There is ONE public namespace, the field builder `t` (step 04). No `types` object is
// exported. A builder carries its FieldType, and every API that needs a type takes a
// builder: param("minAge", t.integer()), expr.cast(t.string()), schemaless changesets.
t.string()  t.integer()  t.bigint()  t.float()  t.decimal()  t.boolean()
t.bigint({ mode: "number" })   // 64-bit column as a JS number; CastError beyond the safe range
t.uuid()    t.binary()
t.date()        // "YYYY-MM-DD" string by default (no timezone bugs); see options
t.time()    t.timestamp()  t.localTimestamp()   // Date; usec variants via option
t.json<T>()                                      // jsonb
t.array(inner)   t.enum(["a", "b"])   t.enum({ a: 1, b: 2 })
t.type(customType)

// There is no `id` type: a key is t.integer().primaryKey(), a foreign key t.integer().

const Money = defineType<Money, string>({
  name: "money",
  db: { kind: "decimal" },
  cast(input) { /* -> { success: true, data } | { success: false, message } */ },
  fromDb: (s) => Money.parse(s),
  toDb: (m) => m.toString(),
  equal: (a, b) => a.eq(b),          // optional; default Object.is
});
```

Ownership: this step implements the `FieldType` objects and exports them from the
**internal** barrel only. The public surface is step 04's `t`; until it lands, test against
the internal objects.

`defineType` fills in defaults (`equal: Object.is`, `fromDb`/`toDb: IDENTITY`).
`parameterized((opts) => type)` is the equivalent of `Ecto.ParameterizedType`; `enum`,
`array` and `decimal({ precision, scale })` are built with it and results are memoised by options.

## Behaviour: cast table

Cast is lenient in the way Ecto is, because input usually comes from JSON or form data.
Anything not listed fails with `{ success: false }` (the changeset turns that into `"is invalid"`).

| Type | Accepts | Notes |
|---|---|---|
| string | `string` | Does **not** coerce numbers. Empty-string handling is the changeset's job (`emptyValues`). |
| integer | safe-integer `number`; `string` matching `/^-?\d+$/` within safe range; `bigint` within safe range | Rejects `1.5`, `"1.0"`, `NaN`, `Infinity`. |
| bigint | `bigint`; integer `number`; integer `string` | App type is `bigint`; with `{ mode: "number" }` it is `number`, and a value beyond the safe range fails the cast. |
| float | finite `number`; numeric `string` | Rejects `NaN`/`Infinity`. |
| decimal | `string` matching a decimal grammar; `number` (finite) | App type is `string` by default (lossless). Document how to plug in `decimal.js` via `defineType`. |
| boolean | `true`/`false`; `"true"`/`"false"`; `"1"`/`"0"`; `1`/`0` | As Ecto. |
| uuid | canonical 36-char string, any case | Normalised to lower case. |
| binary | `Uint8Array`/`Buffer` | |
| date | `"YYYY-MM-DD"`; `Date` (uses UTC date part); `{ year, month, day }` | Validates real calendar dates. Option `as: "date"` yields `Date`. |
| time | `"HH:MM[:SS[.ffffff]]"` | App type string. |
| timestamp | `Date` (valid); ISO-8601 string with offset or `Z` | Truncates to seconds unless `{ precision: "ms" \| "us" }`; default **ms** (JS `Date` resolution) (Ecto truncates to seconds). Rejects strings without an offset. |
| localTimestamp | `Date`; ISO string **without** offset | Interpreted as UTC wall time. |
| json | any JSON-serialisable value | No deep validation; that is what validators are for. |
| array(inner) | arrays; casts each element; fails if any element fails | Error meta includes the failing index. |
| enum | one of the declared values (string form); for mapped enums also accepts the dumped value | App type is the string-literal union. |

## Behaviour: `fromDb` and `toDb`

- `fromDb`/`toDb` must be `IDENTITY` whenever the driver already produces/accepts the app
  representation, so hydration can skip the call. For Postgres via `pg` that is true for
  string, integer (int4), float, boolean, uuid, json/jsonb, arrays of those, and `Date`
  for timestamptz.
- Dialect differences (int8 and numeric arriving as strings, SQLite booleans as 0/1,
  dates as text, JSON as text) are **not** handled here. Types expose their logical
  `db` kind and the adapter supplies overrides (`Adapter.typeOverrides`, step 11). Provide
  the hook: `resolveCodec(type, adapter) -> { fromDb, toDb }`, memoised per (type, adapter instance): two adapters of one
  dialect can be configured to read a type differently.
- `enum` with a mapping dumps to the mapped value and loads back.
- `array(inner)` composes inner fromDb/toDb, and is `IDENTITY` when inner is.

## Equality

`equal` drives changeset change detection. Defaults: `Object.is` for primitives; `Date`
by timestamp; `Uint8Array` by bytes; arrays element-wise with inner `equal`; json by
deep structural equality (write a small, fast one in `internal/`; do not `JSON.stringify`).

## Tests

- Unit: one table-driven test per type for cast (accept and reject lists above, plus
  hostile inputs: `null` prototype objects, objects with `toString`, huge strings, `-0`),
  fromDb, toDb, equal.
- Property (fast-check): for every type, `equal(fromDb(toDb(x)), x)` for valid `x`;
  `cast(x)` is idempotent on its own output; `cast` never throws for arbitrary input.
- Type tests: `FieldType<TApp>` inference for each builtin; `t.enum([...])` infers the
  literal union; `t.array(t.integer())` infers `number[]`.
- Benchmarks: cast of each scalar type; `resolveCodec` hit; array-of-int load for 1,000 elements.

## Docs (`guide/types.md`)

Type reference table (TS type, Postgres column, accepted cast inputs), writing a custom
type (Money example end to end), parameterized types, why dates and decimals are strings by default.

## Acceptance

- [ ] Every type in the Public API implemented and reachable through `t`; no public `types` export.
- [ ] Cast table behaviour covered by tests exactly as specified.
- [ ] Property tests pass with at least 1,000 runs each.
- [ ] No `fromDb`/`toDb` wrapper where `IDENTITY` is correct (asserted by tests).
- [ ] Custom and parameterized types work through the same public interface the builtins use.

## Out of scope

Field options (`nullable`, `default`): step 04. Dialect overrides: steps 11 and 17.
Embedded schemas as types: step 15.
