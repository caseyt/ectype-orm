import { expect, test } from "vitest";
import { uuidType } from "../types/index.js";
import { uuidv7 } from "./uuid.js";

const FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("a generated value is a version 7 UUID in the form the uuid type stores", () => {
  for (let i = 0; i < 1000; i++) {
    const id = uuidv7();
    expect(id).toMatch(FORMAT);
    expect(uuidType().cast(id)).toEqual({ success: true, data: id });
  }
});

test("the first 48 bits are the time in milliseconds", () => {
  expect(uuidv7(0).slice(0, 13)).toBe("00000000-0000");
  expect(uuidv7(1).slice(0, 13)).toBe("00000000-0001");
  expect(uuidv7(0x1234_5678_9abc).slice(0, 13)).toBe("12345678-9abc");
  expect(uuidv7(2 ** 48 - 1).slice(0, 13)).toBe("ffffffff-ffff");
  const before = Date.now();
  const stamped = Number.parseInt(uuidv7().replace("-", "").slice(0, 12), 16);
  expect(stamped).toBeGreaterThanOrEqual(before);
  expect(stamped).toBeLessThanOrEqual(Date.now());
});

test("values made in later milliseconds sort later", () => {
  const ids = [2 ** 40, 1_700_000_000_000, 1_700_000_000_001, 1_800_000_000_000, 2 ** 44].map((ms) =>
    uuidv7(ms),
  );
  expect([...ids].sort()).toEqual(ids);
});

test("values made in the same millisecond differ", () => {
  const ids = new Set(Array.from({ length: 5000 }, () => uuidv7(1_700_000_000_000)));
  expect(ids.size).toBe(5000);
});
