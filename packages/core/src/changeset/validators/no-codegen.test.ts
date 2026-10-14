import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** What a validator is given, for a few changesets, with the modules loaded afresh. */
async function seenValues(): Promise<unknown[]> {
  const { cast } = await import("../changeset.js");
  const { Schema, t } = await import("../../schema/index.js");
  class Gadget extends Schema("gadgets", {
    id: t.integer().primaryKey().dbGenerated(),
    label: t.string(),
    note: t.string().nullable(),
    size: t.integer().default(3),
    toString: t.string().nullable(),
  }) {}
  const seen: unknown[] = [];
  const record = (values: unknown) => {
    seen.push(values);
  };
  cast(Gadget, { label: "lamp", toString: "shown" }, ["label", "toString"]).validate(record);
  cast(Gadget, {}, []).validate(record);
  cast({ data: { a: "x" }, types: { a: t.string(), b: t.integer().default(1) } }, { a: "y" }, ["a"]).validate(
    record,
  );
  return seen;
}

test("without code generation (a Content Security Policy), the validator sees the same values", async () => {
  vi.resetModules();
  const generated = await seenValues();

  vi.resetModules();
  // A runtime that forbids `new Function`, as a CSP without unsafe-eval does.
  vi.stubGlobal(
    "Function",
    new Proxy(Function, {
      construct() {
        throw new EvalError("Code generation from strings disallowed for this context");
      },
    }),
  );
  const interpreted = await seenValues();

  expect(interpreted).toEqual(generated);
  const expected: unknown[] = [
    { label: "lamp", note: null, size: 3, toString: "shown" },
    { note: null, size: 3, toString: null },
    { a: "y", b: 1 },
  ];
  expect(generated).toEqual(expected);
});
