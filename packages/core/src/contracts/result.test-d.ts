import { describe, expectTypeOf, test } from "vitest";
import { type Err, err, type Ok, ok, type Result } from "./result.js";

describe("Result", () => {
  test("narrows on ok", () => {
    const result = {} as Result<number, string>;
    if (result.ok) {
      expectTypeOf(result.value).toEqualTypeOf<number>();
      // @ts-expect-error a success has no error
      result.error;
    } else {
      expectTypeOf(result.error).toEqualTypeOf<string>();
      // @ts-expect-error a failure has no value
      result.value;
    }
  });

  test("ok and err infer their type and fit any Result with that half", () => {
    expectTypeOf(ok(1)).toEqualTypeOf<Ok<number>>();
    expectTypeOf(err("x")).toEqualTypeOf<Err<string>>();
    expectTypeOf(ok({ id: 1 }).value).toEqualTypeOf<{ id: number }>();
    expectTypeOf(ok(1)).not.toBeAny();
    const a: Result<number, string> = ok(1);
    const b: Result<number, string> = err("x");
    void [a, b];
  });

  test("rejects the wrong half", () => {
    // @ts-expect-error the value must be a number
    const a: Result<number, string> = ok("1");
    // @ts-expect-error the error must be a string
    const b: Result<number, string> = err(1);
    void [a, b];
  });

  test("a function can return both halves and callers get the union", () => {
    function parse(text: string): Result<number, Error> {
      const n = Number(text);
      return Number.isNaN(n) ? err(new Error("not a number")) : ok(n);
    }
    expectTypeOf(parse).returns.toEqualTypeOf<Result<number, Error>>();
    expectTypeOf<Result<number, Error>>().toEqualTypeOf<Ok<number> | Err<Error>>();
  });
});
