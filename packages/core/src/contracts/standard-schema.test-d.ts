import { describe, expectTypeOf, test } from "vitest";
import type {
  StandardSchemaV1,
  StandardSchemaV1FailureResult,
  StandardSchemaV1InferInput,
  StandardSchemaV1InferOutput,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
  StandardSchemaV1SuccessResult,
} from "./standard-schema.js";

/** A schema written by hand to the letter of the specification, as a library would ship it. */
const stringToLength: StandardSchemaV1<string, number> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof value === "string"
        ? { value: value.length }
        : { issues: [{ message: "must be a string", path: ["x", { key: 0 }] }] },
  },
};

describe("StandardSchemaV1", () => {
  test("infers input and output", () => {
    expectTypeOf<StandardSchemaV1InferInput<typeof stringToLength>>().toEqualTypeOf<string>();
    expectTypeOf<StandardSchemaV1InferOutput<typeof stringToLength>>().toEqualTypeOf<number>();
    expectTypeOf<StandardSchemaV1InferOutput<typeof stringToLength>>().not.toBeAny();
  });

  test("the output defaults to the input, and both default to unknown", () => {
    expectTypeOf<StandardSchemaV1InferOutput<StandardSchemaV1<string>>>().toEqualTypeOf<string>();
    expectTypeOf<StandardSchemaV1InferInput<StandardSchemaV1>>().toBeUnknown();
  });

  test("validate may answer synchronously or with a promise", () => {
    expectTypeOf(stringToLength["~standard"].validate).returns.toEqualTypeOf<
      StandardSchemaV1Result<number> | Promise<StandardSchemaV1Result<number>>
    >();
    const asyncSchema: StandardSchemaV1<unknown, string> = {
      "~standard": { version: 1, vendor: "test", validate: async () => ({ value: "x" }) },
    };
    void asyncSchema;
  });

  test("a result is told apart by its issues", () => {
    const result = {} as StandardSchemaV1Result<number>;
    if (result.issues === undefined) {
      expectTypeOf(result).toEqualTypeOf<StandardSchemaV1SuccessResult<number>>();
      expectTypeOf(result.value).toEqualTypeOf<number>();
    } else {
      expectTypeOf(result).toEqualTypeOf<StandardSchemaV1FailureResult>();
      expectTypeOf(result.issues).toEqualTypeOf<ReadonlyArray<StandardSchemaV1Issue>>();
    }
  });

  test("any specific schema is a StandardSchemaV1<unknown, unknown>, which is what Validator takes", () => {
    expectTypeOf(stringToLength).toExtend<StandardSchemaV1<unknown, unknown>>();
    expectTypeOf(stringToLength).toExtend<StandardSchemaV1>();
  });

  test("rejects another version, a missing vendor and a wrong output", () => {
    // @ts-expect-error only version 1 exists
    const v2: StandardSchemaV1 = { "~standard": { version: 2, vendor: "x", validate: () => ({ value: 1 }) } };
    // @ts-expect-error vendor is required
    const noVendor: StandardSchemaV1 = { "~standard": { version: 1, validate: () => ({ value: 1 }) } };
    const wrongOutput: StandardSchemaV1<string, number> = {
      // @ts-expect-error the value must be a number
      "~standard": { version: 1, vendor: "x", validate: () => ({ value: "1" }) },
    };
    // @ts-expect-error not a schema
    const notASchema: StandardSchemaV1 = { validate: () => ({ value: 1 }) };
    void [v2, noVendor, wrongOutput, notASchema];
  });
});
