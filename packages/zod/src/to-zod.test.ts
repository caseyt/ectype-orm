import { Org, User, UserSettings } from "@egon-orm/test-support";
import type { AnySchema, FieldType, Row } from "egon-orm";
import { cast, defineType, EmbeddedSchema, meta, QueryError, Schema, t } from "egon-orm";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { ZodHint } from "./index.js";
import { toZod } from "./index.js";

function loaded<S extends AnySchema>(schema: S, values: Readonly<Record<string, unknown>>): Row<S> {
  const info = meta(schema);
  return info.create(
    info.persisted.map((field) => (Object.hasOwn(values, field.name) ? values[field.name] : null)),
    info.rowMeta("loaded", undefined),
  ) as Row<S>;
}

class Ledger extends Schema("ledgers", {
  id: t.integer().primaryKey().dbGenerated(),
  label: t.string(),
  count: t.integer(),
  big: t.bigint(),
  safe: t.bigint({ mode: "number" }),
  ratio: t.float(),
  amount: t.decimal({ precision: 10, scale: 2 }),
  plainAmount: t.decimal(),
  flag: t.boolean(),
  ref: t.uuid(),
  bytes: t.binary(),
  day: t.date(),
  dayAsDate: t.date({ as: "date" }),
  clock: t.time(),
  at: t.timestamp(),
  localAt: t.localTimestamp(),
  secondsAt: t.timestamp({ precision: "s" }),
  doc: t.json<{ a: number }>(),
  tags: t.array(t.string()),
  grid: t.array(t.array(t.integer())),
  kind: t.enum(["in", "out"]),
  level: t.enum({ low: 1, high: 2 }),
}) {}

const good = {
  id: 1,
  label: "petty cash",
  count: 3,
  big: 9007199254740993n,
  safe: 42,
  ratio: 0.5,
  amount: "12.50",
  plainAmount: "1.000001",
  flag: true,
  ref: "0190f1f4-6c1e-7cc3-9d2a-6c3f0e2b8a11",
  bytes: new Uint8Array([1, 2]),
  day: "2026-05-04",
  dayAsDate: new Date("2026-05-04T00:00:00Z"),
  clock: "09:30:00",
  at: new Date("2026-05-04T09:30:00.123Z"),
  localAt: new Date("2026-05-04T09:30:00.123Z"),
  secondsAt: new Date("2026-05-04T09:30:00Z"),
  doc: { a: 1 },
  tags: ["x", "y"],
  grid: [[1], [2, 3]],
  kind: "in",
  level: "high",
};

/** The field names that `schema` rejects in `value`. */
function rejected(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  if (result.success) return [];
  return [...new Set(result.error.issues.map((issue) => String(issue.path[0])))].sort();
}

describe("toZod: field types", () => {
  const LedgerZ = toZod(Ledger);

  test("accepts a value of every type, as the type holds it", () => {
    expect(rejected(LedgerZ, good)).toEqual([]);
  });

  const bad: [keyof typeof good, unknown][] = [
    ["label", 1],
    ["count", 1.5],
    ["count", "3"],
    ["big", 1],
    ["safe", 2 ** 60],
    ["safe", 3n],
    ["ratio", "0.5"],
    ["amount", 12.5],
    ["amount", "12.505"],
    ["amount", "abc"],
    ["flag", "true"],
    ["ref", "not-a-uuid"],
    ["ref", "0190F1F4-6C1E-7CC3-9D2A-6C3F0E2B8A11"],
    ["bytes", [1, 2]],
    ["day", "2026-13-01"],
    ["day", new Date()],
    ["dayAsDate", "2026-05-04"],
    ["clock", "25:00:00"],
    ["at", "2026-05-04T09:30:00Z"],
    ["at", new Date("nope")],
    ["secondsAt", new Date("2026-05-04T09:30:00.500Z")],
    ["doc", undefined],
    ["tags", ["x", 1]],
    ["tags", "x"],
    ["grid", [[1], ["2"]]],
    ["kind", "sideways"],
    ["level", 2],
    ["level", "medium"],
  ];

  const show = (value: unknown): string =>
    typeof value === "bigint"
      ? `${value}n`
      : value instanceof Date
        ? value.toString()
        : String(JSON.stringify(value));

  for (const [field, value] of bad) {
    test(`rejects ${show(value)} for ${field}`, () => {
      expect(rejected(LedgerZ, { ...good, [field]: value })).toEqual([field]);
    });
  }

  test("rejects null and absence for fields that are not nullable", () => {
    expect(rejected(LedgerZ, { ...good, label: null })).toEqual(["label"]);
    const { label: _label, ...withoutLabel } = good;
    expect(rejected(LedgerZ, withoutLabel)).toEqual(["label"]);
  });

  test("accepts null for nullable fields, and only for them", () => {
    const UserZ = toZod(User, { pick: ["name", "email"] });
    expect(UserZ.safeParse({ email: "a@b.c", name: null }).success).toBe(true);
    expect(UserZ.safeParse({ email: null, name: "Ada" }).success).toBe(false);
  });

  test("a custom type accepts exactly what the type accepts", () => {
    const Even = defineType<number>({
      name: "even",
      db: { kind: "integer" },
      cast: (input) =>
        typeof input === "number" && input % 2 === 0 ? { success: true, data: input } : { success: false },
    });
    class Pair extends Schema("pairs", { n: t.type(Even) }, { primaryKey: false }) {}
    const PairZ = toZod(Pair);
    expect(PairZ.safeParse({ n: 4 }).success).toBe(true);
    expect(PairZ.safeParse({ n: 3 }).success).toBe(false);
    expect(PairZ.safeParse({ n: "4" }).success).toBe(false);
  });

  test("a custom type's zod hint is used instead, as a schema or a function", () => {
    const Slug = defineType<string>({
      name: "slug",
      db: { kind: "text" },
      cast: (input) => (typeof input === "string" ? { success: true, data: input } : { success: false }),
    });
    const hinted: FieldType<string, string> & ZodHint<string> = {
      ...Slug,
      zod: z.string().regex(/^[a-z-]+$/),
    };
    const lazyHint: FieldType<string, string> & ZodHint<string> = { ...Slug, zod: () => z.string().max(3) };
    class Page extends Schema(
      "pages",
      { slug: t.type(hinted), code: t.type(lazyHint).nullable() },
      { primaryKey: false },
    ) {}
    const PageZ = toZod(Page);
    expect(PageZ.safeParse({ slug: "hello-world", code: "abc" }).success).toBe(true);
    expect(rejected(PageZ, { slug: "Hello World", code: "abcd" })).toEqual(["code", "slug"]);
    expect(PageZ.safeParse({ slug: "ok", code: null }).success).toBe(true);
  });

  test("a hint that is not a Zod schema is refused", () => {
    const Odd = defineType<string>({ name: "odd", db: { kind: "text" }, cast: () => ({ success: false }) });
    class Broken extends Schema(
      "broken",
      { x: t.type({ ...Odd, zod: "z.string()" } as FieldType<string, string>) },
      { primaryKey: false },
    ) {}
    expect(() => toZod(Broken)).toThrow(QueryError);
    expect(() => toZod(Broken)).toThrow(/zod hint of the type "odd"/);
  });
});

describe("toZod: embeds", () => {
  test("an embedOne becomes a nested object; a loaded embed passes", () => {
    const UserZ = toZod(User, { pick: ["settings"] });
    const settings = loaded(UserSettings, { theme: "dark", emailNotifications: false });
    expect(UserZ.safeParse({ settings }).success).toBe(true);
    expect(UserZ.safeParse({ settings: null }).success).toBe(true);
    const bad = UserZ.safeParse({ settings: { theme: "sepia", emailNotifications: true } });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(["settings", "theme"]);
  });

  test("an embedMany becomes an array of nested objects", () => {
    class Address extends EmbeddedSchema({ city: t.string() }) {}
    class Customer extends Schema(
      "customers",
      { addresses: t.embedMany(() => Address) },
      { primaryKey: false },
    ) {}
    const CustomerZ = toZod(Customer);
    expect(CustomerZ.safeParse({ addresses: [{ city: "Oslo" }] }).success).toBe(true);
    expect(CustomerZ.safeParse({ addresses: [{ city: 1 }] }).error?.issues[0]?.path).toEqual([
      "addresses",
      0,
      "city",
    ]);
  });
});

describe("toZod: modes, pick and omit", () => {
  test('"row" is the default and includes virtual and redacted fields, every key required', () => {
    const keys = Object.keys(toZod(User).shape);
    expect(keys).toEqual(meta(User).fields.map((field) => field.name));
    expect(keys).toContain("password");
    expect(keys).toContain("passwordHash");
    expect(toZod(User).safeParse({}).success).toBe(false);
  });

  test('"insert" leaves virtual fields out and makes defaulted, generated and nullable fields optional', () => {
    const UserInsert = toZod(User, { mode: "insert" });
    expect(Object.keys(UserInsert.shape)).not.toContain("password");
    expect(UserInsert.safeParse({ email: "ada@engine.example" }).success).toBe(true);
    expect(rejected(UserInsert, {})).toEqual(["email"]);
    expect(toZod(Org, { mode: "insert" }).safeParse({ name: "Acme" }).success).toBe(true);
  });

  test("an optional key may be absent but not undefined", () => {
    const UserInsert = toZod(User, { mode: "insert" });
    expect(rejected(UserInsert, { email: "a@b.c", name: undefined })).toEqual(["name"]);
  });

  test('"update" makes every field optional', () => {
    expect(toZod(User, { mode: "update" }).safeParse({}).success).toBe(true);
    expect(rejected(toZod(User, { mode: "update" }), { age: "x" })).toEqual(["age"]);
  });

  test("pick and omit select the keys, in field order", () => {
    expect(Object.keys(toZod(User, { pick: ["name", "email"] }).shape)).toEqual(["email", "name"]);
    expect(Object.keys(toZod(Org, { omit: ["id"] }).shape)).toEqual(["name"]);
    expect(Object.keys(toZod(User, { pick: ["name", "email"], omit: ["name"] }).shape)).toEqual(["email"]);
  });

  test("returns the same object for the same schema and mode without pick or omit", () => {
    expect(toZod(User)).toBe(toZod(User));
    expect(toZod(User, { mode: "insert" })).toBe(toZod(User, { mode: "insert" }));
    expect(toZod(User, { mode: "insert" })).not.toBe(toZod(User));
  });

  test("refuses unknown modes and names", () => {
    expect(() => toZod(User, { mode: "patch" as never })).toThrow(/mode must be "row", "insert" or "update"/);
    expect(() => toZod(User, { pick: ["emial" as never] })).toThrow(/pick names "emial"/);
    expect(() => toZod(User, { mode: "insert", pick: ["password" as never] })).toThrow(QueryError);
    expect(() => toZod(User, { omit: [1 as never] })).toThrow(/omit names 1/);
    expect(() => toZod(User, { pick: "email" as never })).toThrow(/pick must be a list/);
  });
});

describe("toZod with validate", () => {
  test("a changeset of a new record reports a missing required field", () => {
    const cs = cast(User, { name: "No Email" }, ["name"]).validate(toZod(User, { mode: "insert" }));
    expect(cs.errors.email?.[0]).toMatchObject({ validation: "schema", meta: { path: [] } });
    expect(Object.keys(cs.errors)).toEqual(["email"]);
  });

  test("a loaded row with its changes passes the row schema", () => {
    const at = new Date("2026-01-01T00:00:00Z");
    const row = loaded(User, {
      id: 1,
      email: "ada@engine.example",
      role: "admin",
      lockVersion: 1,
      createdAt: at,
      updatedAt: at,
      settings: loaded(UserSettings, { theme: "light", emailNotifications: true }),
    });
    const cs = cast(row, { name: "Ada", password: "correct horse battery" }, ["name", "password"]).validate(
      toZod(User),
    );
    expect(cs.errors).toEqual({});
  });
});
