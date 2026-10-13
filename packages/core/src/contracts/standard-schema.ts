/**
 * The Standard Schema interface, version 1, vendored as types only (decision D15).
 *
 * Copied from the specification at https://standardschema.dev (the `@standard-schema/spec`
 * package, MIT licence), whose own guidance is to copy the interface instead of depending
 * on the package. Do not edit the shapes: they are defined by the specification. Zod,
 * Valibot, ArkType and recent Yup schemas all satisfy {@link StandardSchemaV1}.
 *
 * Consumed by step 06 (`changeset/validators/`) and by `@egon-orm/zod`.
 *
 * @module
 */

/**
 * A schema of any library that implements Standard Schema v1.
 *
 * @example
 * ```ts
 * function describe(schema: StandardSchemaV1): string {
 *   return `${schema["~standard"].vendor} schema, spec version ${schema["~standard"].version}`;
 * }
 * ```
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The Standard Schema properties. */
  readonly "~standard": StandardSchemaV1Props<Input, Output>;
}

/**
 * The properties every Standard Schema exposes under `"~standard"`.
 *
 * @example
 * ```ts
 * const props: StandardSchemaV1Props<unknown, string> = {
 *   version: 1,
 *   vendor: "example",
 *   validate: (value) =>
 *     typeof value === "string" ? { value } : { issues: [{ message: "must be a string" }] },
 * };
 * ```
 */
export interface StandardSchemaV1Props<Input = unknown, Output = Input> {
  /** The version number of the standard. */
  readonly version: 1;
  /** The vendor name of the schema library. */
  readonly vendor: string;
  /** Validates unknown input values. May answer synchronously or with a promise. */
  readonly validate: (
    value: unknown,
  ) => StandardSchemaV1Result<Output> | Promise<StandardSchemaV1Result<Output>>;
  /** Inferred types associated with the schema. Never present at runtime. */
  readonly types?: StandardSchemaV1Types<Input, Output> | undefined;
}

/**
 * What `validate` returns: the output value, or the issues.
 *
 * @example
 * ```ts
 * function isFailure(result: StandardSchemaV1Result<unknown>): result is StandardSchemaV1FailureResult {
 *   return result.issues !== undefined;
 * }
 * ```
 */
export type StandardSchemaV1Result<Output> =
  | StandardSchemaV1SuccessResult<Output>
  | StandardSchemaV1FailureResult;

/**
 * The result of a successful validation.
 *
 * @example
 * ```ts
 * const success: StandardSchemaV1SuccessResult<number> = { value: 1 };
 * ```
 */
export interface StandardSchemaV1SuccessResult<Output> {
  /** The typed output value. */
  readonly value: Output;
  /** The non-existent issues. */
  readonly issues?: undefined;
}

/**
 * The result of a failed validation.
 *
 * @example
 * ```ts
 * const failure: StandardSchemaV1FailureResult = { issues: [{ message: "is required", path: ["email"] }] };
 * ```
 */
export interface StandardSchemaV1FailureResult {
  /** The issues of the failed validation. */
  readonly issues: ReadonlyArray<StandardSchemaV1Issue>;
}

/**
 * One validation issue.
 *
 * @example
 * ```ts
 * const issue: StandardSchemaV1Issue = { message: "is too short", path: ["profile", { key: "bio" }] };
 * ```
 */
export interface StandardSchemaV1Issue {
  /** The error message of the issue. */
  readonly message: string;
  /** The path of the issue, if any. A segment is a key, or an object holding one. */
  readonly path?: ReadonlyArray<PropertyKey | StandardSchemaV1PathSegment> | undefined;
}

/**
 * A path segment in object form.
 *
 * @example
 * ```ts
 * const segment: StandardSchemaV1PathSegment = { key: "email" };
 * ```
 */
export interface StandardSchemaV1PathSegment {
  /** The key representing a path segment. */
  readonly key: PropertyKey;
}

/**
 * The type-level information of a schema.
 *
 * @example
 * ```ts
 * type Types = StandardSchemaV1Types<string, number>; // { input: string; output: number }
 * ```
 */
export interface StandardSchemaV1Types<Input = unknown, Output = Input> {
  /** The input type of the schema. */
  readonly input: Input;
  /** The output type of the schema. */
  readonly output: Output;
}

/**
 * Infers the input type of a Standard Schema.
 *
 * @example
 * ```ts
 * declare const schema: StandardSchemaV1<string, number>;
 * type In = StandardSchemaV1InferInput<typeof schema>; // string
 * ```
 */
export type StandardSchemaV1InferInput<Schema extends StandardSchemaV1> = NonNullable<
  Schema["~standard"]["types"]
>["input"];

/**
 * Infers the output type of a Standard Schema.
 *
 * @example
 * ```ts
 * declare const schema: StandardSchemaV1<string, number>;
 * type Out = StandardSchemaV1InferOutput<typeof schema>; // number
 * ```
 */
export type StandardSchemaV1InferOutput<Schema extends StandardSchemaV1> = NonNullable<
  Schema["~standard"]["types"]
>["output"];
