import { describe, expect, test, vi } from "vitest";
import type { DbType } from "../contracts/type.js";
import { IDENTITY } from "../contracts/type.js";
import { SchemaDefinitionError } from "../errors.js";
import { defineType, detached, parameterized } from "./define.js";

const castString = (input: unknown) =>
  typeof input === "string" ? ({ success: true, data: input } as const) : ({ success: false } as const);

describe("defineType", () => {
  test("fills in IDENTITY conversions and Object.is equality", () => {
    const type = defineType<string>({ name: "slug", db: { kind: "text" }, cast: castString });
    expect(type.name).toBe("slug");
    expect(type.db).toEqual({ kind: "text" });
    expect(type.cast).toBe(castString);
    expect(type.fromDb).toBe(IDENTITY);
    expect(type.toDb).toBe(IDENTITY);
    expect(type.equal).toBe(Object.is);
  });

  test("keeps the conversions and the equality it is given", () => {
    const fromDb = (stored: string) => BigInt(stored);
    const toDb = (value: bigint) => value.toString();
    const equal = (a: bigint, b: bigint) => a === b;
    const type = defineType<bigint, string>({
      name: "cents",
      db: { kind: "decimal" },
      cast: (input) => (typeof input === "bigint" ? { success: true, data: input } : { success: false }),
      fromDb,
      toDb,
      equal,
    });
    expect(type.fromDb).toBe(fromDb);
    expect(type.toDb).toBe(toDb);
    expect(type.equal).toBe(equal);
    expect(type.fromDb("12")).toBe(12n);
    expect(type.toDb(12n)).toBe("12");
  });

  test("every type has the same keys in the same order, and is frozen", () => {
    const plain = defineType<string>({ name: "a", db: { kind: "text" }, cast: castString });
    const full = defineType<string, string>({
      equal: Object.is,
      toDb: (v) => v,
      fromDb: (v) => v,
      cast: castString,
      db: { kind: "text" },
      name: "b",
    });
    const keys = ["name", "db", "cast", "fromDb", "toDb", "equal"];
    expect(Object.keys(plain)).toEqual(keys);
    expect(Object.keys(full)).toEqual(keys);
    expect(Object.isFrozen(plain)).toBe(true);
  });

  test.each([
    ["an empty name", { name: "", db: { kind: "text" }, cast: castString }, /non-empty name/],
    [
      "a name that is not a string",
      { name: 5, db: { kind: "text" }, cast: castString },
      /non-empty name.*number/,
    ],
    ["no db", { name: "x", cast: castString }, /Type "x": db must be a column type.*undefined/],
    ["a null db", { name: "x", db: null, cast: castString }, /db must be a column type.*null/],
    [
      "a db that is a string",
      { name: "x", db: "text", cast: castString },
      /db must be a column type.*string/,
    ],
    ["a db that is an array", { name: "x", db: [], cast: castString }, /db must be a column type.*an array/],
    [
      "an array db without an element",
      { name: "x", db: { kind: "array" }, cast: castString },
      /db\.of must be/,
    ],
    [
      "a column kind that does not exist",
      { name: "x", db: { kind: "varchar" }, cast: castString },
      /db\.kind is "varchar", which is not a column kind.*\{ kind: "custom", sql \}/,
    ],
    [
      "an array of a column kind that does not exist",
      { name: "x", db: { kind: "array", of: { kind: "int" } }, cast: castString },
      /db\.of\.kind is "int"/,
    ],
    [
      "a cast that is not a function",
      { name: "x", db: { kind: "text" }, cast: "no" },
      /cast must be a function/,
    ],
    [
      "a fromDb that is not a function",
      { name: "x", db: { kind: "text" }, cast: castString, fromDb: 1 },
      /fromDb must be/,
    ],
    [
      "a toDb that is not a function",
      { name: "x", db: { kind: "text" }, cast: castString, toDb: {} },
      /toDb must be/,
    ],
    [
      "an equal that is not a function",
      { name: "x", db: { kind: "text" }, cast: castString, equal: "is" },
      /equal must be/,
    ],
  ])("rejects %s", (_label, definition, message) => {
    const define = () => defineType(definition as never);
    expect(define).toThrow(SchemaDefinitionError);
    expect(define).toThrow(message);
  });

  test("keeps a frozen copy of the column type, so that changing the caller's object changes nothing", () => {
    const db = { kind: "custom" as const, sql: "citext" };
    const type = defineType<string>({ name: "x", db, cast: castString });
    db.sql = "x; drop table users";
    expect(type.db).toEqual({ kind: "custom", sql: "citext" });
    expect(Object.isFrozen(type.db)).toBe(true);

    const inner = { kind: "custom" as const, sql: "mood" };
    const nested = defineType<string>({ name: "y", db: { kind: "array", of: inner }, cast: castString });
    inner.sql = "y'; --";
    expect(nested.db).toEqual({ kind: "array", of: { kind: "custom", sql: "mood" } });
    expect(Object.isFrozen((nested.db as { of: object }).of)).toBe(true);

    // Extra properties of the caller's object are not carried over.
    const extra = defineType<string>({
      name: "z",
      db: { kind: "text", sql: "ignored" } as never,
      cast: castString,
    });
    expect(extra.db).toEqual({ kind: "text" });
  });

  test.each(["money", "citext", "numeric(10, 2)", "timestamp with time zone", "public.mood[]"])(
    'accepts the custom SQL type "%s"',
    (sql) => {
      expect(defineType<string>({ name: "x", db: { kind: "custom", sql }, cast: castString }).db).toEqual({
        kind: "custom",
        sql,
      });
    },
  );

  test.each([
    "text; drop table users",
    "text'",
    'te"xt',
    "text -- comment",
    "text/**/",
    "numeric(10,2) not null default (select 1)",
    "",
    "1text",
  ])('rejects the custom SQL type "%s"', (sql) => {
    const define = () => defineType<string>({ name: "x", db: { kind: "custom", sql }, cast: castString });
    expect(define).toThrow(SchemaDefinitionError);
    expect(define).toThrow(/plain SQL type name/);
  });

  test("rejects a custom SQL type that is not a string, and one nested in an array type", () => {
    expect(() =>
      defineType<string>({ name: "x", db: { kind: "custom", sql: 5 } as never, cast: castString }),
    ).toThrow(/db\.sql must be a plain SQL type name/);
    const nested: DbType = { kind: "array", of: { kind: "array", of: { kind: "custom", sql: "a;b" } } };
    expect(() => defineType<string>({ name: "x", db: nested, cast: castString })).toThrow(
      /db\.of\.of\.sql must be a plain SQL type name/,
    );
  });
});

describe("parameterized", () => {
  const family = () => {
    const build = vi.fn((_options: unknown) =>
      defineType<string>({ name: "member", db: { kind: "text" }, cast: castString }),
    );
    return { build, make: parameterized(build) };
  };

  test("returns the same type for equal options and builds it once", () => {
    const { build, make } = family();
    const first = make({ code: "EUR", digits: 2 });
    expect(make({ code: "EUR", digits: 2 })).toBe(first);
    expect(make({ digits: 2, code: "EUR" })).toBe(first);
    expect(build).toHaveBeenCalledTimes(1);
    expect(make({ code: "USD", digits: 2 })).not.toBe(first);
    expect(build).toHaveBeenCalledTimes(2);
  });

  test("compares nested objects by content and arrays in order", () => {
    const { make } = family();
    expect(make({ a: { b: [1, 2] } })).toBe(make({ a: { b: [1, 2] } }));
    expect(make({ a: { b: [1, 2] } })).not.toBe(make({ a: { b: [2, 1] } }));
    expect(make([])).not.toBe(make({}));
    expect(make([[]])).not.toBe(make([]));
    expect(make(Object.assign(Object.create(null), { a: 1 }))).toBe(make({ a: 1 }));
  });

  test("tells apart values that print alike", () => {
    const { make } = family();
    const distinct = [
      1,
      "1",
      1n,
      true,
      "true",
      false,
      "false",
      null,
      "null",
      undefined,
      "undefined",
      0,
      -0,
      "",
      [],
      {},
      [1],
      ["1"],
    ];
    const types = distinct.map((options) => make(options));
    expect(new Set(types).size).toBe(distinct.length);
    distinct.forEach((options, i) => {
      expect(make(options)).toBe(types[i]);
    });
  });

  test("a key that looks like structure cannot collide with structure", () => {
    const { make } = family();
    expect(make({ 'a":1,"b': 2 })).not.toBe(make({ a: 1, b: 2 }));
    expect(make(["a,b"])).not.toBe(make(["a", "b"]));
  });

  test("compares types, functions, symbols and class instances by identity", () => {
    const { make } = family();
    const inner = defineType<string>({ name: "inner", db: { kind: "text" }, cast: castString });
    const twin = defineType<string>({ name: "inner", db: { kind: "text" }, cast: castString });
    expect(make({ of: inner })).toBe(make({ of: inner }));
    expect(make({ of: inner })).not.toBe(make({ of: twin }));

    const fn = () => 1;
    expect(make(fn)).toBe(make(fn));
    expect(make(fn)).not.toBe(make(() => 1));

    const symbol = Symbol("s");
    expect(make(symbol)).toBe(make(symbol));
    expect(make(symbol)).not.toBe(make(Symbol("s")));

    const date = new Date(0);
    expect(make(date)).toBe(make(date));
    expect(make(date)).not.toBe(make(new Date(0)));
  });

  test("compares symbol keys too, by the symbol's identity", () => {
    const { make } = family();
    const key = Symbol.for("x");
    expect(make({ [key]: 1 })).toBe(make({ [key]: 1 }));
    expect(make({ [key]: 1 })).not.toBe(make({ [key]: 2 }));
    expect(make({ [key]: 1 })).not.toBe(make({}));
    expect(make({ [Symbol("x")]: 1 })).not.toBe(make({ [Symbol("x")]: 1 }));
    const other = Symbol("y");
    expect(make({ [key]: 1, [other]: 2 })).toBe(make({ [other]: 2, [key]: 1 }));
    // A symbol key that is not enumerable is not part of the options, like such a string key.
    const hidden = Object.defineProperty({}, key, { value: 1, enumerable: false });
    expect(make(hidden)).toBe(make({}));
  });

  test("options that contain themselves are refused, not followed forever", () => {
    const { make } = family();
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => make(cyclic)).toThrow(SchemaDefinitionError);
    expect(() => make(cyclic)).toThrow(/nested more than 100 levels deep/);
    const loop: unknown[] = [];
    loop.push(loop);
    expect(() => make(loop)).toThrow(SchemaDefinitionError);
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = [deep];
    expect(make(deep)).toBe(make(deep));
  });

  test("each family has its own cache", () => {
    const a = family();
    const b = family();
    expect(a.make({ n: 1 })).not.toBe(b.make({ n: 1 }));
  });
});

describe("detached", () => {
  class Shouting {
    readonly name = "shouting";
    readonly db = { kind: "text" } as const;
    constructor(readonly mark: string) {}
    cast(input: unknown) {
      return typeof input === "string"
        ? ({ success: true, data: input + this.mark } as const)
        : ({ success: false } as const);
    }
    fromDb(value: string): string {
      return value + this.mark;
    }
    toDb(value: string): string {
      return value.slice(0, -this.mark.length);
    }
    equal(a: string, b: string): boolean {
      return this.mark !== "" && a === b;
    }
  }

  test("gives the functions of a defined type as they are", () => {
    const fromDb = (stored: string) => stored.toUpperCase();
    const type = defineType<string, string>({
      name: "x",
      db: { kind: "text" },
      cast: castString,
      fromDb,
      toDb: (v) => v,
    });
    expect(detached(type, "fromDb")).toBe(fromDb);
    expect(detached(type, "cast")).toBe(castString);
    expect(detached(type, "equal")).toBe(Object.is);
  });

  test("binds the methods of a type that was written by hand as a class", () => {
    const type = new Shouting("!");
    expect(detached(type, "cast")("a")).toEqual({ success: true, data: "a!" });
    expect(detached(type, "fromDb")("a")).toBe("a!");
    expect(detached(type, "toDb")("a!")).toBe("a");
    expect(detached(type, "equal")("a", "a")).toBe(true);
  });

  test("never binds IDENTITY, so the reference check still skips it", () => {
    const handWritten = {
      name: "plain",
      db: { kind: "text" } as const,
      cast: castString,
      fromDb: IDENTITY,
      toDb: IDENTITY,
      equal: Object.is,
    };
    expect(detached(handWritten, "fromDb")).toBe(IDENTITY);
    expect(detached(handWritten, "toDb")).toBe(IDENTITY);
    const defined = defineType<string>({ name: "d", db: { kind: "text" }, cast: castString });
    expect(detached(defined, "toDb")).toBe(IDENTITY);
  });
});
