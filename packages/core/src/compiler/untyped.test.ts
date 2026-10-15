// A value with no type that is not text is refused where nothing gives it a type (owner
// decision, 2026-10-15). The types already refuse `val(5)` in a select; these tests reach
// the compiler with hand-built trees and casts, as a caller without the types would.
import { Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type { ExprNode, QueryAst } from "../contracts/query.js";
import { caseWhen, coalesce, from, t, val } from "../index.js";
import { caseNode, fnNode, literalNode, paramNode } from "../query/ast.js";
import { bindParams } from "./bind.js";
import { createCompiler } from "./compiler.js";
import { postgresDialect } from "./dialect.js";
import { bareQuery, col, rebuild, selectObject, selectOne, typeOf, value } from "./sql-fixtures.js";
import { untypedValue } from "./untyped.js";

const users = from(User, "u").ast;

function compile(ast: QueryAst, operation: "all" | "updateAll" = "all") {
  return createCompiler(postgresDialect).compile(ast, operation, undefined);
}

function selecting(node: ExprNode): QueryAst {
  return rebuild(users, { select: selectOne(node) });
}

const untyped = (v: unknown): ExprNode => paramNode(v, undefined, false);

describe("an untyped value that is not text", () => {
  test.each([
    ["a number", 5, "It is a number: give it a type, val(value, t.integer()) or val(value, t.float())."],
    ["a boolean", true, "It is a boolean: give it a type, val(value, t.boolean())."],
    ["a bigint", 5n, "It is a bigint: give it a type, val(value, t.bigint())."],
    ["a Date", new Date(0), "It is a Date: give it a type, val(value, t.timestamp())."],
    ["bytes", new Uint8Array(1), "It is bytes: give it a type, val(value, t.binary())."],
    ["an object", { a: 1 }, "It is an object or array: give it a type, val(value, t.json())."],
  ])("is refused in the select list: %s", (_kind, v, hint) => {
    expect(() => compile(selecting(untyped(v)))).toThrow(
      `A value without a type is in the select list, where nothing gives it one, so the database would return it as text. ${hint}`,
    );
  });

  test("the error names the place but never the value", () => {
    expect(untypedValue("the select list", 123456789).message).not.toContain("123456789");
  });

  test("is refused nested in an object or array select", () => {
    const ast = rebuild(users, {
      select: {
        kind: "select",
        shape: {
          kind: "object",
          keys: ["id", "inner"],
          values: [
            { kind: "expr", expr: col("u", "id"), type: undefined },
            { kind: "tuple", items: [{ kind: "expr", expr: untyped(1), type: undefined }] },
          ],
        },
        constants: [],
      },
    });
    expect(() => compile(ast)).toThrow("A value without a type is in the select list");
  });

  test("is refused as a CASE result or ELSE in a select", () => {
    const when = { when: literalNode(true), result: untyped(1) };
    expect(() => compile(selecting(caseNode([when], undefined)))).toThrow(
      "A value without a type is in a result of a CASE in the select list",
    );
    const typedWhen = { when: literalNode(true), result: value(1, typeOf(t.integer())) };
    expect(() => compile(selecting(caseNode([typedWhen], untyped(2))))).toThrow(
      "A value without a type is in a result of a CASE in the select list",
    );
  });

  test("is refused in a coalesce of nothing but untyped values; another argument types it", () => {
    expect(() => compile(selecting(fnNode("coalesce", [untyped(1), untyped(2)])))).toThrow(
      "A value without a type is in coalesce() in the select list",
    );
    expect(compile(selecting(fnNode("coalesce", [untyped("a"), untyped(null)]))).sql).toBe(
      'select coalesce(cast($1 as text), cast($2 as text)) as "c0" from "users" as "u"',
    );
    expect(compile(selecting(fnNode("coalesce", [col("u", "age"), untyped(0)]))).sql).toBe(
      'select coalesce("u"."age", $1) as "c0" from "users" as "u"',
    );
  });

  test("is refused in a values cell and a RETURNING list", () => {
    const values = rebuild(bareQuery({ kind: "values", columns: ["a"], rows: [[untyped(1)]], alias: "v" }), {
      select: selectOne(col("v", "a")),
    });
    expect(() => compile(values)).toThrow("A value without a type is in a values list");
    const returning = rebuild(from(Post, "p").ast, {
      updates: [{ kind: "update", field: "views", column: "views", value: literalNode(0) }],
      select: selectObject({ n: untyped(1) }),
    });
    expect(() => compile(returning, "updateAll")).toThrow("A value without a type is in the select list");
  });

  test("is refused when bound to a plan made from a query whose value was text", () => {
    const compiler = createCompiler(postgresDialect);
    const text = selecting(untyped("x"));
    const number = selecting(untyped(5));
    const plan = compiler.compile(text, "all", undefined);
    expect(bindParams(plan.slots, text.params)).toEqual(["x"]);
    // Same shape: the cached plan is found, and binding the number is refused.
    expect(compiler.compile(number, "all", undefined)).toBe(plan);
    expect(() => bindParams(plan.slots, number.params)).toThrow(
      "A value without a type is in the select list",
    );
    expect(bindParams(plan.slots, selecting(untyped(null)).params)).toEqual([null]);
  });

  test("an untyped named parameter takes text or null only", () => {
    const ast = selecting({ kind: "namedParam", name: "label", type: undefined, redact: false });
    const plan = compile(ast);
    expect(plan.sql).toBe('select cast($1 as text) as "c0" from "users" as "u"');
    expect(bindParams(plan.slots, [], { label: "x" })).toEqual(["x"]);
    expect(() => bindParams(plan.slots, [], { label: 1 })).toThrow(
      "A value without a type is in the select list",
    );
  });
});

describe("what the types let through is refused by the compiler", () => {
  test("a CASE started with text whose ELSE is an untyped number", () => {
    const q = from(User, "u").select(({ u }) => caseWhen(u.age.lt(18), "minor").else(5));
    expect(() => compile(q.ast)).toThrow(
      "A value without a type is in a result of a CASE in the select list",
    );
  });

  test("a coalesce of untyped values", () => {
    const q = from(User, "u").select(() => coalesce(val(1), val(1)));
    expect(() => compile(q.ast)).toThrow("A value without a type is in coalesce() in the select list");
  });
});

describe("what stays allowed", () => {
  test("text, null, typed values and literals", () => {
    const ast = rebuild(users, {
      select: selectObject({
        label: untyped("member"),
        none: untyped(null),
        n: value(5, typeOf(t.integer())),
        one: literalNode(1),
      }),
    });
    const plan = compile(ast);
    expect(plan.sql).toBe(
      'select cast($1 as text) as "c0", cast($2 as text) as "c1", cast($3 as integer) as "c2", 1 as "c3" from "users" as "u"',
    );
    expect(bindParams(plan.slots, ast.params)).toEqual(["member", null, 5]);
  });

  test("an untyped value compared with a column is typed by it, and not checked", () => {
    const ast = rebuild(users, {
      wheres: [
        {
          kind: "bool",
          op: "and",
          expr: { kind: "binary", op: "eq", left: col("u", "age"), right: untyped(5) },
        },
      ],
      select: selectOne(col("u", "id")),
    });
    expect(bindParams(compile(ast).slots, ast.params)).toEqual([5]);
  });
});
