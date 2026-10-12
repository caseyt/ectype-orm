import { describe, expectTypeOf, test } from "vitest";
import type {
  AnyEctoType,
  AppTypeOf,
  CastResult,
  Codec,
  DbType,
  DbTypeKind,
  DbTypeOf,
  EctoType,
} from "./type.js";
import { IDENTITY } from "./type.js";

declare const stringType: EctoType<string, string>;
declare const dateType: EctoType<Date, string>;
declare const jsonType: EctoType<{ theme: string }>;

describe("EctoType", () => {
  test("types cast, load, dump and equal from its parameters", () => {
    expectTypeOf(dateType.cast).returns.toEqualTypeOf<CastResult<Date>>();
    expectTypeOf(dateType.cast).parameter(0).toBeUnknown();
    expectTypeOf(dateType.load).toEqualTypeOf<(value: string) => Date>();
    expectTypeOf(dateType.dump).toEqualTypeOf<(value: Date) => string>();
    expectTypeOf(dateType.equal).toEqualTypeOf<(a: Date, b: Date) => boolean>();
    expectTypeOf(dateType.load("2026-01-01")).not.toBeAny();
  });

  test("the driver type defaults to unknown", () => {
    expectTypeOf(jsonType.load).parameter(0).toBeUnknown();
    expectTypeOf(jsonType.dump).returns.toBeUnknown();
  });

  test("rejects wrong value types", () => {
    // @ts-expect-error dump takes the application type
    dateType.dump("2026-01-01");
    // @ts-expect-error load takes the driver type
    dateType.load(new Date());
    // @ts-expect-error equal compares application values
    dateType.equal(new Date(), "2026-01-01");
  });

  test("an implementation must provide every member with the right types", () => {
    const upper: EctoType<string, string> = {
      name: "upper",
      db: { kind: "text" },
      cast: (input) => (typeof input === "string" ? { ok: true, value: input.toUpperCase() } : { ok: false }),
      load: IDENTITY,
      dump: IDENTITY,
      equal: Object.is,
    };
    void upper;
    // @ts-expect-error equal is missing
    const incomplete: EctoType<string, string> = {
      name: "x",
      db: { kind: "text" },
      cast: () => ({ ok: false }),
      load: IDENTITY,
      dump: IDENTITY,
    };
    void incomplete;
    const wrongCast: EctoType<string, string> = {
      name: "x",
      db: { kind: "text" },
      // @ts-expect-error cast must produce the application type
      cast: () => ({ ok: true, value: 1 }),
      load: IDENTITY,
      dump: IDENTITY,
      equal: Object.is,
    };
    void wrongCast;
  });

  test("IDENTITY is not a valid load when the two types differ", () => {
    const bad: EctoType<Date, string> = {
      name: "x",
      db: { kind: "timestamptz" },
      cast: () => ({ ok: false }),
      // @ts-expect-error a string is not a Date
      load: IDENTITY,
      dump: (value) => value.toISOString(),
      equal: (a, b) => a.getTime() === b.getTime(),
    };
    void bad;
  });
});

describe("AnyEctoType", () => {
  test("accepts every EctoType", () => {
    expectTypeOf(stringType).toExtend<AnyEctoType>();
    expectTypeOf(dateType).toExtend<AnyEctoType>();
    expectTypeOf(jsonType).toExtend<AnyEctoType>();
    const stored: AnyEctoType[] = [stringType, dateType, jsonType];
    void stored;
  });

  test("reads back unknown, never any", () => {
    const stored: AnyEctoType = dateType;
    expectTypeOf(stored.load("x")).toBeUnknown();
    expectTypeOf(stored.dump(1)).toBeUnknown();
    expectTypeOf(stored.cast("x")).toEqualTypeOf<CastResult<unknown>>();
    expectTypeOf(stored.load("x")).not.toBeAny();
  });

  test("rejects things that are not types", () => {
    // @ts-expect-error not an EctoType
    const bad: AnyEctoType = { name: "x" };
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
  test("narrows on ok", () => {
    const result = {} as CastResult<number>;
    if (result.ok) {
      expectTypeOf(result.value).toEqualTypeOf<number>();
    } else {
      expectTypeOf(result.message).toEqualTypeOf<string | undefined>();
      expectTypeOf(result.meta).toEqualTypeOf<Readonly<Record<string, unknown>> | undefined>();
      // @ts-expect-error a failure has no value
      result.value;
    }
  });

  test("a failure cannot carry a value and a success must", () => {
    // @ts-expect-error value on a failure
    const a: CastResult<number> = { ok: false, value: 1 };
    // @ts-expect-error success without a value
    const b: CastResult<number> = { ok: true };
    // @ts-expect-error wrong value type
    const c: CastResult<number> = { ok: true, value: "1" };
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
    const codec: Codec = { load: (text) => BigInt(text as string), dump: IDENTITY };
    expectTypeOf(codec.load).toEqualTypeOf<(value: unknown) => unknown>();
    expectTypeOf(codec.load(1)).not.toBeAny();
    // @ts-expect-error both members are required
    const half: Codec = { load: IDENTITY };
    void half;
  });
});
