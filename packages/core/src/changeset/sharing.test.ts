// Every method returns a new changeset that shares what it did not change. A validation
// that passes makes the new changeset and one validation entry, and nothing else.
import { readdirSync, readFileSync } from "node:fs";
import { User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { AnySchema, Row } from "../contracts/schema.js";
import { meta } from "../schema/index.js";
import { cast, change } from "./changeset.js";

function loaded<S extends AnySchema>(schema: S, values: Readonly<Record<string, unknown>>): Row<S> {
  const info = meta(schema);
  return info.create(
    info.persisted.map((field) => (Object.hasOwn(values, field.name) ? values[field.name] : null)),
    info.rowMeta("loaded", undefined),
  ) as Row<S>;
}

const form = () =>
  cast(
    User,
    { email: "ida@example.com", name: "Ida", age: "30", role: "admin", password: "long enough pass" },
    ["email", "name", "age", "role", "password"],
  );

describe("structural sharing", () => {
  test("a passing validation shares changes, errors, data, params and every list", () => {
    const cs1 = form().uniqueConstraint("email");
    const passing = [
      (cs: typeof cs1) => cs.validateRequired(["email", "name"]),
      (cs: typeof cs1) => cs.validateFormat("email", /@/),
      (cs: typeof cs1) => cs.validateLength("name", { min: 2 }),
      (cs: typeof cs1) => cs.validateNumber("age", { greaterThan: 0 }),
      (cs: typeof cs1) => cs.validateInclusion("role", ["admin", "member"]),
      (cs: typeof cs1) => cs.validateExclusion("name", ["root"]),
      (cs: typeof cs1) => cs.validateConfirmation("password"),
      (cs: typeof cs1) => cs.validateChange("name", () => undefined),
    ];
    for (const validate of passing) {
      const cs2 = validate(cs1);
      expect(cs2).not.toBe(cs1);
      expect(cs2.valid).toBe(true);
      expect(cs2.changes).toBe(cs1.changes);
      expect(cs2.errors).toBe(cs1.errors);
      expect(cs2.data).toBe(cs1.data);
      expect(cs2.params).toBe(cs1.params);
      expect(cs2.constraints).toBe(cs1.constraints);
      expect(cs2.filters).toBe(cs1.filters);
      expect(cs2.prepare).toBe(cs1.prepare);
      expect(cs2.validations.length).toBe(cs1.validations.length + (validate === passing[0] ? 2 : 1));
    }
  });

  test("a failing validation copies only the errors", () => {
    const cs1 = form();
    const cs2 = cs1.validateLength("name", { min: 10 });
    expect(cs2.changes).toBe(cs1.changes);
    expect(cs2.errors).not.toBe(cs1.errors);
    expect(cs1.errors).toEqual({});
    const cs3 = cs2.validateFormat("email", /^x/);
    expect(cs3.errors.name).toBe(cs2.errors.name);
  });

  test("putChange copies the changes and leaves the original untouched", () => {
    const cs1 = form();
    const before = { ...cs1.changes };
    const cs2 = cs1.putChange("name", "Ida B.");
    expect(cs2.changes).not.toBe(cs1.changes);
    expect(cs1.changes).toEqual(before);
    expect(cs2.errors).toBe(cs1.errors);
  });

  test("cast never changes the row it starts from", () => {
    const row = loaded(User, { id: 4, email: "a@b.c", name: "A", role: "member", lockVersion: 1 });
    const snapshot = { ...row };
    cast(row, { name: "B", email: "" }, ["name", "email"]).validateRequired().applyChanges();
    expect({ ...row }).toEqual(snapshot);
  });

  test("valid is a stored property, not a getter", () => {
    const cs = form();
    const descriptor = Object.getOwnPropertyDescriptor(cs, "valid");
    expect(descriptor && "value" in descriptor).toBe(true);
  });

  test("every changeset has the same own keys in the same order", () => {
    const keys = (value: object) => Reflect.ownKeys(value);
    const shapes = [
      form(),
      form().validateLength("name", { min: 10 }),
      change(User),
      change(User).uniqueConstraint("email"),
      change(User).optimisticLock("lockVersion"),
      cast(form(), { name: "x" }, ["name"]),
      form().merge(form()),
    ].map(keys);
    for (const shape of shapes) expect(shape).toEqual(shapes[0]);
  });
});

describe("module boundaries", () => {
  test("nothing in the changeset module imports the database, the adapter or the repo", () => {
    const dir = new URL(".", import.meta.url);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(new URL(file, dir), "utf8");
      const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1] as string);
      for (const path of imports) {
        expect(path, `${file} imports ${path}`).not.toMatch(/adapter|repo|compiler|query|^pg$|postgres/);
      }
    }
  });
});
