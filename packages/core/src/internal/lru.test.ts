import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { LruCache } from "./lru.js";

describe("LruCache", () => {
  test("returns what was stored and undefined for a miss", () => {
    const cache = new LruCache<string, number>(2);
    expect(cache.get("a")).toBeUndefined();
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.size).toBe(1);
    expect(cache.capacity).toBe(2);
  });

  test("evicts the least recently set entry when full", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.has("a")).toBe(false);
    expect([cache.get("b"), cache.get("c")]).toEqual([2, 3]);
    expect(cache.size).toBe(2);
  });

  test("a get makes the entry the most recently used", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
  });

  test("has does not count as a use", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.has("a")).toBe(true);
    cache.set("c", 3);
    expect(cache.has("a")).toBe(false);
  });

  test("setting an existing key replaces the value, refreshes it and evicts nothing", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 10);
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBe(10);
    cache.set("c", 3);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
  });

  test("delete removes one entry and reports whether it existed", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("a")).toBe(false);
    expect(cache.size).toBe(0);
  });

  test("clear removes everything and the cache stays usable", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
    cache.set("c", 3);
    expect(cache.get("c")).toBe(3);
  });

  test("a capacity of one keeps only the last entry", () => {
    const cache = new LruCache<number, string>(1);
    cache.set(1, "one");
    cache.set(2, "two");
    expect([cache.has(1), cache.get(2), cache.size]).toEqual([false, "two", 1]);
  });

  test("keeps falsy values other than undefined", () => {
    const cache = new LruCache<string, number | boolean | string | null>(4);
    cache.set("zero", 0);
    cache.set("false", false);
    cache.set("empty", "");
    cache.set("null", null);
    expect([cache.get("zero"), cache.get("false"), cache.get("empty"), cache.get("null")]).toEqual([
      0,
      false,
      "",
      null,
    ]);
  });

  test("keys are compared like Map keys: by identity for objects, NaN equals NaN", () => {
    const cache = new LruCache<unknown, number>(4);
    const key = {};
    cache.set(key, 1);
    cache.set(Number.NaN, 2);
    expect(cache.get(key)).toBe(1);
    expect(cache.get({})).toBeUndefined();
    expect(cache.get(Number.NaN)).toBe(2);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects a capacity of %s", (capacity) => {
    expect(() => new LruCache(capacity)).toThrow(RangeError);
    expect(() => new LruCache(capacity)).toThrow(
      `LruCache capacity must be a positive integer, got ${capacity}`,
    );
  });

  test("behaves like a reference model under any sequence of operations", () => {
    type Op = { op: "get" | "set" | "delete" | "has"; key: number; value: number } | { op: "clear" };
    const operation: fc.Arbitrary<Op> = fc.oneof(
      {
        weight: 9,
        arbitrary: fc.record({
          op: fc.constantFrom("get", "set", "delete", "has"),
          key: fc.integer({ min: 0, max: 7 }),
          value: fc.integer(),
        }),
      },
      { weight: 1, arbitrary: fc.constant({ op: "clear" } as const) },
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.array(operation, { maxLength: 200 }),
        (capacity, ops) => {
          const cache = new LruCache<number, number>(capacity);
          // Reference: an array ordered from least to most recently used.
          let model: [number, number][] = [];
          for (const step of ops) {
            if (step.op === "clear") {
              cache.clear();
              model = [];
              continue;
            }
            const at = model.findIndex(([key]) => key === step.key);
            switch (step.op) {
              case "get": {
                const expected = at === -1 ? undefined : model[at]![1];
                expect(cache.get(step.key)).toBe(expected);
                if (at !== -1) model.push(...model.splice(at, 1));
                break;
              }
              case "has":
                expect(cache.has(step.key)).toBe(at !== -1);
                break;
              case "delete":
                expect(cache.delete(step.key)).toBe(at !== -1);
                if (at !== -1) model.splice(at, 1);
                break;
              case "set":
                cache.set(step.key, step.value);
                if (at !== -1) model.splice(at, 1);
                else if (model.length === capacity) model.shift();
                model.push([step.key, step.value]);
                break;
            }
            expect(cache.size).toBe(model.length);
            expect(cache.size).toBeLessThanOrEqual(capacity);
          }
          for (const [key] of model) expect(cache.has(key)).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
