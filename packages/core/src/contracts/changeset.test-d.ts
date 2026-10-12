import { describe, expectTypeOf, test } from "vitest";
import type {
  Action,
  ChangesetError,
  ChangesetLike,
  Constraint,
  ConstraintType,
  ValidationIssue,
  Validator,
  ValidatorContext,
  ValidatorFn,
  ValidatorResult,
} from "./changeset.js";
import type { StandardSchemaV1 } from "./standard-schema.js";

interface Event {
  title: string;
  startsAt: Date;
  endsAt: Date;
}

describe("ValidatorFn", () => {
  test("types its arguments from the data type", () => {
    const validator: ValidatorFn<Event> = (values, ctx) => {
      expectTypeOf(values).toEqualTypeOf<Readonly<Event>>();
      expectTypeOf(ctx.changes).toEqualTypeOf<Readonly<Partial<Event>>>();
      expectTypeOf(ctx.data).toEqualTypeOf<Readonly<Event>>();
      expectTypeOf(ctx.action).toEqualTypeOf<Action | null>();
      expectTypeOf(ctx.isChanged).parameter(0).toEqualTypeOf<keyof Event>();
      expectTypeOf(values).not.toBeAny();
      return [];
    };
    void validator;
  });

  test("accepts every way of returning issues or nothing, sync and async", () => {
    // The plain-function example of step 06, verbatim in shape.
    const crossField: ValidatorFn<Event> = (v, { isChanged }) =>
      isChanged("endsAt") && v.endsAt <= v.startsAt
        ? [{ path: "endsAt", message: "must be after start" }]
        : [];
    const nothing: ValidatorFn<Event> = () => {};
    const sometimes: ValidatorFn<Event> = (v) => {
      if (v.endsAt <= v.startsAt)
        return [{ path: ["endsAt"], message: "must be after start", meta: { limit: 1 } }];
    };
    const asyncIssues: ValidatorFn<Event> = async (v) =>
      v.title === "" ? [{ path: "title", message: "is not allowed" }] : [];
    const asyncNothing: ValidatorFn<Event> = async () => {};
    void [crossField, nothing, sometimes, asyncIssues, asyncNothing];
  });

  test("rejects wrong field names, wrong issue shapes and other return values", () => {
    // @ts-expect-error not a field of Event
    const a: ValidatorFn<Event> = (_v, { isChanged }) => (isChanged("nope") ? [] : []);
    // @ts-expect-error an issue needs a message
    const b: ValidatorFn<Event> = () => [{ path: "title" }];
    // @ts-expect-error a string is not a list of issues
    const c: ValidatorFn<Event> = () => "is invalid";
    // @ts-expect-error not a property of Event
    const d: ValidatorFn<Event> = (v) => (v.nope ? [] : []);
    void [a, b, c, d];
  });

  test("the values are read-only", () => {
    const mutating: ValidatorFn<Event> = (values) => {
      // @ts-expect-error validators must not mutate their input
      values.title = "x";
    };
    void mutating;
  });

  test("its result is the issues or undefined, never any", () => {
    expectTypeOf<ValidatorResult>().toEqualTypeOf<readonly ValidationIssue[] | undefined>();
    expectTypeOf<ReturnType<ValidatorFn<Event>>>().toEqualTypeOf<
      ValidatorResult | Promise<ValidatorResult>
    >();
    expectTypeOf<ReturnType<ValidatorFn<Event>>>().not.toBeAny();
  });
});

describe("Validator", () => {
  test("is a Standard Schema or a function", () => {
    const schema = {} as StandardSchemaV1<unknown, Event>;
    const fn: ValidatorFn<Event> = () => [];
    const validators: Validator<Event>[] = [schema, fn];
    void validators;
    // @ts-expect-error neither a schema nor a function
    const bad: Validator<Event> = { validate: () => [] };
    void bad;
  });

  test("a function validator is told apart from a schema by typeof", () => {
    const validator = {} as Validator<Event>;
    if (typeof validator === "function") expectTypeOf(validator).toEqualTypeOf<ValidatorFn<Event>>();
    else expectTypeOf(validator).toEqualTypeOf<StandardSchemaV1<unknown, unknown>>();
  });
});

describe("ChangesetError and Constraint", () => {
  test("an error needs a message and meta; validation and constraint are optional", () => {
    const plain: ChangesetError = { message: "is invalid", meta: {} };
    const full: ChangesetError = {
      message: "x %{count}",
      validation: "length",
      constraint: "unique",
      meta: { count: 3 },
    };
    void [plain, full];
    // @ts-expect-error meta is required
    const noMeta: ChangesetError = { message: "is invalid" };
    // @ts-expect-error message is required
    const noMessage: ChangesetError = { meta: {} };
    void [noMeta, noMessage];
    expectTypeOf<ChangesetError["meta"]>().toEqualTypeOf<Readonly<Record<string, unknown>>>();
  });

  test("errors and their meta are read-only", () => {
    const error: ChangesetError = { message: "is invalid", meta: {} };
    // @ts-expect-error read-only
    error.message = "x";
    // @ts-expect-error read-only
    error.meta.count = 1;
  });

  test("a constraint has exactly the specified types and match modes", () => {
    expectTypeOf<ConstraintType>().toEqualTypeOf<
      "unique" | "foreignKey" | "check" | "exclusion" | "noAssoc"
    >();
    expectTypeOf<Constraint["match"]>().toEqualTypeOf<"exact" | "suffix" | "prefix">();
    const constraint: Constraint = {
      type: "unique",
      name: "users_email_index",
      match: "exact",
      field: "email",
      message: "has already been taken",
    };
    void constraint;
    // @ts-expect-error not a constraint type
    const bad: Constraint = { ...constraint, type: "primaryKey" };
    // @ts-expect-error every member is required
    const partial: Constraint = { type: "unique", name: "x" };
    void [bad, partial];
  });

  test("Action lists the five changeset actions", () => {
    expectTypeOf<Action>().toEqualTypeOf<"insert" | "update" | "delete" | "replace" | "ignore">();
  });
});

describe("ChangesetLike", () => {
  test("carries the data type through", () => {
    const changeset = {} as ChangesetLike<Event>;
    expectTypeOf(changeset.data).toEqualTypeOf<Event>();
    expectTypeOf(changeset.valid).toEqualTypeOf<boolean>();
    expectTypeOf(changeset.action).toEqualTypeOf<Action | null>();
    expectTypeOf(changeset.errors).toEqualTypeOf<Readonly<Record<string, readonly ChangesetError[]>>>();
    expectTypeOf(changeset.data).not.toBeAny();
  });

  test("defaults the data type to unknown, and any ChangesetLike fits it", () => {
    expectTypeOf<ChangesetLike["data"]>().toBeUnknown();
    expectTypeOf<ChangesetLike<Event>>().toExtend<ChangesetLike>();
  });

  test("ValidatorContext is assignable from a narrower implementation", () => {
    const ctx: ValidatorContext<Event> = {
      changes: { title: "x" },
      data: { title: "", startsAt: new Date(), endsAt: new Date() },
      isChanged: (field) => field === "title",
      action: null,
    };
    void ctx;
  });
});
