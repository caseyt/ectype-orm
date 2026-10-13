import { describe, expectTypeOf, test } from "vitest";
import { type Failure, failure, type Result, type Success, success } from "./result.js";

describe("Result", () => {
  test("narrows on success", () => {
    const result = {} as Result<number, string>;
    if (result.success) {
      expectTypeOf(result.data).toEqualTypeOf<number>();
      // @ts-expect-error a success has no error
      result.error;
    } else {
      expectTypeOf(result.error).toEqualTypeOf<string>();
      // @ts-expect-error a failure has no data
      result.data;
    }
  });

  test("success and failure infer their type and fit any Result with that half", () => {
    expectTypeOf(success(1)).toEqualTypeOf<Success<number>>();
    expectTypeOf(failure("x")).toEqualTypeOf<Failure<string>>();
    expectTypeOf(success({ id: 1 }).data).toEqualTypeOf<{ id: number }>();
    expectTypeOf(success(1)).not.toBeAny();
    const a: Result<number, string> = success(1);
    const b: Result<number, string> = failure("x");
    void [a, b];
  });

  test("rejects the wrong half", () => {
    // @ts-expect-error the data must be a number
    const a: Result<number, string> = success("1");
    // @ts-expect-error the error must be a string
    const b: Result<number, string> = failure(1);
    void [a, b];
  });

  test("a function can return both halves and callers get the union", () => {
    function parse(text: string): Result<number, Error> {
      const n = Number(text);
      return Number.isNaN(n) ? failure(new Error("not a number")) : success(n);
    }
    expectTypeOf(parse).returns.toEqualTypeOf<Result<number, Error>>();
    expectTypeOf<Result<number, Error>>().toEqualTypeOf<Success<number> | Failure<Error>>();
  });
});
