import { User, UserSettings } from "@egon-orm/test-support";
import type { ValidationIssue } from "egon-orm";
import { cast } from "egon-orm";
import { describe, expect, test } from "vitest";
import * as yup from "yup";
import { keynote, loaded, member, runScenarios } from "./scenarios.js";

const signup = yup.object({
  email: yup.string().email().required(),
  age: yup.number().integer().min(13).nullable(),
});
const settings = yup.object({
  settings: yup
    .object({ theme: yup.string().oneOf(["light", "dark"]).required() })
    .nullable()
    .default(null),
});
const schedule = yup
  .object({ startsAt: yup.date().required(), endsAt: yup.date().required() })
  .test("order", "must be after start", function check(input) {
    return (
      input.endsAt > input.startsAt || this.createError({ path: "endsAt", message: "must be after start" })
    );
  });

// Yup implements Standard Schema from 1.7 (the installed version is pinned in
// package.json), but its validate() is always asynchronous: run it with validateAsync.
runScenarios(
  "Yup",
  {
    signup,
    settings,
    schedule,
    normalizeEmail: yup.object({ email: yup.string().trim().lowercase().required() }),
    email: yup.string().email().required(),
  },
  { asyncOnly: true },
);

// The adapter the guide shows (docs/site/examples/validation.ts, region yup-sync), kept
// identical to it.

/** Yup's path text (`settings.theme`, `tags[0]`, `["a.b"]` for a key with a dot) as a list of keys. */
function yupPath(path: string | undefined): PropertyKey[] {
  const keys: PropertyKey[] = [];
  for (const [, quoted, index, plain] of (path ?? "").matchAll(
    /\["((?:[^"\\]|\\.)*)"\]|\[(\d+)\]|([^.[\]]+)/g,
  )) {
    keys.push(quoted ?? (index !== undefined ? Number(index) : (plain as string)));
  }
  return keys;
}

/** Runs a Yup schema synchronously, as a validator function. */
function yupSync(schema: yup.AnyObjectSchema) {
  return (values: object): ValidationIssue[] => {
    try {
      schema.validateSync(values, { abortEarly: false });
      return [];
    } catch (error) {
      if (!(error instanceof yup.ValidationError)) throw error;
      const errors = error.inner.length > 0 ? error.inner : [error];
      return errors.map((e) => ({ path: yupPath(e.path), message: e.message }));
    }
  };
}

describe("Yup: the synchronous function adapter", () => {
  test("reports field issues, nested paths and cross-field rules with validate", () => {
    const signedUp = cast(User, { email: "not an address", age: "9" }, ["email", "age"]).validate(
      yupSync(signup),
    );
    expect(Object.keys(signedUp.errors).sort()).toEqual(["age", "email"]);

    const sepia = loaded(UserSettings, { theme: "sepia", emailNotifications: true });
    const nested = cast(member(sepia), {}, []).validate(yupSync(settings));
    expect(nested.errors.settings?.[0]?.meta.path).toEqual(["theme"]);

    const moved = cast(keynote(), { startsAt: "2026-06-01T12:00:00Z" }, ["startsAt"]);
    expect(moved.validate(yupSync(schedule)).errorMessages()).toEqual({ endsAt: ["must be after start"] });
    expect(moved.validate(yupSync(schedule), { scope: "changed" }).valid).toBe(true);
  });

  test("passes valid input, and lets errors that are not validation errors through", () => {
    const fine = cast(User, { email: "annie@easley.example" }, ["email"]).validate(yupSync(signup));
    expect(fine.valid).toBe(true);
    const throwing = yup.object({ email: yup.string() }).test("boom", "x", () => {
      throw new RangeError("bug in a test");
    });
    expect(() => cast(User, {}, []).validate(yupSync(throwing))).toThrow(RangeError);
  });

  test("turns Yup's path text into keys: a quoted key keeps its dot, an index is a number", () => {
    const schema = yup.object({
      "a.b": yup.string().required(),
      list: yup.array(yup.object({ x: yup.string().required() })),
    });
    expect(yupSync(schema)({ list: [{}] }).map((issue) => issue.path)).toEqual([["a.b"], ["list", 0, "x"]]);
  });

  test("the verbatim schema works through the adapter", () => {
    const cs = cast(User, { email: "nope" }, ["email"]);
    // The step's example: cs.validate(yup.object({ email: yup.string().email().required() })).
    const checked = cs.validate(yupSync(yup.object({ email: yup.string().email().required() })));
    expect(Object.keys(checked.errors)).toEqual(["email"]);
  });
});
