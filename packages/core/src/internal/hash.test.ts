import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { HASH_SEED, hashInt, hashString } from "./hash.js";

const isInt32 = (n: number): boolean => Number.isInteger(n) && n >= -(2 ** 31) && n < 2 ** 31;

/** The textbook FNV-1a over a byte sequence, for comparison. */
function fnv1a(bytes: readonly number[], seed = 0x811c9dc5): number {
  let h = seed;
  for (const byte of bytes) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

describe("HASH_SEED", () => {
  test("is the FNV-1a offset basis as a signed 32-bit integer", () => {
    expect(HASH_SEED).toBe(0x811c9dc5 | 0);
    expect(HASH_SEED).toBe(-2128831035);
  });
});

describe("hashInt", () => {
  test("is FNV-1a over the four little-endian bytes of the integer", () => {
    expect(hashInt(HASH_SEED, 0x04030201)).toBe(fnv1a([1, 2, 3, 4]));
    expect(hashInt(HASH_SEED, 0)).toBe(fnv1a([0, 0, 0, 0]));
    expect(hashInt(HASH_SEED, -1)).toBe(fnv1a([255, 255, 255, 255]));
    expect(hashInt(7, 0x80000000)).toBe(fnv1a([0, 0, 0, 0x80], 7));
  });

  test("matches known values, so the function cannot change unnoticed", () => {
    expect(hashInt(HASH_SEED, 0)).toBe(1268118805);
    expect(hashInt(HASH_SEED, 1)).toBe(fnv1a([1, 0, 0, 0]));
    expect(hashInt(HASH_SEED, 1)).not.toBe(hashInt(HASH_SEED, 0));
  });

  test("always returns a signed 32-bit integer", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (seed, value) => {
        expect(isInt32(hashInt(seed, value))).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  test("uses only the low 32 bits of the value", () => {
    expect(hashInt(HASH_SEED, 2 ** 32 + 5)).toBe(hashInt(HASH_SEED, 5));
    expect(hashInt(HASH_SEED, 5.9)).toBe(hashInt(HASH_SEED, 5));
  });

  test("depends on every byte of the value", () => {
    const base = hashInt(HASH_SEED, 0);
    for (const value of [1, 1 << 8, 1 << 16, 1 << 24]) expect(hashInt(HASH_SEED, value)).not.toBe(base);
  });

  test("depends on the incoming hash and on the order of the values", () => {
    expect(hashInt(1, 42)).not.toBe(hashInt(2, 42));
    expect(hashInt(hashInt(HASH_SEED, 1), 2)).not.toBe(hashInt(hashInt(HASH_SEED, 2), 1));
  });
});

describe("hashString", () => {
  test("is the length, then FNV-1a over the low and high byte of each UTF-16 code unit", () => {
    expect(hashString(HASH_SEED, "")).toBe(hashInt(HASH_SEED, 0));
    expect(hashString(HASH_SEED, "ab")).toBe(fnv1a([97, 0, 98, 0], hashInt(HASH_SEED, 2)));
    expect(hashString(HASH_SEED, "ሴ")).toBe(fnv1a([0x34, 0x12], hashInt(HASH_SEED, 1)));
  });

  test("always returns a signed 32-bit integer and is deterministic", () => {
    fc.assert(
      fc.property(fc.integer(), fc.string({ unit: "binary" }), (seed, value) => {
        const hash = hashString(seed, value);
        expect(isInt32(hash)).toBe(true);
        expect(hashString(seed, value)).toBe(hash);
      }),
      { numRuns: 2000 },
    );
  });

  test("tells apart strings that differ only in a high byte", () => {
    expect(hashString(HASH_SEED, "Ł")).not.toBe(hashString(HASH_SEED, "Ɂ"));
    expect(hashString(HASH_SEED, "A")).not.toBe(hashString(HASH_SEED, "Ł"));
  });

  test("tells apart different splits of the same characters", () => {
    const split = (a: string, b: string): number => hashString(hashString(HASH_SEED, a), b);
    expect(split("ab", "c")).not.toBe(split("a", "bc"));
    expect(split("", "abc")).not.toBe(split("abc", ""));
  });

  test("is sensitive to order and to the incoming hash", () => {
    expect(hashString(HASH_SEED, "ab")).not.toBe(hashString(HASH_SEED, "ba"));
    expect(hashString(1, "ab")).not.toBe(hashString(2, "ab"));
  });

  test("spreads typical identifiers without collisions", () => {
    const names = new Set<string>();
    for (const table of ["users", "posts", "comments", "tags", "orgs", "memberships", "profiles"]) {
      for (const column of ["id", "name", "email", "age", "title", "body", "inserted_at", "updated_at"]) {
        for (const alias of ["u", "p", "c", "t", "x0", "x1"]) names.add(`${alias}.${table}.${column}`);
      }
    }
    const hashes = new Set([...names].map((name) => hashString(HASH_SEED, name)));
    expect(hashes.size).toBe(names.size);
  });
});
