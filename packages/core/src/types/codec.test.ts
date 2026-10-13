import { describe, expect, test, vi } from "vitest";
import type { AnyFieldType, Codec } from "../contracts/type.js";
import { IDENTITY } from "../contracts/type.js";
import { resolveCodec } from "./codec.js";
import { arrayType } from "./composite.js";
import { bigintType, integerType, stringType } from "./scalars.js";
import { dateType } from "./temporal.js";

/** An adapter that overrides exactly the given types. */
function adapterWith(overrides: readonly (readonly [AnyFieldType, Codec])[] = []) {
  const table = new Map(overrides);
  return { typeOverrides: vi.fn((type: AnyFieldType) => table.get(type)) };
}

const int8: Codec = { fromDb: (text) => BigInt(text as string), toDb: (value) => String(value) };

describe("resolveCodec", () => {
  test("a type that converts nothing resolves to IDENTITY in both directions", () => {
    const codec = resolveCodec(integerType(), adapterWith());
    expect(codec.fromDb).toBe(IDENTITY);
    expect(codec.toDb).toBe(IDENTITY);
    expect(Object.isFrozen(codec)).toBe(true);
  });

  test("a type with its own conversions resolves to exactly those functions", () => {
    const type = dateType({ as: "date" });
    const codec = resolveCodec(type, adapterWith());
    expect(codec.fromDb).toBe(type.fromDb);
    expect(codec.toDb).toBe(type.toDb);
    expect(Object.keys(codec)).toEqual(["fromDb", "toDb"]);
    expect(Object.isFrozen(codec)).toBe(true);

    const oneWay = resolveCodec(bigintType({ mode: "number" }), adapterWith());
    expect(oneWay.fromDb).toBe(bigintType({ mode: "number" }).fromDb);
    expect(oneWay.toDb).toBe(IDENTITY);
  });

  test("the adapter's override replaces the type's own conversions", () => {
    const adapter = adapterWith([[bigintType(), int8]]);
    expect(resolveCodec(bigintType(), adapter)).toBe(int8);
    expect(resolveCodec(integerType(), adapter).fromDb).toBe(IDENTITY);
  });

  test("asks the adapter once per type and returns the same object afterwards", () => {
    const adapter = adapterWith([[bigintType(), int8]]);
    const first = resolveCodec(integerType(), adapter);
    expect(resolveCodec(integerType(), adapter)).toBe(first);
    expect(resolveCodec(bigintType(), adapter)).toBe(resolveCodec(bigintType(), adapter));
    expect(adapter.typeOverrides).toHaveBeenCalledTimes(2);
    expect(adapter.typeOverrides).toHaveBeenNthCalledWith(1, integerType());
    expect(adapter.typeOverrides).toHaveBeenNthCalledWith(2, bigintType());
  });

  test("caches per adapter instance: two adapters may read one type differently", () => {
    const asBigint = adapterWith([[bigintType(), int8]]);
    const asIs = adapterWith();
    expect(resolveCodec(bigintType(), asBigint)).toBe(int8);
    expect(resolveCodec(bigintType(), asIs).fromDb).toBe(IDENTITY);
    expect(resolveCodec(bigintType(), asBigint)).toBe(int8);
    expect(asBigint.typeOverrides).toHaveBeenCalledTimes(1);
    expect(asIs.typeOverrides).toHaveBeenCalledTimes(1);
  });

  describe("arrays", () => {
    test("an array of an overridden element applies the override to each element", () => {
      const adapter = adapterWith([[bigintType(), int8]]);
      const codec = resolveCodec(arrayType(bigintType()), adapter);
      expect(codec.fromDb(["1", null, "9007199254740993"])).toEqual([1n, null, 9007199254740993n]);
      expect(codec.toDb([1n, null])).toEqual(["1", null]);
      expect(Object.isFrozen(codec)).toBe(true);
      expect(resolveCodec(arrayType(bigintType()), adapter)).toBe(codec);
      // The element's codec was resolved through the same cache.
      expect(resolveCodec(bigintType(), adapter)).toBe(int8);
      expect(adapter.typeOverrides).toHaveBeenCalledTimes(2);
    });

    test("an override in one direction leaves the other direction as IDENTITY", () => {
      const fromText: Codec = { fromDb: (text) => Number(text), toDb: IDENTITY };
      const codec = resolveCodec(arrayType(integerType()), adapterWith([[integerType(), fromText]]));
      expect(codec.toDb).toBe(IDENTITY);
      expect(codec.fromDb(["1", "2"])).toEqual([1, 2]);

      const toText: Codec = { fromDb: IDENTITY, toDb: (value) => String(value) };
      const reverse = resolveCodec(arrayType(integerType()), adapterWith([[integerType(), toText]]));
      expect(reverse.fromDb).toBe(IDENTITY);
      expect(reverse.toDb([1, 2])).toEqual(["1", "2"]);
    });

    test("an element override that converts nothing makes the array convert nothing", () => {
      const element = dateType({ as: "date" });
      const nothing: Codec = { fromDb: IDENTITY, toDb: IDENTITY };
      const codec = resolveCodec(arrayType(element), adapterWith([[element, nothing]]));
      expect(codec.fromDb).toBe(IDENTITY);
      expect(codec.toDb).toBe(IDENTITY);
    });

    test("an override of the array itself wins over its element's", () => {
      const array = arrayType(bigintType());
      const jsonText: Codec = {
        fromDb: (text) => JSON.parse(text as string),
        toDb: (value) => JSON.stringify(value),
      };
      const adapter = adapterWith([
        [array, jsonText],
        [bigintType(), int8],
      ]);
      expect(resolveCodec(array, adapter)).toBe(jsonText);
      expect(adapter.typeOverrides).toHaveBeenCalledTimes(1);
    });

    test("without any override an array keeps its own conversions", () => {
      const plain = arrayType(stringType());
      const identity = resolveCodec(plain, adapterWith());
      expect(identity.fromDb).toBe(IDENTITY);
      expect(identity.toDb).toBe(IDENTITY);

      const dates = arrayType(dateType({ as: "date" }));
      const codec = resolveCodec(dates, adapterWith());
      expect(codec.fromDb).toBe(dates.fromDb);
      expect(codec.toDb).toBe(dates.toDb);
    });

    test("a nested array reaches the override of its innermost element", () => {
      const adapter = adapterWith([[bigintType(), int8]]);
      const codec = resolveCodec(arrayType(arrayType(bigintType())), adapter);
      expect(codec.fromDb([["1", "2"], null, ["3"]])).toEqual([[1n, 2n], null, [3n]]);
      expect(codec.toDb([[1n], [2n, 3n]])).toEqual([["1"], ["2", "3"]]);
    });
  });
});
