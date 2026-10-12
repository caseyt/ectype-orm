# Step 03 — Type system (Ecto.Type)

**Depends on:** 02. **Parallel with:** 07, 11.
**Owns:** `packages/core/src/types/`, `benchmarks/micro/types.bench.ts`, `docs/site/guide/types.md`.

## Goal

Implement every built-in `EctoType` and the mechanism for user-defined types. A type
answers three questions: how to **cast** untrusted input, how to **load** a driver value,
how to **dump** an application value; plus equality for change detection.

## Public API

```ts
import { types, defineType, parameterized } from "ectype";

types.string  types.integer  types.bigint  types.float  types.decimal  types.boolean
types.id          // integer primary/foreign key (alias of integer with db bigint)
types.uuid    types.binary
types.date        // "YYYY-MM-DD" string by default (no timezone bugs); see options
types.time    types.utcDatetime  types.naiveDatetime   // Date; usec variants via option
types.json<T>()  types.map<T>()                         // jsonb
types.array(inner)   types.enum(["a", "b"])   types.enum({ a: 1, b: 2 })

const Money = defineType<Money, string>({
  name: "money",
  db: { kind: "decimal" },
  cast(input) { /* -> { ok: true, value } | { ok: false, message } */ },
  load: (s) => Money.parse(s),
  dump: (m) => m.toString(),
  equal: (a, b) => a.eq(b),          // optional; default Object.is
});
```

`defineType` fills in defaults (`equal: Object.is`, `load`/`dump: IDENTITY`).
`parameterized((opts) => type)` is the equivalent of `Ecto.ParameterizedType`; `enum`,
`array` and `decimal({ precision, scale })` are built with it and results are memoised by options.

## Behaviour: cast table

Cast is lenient in the way Ecto is, because input usually comes from JSON or form data.
Anything not listed fails with `{ ok: false }` (the changeset turns that into `"is invalid"`).

| Type | Accepts | Notes |
|---|---|---|
| string | `string` | Does **not** coerce numbers. Empty-string handling is the changeset's job (`emptyValues`). |
| integer / id | safe-integer `number`; `string` matching `/^-?\d+$/` within safe range; `bigint` within safe range | Rejects `1.5`, `"1.0"`, `NaN`, `Infinity`. |
| bigint | `bigint`; integer `number`; integer `string` | App type is `bigint`. |
| float | finite `number`; numeric `string` | Rejects `NaN`/`Infinity`. |
| decimal | `string` matching a decimal grammar; `number` (finite) | App type is `string` by default (lossless). Document how to plug in `decimal.js` via `defineType`. |
| boolean | `true`/`false`; `"true"`/`"false"`; `"1"`/`"0"`; `1`/`0` | As Ecto. |
| uuid | canonical 36-char string, any case | Normalised to lower case. |
| binary | `Uint8Array`/`Buffer` | |
| date | `"YYYY-MM-DD"`; `Date` (uses UTC date part); `{ year, month, day }` | Validates real calendar dates. Option `as: "date"` yields `Date`. |
| time | `"HH:MM[:SS[.ffffff]]"` | App type string. |
| utcDatetime | `Date` (valid); ISO-8601 string with offset or `Z` | Truncates to seconds unless `{ precision: "ms" \| "us" }`; default **ms** (JS `Date` resolution) — a stated difference from Ecto. Rejects strings without an offset. |
| naiveDatetime | `Date`; ISO string **without** offset | Interpreted as UTC wall time. |
| json / map | any JSON-serialisable value; `map` requires a plain object | No deep validation; that is what validators are for. |
| array(inner) | arrays; casts each element; fails if any element fails | Error meta includes the failing index. |
| enum | one of the declared values (string form); for mapped enums also accepts the dumped value | App type is the string-literal union. |

## Behaviour: load and dump

- `load`/`dump` must be `IDENTITY` whenever the driver already produces/accepts the app
  representation, so hydration can skip the call. For Postgres via `pg` that is true for
  string, integer (int4), float, boolean, uuid, json/jsonb, arrays of those, and `Date`
  for timestamptz.
- Dialect differences (int8 and numeric arriving as strings, SQLite booleans as 0/1,
  dates as text, JSON as text) are **not** handled here. Types expose their logical
  `db` kind and the adapter supplies overrides (`Adapter.typeOverrides`, step 11). Provide
  the hook: `resolveCodec(type, adapter) -> { load, dump }`, memoised per (type, dialect).
- `enum` with a mapping dumps to the mapped value and loads back.
- `array(inner)` composes inner load/dump, and is `IDENTITY` when inner is.

## Equality

`equal` drives changeset change detection. Defaults: `Object.is` for primitives; `Date`
by timestamp; `Uint8Array` by bytes; arrays element-wise with inner `equal`; json/map by
deep structural equality (write a small, fast one in `internal/`; do not `JSON.stringify`).

## Tests

- Unit: one table-driven test per type for cast (accept and reject lists above, plus
  hostile inputs: `null` prototype objects, objects with `toString`, huge strings, `-0`),
  load, dump, equal.
- Property (fast-check): for every type, `equal(load(dump(x)), x)` for valid `x`;
  `cast(x)` is idempotent on its own output; `cast` never throws for arbitrary input.
- Type tests: `EctoType<TApp>` inference for each builtin; `types.enum([...])` infers the
  literal union; `types.array(types.integer)` infers `number[]`.
- Benchmarks: cast of each scalar type; `resolveCodec` hit; array-of-int load for 1,000 elements.

## Docs (`guide/types.md`)

Type reference table (TS type, Postgres column, accepted cast inputs), writing a custom
type (Money example end to end), parameterized types, the datetime precision and decimal
representation differences from Ecto.

## Acceptance

- [ ] Every type in the Public API implemented and exported under `types`.
- [ ] Cast table behaviour covered by tests exactly as specified.
- [ ] Property tests pass with at least 1,000 runs each.
- [ ] No `load`/`dump` wrapper where `IDENTITY` is correct (asserted by tests).
- [ ] Custom and parameterized types work through the same public interface the builtins use.

## Out of scope

Field options (`nullable`, `default`): step 04. Dialect overrides: steps 11 and 17.
Embedded schemas as types: step 15.
