import { describe, expect, test } from "vitest";
import type { AnyFieldType } from "../contracts/type.js";
import { IDENTITY } from "../contracts/type.js";
import { resolveCodec } from "../types/codec.js";
import {
  arrayType,
  bigintType,
  binaryType,
  dateType,
  defineType,
  jsonType,
  stringType,
} from "../types/index.js";
import { typeOverridesFrom } from "./codecs.js";

const any = (type: unknown): AnyFieldType => type as AnyFieldType;

const toBigint = (value: unknown): unknown => (typeof value === "string" ? BigInt(value) : value);
const stringify = (value: unknown): unknown => JSON.stringify(value);

describe("typeOverridesFrom", () => {
  const overrides = typeOverridesFrom({
    bigint: { fromDb: toBigint },
    json: { toDb: stringify },
    jsonb: { toDb: stringify },
  });

  test("a kind without a fix has no override, so the type's own conversions are used", () => {
    expect(overrides(any(stringType()))).toBeUndefined();
    expect(overrides(any(binaryType()))).toBeUndefined();
  });

  test("a fix on a type whose own conversion is the identity is the fix itself, the other side stays the identity", () => {
    const codec = overrides(any(bigintType()));
    expect(codec?.fromDb).toBe(toBigint);
    expect(codec?.toDb).toBe(IDENTITY);
    expect(Object.isFrozen(codec)).toBe(true);
  });

  test("a fix is composed with a type's own fromDb: the fix runs first", () => {
    const codec = overrides(any(bigintType({ mode: "number" })));
    expect(codec?.fromDb("42")).toBe(42);
    expect(codec?.fromDb(9_007_199_254_740_991n)).toBe(9_007_199_254_740_991);
    expect(() => codec?.fromDb("9007199254740993")).toThrow(/safe integer range/);
  });

  test("a fix is composed with a type's own toDb: the type's runs first", () => {
    const point = defineType<{ x: number }, { coordinates: number[] }>({
      name: "point",
      db: { kind: "jsonb" },
      cast: () => ({ success: false }),
      fromDb: (stored) => ({ x: stored.coordinates[0] ?? 0 }),
      toDb: (value) => ({ coordinates: [value.x] }),
    });
    const codec = overrides(any(point));
    expect(codec?.toDb({ x: 3 })).toBe('{"coordinates":[3]}');
    expect(codec?.fromDb({ coordinates: [5] })).toEqual({ x: 5 });
  });

  test("the json type gets its parameter serialised, whatever the value", () => {
    const codec = overrides(any(jsonType()));
    expect(codec?.toDb(["a", 1])).toBe('["a",1]');
    expect(codec?.toDb("text")).toBe('"text"');
    expect(codec?.fromDb).toBe(IDENTITY);
  });

  test("an array has no override itself; resolveCodec applies the element's to each element", () => {
    const tags = any(arrayType(bigintType()));
    expect(overrides(tags)).toBeUndefined();
    const adapter = { typeOverrides: overrides };
    expect(resolveCodec(tags, adapter).fromDb(["1", null, "2"])).toEqual([1n, null, 2n]);
  });

  test("a custom kind has no override", () => {
    const money = defineType<string>({
      name: "money",
      db: { kind: "custom", sql: "money" },
      cast: () => ({ success: false }),
    });
    expect(overrides(any(money))).toBeUndefined();
  });

  test("a type of a fixed kind written as a class keeps its receiver", () => {
    class Doubled {
      readonly name = "doubled";
      readonly db = { kind: "bigint" } as const;
      readonly factor = 2n;
      cast(): { success: false } {
        return { success: false };
      }
      fromDb(value: bigint): bigint {
        return value * this.factor;
      }
      toDb(value: bigint): bigint {
        return value / this.factor;
      }
      equal(a: bigint, b: bigint): boolean {
        return a === b;
      }
    }
    const codec = overrides(any(new Doubled()));
    expect(codec?.fromDb("21")).toBe(42n);
    expect(codec?.toDb(42n)).toBe(21n);
  });

  test("the date type with no fix for its kind is left alone", () => {
    expect(overrides(any(dateType({ as: "date" })))).toBeUndefined();
  });
});
