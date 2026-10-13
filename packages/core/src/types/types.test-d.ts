import { describe, expectTypeOf, test } from "vitest";
import type { Adapter } from "../contracts/adapter.js";
import type { AnyFieldType, AppTypeOf, CastResult, Codec, DbTypeOf, FieldType } from "../contracts/type.js";
import type { TypeDefinition } from "./index.js";
import {
  arrayType,
  bigintType,
  binaryType,
  booleanType,
  dateType,
  decimalType,
  defineType,
  elementTypeOf,
  enumType,
  floatType,
  integerType,
  jsonType,
  localTimestampType,
  parameterized,
  resolveCodec,
  stringType,
  timestampType,
  timeType,
  uuidType,
} from "./index.js";

/** The data of a successful cast. */
type CastData<T extends AnyFieldType> = Extract<ReturnType<T["cast"]>, { success: true }>["data"];

describe("built-in types infer their application and driver types", () => {
  test("scalars", () => {
    expectTypeOf(stringType()).toEqualTypeOf<FieldType<string, string>>();
    expectTypeOf(integerType()).toEqualTypeOf<FieldType<number, number>>();
    expectTypeOf(floatType()).toEqualTypeOf<FieldType<number, number>>();
    expectTypeOf(decimalType()).toEqualTypeOf<FieldType<string, string>>();
    expectTypeOf(decimalType({ precision: 10, scale: 2 })).toEqualTypeOf<FieldType<string, string>>();
    expectTypeOf(booleanType()).toEqualTypeOf<FieldType<boolean, boolean>>();
    expectTypeOf(uuidType()).toEqualTypeOf<FieldType<string, string>>();
    expectTypeOf(binaryType()).toEqualTypeOf<FieldType<Uint8Array, Uint8Array>>();
    expectTypeOf<AppTypeOf<ReturnType<typeof integerType>>>().toEqualTypeOf<number>();
    expectTypeOf<AppTypeOf<ReturnType<typeof integerType>>>().not.toBeAny();
  });

  test("bigint is a bigint, and a number with { mode: 'number' }", () => {
    expectTypeOf(bigintType()).toEqualTypeOf<FieldType<bigint, bigint>>();
    expectTypeOf(bigintType({})).toEqualTypeOf<FieldType<bigint, bigint>>();
    expectTypeOf(bigintType({ mode: "bigint" })).toEqualTypeOf<FieldType<bigint, bigint>>();
    expectTypeOf(bigintType({ mode: "number" })).toEqualTypeOf<FieldType<number, number | bigint | string>>();
    const asNumber = bigintType({ mode: "number" });
    expectTypeOf<AppTypeOf<typeof asNumber>>().toEqualTypeOf<number>();
    expectTypeOf<AppTypeOf<typeof asNumber>>().not.toBeAny();
    // @ts-expect-error an unknown mode
    bigintType({ mode: "string" });
  });

  test("date is a string, and a Date with { as: 'date' }", () => {
    expectTypeOf(dateType()).toEqualTypeOf<FieldType<string, string>>();
    expectTypeOf(dateType({ as: "string" })).toEqualTypeOf<FieldType<string, string>>();
    expectTypeOf(dateType({ as: "date" })).toEqualTypeOf<FieldType<Date, string>>();
    // @ts-expect-error an unknown representation
    dateType({ as: "luxon" });
  });

  test("time and timestamps", () => {
    expectTypeOf(timeType()).toEqualTypeOf<FieldType<string, string>>();
    expectTypeOf(timestampType()).toEqualTypeOf<FieldType<Date, Date>>();
    expectTypeOf(timestampType({ precision: "us" })).toEqualTypeOf<FieldType<Date, Date>>();
    expectTypeOf(localTimestampType({ precision: "s" })).toEqualTypeOf<FieldType<Date, Date>>();
    // @ts-expect-error an unknown precision
    timestampType({ precision: "ns" });
    // @ts-expect-error precision is not a number of digits
    localTimestampType({ precision: 3 });
  });

  test("decimal options need a precision", () => {
    // @ts-expect-error scale alone
    decimalType({ scale: 2 });
    // @ts-expect-error precision is a number
    decimalType({ precision: "10" });
  });
});

describe("json", () => {
  test("has the type it is told to have, and unknown otherwise", () => {
    expectTypeOf(jsonType<{ theme: string }>()).toEqualTypeOf<
      FieldType<{ theme: string }, { theme: string }>
    >();
    expectTypeOf(jsonType()).toEqualTypeOf<FieldType<unknown, unknown>>();
    expectTypeOf<AppTypeOf<ReturnType<typeof jsonType<{ theme: string }>>>>().not.toBeAny();
    expectTypeOf<AppTypeOf<ReturnType<typeof jsonType>>>().not.toBeAny();
  });
});

describe("array", () => {
  test("array(integer) is number[]", () => {
    const integers = arrayType(integerType());
    expectTypeOf(integers).toEqualTypeOf<FieldType<number[], number[]>>();
    expectTypeOf<AppTypeOf<typeof integers>>().toEqualTypeOf<number[]>();
    expectTypeOf<AppTypeOf<typeof integers>>().not.toBeAny();
    expectTypeOf<CastData<typeof integers>>().toEqualTypeOf<number[]>();
  });

  test("carries the element's application and driver types separately", () => {
    expectTypeOf(arrayType(dateType({ as: "date" }))).toEqualTypeOf<FieldType<Date[], string[]>>();
    expectTypeOf(arrayType(arrayType(stringType()))).toEqualTypeOf<FieldType<string[][], string[][]>>();
    expectTypeOf(arrayType(enumType(["a", "b"]))).toEqualTypeOf<FieldType<("a" | "b")[], string[]>>();
    expectTypeOf(arrayType(jsonType<{ n: number }>())).toEqualTypeOf<
      FieldType<{ n: number }[], { n: number }[]>
    >();
  });

  test("needs a type, not a value", () => {
    // @ts-expect-error a string is not a type
    arrayType("integer");
    // @ts-expect-error the builder function is not a type; call it
    arrayType(integerType);
  });

  test("elementTypeOf gives an untyped type or undefined", () => {
    expectTypeOf(elementTypeOf(arrayType(integerType()))).toEqualTypeOf<AnyFieldType | undefined>();
  });
});

describe("enum", () => {
  test("a list infers the union of its literals", () => {
    const role = enumType(["admin", "member"]);
    expectTypeOf(role).toEqualTypeOf<FieldType<"admin" | "member", string>>();
    expectTypeOf<AppTypeOf<typeof role>>().toEqualTypeOf<"admin" | "member">();
    expectTypeOf<AppTypeOf<typeof role>>().not.toBeAny();
    expectTypeOf<AppTypeOf<typeof role>>().not.toEqualTypeOf<string>();
    expectTypeOf<CastData<typeof role>>().toEqualTypeOf<"admin" | "member">();
    expectTypeOf(role.equal).parameter(0).toEqualTypeOf<"admin" | "member">();
  });

  test("a list held in a const variable keeps its literals", () => {
    const ROLES = ["admin", "member", "guest"] as const;
    expectTypeOf(enumType(ROLES)).toEqualTypeOf<FieldType<"admin" | "member" | "guest", string>>();
  });

  test("a mapping infers the union of its keys and stores its values", () => {
    const level = enumType({ low: 1, high: 2 });
    expectTypeOf(level).toEqualTypeOf<FieldType<"low" | "high", 1 | 2>>();
    expectTypeOf<AppTypeOf<typeof level>>().toEqualTypeOf<"low" | "high">();
    expectTypeOf<DbTypeOf<typeof level>>().toEqualTypeOf<1 | 2>();
    expectTypeOf<AppTypeOf<typeof level>>().not.toBeAny();
    expectTypeOf(level.toDb("low")).toEqualTypeOf<1 | 2>();
    expectTypeOf(enumType({ active: "A", archived: "X" })).toEqualTypeOf<
      FieldType<"active" | "archived", "A" | "X">
    >();
  });

  test("rejects members that cannot be an enum", () => {
    // @ts-expect-error an empty list
    enumType([]);
    // @ts-expect-error numbers in a list
    enumType([1, 2]);
    // @ts-expect-error a mapping whose values are neither all strings nor all numbers
    enumType({ a: 1, b: "x" });
    // @ts-expect-error a mapping to booleans
    enumType({ a: true });
    // @ts-expect-error a single string
    enumType("admin");
  });

  test("values of an enum are checked where they are used", () => {
    const role = enumType(["admin", "member"]);
    role.equal("admin", "member");
    // @ts-expect-error not a member
    role.equal("admin", "owner");
    // @ts-expect-error not a member
    role.toDb("owner");
  });
});

describe("defineType", () => {
  class Money {
    constructor(readonly cents: bigint) {}
  }

  test("takes its types from the type arguments", () => {
    const money = defineType<Money, string>({
      name: "money",
      db: { kind: "decimal" },
      cast: (input) => (input instanceof Money ? { success: true, data: input } : { success: false }),
      fromDb: (stored) => {
        expectTypeOf(stored).toEqualTypeOf<string>();
        return new Money(BigInt(stored));
      },
      toDb: (value) => {
        expectTypeOf(value).toEqualTypeOf<Money>();
        return String(value.cents);
      },
      equal: (a, b) => {
        expectTypeOf(a).toEqualTypeOf<Money>();
        return a.cents === b.cents;
      },
    });
    expectTypeOf(money).toEqualTypeOf<FieldType<Money, string>>();
    expectTypeOf<AppTypeOf<typeof money>>().toEqualTypeOf<Money>();
    expectTypeOf<DbTypeOf<typeof money>>().toEqualTypeOf<string>();
    expectTypeOf<AppTypeOf<typeof money>>().not.toBeAny();
  });

  test("with one type argument the driver type is the application type, and conversions are optional", () => {
    const slug = defineType<string>({
      name: "slug",
      db: { kind: "text" },
      cast: (input) => {
        expectTypeOf(input).toBeUnknown();
        return typeof input === "string" ? { success: true, data: input } : { success: false, message: "no" };
      },
    });
    expectTypeOf(slug).toEqualTypeOf<FieldType<string, string>>();
  });

  test("infers the application type from cast when no type argument is given", () => {
    const flag = defineType({
      name: "flag",
      db: { kind: "boolean" },
      cast: (input): CastResult<boolean> =>
        typeof input === "boolean" ? { success: true, data: input } : { success: false },
    });
    expectTypeOf(flag).toEqualTypeOf<FieldType<boolean, boolean>>();
    expectTypeOf<AppTypeOf<typeof flag>>().not.toBeAny();
  });

  test("conversions are required when the driver type differs from the application type", () => {
    const cast = (input: unknown): CastResult<Money> =>
      input instanceof Money ? { success: true, data: input } : { success: false };
    // @ts-expect-error fromDb and toDb are missing
    defineType<Money, string>({ name: "money", db: { kind: "decimal" }, cast });
    // @ts-expect-error toDb is missing
    defineType<Money, string>({
      name: "money",
      db: { kind: "decimal" },
      cast,
      fromDb: (s) => new Money(BigInt(s)),
    });
    // @ts-expect-error fromDb is missing
    defineType<Money, string>({ name: "money", db: { kind: "decimal" }, cast, toDb: (m) => String(m.cents) });
    // @ts-expect-error a driver type that is only wider than the application type still needs conversions
    defineType<number, number | string>({
      name: "n",
      db: { kind: "bigint" },
      cast: () => ({ success: false }),
    });
  });

  test("rejects a definition whose members have the wrong types", () => {
    const cast = (input: unknown): CastResult<string> =>
      typeof input === "string" ? { success: true, data: input } : { success: false };
    // @ts-expect-error name is missing
    defineType<string>({ db: { kind: "text" }, cast });
    // @ts-expect-error not a column type
    defineType<string>({ name: "x", db: { kind: "varchar" }, cast });
    // @ts-expect-error a custom column type needs its sql
    defineType<string>({ name: "x", db: { kind: "custom" }, cast });
    // @ts-expect-error cast returns the wrong application type
    defineType<number>({ name: "x", db: { kind: "integer" }, cast });
    // @ts-expect-error a cast result is { success, data }, not a bare value
    defineType<string>({ name: "x", db: { kind: "text" }, cast: (input) => String(input) });
    const never = (): CastResult<Money> => ({ success: false });
    const fromDb = (stored: string): Money => new Money(BigInt(stored));
    const toCents = (money: Money): bigint => money.cents;
    // @ts-expect-error toDb returns the wrong driver type
    defineType<Money, string>({ name: "x", db: { kind: "decimal" }, cast: never, fromDb, toDb: toCents });
    // @ts-expect-error equal compares application values
    defineType<string>({ name: "x", db: { kind: "text" }, cast, equal: (a: number, b: number) => a === b });
  });

  test("TypeDefinition is the argument type", () => {
    expectTypeOf(defineType<Money, string>)
      .parameter(0)
      .toEqualTypeOf<TypeDefinition<Money, string>>();
    const definition: TypeDefinition<string> = {
      name: "slug",
      db: { kind: "text" },
      cast: (input) => (typeof input === "string" ? { success: true, data: input } : { success: false }),
    };
    expectTypeOf(defineType(definition)).toEqualTypeOf<FieldType<string, string>>();
  });

  test("a defined type is usable wherever a type of unknown parameters is expected", () => {
    const stored: AnyFieldType = defineType<string>({
      name: "s",
      db: { kind: "text" },
      cast: () => ({ success: false }),
    });
    expectTypeOf(stored.fromDb("x")).toBeUnknown();
    expectTypeOf(arrayType(dateType({ as: "date" }))).toExtend<AnyFieldType>();
    expectTypeOf(enumType({ low: 1 })).toExtend<AnyFieldType>();
  });
});

describe("parameterized", () => {
  test("keeps the options type and the type it builds", () => {
    const fixed = parameterized((options: { readonly length: number }) =>
      defineType<string>({
        name: `char(${options.length})`,
        db: { kind: "custom", sql: `char(${options.length})` },
        cast: () => ({ success: false }),
      }),
    );
    expectTypeOf(fixed).toEqualTypeOf<(options: { readonly length: number }) => FieldType<string, string>>();
    expectTypeOf(fixed({ length: 2 })).toEqualTypeOf<FieldType<string, string>>();
    expectTypeOf(fixed({ length: 2 })).not.toBeAny();
    // @ts-expect-error the wrong options
    fixed({ size: 2 });
    // @ts-expect-error options are required
    fixed();
  });

  test("the builder has to return a type", () => {
    // @ts-expect-error a string is not a type
    parameterized((options: { n: number }) => `type ${options.n}`);
  });
});

describe("resolveCodec", () => {
  test("takes a type and anything with typeOverrides, and returns a Codec", () => {
    const adapter = { typeOverrides: (_type: AnyFieldType): Codec | undefined => undefined };
    expectTypeOf(resolveCodec(integerType(), adapter)).toEqualTypeOf<Codec>();
    expectTypeOf(resolveCodec).parameter(1).toEqualTypeOf<Pick<Adapter, "typeOverrides">>();
    expectTypeOf<Adapter>().toExtend<Parameters<typeof resolveCodec>[1]>();
    // @ts-expect-error not an adapter
    resolveCodec(integerType(), {});
    // @ts-expect-error not a type
    resolveCodec("integer", adapter);
  });
});
