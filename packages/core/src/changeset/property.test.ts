// Invariants of changesets, over generated input.
import { Post, User } from "@egon-orm/test-support";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { AnySchema, Row } from "../contracts/schema.js";
import { meta } from "../schema/index.js";
import { type Changeset, cast, change } from "./changeset.js";

function loaded<S extends AnySchema>(schema: S, values: Readonly<Record<string, unknown>>): Row<S> {
  const info = meta(schema);
  return info.create(
    info.persisted.map((field) => (Object.hasOwn(values, field.name) ? values[field.name] : null)),
    info.rowMeta("loaded", undefined),
  ) as Row<S>;
}

const userFields = [
  "id",
  "email",
  "name",
  "age",
  "role",
  "password",
  "passwordHash",
  "lockVersion",
  "createdAt",
  "updatedAt",
] as const;
const postFields = [
  "id",
  "authorId",
  "title",
  "body",
  "published",
  "views",
  "tagList",
  "publishedAt",
] as const;

/** JSON objects whose keys are often field names. */
const params = (fields: readonly string[]) =>
  fc.dictionary(fc.oneof(fc.constantFrom(...fields), fc.string()), fc.jsonValue(), { maxKeys: 12 });

const noErrors = (cs: Changeset<AnySchema>) => Object.keys(cs.errors).length === 0;

/** A user row with values a database could hold. */
const userRow = fc
  .record({
    id: fc.integer({ min: 1 }),
    email: fc.string({ minLength: 1 }),
    name: fc.option(fc.string()),
    age: fc.option(fc.integer({ min: 0, max: 150 })),
    role: fc.constantFrom("admin", "member"),
    lockVersion: fc.integer({ min: 1, max: 1000 }),
    createdAt: fc.date({ noInvalidDate: true }),
  })
  .map((values) => loaded(User, { ...values, updatedAt: values.createdAt }));

describe("properties", () => {
  test("cast never throws on any JSON params, and valid means no errors", () => {
    fc.assert(
      fc.property(params(userFields), params(postFields), (forUser, forPost) => {
        const user = cast(User, forUser, userFields);
        const post = cast(Post, forPost, postFields);
        expect(user.valid).toBe(noErrors(user as never));
        expect(post.valid).toBe(noErrors(post as never));
      }),
    );
  });

  test("a change is never null on a field that is not nullable, and never equals the current value", () => {
    fc.assert(
      fc.property(userRow, params(userFields), (row, given) => {
        const cs = cast(row, given, userFields);
        const fields = meta(User).fieldsByName;
        for (const [name, value] of Object.entries(cs.changes)) {
          const field = fields.get(name);
          if (field === undefined) throw new Error(`unknown change ${name}`);
          if (!field.nullable) expect(value).not.toBeNull();
          const current = (row as unknown as Record<string, unknown>)[name];
          if (value !== null && current !== null && current !== undefined) {
            expect(field.type.equal(value, current)).toBe(false);
          }
        }
      }),
    );
  });

  test("casting a changeset again never leaves a change equal to the row's value", () => {
    fc.assert(
      fc.property(userRow, params(userFields), params(userFields), (row, first, second) => {
        const cs = cast(cast(row, first, userFields), second, userFields);
        const fields = meta(User).fieldsByName;
        for (const [name, value] of Object.entries(cs.changes)) {
          const field = fields.get(name);
          const current = (row as unknown as Record<string, unknown>)[name];
          if (field === undefined || value === null || current === null || current === undefined) continue;
          expect(field.type.equal(value, current)).toBe(false);
        }
      }),
    );
  });

  test("change(row, applied values) gives back exactly the changes", () => {
    fc.assert(
      fc.property(userRow, params(userFields), (row, given) => {
        const cs = cast(row, given, userFields);
        const applied = cs.applyChanges() as unknown as Record<string, unknown>;
        const values: Record<string, unknown> = {};
        for (const name of userFields) values[name] = applied[name];
        expect(change(row, values as never).changes).toEqual(cs.changes);
      }),
    );
  });

  test("running the same validation twice does not change valid or the errors' keys", () => {
    fc.assert(
      fc.property(params(userFields), fc.integer({ min: 0, max: 5 }), (given, min) => {
        const once = cast(User, given, userFields)
          .validateRequired(["email"])
          .validateLength("name", { min })
          .validateNumber("age", { greaterThan: 18 });
        const twice = once
          .validateRequired(["email"])
          .validateLength("name", { min })
          .validateNumber("age", { greaterThan: 18 });
        expect(twice.valid).toBe(once.valid);
        expect(Object.keys(twice.errors)).toEqual(Object.keys(once.errors));
        expect(twice.valid).toBe(noErrors(twice as never));
      }),
    );
  });

  test("valid always means no errors, whatever is chained", () => {
    const steps = fc.array(
      fc.constantFrom<(cs: Changeset<typeof User>) => Changeset<typeof User>>(
        (cs) => cs.validateRequired(),
        (cs) => cs.validateFormat("email", /@/),
        (cs) => cs.validateLength("name", { min: 2, max: 5 }),
        (cs) => cs.validateNumber("age", { lessThan: 100 }),
        (cs) => cs.validateInclusion("role", ["member"]),
        (cs) => cs.putChange("name", null),
        (cs) => cs.deleteChange("email"),
        (cs) => cs.uniqueConstraint("email"),
      ),
      { maxLength: 8 },
    );
    fc.assert(
      fc.property(params(userFields), steps, (given, chain) => {
        const cs = chain.reduce(
          (current, step) => step(current),
          cast(User, given, userFields) as Changeset<typeof User>,
        );
        expect(cs.valid).toBe(noErrors(cs as never));
      }),
    );
  });
});
