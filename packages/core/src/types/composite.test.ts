import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import type { AnyFieldType } from "../contracts/type.js";
import { IDENTITY } from "../contracts/type.js";
import { CastError, SchemaDefinitionError } from "../errors.js";
import { arrayType, elementTypeOf, enumType, jsonType, mapElements } from "./composite.js";
import { defineType } from "./define.js";
import { bigintType, integerType, stringType } from "./scalars.js";
import { dateType, timestampType } from "./temporal.js";

const throwingProxy = (target: object): object =>
  new Proxy(target, {
    get() {
      throw new Error("trap");
    },
    ownKeys() {
      throw new Error("trap");
    },
    getPrototypeOf() {
      throw new Error("trap");
    },
  });

function nested(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i++) value = i % 2 === 0 ? [value] : { v: value };
  return value;
}

describe("json", () => {
  const type = jsonType();

  test.each([
    ["an object", { theme: "dark", count: 2, on: true, none: null }],
    ["an array", [1, "a", null, { b: [true] }]],
    ["a string", "text"],
    ["an empty string", ""],
    ["zero", 0],
    ["a negative float", -1.5],
    ["false", false],
    ["an empty object", {}],
    ["an empty array", []],
    ["an object without a prototype", Object.assign(Object.create(null), { a: [1] })],
    ["an object with a toString key", { toString: "mine", constructor: 1 }],
    ["nesting 500 deep", nested(500)],
  ])("accepts %s and returns the same value", (_label, input) => {
    const result = type.cast(input);
    expect(result.success).toBe(true);
    expect((result as { data: unknown }).data).toBe(input);
  });

  test("walks a value that is referenced from many places once", () => {
    // 2^60 paths lead to the innermost array; walking each of them would never finish.
    let value: unknown = [1];
    for (let i = 0; i < 60; i++) value = [value, value];
    const started = performance.now();
    expect(type.cast(value).success).toBe(true);
    let invalid: unknown = [undefined];
    for (let i = 0; i < 60; i++) invalid = { a: invalid, b: invalid };
    expect(type.cast(invalid).success).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("accepts a plain object and an array made in another realm", () => {
    const foreign = runInNewContext('({ theme: "dark", tags: ["a", { n: 1 }] })') as object;
    expect(Object.getPrototypeOf(foreign)).not.toBe(Object.prototype);
    expect((type.cast(foreign) as { data: unknown }).data).toBe(foreign);
    expect(type.cast(runInNewContext("({ at: new Date(0) })")).success).toBe(false);
    expect(type.cast(runInNewContext("new (class Point { x = 1 })()")).success).toBe(false);
    expect(type.cast(runInNewContext("new Map()")).success).toBe(false);
  });

  test("accepts the same object in two places (shared, not cyclic)", () => {
    const shared = { n: 1 };
    expect(type.cast({ a: shared, b: shared, c: [shared, shared] }).success).toBe(true);
  });

  const cyclicObject: Record<string, unknown> = { a: { b: {} } };
  (cyclicObject.a as Record<string, unknown>).b = cyclicObject;
  const cyclicArray: unknown[] = [];
  cyclicArray.push([cyclicArray]);
  const sparse: unknown[] = [];
  sparse[2] = 1;
  class Point {
    x = 1;
  }

  test.each([
    ["undefined", undefined],
    ["undefined inside an object", { a: undefined }],
    ["undefined inside an array", [undefined]],
    ["a sparse array", sparse],
    ["NaN", Number.NaN],
    ["Infinity inside a document", { a: [Number.POSITIVE_INFINITY] }],
    ["a Date", new Date(0)],
    ["a Date inside a document", { at: new Date(0) }],
    ["a Map", new Map()],
    ["a Set", new Set([1])],
    ["a class instance", new Point()],
    ["a Uint8Array", new Uint8Array(2)],
    ["a function", () => 1],
    ["a function inside a document", { f: () => 1 }],
    ["a symbol", Symbol("s")],
    ["a bigint", 1n],
    ["a bigint inside a document", [1n]],
    ["an object that contains itself", cyclicObject],
    ["an array that contains itself", cyclicArray],
    ["nesting 501 deep", nested(501)],
    ["nesting 100,000 deep", nested(100_000)],
    [
      "an object whose getter throws",
      Object.defineProperty({}, "a", {
        enumerable: true,
        get: () => {
          throw new Error("getter");
        },
      }),
    ],
    ["a proxy whose traps throw", throwingProxy({})],
    ["an array proxy whose traps throw", throwingProxy([])],
  ])("rejects %s", (_label, input) => {
    expect(type.cast(input)).toEqual({ success: false });
  });

  test("is a jsonb column, read and written without conversion, compared structurally", () => {
    expect(type.name).toBe("json");
    expect(type.db).toEqual({ kind: "jsonb" });
    expect(type.fromDb).toBe(IDENTITY);
    expect(type.toDb).toBe(IDENTITY);
    expect(type.equal({ a: [1, { b: 2 }], c: null }, { c: null, a: [1, { b: 2 }] })).toBe(true);
    expect(type.equal({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(type.equal([1, 2], [2, 1])).toBe(false);
  });

  test("every json type is the same object, whatever its type parameter", () => {
    expect(jsonType<{ a: number }>()).toBe(jsonType<string[]>());
  });
});

describe("mapElements", () => {
  test("converts each element and passes null through", () => {
    const double = mapElements((value) => (value as number) * 2);
    expect(double([1, null, 3, undefined])).toEqual([2, null, 6, null]);
    expect(double([])).toEqual([]);
  });

  test("returns a new array and leaves the input untouched", () => {
    const input = [1, 2];
    const output = mapElements((value) => String(value))(input);
    expect(output).toEqual(["1", "2"]);
    expect(output).not.toBe(input);
    expect(input).toEqual([1, 2]);
  });
});

describe("array", () => {
  const integers = arrayType(integerType());

  test("casts each element with the element type", () => {
    expect(integers.cast([1, "2", 3n])).toEqual({ success: true, data: [1, 2, 3] });
    expect(integers.cast([])).toEqual({ success: true, data: [] });
    expect(arrayType(stringType()).cast(["a", "b"])).toEqual({ success: true, data: ["a", "b"] });
  });

  test("returns a new array and leaves the input untouched", () => {
    const input = ["1", "2"];
    const result = integers.cast(input) as { data: number[] };
    expect(result.data).not.toBe(input);
    expect(input).toEqual(["1", "2"]);
  });

  test("fails with the index of the first element that fails", () => {
    expect(integers.cast([1, "x", "y"])).toEqual({ success: false, meta: { index: 1 } });
    expect(integers.cast([1.5])).toEqual({ success: false, meta: { index: 0 } });
  });

  test("rejects a null or missing element, with its index", () => {
    expect(integers.cast([1, null])).toEqual({ success: false, meta: { index: 1 } });
    expect(integers.cast([undefined, 1])).toEqual({ success: false, meta: { index: 0 } });
    const sparse: unknown[] = [1];
    sparse[2] = 3;
    expect(integers.cast(sparse)).toEqual({ success: false, meta: { index: 1 } });
  });

  test("rejects a null element even when the element type would accept null", () => {
    // json accepts a null inside a document, so only the array's own check rejects this.
    expect(jsonType().cast(null).success).toBe(true);
    const documents = arrayType(jsonType());
    expect(documents.cast([1, null])).toEqual({ success: false, meta: { index: 1 } });
    expect(documents.cast([undefined])).toEqual({ success: false, meta: { index: 0 } });
    expect(documents.cast([{ a: null }, [null]])).toEqual({ success: true, data: [{ a: null }, [null]] });
  });

  test("an element type written as a class, whose methods use `this`, works as an element", () => {
    class Prefixed {
      readonly name = "prefixed";
      readonly db = { kind: "text" } as const;
      constructor(readonly prefix: string) {}
      cast(input: unknown) {
        return typeof input === "string"
          ? ({ success: true, data: this.prefix + input } as const)
          : ({ success: false } as const);
      }
      fromDb(value: string): string {
        return this.prefix + value;
      }
      toDb(value: string): string {
        return value.slice(this.prefix.length);
      }
      equal(a: string, b: string): boolean {
        return this.prefix.length >= 0 && a === b;
      }
    }
    const type = arrayType(new Prefixed("p:"));
    expect(type.cast(["a", "b"])).toEqual({ success: true, data: ["p:a", "p:b"] });
    expect(type.fromDb(["a"])).toEqual(["p:a"]);
    expect(type.toDb(["p:a"])).toEqual(["a"]);
    expect(type.equal(["p:a"], ["p:a"])).toBe(true);
    expect(type.equal(["p:a"], ["p:b"])).toBe(false);
  });

  test("keeps the message and the metadata of the element that failed", () => {
    const even = defineType<number>({
      name: "even",
      db: { kind: "integer" },
      cast: (input) =>
        typeof input === "number" && input % 2 === 0
          ? { success: true, data: input }
          : { success: false, message: "must be divisible by {by}", meta: { by: 2, index: "inner" } },
    });
    expect(arrayType(even).cast([2, 4, 5])).toEqual({
      success: false,
      message: "must be divisible by {by}",
      meta: { by: 2, index: 2 },
    });
    const quiet = defineType<number>({
      name: "quiet",
      db: { kind: "integer" },
      cast: () => ({ success: false, meta: { reason: "never" } }),
    });
    expect(arrayType(quiet).cast([1])).toEqual({ success: false, meta: { reason: "never", index: 0 } });
  });

  test.each([
    ["a string", "abc"],
    ["a number", 1],
    ["an object", { 0: 1, length: 1 }],
    ["a Set", new Set([1])],
    ["a Uint8Array", new Uint8Array([1])],
    ["null", null],
    ["undefined", undefined],
    ["an array proxy whose traps throw", throwingProxy([1])],
  ])("rejects %s", (_label, input) => {
    expect(integers.cast(input)).toEqual({ success: false });
  });

  test("a revoked proxy is rejected, not thrown", () => {
    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();
    expect(integers.cast(proxy)).toEqual({ success: false });
  });

  test("arrays nest", () => {
    const matrix = arrayType(arrayType(integerType()));
    expect(matrix.name).toBe("array(array(integer))");
    expect(matrix.db).toEqual({ kind: "array", of: { kind: "array", of: { kind: "integer" } } });
    expect(matrix.cast([["1"], [2, 3]])).toEqual({ success: true, data: [[1], [2, 3]] });
    expect(matrix.cast([[1], [2, 3, "x"]])).toEqual({ success: false, meta: { index: 1, path: [1, 2] } });
    expect(matrix.cast([1])).toEqual({ success: false, meta: { index: 0, path: [0] } });
    expect(matrix.cast([[1], null])).toEqual({ success: false, meta: { index: 1, path: [1] } });
    const cube = arrayType(matrix);
    expect(cube.cast([[[1]], [[2], [3, 4, 5.5]]])).toEqual({
      success: false,
      meta: { index: 1, path: [1, 1, 2] },
    });
    expect(integers.cast([1, "x"])).toEqual({ success: false, meta: { index: 1 } });
    expect(matrix.fromDb).toBe(IDENTITY);
    expect(matrix.equal([[1], [2]], [[1], [2]])).toBe(true);
    expect(matrix.equal([[1], [2]], [[1], [3]])).toBe(false);
  });

  test("is an array column named after its element", () => {
    expect(integers.name).toBe("array(integer)");
    expect(integers.db).toEqual({ kind: "array", of: { kind: "integer" } });
    expect(arrayType(timestampType()).db).toEqual({ kind: "array", of: { kind: "timestamptz" } });
  });

  test("an array of the same element type is the same type", () => {
    expect(arrayType(integerType())).toBe(integers);
    expect(arrayType(arrayType(integerType()))).toBe(arrayType(integers));
    expect(arrayType(stringType())).not.toBe(integers);
    expect(arrayType(bigintType())).not.toBe(arrayType(bigintType({ mode: "number" })));
  });

  test("needs no conversion when its element needs none", () => {
    for (const element of [
      integerType(),
      stringType(),
      timestampType(),
      jsonType(),
      bigintType(),
    ] as AnyFieldType[]) {
      const type = arrayType(element);
      expect(type.fromDb).toBe(IDENTITY);
      expect(type.toDb).toBe(IDENTITY);
    }
  });

  test("converts each element when its element converts, and passes NULL elements through", () => {
    const dates = arrayType(dateType({ as: "date" }));
    expect(dates.fromDb).not.toBe(IDENTITY);
    expect(dates.toDb).not.toBe(IDENTITY);
    expect(dates.fromDb(["2026-10-13", null as never, "2026-10-14"])).toEqual([
      new Date(Date.UTC(2026, 9, 13)),
      null,
      new Date(Date.UTC(2026, 9, 14)),
    ]);
    expect(dates.toDb([new Date(Date.UTC(2026, 9, 13)), null as never])).toEqual(["2026-10-13", null]);
  });

  test("converts only the direction that needs it", () => {
    const type = arrayType(bigintType({ mode: "number" }));
    expect(type.toDb).toBe(IDENTITY);
    expect(type.fromDb(["1", 2n, 3])).toEqual([1, 2, 3]);
    expect(() => type.fromDb(["9007199254740993"])).toThrow(CastError);
  });

  test("compares element by element with the element's equality", () => {
    const dates = arrayType(timestampType());
    const a = [new Date(1), new Date(2)];
    expect(dates.equal(a, a)).toBe(true);
    expect(dates.equal(a, [new Date(1), new Date(2)])).toBe(true);
    expect(dates.equal(a, [new Date(1), new Date(3)])).toBe(false);
    expect(dates.equal(a, [new Date(2), new Date(1)])).toBe(false);
    expect(dates.equal(a, [new Date(1)])).toBe(false);
    expect(dates.equal([], [])).toBe(true);
  });

  test("compares stored NULL elements without handing them to the element type", () => {
    const dates = arrayType(timestampType());
    const none = null as never;
    expect(dates.equal([none, new Date(1)], [none, new Date(1)])).toBe(true);
    expect(dates.equal([none], [new Date(1)])).toBe(false);
    expect(dates.equal([new Date(1)], [none])).toBe(false);
    expect(dates.equal([none], [undefined as never])).toBe(false);
  });

  test("elementTypeOf gives the element of an array type and undefined for anything else", () => {
    expect(elementTypeOf(integers)).toBe(integerType());
    expect(elementTypeOf(arrayType(integers))).toBe(integers);
    expect(elementTypeOf(integerType())).toBeUndefined();
    const lookalike = defineType<number[]>({
      name: "array(integer)",
      db: { kind: "array", of: { kind: "integer" } },
      cast: () => ({ success: false }),
    });
    expect(elementTypeOf(lookalike)).toBeUndefined();
  });
});

describe("enum from a list", () => {
  const role = enumType(["admin", "member"]);

  test("accepts the listed values", () => {
    expect(role.cast("admin")).toEqual({ success: true, data: "admin" });
    expect(role.cast("member")).toEqual({ success: true, data: "member" });
  });

  test.each([
    "owner",
    "Admin",
    "admin ",
    "",
    "toString",
    "constructor",
    "__proto__",
    0,
    1,
    true,
    null,
    undefined,
    {},
    ["admin"],
  ])("rejects %s", (input) => {
    expect(role.cast(input)).toEqual({ success: false });
  });

  test("is a text column, read and written without conversion", () => {
    expect(role.name).toBe("enum");
    expect(role.db).toEqual({ kind: "text" });
    expect(role.fromDb).toBe(IDENTITY);
    expect(role.toDb).toBe(IDENTITY);
    expect(role.equal("admin", "admin")).toBe(true);
    expect(role.equal("admin", "member")).toBe(false);
  });

  test("the same list gives the same type; another order or another list does not", () => {
    expect(enumType(["admin", "member"])).toBe(role);
    expect(enumType(["member", "admin"])).not.toBe(role);
    expect(enumType(["admin"])).not.toBe(role);
  });
});

describe("enum from a mapping", () => {
  const level = enumType({ low: 1, high: 2 });
  const status = enumType({ active: "A", archived: "X" });

  test("accepts a key or its stored value, and gives the key", () => {
    expect(level.cast("low")).toEqual({ success: true, data: "low" });
    expect(level.cast(2)).toEqual({ success: true, data: "high" });
    expect(status.cast("archived")).toEqual({ success: true, data: "archived" });
    expect(status.cast("X")).toEqual({ success: true, data: "archived" });
  });

  test.each([3, 0, "2", "1", "medium", "LOW", 1n, true, null, undefined, {}, [1]])("rejects %s", (input) => {
    expect(level.cast(input)).toEqual({ success: false });
  });

  test("a key may be spelled like its own stored value", () => {
    const same = enumType({ a: "a", b: "B" });
    expect(same.cast("a")).toEqual({ success: true, data: "a" });
    expect(same.cast("B")).toEqual({ success: true, data: "b" });
    expect(same.toDb("a")).toBe("a");
    expect(same.fromDb("a")).toBe("a");
  });

  test("casting a stored value gives back the key it was written from, for every member", () => {
    for (const [type, keys] of [
      [level, ["low", "high"]],
      [status, ["active", "archived"]],
    ] as const) {
      for (const key of keys) {
        expect(type.cast(type.toDb(key as never))).toEqual({ success: true, data: key });
      }
    }
  });

  test("writes the stored value and reads the key back", () => {
    expect(level.toDb("low")).toBe(1);
    expect(level.toDb("high")).toBe(2);
    expect(level.fromDb(1)).toBe("low");
    expect(level.fromDb(2)).toBe("high");
    expect(status.toDb("active")).toBe("A");
    expect(status.fromDb("X")).toBe("archived");
  });

  test("throws CastError when the stored value is not in the mapping, without quoting it", () => {
    const read = () => level.fromDb(97531 as never);
    expect(read).toThrow(CastError);
    expect(read).toThrow("An enum column holds a number that is not one of the enum's stored values (2, 1)");
    expect(() => status.fromDb("secret-value" as never)).toThrow(
      /holds a string that is not one of.*"A", "X"/,
    );
    try {
      status.fromDb("secret-value" as never);
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-value");
    }
  });

  test("throws CastError when asked to write a value that is not a key", () => {
    const write = () => level.toDb("medium" as never);
    expect(write).toThrow(CastError);
    expect(write).toThrow('not a member of the enum ("high", "low")');
  });

  test("is an integer column for number values and a text column for string values", () => {
    expect(level.name).toBe("enum");
    expect(level.db).toEqual({ kind: "integer" });
    expect(status.db).toEqual({ kind: "text" });
    expect(level.fromDb).not.toBe(IDENTITY);
    expect(level.toDb).not.toBe(IDENTITY);
  });

  test("the same mapping gives the same type, whatever the key order", () => {
    expect(enumType({ high: 2, low: 1 })).toBe(level);
    expect(enumType({ low: 1, high: 3 })).not.toBe(level);
    expect(enumType({ low: "1", high: "2" })).not.toBe(level);
  });
});

describe("enum definitions that are rejected", () => {
  test.each([
    ["an empty list", [], /needs at least one value/],
    ["an empty mapping", {}, /needs at least one value/],
    [
      "a list with a number",
      ["a", 1],
      /values must be strings, but got 1\. For other stored values use a mapping/,
    ],
    ["a list with an object", ["a", {}], /values must be strings, but got object/],
    ["a repeated value", ["a", "b", "a"], /values must be distinct, but got \["a","b","a"\]/],
    ["a mapping with mixed values", { a: 1, b: "x" }, /all strings or all whole numbers, but got 1, "x"/],
    ["a mapping with mixed values, string first", { a: "x", b: 1 }, /all strings or all whole numbers/],
    ["a mapping with a fraction", { a: 1.5 }, /all strings or all whole numbers, but got 1\.5/],
    ["a mapping with a boolean", { a: true }, /all strings or all whole numbers, but got boolean/],
    ["a mapping with a null", { a: null }, /all strings or all whole numbers, but got object/],
    ["a mapping with a repeated value", { a: 1, b: 1 }, /mapping values must be distinct, but got 1, 1/],
    [
      "a mapping where a key is another key's stored value",
      { a: "b", b: "a" },
      /mapping is ambiguous: "a" is a key and also the stored value of "b"/,
    ],
    [
      "a mapping where one key is another key's stored value",
      { x: "y", y: "z" },
      /mapping is ambiguous: "y"/,
    ],
    ["a string", "admin", /takes a list of strings.*but got string/],
    ["null", null, /takes a list of strings.*but got null/],
    ["nothing", undefined, /takes a list of strings.*but got undefined/],
  ])("%s", (_label, members, message) => {
    const make = () => enumType(members as never);
    expect(make).toThrow(SchemaDefinitionError);
    expect(make).toThrow(message);
  });
});
