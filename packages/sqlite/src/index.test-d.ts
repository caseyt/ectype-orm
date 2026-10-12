import { expectTypeOf, test } from "vitest";
import { VERSION } from "./index.js";

test("VERSION is a string, not any", () => {
  expectTypeOf(VERSION).toBeString();
  expectTypeOf(VERSION).not.toBeAny();
});
