import { User } from "@egon-orm/test-support";
import { describe, expectTypeOf, test } from "vitest";
import type { Action, ValidatorFn } from "../../contracts/changeset.js";
import type { Row } from "../../contracts/schema.js";
import type { StandardSchemaV1 } from "../../contracts/standard-schema.js";
import { Schema, t } from "../../schema/index.js";
import type { Changeset } from "../changeset.js";
import { cast } from "../changeset.js";
import type { FieldValues } from "../types.js";
import type { FieldValidator, ValidateOptions } from "./types.js";
import { BASE } from "./types.js";

declare const params: unknown;
declare const schema: StandardSchemaV1<unknown, { email: string }>;

class Meetup extends Schema("meetups", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
  startsAt: t.timestamp(),
  endsAt: t.timestamp().nullable(),
}) {}

describe("validate", () => {
  test("returns the same changeset type", () => {
    const cs = cast(User, params, ["email"]);
    expectTypeOf(cs.validate(schema)).toEqualTypeOf<Changeset<typeof User, true>>();
    expectTypeOf(cs.validateAsync(schema)).toEqualTypeOf<Promise<Changeset<typeof User, true>>>();
    expectTypeOf(cs.validate(schema)).not.toBeAny();
  });

  test("types a function's values and context from the schema", () => {
    cast(User, params, ["email"]).validate((values, ctx) => {
      expectTypeOf(values).toEqualTypeOf<Readonly<FieldValues<typeof User>>>();
      expectTypeOf(values.email).toEqualTypeOf<string>();
      expectTypeOf(values.age).toEqualTypeOf<number | null>();
      expectTypeOf(ctx.data).toEqualTypeOf<Readonly<FieldValues<typeof User>>>();
      expectTypeOf(ctx.changes).toEqualTypeOf<Readonly<Partial<FieldValues<typeof User>>>>();
      expectTypeOf(ctx.action).toEqualTypeOf<Action | null>();
      expectTypeOf(ctx.isChanged).parameter(0).toEqualTypeOf<keyof FieldValues<typeof User>>();
      expectTypeOf(values).not.toBeAny();
    });
  });

  test("ValidatorFn<Row<User>> parameters are typed from the row", () => {
    const fn: ValidatorFn<Row<typeof User>> = (values, { isChanged }) => {
      expectTypeOf(values.email).toEqualTypeOf<string>();
      expectTypeOf(values.displayName).toEqualTypeOf<string>();
      return isChanged("email") ? [] : undefined;
    };
    void fn;
  });

  test("the verbatim cross-field function compiles on a typed changeset", () => {
    const cs = cast(Meetup, params, ["startsAt", "endsAt"]);
    cs.validate((v, { isChanged }) =>
      isChanged("endsAt") && v.endsAt !== null && v.endsAt <= v.startsAt
        ? [{ path: "endsAt", message: "must be after start" }]
        : [],
    );
  });

  test("accepts sync and async functions, with and without a return", () => {
    const cs = cast(User, params, ["email"]);
    cs.validate(() => {});
    cs.validate(() => [{ path: [], message: "x", meta: { a: 1 } }]);
    void cs.validateAsync(async () => {});
    void cs.validateAsync(async (v) => (v.email === "" ? [{ path: "email", message: "is empty" }] : []));
  });

  test("rejects what is not a validator", () => {
    const cs = cast(User, params, ["email"]);
    // @ts-expect-error a string is not a validator
    cs.validate("email");
    // @ts-expect-error an object without ~standard is not a validator
    cs.validate({ parse: () => ({}) });
    // @ts-expect-error a function must return issues, not a string
    cs.validate(() => "is wrong");
    // @ts-expect-error an issue needs a message
    cs.validate(() => [{ path: "email" }]);
    // @ts-expect-error isChanged takes a field name
    cs.validate((_v, { isChanged }) => (isChanged("emial") ? [] : []));
  });

  test("options are typed: scope, apply, and only with field names", () => {
    const cs = cast(User, params, ["email"]);
    cs.validate(schema, { scope: "changed", apply: true, only: ["email", "name"] });
    // @ts-expect-error there is no "auto" scope
    cs.validate(schema, { scope: "auto" });
    // @ts-expect-error only takes field names
    cs.validate(schema, { only: ["emial"] });
    expectTypeOf<ValidateOptions<typeof User>["only"]>().toEqualTypeOf<
      readonly (keyof FieldValues<typeof User> & string)[] | undefined
    >();
  });
});

describe("validateField", () => {
  test("types a function's value from the field, without null", () => {
    const cs = cast(User, params, ["name"]);
    cs.validateField("name", (name) => {
      expectTypeOf(name).toEqualTypeOf<string>();
      return [];
    });
    cs.validateField("age", (age, ctx) => {
      expectTypeOf(age).toEqualTypeOf<number>();
      expectTypeOf(ctx.data.email).toEqualTypeOf<string>();
    });
    expectTypeOf(cs.validateField("name", schema)).toEqualTypeOf<typeof cs>();
    expectTypeOf(cs.validateFieldAsync("name", schema)).toEqualTypeOf<Promise<typeof cs>>();
  });

  test("rejects unknown fields and functions of the wrong value type", () => {
    const cs = cast(User, params, ["name"]);
    // @ts-expect-error not a field
    cs.validateField("emial", schema);
    // @ts-expect-error age is a number
    cs.validateField("age", (age: string) => (age === "" ? [] : []));
  });

  test("FieldValidator is a Standard Schema or a function of the value", () => {
    const fromSchema: FieldValidator<string, FieldValues<typeof User>> = schema;
    const fromFn: FieldValidator<string, FieldValues<typeof User>> = (value) =>
      value.length > 3 ? [] : [{ path: [], message: "is short" }];
    void [fromSchema, fromFn];
  });
});

describe("BASE", () => {
  test("is the literal key", () => {
    expectTypeOf(BASE).toEqualTypeOf<"$base">();
  });
});
