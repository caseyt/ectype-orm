import { User } from "@egon-orm/test-support";
import type { AnySchema, Row } from "egon-orm";
import { cast, meta, QueryError } from "egon-orm";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { castWith, toZod } from "./index.js";

function loaded<S extends AnySchema>(schema: S, values: Readonly<Record<string, unknown>>): Row<S> {
  const info = meta(schema);
  return info.create(
    info.persisted.map((field) => (Object.hasOwn(values, field.name) ? values[field.name] : null)),
    info.rowMeta("loaded", undefined),
  ) as Row<S>;
}

const SignUp = toZod(User, { mode: "insert", pick: ["email", "name", "age"] }).extend({
  email: z.string().email(),
});

describe("castWith", () => {
  test("permits the schema's keys and validates with the schema", () => {
    const cs = castWith(User, { email: "nope", name: "Alan", role: "admin" }, SignUp);
    expect(cs.changes).toEqual({ email: "nope", name: "Alan" });
    expect(Object.keys(cs.errors)).toEqual(["email"]);
    expect(cs.validations).toEqual([["$schema", { validator: SignUp, opts: undefined }]]);
  });

  test("is cast followed by validate", () => {
    const params = { email: "alan@turing.example", age: "41", name: "" };
    const viaCastWith = castWith(User, params, SignUp);
    const byHand = cast(User, params, ["email", "name", "age"]).validate(SignUp);
    expect(viaCastWith.changes).toEqual(byHand.changes);
    expect(viaCastWith.errors).toEqual(byHand.errors);
  });

  test("works on a loaded row and on a changeset", () => {
    const row = loaded(User, { id: 2, email: "alan@turing.example", role: "member", lockVersion: 1 });
    const renamed = castWith(row, { name: "A. Turing" }, toZod(User, { mode: "update", pick: ["name"] }));
    expect(renamed.changes).toEqual({ name: "A. Turing" });
    const again = castWith(
      cast(User, { email: "x@y.z" }, ["email"]),
      { age: "7" },
      z.object({ age: z.number().min(13) }),
    );
    expect(again.changes).toEqual({ email: "x@y.z", age: 7 });
    expect(Object.keys(again.errors)).toEqual(["age"]);
  });

  test("refuses a schema that is not a Zod object, and keys that are not fields", () => {
    expect(() => castWith(User, {}, z.string() as never)).toThrow(TypeError);
    expect(() => castWith(User, {}, z.object({ termsOfService: z.boolean() }) as never)).toThrow(QueryError);
  });
});
