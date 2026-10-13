import { describe, expectTypeOf, test } from "vitest";
import type {
  AnyFieldType,
  AppTypeOf,
  CastResult,
  Codec,
  DbType,
  DbTypeKind,
  DbTypeOf,
  FieldType,
} from "./type.js";
import { IDENTITY } from "./type.js";

declare const stringType: FieldType<string, string>;
declare const dateType: FieldType<Date, string>;
declare const jsonType: FieldType<{ theme: string }>;

describe("FieldType", () => {
  test("types cast, fromDb, toDb and equal from its parameters", () => {
    expectTypeOf(dateType.cast).returns.toEqualTypeOf<CastResult<Date>>();
    expectTypeOf(dateType.cast).parameter(0).toBeUnknown();
    expectTypeOf(dateType.fromDb).toEqualTypeOf<(value: string) => Date>();
    expectTypeOf(dateType.toDb).toEqualTypeOf<(value: Date) => string>();
    expectTypeOf(dateType.equal).toEqualTypeOf<(a: Date, b: Date) => boolean>();
    expectTypeOf(dateType.fromDb("2026-01-01")).not.toBeAny();
  });

  test("the driver type defaults to unknown", () => {
    expectTypeOf(jsonType.fromDb).parameter(0).toBeUnknown();
    expectTypeOf(jsonType.toDb).returns.toBeUnknown();
  });

  test("rejects wrong data types", () => {
    // @ts-expect-error toDb takes the application type
    dateType.toDb("2026-01-01");
    // @ts-expect-error fromDb takes the driver type
    dateType.fromDb(new Date());
    // @ts-expect-error equal compares application values
    dateType.equal(new Date(), "2026-01-01");
  });

  test("an implementation must provide every member with the right types", () => {
    const upper: FieldType<string, string> = {
      name: "upper",
      db: { kind: "text" },
      cast: (input) =>
        typeof input === "string" ? { success: true, data: input.toUpperCase() } : { success: false },
      fromDb: IDENTITY,
      toDb: IDENTITY,
      equal: Object.is,
    };
    void upper;
    // @ts-expect-error equal is missing
    const incomplete: FieldType<string, string> = {
      name: "x",
      db: { kind: "text" },
      cast: () => ({ success: false }),
      fromDb: IDENTITY,
      toDb: IDENTITY,
    };
    void incomplete;
    const wrongCast: FieldType<string, string> = {
      name: "x",
      db: { kind: "text" },
      // @ts-expect-error cast must produce the application type
      cast: () => ({ success: true, data: 1 }),
      fromDb: IDENTITY,
      toDb: IDENTITY,
      equal: Object.is,
    };
    void wrongCast;
  });

  test("IDENTITY is not a valid fromDb when the two types differ", () => {
    const bad: FieldType<Date, string> = {
      name: "x",
      db: { kind: "timestamptz" },
      cast: () => ({ success: false }),
      // @ts-expect-error a string is not a Date
      fromDb: IDENTITY,
      toDb: (value) => value.toISOString(),
      equal: (a, b) => a.getTime() === b.getTime(),
    };
    void bad;
  });
});

describe("AnyFieldType", () => {
  test("accepts every FieldType", () => {
    expectTypeOf(stringType).toExtend<AnyFieldType>();
    expectTypeOf(dateType).toExtend<AnyFieldType>();
    expectTypeOf(jsonType).toExtend<AnyFieldType>();
    const stored: AnyFieldType[] = [stringType, dateType, jsonType];
    void stored;
  });

  test("reads back unknown, never any", () => {
    const stored: AnyFieldType = dateType;
    expectTypeOf(stored.fromDb("x")).toBeUnknown();
    expectTypeOf(stored.toDb(1)).toBeUnknown();
    expectTypeOf(stored.cast("x")).toEqualTypeOf<CastResult<unknown>>();
    expectTypeOf(stored.fromDb("x")).not.toBeAny();
  });

  test("rejects things that are not types", () => {
    // @ts-expect-error not an FieldType
    const bad: AnyFieldType = { name: "x" };
    void bad;
  });
});

describe("AppTypeOf and DbTypeOf", () => {
  test("recover the parameters", () => {
    expectTypeOf<AppTypeOf<typeof dateType>>().toEqualTypeOf<Date>();
    expectTypeOf<DbTypeOf<typeof dateType>>().toEqualTypeOf<string>();
    expectTypeOf<AppTypeOf<typeof jsonType>>().toEqualTypeOf<{ theme: string }>();
    expectTypeOf<DbTypeOf<typeof jsonType>>().toBeUnknown();
    expectTypeOf<AppTypeOf<typeof dateType>>().not.toBeAny();
  });

  test("are never for something that is not a type", () => {
    expectTypeOf<AppTypeOf<string>>().toBeNever();
    expectTypeOf<DbTypeOf<{ name: string }>>().toBeNever();
  });
});

describe("CastResult", () => {
  test("narrows on success", () => {
    const result = {} as CastResult<number>;
    if (result.success) {
      expectTypeOf(result.data).toEqualTypeOf<number>();
    } else {
      expectTypeOf(result.message).toEqualTypeOf<string | undefined>();
      expectTypeOf(result.meta).toEqualTypeOf<Readonly<Record<string, unknown>> | undefined>();
      // @ts-expect-error a failure has no data
      result.data;
    }
  });

  test("a failure cannot carry data and a success must", () => {
    // @ts-expect-error data on a failure
    const a: CastResult<number> = { success: false, data: 1 };
    // @ts-expect-error success without data
    const b: CastResult<number> = { success: true };
    // @ts-expect-error wrong data type
    const c: CastResult<number> = { success: true, data: "1" };
    void [a, b, c];
  });
});

describe("DbType", () => {
  test("accepts scalars, arrays of any depth and custom types", () => {
    const types: DbType[] = [
      { kind: "integer" },
      { kind: "jsonb" },
      { kind: "array", of: { kind: "array", of: { kind: "uuid" } } },
      { kind: "custom", sql: "money" },
    ];
    void types;
    expectTypeOf<DbTypeKind>().toEqualTypeOf<
      | "integer"
      | "bigint"
      | "float"
      | "decimal"
      | "boolean"
      | "text"
      | "uuid"
      | "binary"
      | "date"
      | "time"
      | "timestamp"
      | "timestamptz"
      | "json"
      | "jsonb"
      | "array"
      | "custom"
    >();
  });

  test("rejects unknown kinds and incomplete variants", () => {
    // @ts-expect-error no such kind
    const a: DbType = { kind: "varchar" };
    // @ts-expect-error an array needs its element type
    const b: DbType = { kind: "array" };
    // @ts-expect-error a custom type needs its SQL
    const c: DbType = { kind: "custom" };
    void [a, b, c];
  });
});

describe("IDENTITY and Codec", () => {
  test("IDENTITY preserves the type of its argument", () => {
    expectTypeOf(IDENTITY(1 as const)).toEqualTypeOf<1>();
    expectTypeOf(IDENTITY("a")).toEqualTypeOf<string>();
    expectTypeOf(IDENTITY({ id: 1 })).not.toBeAny();
  });

  test("a Codec takes and returns unknown, and IDENTITY is a valid member", () => {
    const codec: Codec = { fromDb: (text) => BigInt(text as string), toDb: IDENTITY };
    expectTypeOf(codec.fromDb).toEqualTypeOf<(value: unknown) => unknown>();
    expectTypeOf(codec.fromDb(1)).not.toBeAny();
    // @ts-expect-error both members are required
    const half: Codec = { fromDb: IDENTITY };
    void half;
  });
});
