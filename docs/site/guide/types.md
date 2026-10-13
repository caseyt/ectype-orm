# Types

A type answers three questions about a field: how to accept untrusted input, how to read
the value the database returns, and how to write a value to the database.

All types come from `t`, the same object used to declare fields. Wherever the library
needs a type on its own, such as `param("minAge", t.integer())`, you pass a field builder.

## Built-in types

| Type | In TypeScript | Postgres column | Accepts from untrusted input |
|---|---|---|---|
| `t.string()` | `string` | `text`, `varchar` | Strings only. Numbers are not coerced. |
| `t.integer()` | `number` | `integer` | Safe integers and digit strings such as `"42"`. Rejects `1.5`, `"1.0"`, `NaN`. |
| `t.bigint()` | `bigint` | `bigint` | A `bigint`, an integer `number`, or a digit string. |
| `t.bigint({ mode: "number" })` | `number` | `bigint` | As `integer`. A stored value beyond the safe integer range throws `CastError`. |
| `t.float()` | `number` | `double precision` | Finite numbers and numeric strings. |
| `t.decimal()` | `string` | `numeric` | Decimal strings and finite numbers. |
| `t.boolean()` | `boolean` | `boolean` | `true`, `false`, `"true"`, `"false"`, `1`, `0`, `"1"`, `"0"`. |
| `t.uuid()` | `string` | `uuid` | The canonical 36-character form, any case; stored lower-case. |
| `t.binary()` | `Uint8Array` | `bytea` | `Uint8Array` or `Buffer`. |
| `t.date()` | `string` (`"YYYY-MM-DD"`) | `date` | A date string, a `Date` (its UTC date), or `{ year, month, day }`. Rejects impossible dates. |
| `t.time()` | `string` | `time` | `"HH:MM"`, `"HH:MM:SS"`, with optional fraction. |
| `t.timestamp()` | `Date` | `timestamptz` | A valid `Date`, or an ISO-8601 string **with** an offset or `Z`. |
| `t.localTimestamp()` | `Date` | `timestamp` | A `Date`, or an ISO-8601 string **without** an offset, read as UTC. |
| `t.json<T>()` | `T` | `jsonb` | Anything JSON-serialisable. The shape is not checked; use a validator. |
| `t.array(inner)` | `T[]` | `inner[]` | An array; each element is cast with `inner`. |
| `t.enum(["a", "b"])` | `"a" \| "b"` | `text` | One of the listed values. |
| `t.enum({ a: 1, b: 2 })` | `"a" \| "b"` | `integer` | A key, or its stored value. |
| `t.type(custom)` | yours | yours | Whatever your type accepts. See [Custom types](#custom-types). |

Options:

- `t.decimal({ precision, scale })`.
- `t.date({ as: "date" })` gives a `Date` instead of a string.
- `t.timestamp({ precision: "us" })`. The default is milliseconds, which is what a
  JavaScript `Date` holds.

## Why dates and decimals are strings

- A `date` has no time zone. Turning `2026-10-13` into a `Date` gives a moment in time,
  which shifts to the 12th or 14th in some time zones. A string cannot shift.
- A `decimal` exists to avoid floating-point error. Reading `19.99` into a `number` would
  reintroduce it. Use a [custom type](#custom-types) to get a decimal object instead.

## Null

`null` never reaches a type. Whether a field may be `null` is decided by `.nullable()` on
the field, and handled before the type is involved.

## Equality

Each type knows how to compare two values, which is how a changeset decides whether a
value changed. Dates compare by timestamp, binaries by bytes, arrays element by element,
and JSON values structurally.

## Custom types

```ts
import { defineType, t } from "egon-orm";

const MoneyType = defineType<Money, string>({
  name: "money",
  db: { kind: "decimal" },
  cast(input) {
    return isMoneyLike(input)
      ? { success: true, data: Money.parse(input) }
      : { success: false, message: "is not a valid amount" };
  },
  fromDb: (stored) => Money.parse(stored),
  toDb: (money) => money.toString(),
  equal: (a, b) => a.eq(b),
});

class Product extends Schema("products", {
  id: t.integer().primaryKey(),
  price: t.type(MoneyType),
}) {}
```

| Member | Purpose |
|---|---|
| `name` | Shown in error messages. |
| `db` | The logical column type: `{ kind: "decimal" }`, `{ kind: "array", of }`, `{ kind: "custom", sql }` and so on. |
| `cast(input)` | Untrusted input to your value. Return `{ success: true, data }` or `{ success: false, message? }`. It must never throw. |
| `fromDb(stored)` | The driver's value to your value. Optional when they are the same. |
| `toDb(value)` | Your value to a query parameter. Optional when they are the same. |
| `equal(a, b)` | Optional; defaults to `Object.is`. |

Leave `fromDb` and `toDb` out when no conversion is needed. The library then skips the
call entirely when reading rows.

## Types that take options

`parameterized` builds a type from options and remembers the result per option set. The
built-in `enum`, `array` and `decimal` are made this way.

```ts
import { parameterized } from "egon-orm";

const currency = parameterized((opts: { code: string }) =>
  defineType<Money, string>({ name: `money(${opts.code})`, db: { kind: "decimal" }, /* ... */ }),
);

price: t.type(currency({ code: "EUR" }));
```

## Differences between databases

SQLite and MySQL store some of these differently (booleans as `0`/`1`, JSON as text, no
array columns). The adapter converts for you; the TypeScript type is the same everywhere.
See [Dialect support](/reference/dialect-support).
