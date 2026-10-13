import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import * as contracts from "./index.js";
import { err, ok } from "./result.js";
import { META, ROW } from "./schema.js";
import { CUSTOM_SQL_TYPE, IDENTITY } from "./type.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const sourceFiles = readdirSync(here).filter(
  (file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".test-d.ts"),
);

describe("contract files", () => {
  test("are the ones the plan lists, plus the barrel", () => {
    expect(sourceFiles.sort()).toEqual([
      "adapter.ts",
      "changeset.ts",
      "index.ts",
      "query.ts",
      "result.ts",
      "schema.ts",
      "standard-schema.ts",
      "type.ts",
    ]);
  });

  test.each(sourceFiles)(
    "%s does not mention a Kysely type or import anything outside contracts/",
    (file) => {
      const source = readFileSync(`${here}${file}`, "utf8");
      // Prose may say that Kysely is the back end; code may not name anything of it.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      const specifiers = [...code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
        (match) => match[1],
      );
      for (const specifier of specifiers) expect(specifier).toMatch(/^\.\/[a-z-]+\.js$/);
      // Guards the scan itself: these two are known to import, so an empty list means the pattern broke.
      if (file === "schema.ts") expect(specifiers).toEqual(["./type.js"]);
      if (file === "adapter.ts") expect(specifiers).toEqual(["./query.js", "./schema.js", "./type.js"]);
      expect(code).not.toMatch(/kysely/i);
      expect(code).not.toMatch(/OperationNode|QueryCompiler|DatabaseConnection|\bDriver\b/);
    },
  );

  test.each(sourceFiles.filter((file) => file !== "index.ts"))("%s is re-exported by the barrel", (file) => {
    const barrel = readFileSync(`${here}index.ts`, "utf8");
    expect(barrel).toContain(`"./${file.replace(/\.ts$/, ".js")}"`);
  });

  test("the barrel has exactly these runtime exports; everything else is a type", () => {
    expect(Object.keys(contracts).sort()).toEqual([
      "CUSTOM_SQL_TYPE",
      "IDENTITY",
      "META",
      "ROW",
      "err",
      "ok",
    ]);
  });
});

describe("ok and err", () => {
  test("build the two halves of a Result", () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
    expect(err("nope")).toEqual({ ok: false, error: "nope" });
  });

  test("keep the value and the error by identity", () => {
    const value = { id: 1 };
    const error = new Error("boom");
    expect(ok(value).value).toBe(value);
    expect(err(error).error).toBe(error);
  });

  test("accept undefined and null", () => {
    expect(ok(undefined)).toEqual({ ok: true, value: undefined });
    expect(Object.hasOwn(ok(undefined), "value")).toBe(true);
    expect(err(null)).toEqual({ ok: false, error: null });
  });

  test("give every result of a kind the same keys in the same order", () => {
    expect(Object.keys(ok(1))).toEqual(["ok", "value"]);
    expect(Object.keys(err(1))).toEqual(["ok", "error"]);
  });
});

describe("IDENTITY", () => {
  test("returns its argument, by identity", () => {
    const value = { id: 1 };
    expect(IDENTITY(value)).toBe(value);
    expect(IDENTITY(null)).toBeNull();
    expect(IDENTITY(undefined)).toBeUndefined();
    expect(Object.is(IDENTITY(-0), -0)).toBe(true);
  });

  test("is one function, so a reference check can skip the call", () => {
    const load: (value: unknown) => unknown = IDENTITY;
    expect(load === IDENTITY).toBe(true);
    expect(((value: unknown) => value) === IDENTITY).toBe(false);
  });
});

describe("META and ROW", () => {
  test("are registered symbols, shared by every copy of the package", () => {
    expect(META).toBe(Symbol.for("ectype.meta"));
    expect(ROW).toBe(Symbol.for("ectype.row"));
    expect(META).not.toBe(ROW);
  });

  test("ROW does not show up when a row is enumerated or serialised", () => {
    const row = { id: 1, [ROW]: { state: "loaded", source: "users", prefix: undefined } };
    expect(Object.keys(row)).toEqual(["id"]);
    expect(JSON.stringify(row)).toBe('{"id":1}');
    const seen: string[] = [];
    for (const key in row) seen.push(key);
    expect(seen).toEqual(["id"]);
  });
});

describe("CUSTOM_SQL_TYPE", () => {
  test.each([
    "money",
    "citext",
    "int8",
    "numeric(10, 2)",
    "numeric(10,2)",
    "varchar(255)",
    "timestamp with time zone",
    "double precision",
    "public.mood",
    "public.mood[]",
    "int4[][]",
    "_private_type",
  ])("accepts the type name %j", (sql) => {
    expect(CUSTOM_SQL_TYPE.test(sql)).toBe(true);
  });

  test.each([
    "",
    " ",
    "text; drop table users",
    "text) --",
    "text'",
    'te"xt',
    "text/*x*/",
    "text--",
    "numeric(10, 2",
    "numeric(a)",
    "numeric(1, 2, 3)",
    "int4[1]",
    "text  with  spaces",
    " text",
    "text ",
    "1text",
    "text\nint",
    "text::int",
    "(select 1)",
    "a.b.",
    "text[",
  ])("rejects %j", (sql) => {
    expect(CUSTOM_SQL_TYPE.test(sql)).toBe(false);
  });

  test("is not stateful (no global or sticky flag)", () => {
    expect(CUSTOM_SQL_TYPE.flags).toBe("");
    expect([CUSTOM_SQL_TYPE.test("money"), CUSTOM_SQL_TYPE.test("money")]).toEqual([true, true]);
  });
});
