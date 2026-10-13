import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { deepEqual } from "./deep-equal.js";

describe("deepEqual", () => {
  test.each([
    [1, 1],
    ["a", "a"],
    [null, null],
    [undefined, undefined],
    [Number.NaN, Number.NaN],
    [0, -0],
    [[], []],
    [{}, {}],
    [
      [1, "a", null, [true]],
      [1, "a", null, [true]],
    ],
    [
      { theme: "dark", tags: ["a", "b"], nested: { n: 1 } },
      { nested: { n: 1 }, tags: ["a", "b"], theme: "dark" },
    ],
    [{ a: undefined }, { a: undefined }],
    [new Date(5), new Date(5)],
    [Object.assign(Object.create(null), { a: 1 }), Object.assign(Object.create(null), { a: 1 })],
  ])("%j equals %j", (a, b) => {
    expect(deepEqual(a, b)).toBe(true);
    expect(deepEqual(b, a)).toBe(true);
  });

  test.each([
    [1, 2],
    [1, "1"],
    [0, false],
    [null, undefined],
    [null, {}],
    [{}, null],
    [1, {}],
    [Number.NaN, 1],
    [[], {}],
    [[1, 2], [1]],
    [
      [1, 2],
      [2, 1],
    ],
    [{ a: 1 }, { a: 2 }],
    [{ a: 1 }, { b: 1 }],
    [{ a: 1 }, { a: 1, b: 2 }],
    [{ a: undefined }, { b: undefined }],
    [{ a: { b: [1] } }, { a: { b: [2] } }],
    [new Date(5), new Date(6)],
    [new Date(5), {}],
    [{ a: 1 }, Object.assign(Object.create(null), { a: 1 })],
  ])("%j does not equal %j", (a, b) => {
    expect(deepEqual(a, b)).toBe(false);
    expect(deepEqual(b, a)).toBe(false);
  });

  test("the same object is equal to itself without being walked", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(deepEqual(cyclic, cyclic)).toBe(true);
  });

  test("an inherited key does not stand in for an own key", () => {
    expect(deepEqual({ toString: undefined }, { valueOf: undefined })).toBe(false);
  });

  test("a JSON value equals its copy and its copy with keys reversed", () => {
    const reverseKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseKeys);
      if (typeof value !== "object" || value === null) return value;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).reverse()) {
        Object.defineProperty(out, key, {
          value: reverseKeys((value as Record<string, unknown>)[key]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    };
    fc.assert(
      fc.property(
        fc.jsonValue(),
        (value) => deepEqual(value, structuredClone(value)) && deepEqual(value, reverseKeys(value)),
      ),
      { numRuns: 1000 },
    );
  });

  test("agrees with JSON text on whether two JSON values differ", () => {
    const canonical = (value: unknown): string =>
      JSON.stringify(value, (_key, v: unknown) =>
        typeof v === "object" && v !== null && !Array.isArray(v)
          ? // Tagged, so that {} and [] stay different.
            [
              "\u0000object",
              ...Object.keys(v)
                .sort()
                .map((k) => [k, (v as Record<string, unknown>)[k]]),
            ]
          : v,
      );
    fc.assert(
      fc.property(
        fc.jsonValue(),
        fc.jsonValue(),
        (a, b) => deepEqual(a, b) === (canonical(a) === canonical(b)),
      ),
      { numRuns: 1000 },
    );
  });
});
