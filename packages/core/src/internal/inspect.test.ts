import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { formatStruct, formatValue, omitRedacted, REDACTED, redactFields } from "./inspect.js";

const SECRET = "s3cr3t-value";

describe("redactFields", () => {
  test("replaces the redacted values and keeps the rest, in the same order", () => {
    const row = { id: 1, email: "a@b.c", passwordHash: SECRET, token: SECRET };
    const out = redactFields(row, new Set(["passwordHash", "token"]));
    expect(out).toEqual({ id: 1, email: "a@b.c", passwordHash: REDACTED, token: REDACTED });
    expect(Object.keys(out)).toEqual(["id", "email", "passwordHash", "token"]);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  test("returns a copy and leaves the input alone", () => {
    const row = { passwordHash: SECRET };
    const out = redactFields(row, new Set(["passwordHash"]));
    expect(out).not.toBe(row);
    expect(row.passwordHash).toBe(SECRET);
  });

  test("redacts a key even when its value is null or undefined", () => {
    expect(redactFields({ a: null, b: undefined }, new Set(["a", "b"]))).toEqual({
      a: REDACTED,
      b: REDACTED,
    });
  });

  test("ignores redacted keys that are absent, inherited or symbol-keyed", () => {
    const base = { inherited: SECRET };
    const row = Object.assign(Object.create(base) as Record<string | symbol, unknown>, {
      id: 1,
      [Symbol("s")]: 2,
    });
    expect(redactFields(row, new Set(["inherited", "missing"]))).toEqual({ id: 1 });
  });

  test("with nothing redacted it is a shallow copy", () => {
    const nested = { deep: true };
    const out = redactFields({ nested }, new Set());
    expect(out).toEqual({ nested });
    expect(out.nested).toBe(nested);
  });
});

describe("omitRedacted", () => {
  test("drops the redacted keys entirely", () => {
    const out = omitRedacted({ id: 1, passwordHash: SECRET, email: "a@b.c" }, new Set(["passwordHash"]));
    expect(out).toEqual({ id: 1, email: "a@b.c" });
    expect(Object.hasOwn(out, "passwordHash")).toBe(false);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  test("with nothing redacted it is a shallow copy", () => {
    const row = { id: 1 };
    const out = omitRedacted(row, new Set());
    expect(out).toEqual(row);
    expect(out).not.toBe(row);
  });
});

describe("formatValue", () => {
  test.each([
    ["ada", '"ada"'],
    ['say "hi"\n', '"say \\"hi\\"\\n"'],
    ["", '""'],
    [42, "42"],
    [-0, "-0"],
    [0, "0"],
    [1.5, "1.5"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [10n, "10n"],
    [true, "true"],
    [false, "false"],
    [undefined, "undefined"],
    [null, "null"],
    [Symbol("tag"), "Symbol(tag)"],
    [new Date(0), "1970-01-01T00:00:00.000Z"],
    [new Date(Number.NaN), "Invalid Date"],
    [new Uint8Array([1, 2, 3]), "<Uint8Array 3 bytes>"],
    [Buffer.from("abcd"), "<Buffer 4 bytes>"],
    [[], "[]"],
    [[1, "a", null], '[1, "a", null]'],
    [{}, "{}"],
    [{ id: 1, tags: ["a", "b"] }, '{ id: 1, tags: ["a", "b"] }'],
    [{ "not an identifier": 1, $ok: 2, _x: 3 }, '{ "not an identifier": 1, $ok: 2, _x: 3 }'],
    [Object.create(null), "{}"],
    [Object.assign(Object.create(null) as object, { a: 1 }), "{ a: 1 }"],
  ])("%o -> %s", (value, expected) => {
    expect(formatValue(value)).toBe(expected);
  });

  test("names functions and classes", () => {
    function named() {}
    expect(formatValue(named)).toBe("[Function: named]");
    expect(formatValue(() => {})).toBe("[Function]");
    class Point {
      x = 1;
      y = 2;
    }
    expect(formatValue(new Point())).toBe("Point { x: 1, y: 2 }");
    class Empty {}
    expect(formatValue(new Empty())).toBe("Empty {}");
    expect(formatValue(new Map([[1, 2]]))).toBe("Map {}");
  });

  test("falls back to Object for a prototype without a usable constructor", () => {
    expect(formatValue(Object.create({ constructor: undefined }))).toBe("Object {}");
    expect(formatValue(Object.assign(Object.create({ constructor: {} }) as object, { a: 1 }))).toBe(
      "Object { a: 1 }",
    );
  });

  test("cuts long strings and says how long they were", () => {
    const long = "x".repeat(101);
    expect(formatValue(long)).toBe(`"${"x".repeat(100)}"… (101 characters)`);
    expect(formatValue("x".repeat(100))).toBe(`"${"x".repeat(100)}"`);
  });

  test("shows at most 20 entries of an array or an object", () => {
    const array = Array.from({ length: 23 }, (_, i) => i);
    expect(formatValue(array)).toBe(`[${array.slice(0, 20).join(", ")}, … 3 more]`);
    expect(formatValue(array.slice(0, 20))).toBe(`[${array.slice(0, 20).join(", ")}]`);
    const object = Object.fromEntries(array.map((i) => [`k${i}`, i]));
    expect(formatValue(object)).toBe(
      `{ ${array
        .slice(0, 20)
        .map((i) => `k${i}: ${i}`)
        .join(", ")}, … 3 more }`,
    );
  });

  test("abbreviates below three levels of nesting", () => {
    class Leaf {
      v = 1;
    }
    expect(formatValue({ a: { b: { c: { d: 1 } } } })).toBe("{ a: { b: { c: [Object] } } }");
    expect(formatValue([[[[1]]]])).toBe("[[[[Array]]]]");
    expect(formatValue({ a: { b: { c: new Leaf() } } })).toBe("{ a: { b: { c: [Leaf] } } }");
    expect(formatValue({ a: { b: { c: 1, d: "s", e: null } } })).toBe(
      '{ a: { b: { c: 1, d: "s", e: null } } }',
    );
  });

  test("marks cycles, and shows a shared object every time it appears", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(formatValue(cyclic)).toBe('{ name: "loop", self: [Circular] }');
    const ring: unknown[] = [];
    ring.push(ring);
    expect(formatValue(ring)).toBe("[[Circular]]");
    const shared = { n: 1 };
    expect(formatValue([shared, shared])).toBe("[{ n: 1 }, { n: 1 }]");
    expect(formatValue({ a: shared, b: [shared] })).toBe("{ a: { n: 1 }, b: [{ n: 1 }] }");
  });

  test("does not call toString, toJSON or valueOf defined by the value", () => {
    const hostile = {
      toString() {
        throw new Error("toString called");
      },
      toJSON() {
        throw new Error("toJSON called");
      },
      valueOf() {
        throw new Error("valueOf called");
      },
    };
    expect(formatValue(hostile)).toBe(
      "{ toString: [Function: toString], toJSON: [Function: toJSON], valueOf: [Function: valueOf] }",
    );
  });

  test("renders a value whose getters throw as [unprintable]", () => {
    const hostile = {
      get boom(): never {
        throw new Error("getter called");
      },
    };
    expect(formatValue(hostile)).toBe("[unprintable]");
    expect(formatValue([hostile])).toBe("[unprintable]");
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("trap");
        },
      },
    );
    expect(formatValue(proxy)).toBe("[unprintable]");
  });

  test("never throws and always returns a string, whatever it is given", () => {
    fc.assert(
      fc.property(
        fc.anything({
          withBigInt: true,
          withDate: true,
          withTypedArray: true,
          withMap: true,
          withSet: true,
          withNullPrototype: true,
        }),
        (value) => {
          expect(typeof formatValue(value)).toBe("string");
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe("formatStruct", () => {
  test("renders the name and the fields, with redacted values hidden", () => {
    const row = { id: 1, email: "a@b.c", passwordHash: SECRET };
    const text = formatStruct("User", row, new Set(["passwordHash"]));
    expect(text).toBe('User { id: 1, email: "a@b.c", passwordHash: **redacted** }');
    expect(text).not.toContain(SECRET);
  });

  test("renders an empty record", () => {
    expect(formatStruct("Empty", {}, new Set())).toBe("Empty {}");
  });

  test("quotes keys that are not identifiers", () => {
    expect(formatStruct("Row", { "odd key": 1 }, new Set())).toBe('Row { "odd key": 1 }');
  });

  test("formats nested values like formatValue, one level down", () => {
    const row = { settings: { theme: { dark: { deep: true } } }, tags: ["a"], at: new Date(0) };
    expect(formatStruct("User", row, new Set())).toBe(
      'User { settings: { theme: { dark: [Object] } }, tags: ["a"], at: 1970-01-01T00:00:00.000Z }',
    );
  });

  test("marks a reference back to the record itself", () => {
    const row: Record<string, unknown> = { id: 1 };
    row.self = row;
    expect(formatStruct("Node", row, new Set())).toBe("Node { id: 1, self: [Circular] }");
  });

  test("does not read the value of a redacted field", () => {
    let read = false;
    const row = {
      id: 1,
      get passwordHash(): string {
        read = true;
        return SECRET;
      },
    };
    expect(formatStruct("User", row, new Set(["passwordHash"]))).toBe(
      "User { id: 1, passwordHash: **redacted** }",
    );
    expect(read).toBe(false);
  });

  test("a field whose getter throws is [unprintable]; the others still render", () => {
    const row = {
      id: 1,
      get broken(): never {
        throw new Error("getter called");
      },
      name: "ada",
    };
    expect(formatStruct("User", row, new Set())).toBe('User { id: 1, broken: [unprintable], name: "ada" }');
  });

  test("no redacted value ever appears in the output", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.stringMatching(/^[a-z]{1,6}$/), fc.string({ minLength: 8 }), { minKeys: 1 }),
        (values) => {
          const keys = Object.keys(values);
          const redacted = new Set(keys.filter((_, i) => i % 2 === 0));
          const text = formatStruct("Row", values, redacted);
          const visible = keys.filter((key) => !redacted.has(key)).map((key) => values[key]);
          for (const key of redacted) {
            const secret = values[key] as string;
            // A redacted value may only show up if a visible field holds the same text.
            if (!visible.some((v) => (v as string).includes(secret))) {
              expect(text).not.toContain(JSON.stringify(secret).slice(1, -1));
            }
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});
