// What must hold for every type, built-in or custom: the properties of step 03, checked
// with fast-check, and the rule that a type which converts nothing says so with IDENTITY.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { AnyFieldType, FieldType } from "../contracts/type.js";
import { IDENTITY } from "../contracts/type.js";
import {
  arrayType,
  bigintType,
  binaryType,
  booleanType,
  dateType,
  decimalType,
  defineType,
  enumType,
  floatType,
  integerType,
  jsonType,
  localTimestampType,
  parameterized,
  stringType,
  timestampType,
  timeType,
  uuidType,
} from "./index.js";

const RUNS = { numRuns: 1000 };

interface Subject {
  readonly type: AnyFieldType;
  /** Valid application values of the type. */
  readonly values: fc.Arbitrary<unknown>;
  /** Which of fromDb and toDb must be the IDENTITY function itself. */
  readonly identity: { readonly fromDb: boolean; readonly toDb: boolean };
}

function subject<TApp, TDb>(
  type: FieldType<TApp, TDb>,
  values: fc.Arbitrary<TApp>,
  identity: { fromDb: boolean; toDb: boolean } = { fromDb: true, toDb: true },
): Subject {
  return { type: type as AnyFieldType, values, identity };
}

const CONVERTS = { fromDb: false, toDb: false };

// -0 is not a valid integer value: cast normalises it to 0.
const safeInteger = fc.maxSafeInteger().map((n) => n + 0);
const validDate = fc.date({ noInvalidDate: true });
const wholeSecondDate = validDate.map((date) => new Date(Math.floor(date.getTime() / 1000) * 1000));
const calendarDay = fc
  .date({ min: new Date("0001-01-01T00:00:00Z"), max: new Date("9999-12-31T23:59:59Z"), noInvalidDate: true })
  .map((date) => date.toISOString().slice(0, 10));
const digits = (max: number) =>
  fc.string({ unit: fc.constantFrom(..."0123456789"), minLength: 1, maxLength: max });
const decimalText = fc
  .tuple(fc.boolean(), digits(30), fc.option(digits(12), { nil: undefined }))
  .map(
    ([negative, integer, fraction]) =>
      `${negative ? "-" : ""}${integer}${fraction === undefined ? "" : `.${fraction}`}`,
  );
/** Valid values of a decimal type are what its cast produces. */
const decimalValues = (type: FieldType<string, string>, text: fc.Arbitrary<string>) =>
  text
    .map((value) => type.cast(value))
    .filter((result) => result.success)
    .map((result) => (result as { data: string }).data);
const timeText = fc
  .tuple(
    fc.integer({ min: 0, max: 23 }),
    fc.integer({ min: 0, max: 59 }),
    fc.integer({ min: 0, max: 59 }),
    fc.integer({ min: 0, max: 999_999 }),
  )
  .map(([h, m, s, us]) => {
    const two = (n: number) => String(n).padStart(2, "0");
    const fraction = String(us).padStart(6, "0").replace(/0+$/, "");
    return `${two(h)}:${two(m)}:${two(s)}${fraction === "" ? "" : `.${fraction}`}`;
  });
const jsonDocument = fc.jsonValue().filter((value) => value !== null);

// A custom type, written the way the guide's Money example is.
class Money {
  constructor(readonly cents: bigint) {}
  static parse(text: string): Money {
    const [whole = "0", fraction = ""] = text.split(".");
    const negative = whole.startsWith("-");
    const cents = BigInt(whole.replace("-", "")) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
    return new Money(negative ? -cents : cents);
  }
  toString(): string {
    const absolute = this.cents < 0n ? -this.cents : this.cents;
    return `${this.cents < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
  }
}
const moneyType = defineType<Money, string>({
  name: "money",
  db: { kind: "decimal" },
  cast: (input) => {
    try {
      if (input instanceof Money) return { success: true, data: input };
    } catch {
      // `instanceof` runs the traps of a proxy: a cast must not let them throw.
      return { success: false };
    }
    return typeof input === "string" && /^-?\d{1,15}(\.\d{1,2})?$/.test(input)
      ? { success: true, data: Money.parse(input) }
      : { success: false, message: "is not a valid amount" };
  },
  fromDb: (stored) => Money.parse(stored),
  toDb: (money) => money.toString(),
  equal: (a, b) => a.cents === b.cents,
});
const money = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }).map((cents) => new Money(cents));

const fixedString = parameterized((options: { readonly length: number }) =>
  defineType<string>({
    name: `char(${options.length})`,
    db: { kind: "custom", sql: `char(${options.length})` },
    cast: (input) =>
      typeof input === "string" && input.length === options.length
        ? { success: true, data: input }
        : { success: false },
  }),
);

const role = enumType(["admin", "member", "guest"]);
const level = enumType({ low: 1, mid: 2, high: 3 });
const status = enumType({ active: "A", archived: "X" });

const SUBJECTS: readonly Subject[] = [
  subject(stringType(), fc.string()),
  subject(integerType(), safeInteger),
  subject(bigintType(), fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n })),
  subject(bigintType({ mode: "number" }), safeInteger, { fromDb: false, toDb: true }),
  subject(floatType(), fc.double({ noNaN: true, noDefaultInfinity: true })),
  subject(decimalType(), decimalValues(decimalType(), decimalText)),
  subject(
    decimalType({ precision: 12, scale: 3 }),
    decimalValues(decimalType({ precision: 12, scale: 3 }), decimalText),
  ),
  subject(booleanType(), fc.boolean()),
  subject(uuidType(), fc.uuid()),
  subject(binaryType(), fc.uint8Array()),
  subject(dateType(), calendarDay),
  subject(
    dateType({ as: "date" }),
    calendarDay.map((day) => new Date(`${day}T00:00:00Z`)),
    CONVERTS,
  ),
  subject(timeType(), timeText),
  subject(timestampType(), validDate),
  subject(timestampType({ precision: "s" }), wholeSecondDate),
  subject(timestampType({ precision: "us" }), validDate),
  subject(localTimestampType(), validDate),
  subject(localTimestampType({ precision: "s" }), wholeSecondDate),
  subject(localTimestampType({ precision: "us" }), validDate),
  subject(jsonType(), jsonDocument),
  subject(arrayType(integerType()), fc.array(safeInteger)),
  subject(arrayType(stringType()), fc.array(fc.string())),
  subject(arrayType(timestampType()), fc.array(validDate)),
  subject(arrayType(jsonType()), fc.array(jsonDocument)),
  subject(arrayType(arrayType(integerType())), fc.array(fc.array(safeInteger))),
  subject(arrayType(bigintType({ mode: "number" })), fc.array(safeInteger), { fromDb: false, toDb: true }),
  subject(
    arrayType(dateType({ as: "date" })),
    fc.array(calendarDay.map((day) => new Date(`${day}T00:00:00Z`))),
    CONVERTS,
  ),
  subject(arrayType(level), fc.array(fc.constantFrom("low", "mid", "high")), CONVERTS),
  subject(role, fc.constantFrom("admin", "member", "guest")),
  subject(arrayType(role), fc.array(fc.constantFrom("admin", "member", "guest"))),
  subject(level, fc.constantFrom("low", "mid", "high"), CONVERTS),
  subject(status, fc.constantFrom("active", "archived"), CONVERTS),
  subject(moneyType, money, CONVERTS),
  subject(arrayType(moneyType), fc.array(money), CONVERTS),
  subject(fixedString({ length: 3 }), fc.string({ minLength: 3, maxLength: 3, unit: "binary-ascii" })),
];

/** Everything fast-check can build, plus the inputs each type is most likely to mishandle. */
const anything = fc.oneof(
  fc.anything({
    withBigInt: true,
    withBoxedValues: true,
    withDate: true,
    withMap: true,
    withNullPrototype: true,
    withObjectString: true,
    withSet: true,
    withSparseArray: true,
    withTypedArray: true,
    withUnicodeString: true,
  }),
  fc.string(),
  fc.double(),
  fc.maxSafeInteger().map(String),
  fc.bigInt().map(String),
  fc.date({ noInvalidDate: false }),
  fc.date({ noInvalidDate: true }).map((date) => date.toISOString()),
  fc.date({ noInvalidDate: true }).map((date) => date.toISOString().replace("Z", "")),
  fc.date({ noInvalidDate: true }).map((date) => date.toISOString().slice(0, 10)),
  fc.record({ year: fc.anything(), month: fc.anything(), day: fc.anything() }),
  fc.record({
    year: fc.integer({ min: -5, max: 10_005 }),
    month: fc.integer({ min: 0, max: 13 }),
    day: fc.integer({ min: 0, max: 32 }),
  }),
  fc.constantFrom(
    "low",
    "high",
    "admin",
    "A",
    "X",
    1,
    2,
    3,
    "true",
    "0",
    "1e5",
    ".5",
    "-0",
    "12:30",
    "23:59:59.5",
  ),
);

const throwingProxy = (target: object): unknown =>
  new Proxy(target, {
    get() {
      throw new Error("trap");
    },
    has() {
      throw new Error("trap");
    },
    ownKeys() {
      throw new Error("trap");
    },
    getPrototypeOf() {
      throw new Error("trap");
    },
    getOwnPropertyDescriptor() {
      throw new Error("trap");
    },
  });

function revoked(target: object): unknown {
  const { proxy, revoke } = Proxy.revocable(target, {});
  revoke();
  return proxy;
}

const cyclic: Record<string, unknown> = {};
cyclic.self = cyclic;

/**
 * Inputs chosen to break a cast. None is a valid value of any subject, except where the
 * third member names the types that rightly accept it.
 */
const HOSTILE: readonly (readonly [string, unknown, (readonly string[])?])[] = [
  ["an object without a prototype", Object.create(null), ["json"]],
  ["an object with a toString", { toString: () => "42" }],
  ["an object with a valueOf", { valueOf: () => 42 }],
  [
    "an object whose toString throws",
    {
      toString: () => {
        throw new Error("toString");
      },
    },
  ],
  [
    "an object with a Symbol.toPrimitive that throws",
    {
      [Symbol.toPrimitive]: () => {
        throw new Error("toPrimitive");
      },
    },
    ["json"],
  ],
  [
    "an object whose getters throw",
    Object.defineProperties(
      {},
      {
        year: {
          enumerable: true,
          get: () => {
            throw new Error("getter");
          },
        },
        length: {
          enumerable: true,
          get: () => {
            throw new Error("getter");
          },
        },
      },
    ),
  ],
  ["a huge string", "9".repeat(1_000_000), ["string", "decimal", "json"]],
  ["a huge string of spaces", " ".repeat(1_000_000), ["string", "json"]],
  ["a symbol", Symbol("s")],
  ["a function", () => 1],
  ["a class", class {}],
  ["a proxy whose traps throw", throwingProxy({})],
  ["an array proxy whose traps throw", throwingProxy([])],
  ["a Date proxy whose traps throw", throwingProxy(new Date(0))],
  ["a function proxy whose traps throw", throwingProxy(() => 1)],
  ["a revoked proxy", revoked({})],
  ["a revoked array proxy", revoked([])],
  ["an invalid Date", new Date(Number.NaN)],
  ["an object that inherits from Date.prototype", Object.create(Date.prototype)],
  ["an object that inherits from Uint8Array.prototype", Object.create(Uint8Array.prototype)],
  ["an object that inherits from Array.prototype", Object.create(Array.prototype)],
  ["an object that contains itself", cyclic],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["a bigint beyond 64 bits", 2n ** 70n],
  ["a WeakMap", new WeakMap()],
  ["a Promise", Promise.resolve(1)],
  ["an Error", new Error("e")],
  ["a regular expression", /a/],
  ["a boxed number", new Number(1)],
];

describe.each(SUBJECTS.map((s) => [s.type.name, s] as const))("%s", (_name, { type, values, identity }) => {
  test("a value survives being written to the database and read back", () => {
    fc.assert(
      fc.property(values, (value) => type.equal(type.fromDb(type.toDb(value)), value)),
      RUNS,
    );
  });

  test("cast accepts every valid value and gives an equal value back", () => {
    fc.assert(
      fc.property(values, (value) => {
        const result = type.cast(value);
        return result.success && type.equal(result.data, value);
      }),
      RUNS,
    );
  });

  test("cast is idempotent on its own output", () => {
    fc.assert(
      fc.property(fc.oneof(values, anything), (input) => {
        const first = type.cast(input);
        if (!first.success) return true;
        const second = type.cast(first.data);
        return second.success && type.equal(second.data, first.data);
      }),
      RUNS,
    );
  });

  test("cast never throws, whatever it is given", () => {
    fc.assert(
      fc.property(anything, (input) => {
        const result = type.cast(input);
        return result.success === true || result.success === false;
      }),
      RUNS,
    );
  });

  test.each(
    HOSTILE.map(
      ([label, input, acceptedBy]) => [label, input, acceptedBy?.includes(type.name) ?? false] as const,
    ),
  )("cast does not throw for %s, and rejects it", (_label, input, accepted) => {
    expect(type.cast(input).success).toBe(accepted);
  });

  test("equal is reflexive on valid values", () => {
    fc.assert(
      fc.property(values, (value) => type.equal(value, value)),
      RUNS,
    );
  });

  test("fromDb and toDb are the IDENTITY function exactly when nothing is converted", () => {
    expect(type.fromDb === IDENTITY).toBe(identity.fromDb);
    expect(type.toDb === IDENTITY).toBe(identity.toDb);
  });

  test("has the fixed shape of a type and is frozen", () => {
    expect(Object.keys(type)).toEqual(["name", "db", "cast", "fromDb", "toDb", "equal"]);
    expect(Object.isFrozen(type)).toBe(true);
  });
});

test("every built-in type that the field builder exposes is covered above", () => {
  const names = new Set(SUBJECTS.map((s) => s.type.name));
  for (const name of [
    "string",
    "integer",
    "bigint",
    "bigint(number)",
    "float",
    "decimal",
    "boolean",
    "uuid",
    "binary",
    "date",
    "date(date)",
    "time",
    "timestamp",
    "timestamp(s)",
    "timestamp(us)",
    "localTimestamp",
    "localTimestamp(s)",
    "localTimestamp(us)",
    "json",
    "enum",
    "array(integer)",
  ]) {
    expect(names.has(name), name).toBe(true);
  }
});
