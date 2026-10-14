// Unit tests for the expression methods: the node each operator builds, how operands
// become parameters, null handling, immutability, and that every expression's `params`,
// `lists` and `shape` agree with walking its node.
import { Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import { QueryError } from "../errors.js";
import { meta, Schema, t } from "../schema/index.js";
import { collectParams, namedParamNode, shapeOf } from "./ast.js";
import { type AnyExpr, Col, Expr, isExpr, NONE, type OrderExpr } from "./expr.js";
import { asSubquery, columns, postsByViews, show } from "./expr-fixtures.js";
import { param, val } from "./functions.js";

const u = columns(User, "u");
const p = columns(Post, "p");

class Ledger extends Schema("ledgers", {
  id: t.integer().primaryKey(),
  meta: t.json(),
  scores: t.array(t.integer()),
  secret: t.string().redact(),
  secretTags: t.array(t.string()).redact(),
}) {}
const l = columns(Ledger, "l");

/** The expression's cached `params`, `lists` and `shape` are what a walk of its node gives. */
function expectConsistent(expr: AnyExpr | OrderExpr<unknown>): void {
  const params: unknown[] = [];
  const lists: number[] = [];
  collectParams(expr.node, params, lists);
  expect(expr.params).toEqual(params);
  expect(expr.lists).toEqual(lists);
  expect(expr.shape).toBe(shapeOf(expr.node));
}

function shown(expr: AnyExpr | OrderExpr<unknown>): string {
  expectConsistent(expr);
  return show(expr.node);
}

describe("columns", () => {
  test("a column holds its binding, field, type and redaction", () => {
    const field = meta(User).fieldsByName.get("passwordHash");
    const col = new Col("u", field!);
    expect(col.node).toEqual({
      kind: "column",
      binding: "u",
      field: "passwordHash",
      column: "password_hash",
    });
    expect(col.binding).toBe("u");
    expect(col.field).toBe(field);
    expect(col.type).toBe(field!.type);
    expect(col.redact).toBe(true);
    expect(col.params).toEqual([]);
    expect(col.lists).toEqual([]);
    expectConsistent(col);
  });

  test("the same field under two aliases has two shapes", () => {
    expect(columns(User, "a").id.shape).not.toBe(columns(User, "b").id.shape);
    expect(columns(User, "a").id.shape).toBe(columns(User, "a").id.shape);
  });

  test("isExpr tells expressions from values", () => {
    expect(isExpr(u.age)).toBe(true);
    expect(isExpr(u.age.gte(1))).toBe(true);
    expect(isExpr(18)).toBe(false);
    expect(isExpr(u.age.asc())).toBe(false);
  });
});

describe("comparison operators", () => {
  test("each builds a binary node with the value as a parameter of the column's type", () => {
    expect(shown(u.age.eq(30))).toMatchInlineSnapshot(`"(eq u.age $30:integer)"`);
    expect(shown(u.age.neq(30))).toMatchInlineSnapshot(`"(neq u.age $30:integer)"`);
    expect(shown(u.age.gt(30))).toMatchInlineSnapshot(`"(gt u.age $30:integer)"`);
    expect(shown(u.age.gte(18))).toMatchInlineSnapshot(`"(gte u.age $18:integer)"`);
    expect(shown(u.age.lt(65))).toMatchInlineSnapshot(`"(lt u.age $65:integer)"`);
    expect(shown(u.age.lte(65))).toMatchInlineSnapshot(`"(lte u.age $65:integer)"`);
    expect(shown(u.name.isDistinctFrom("Ann"))).toMatchInlineSnapshot(
      `"(isDistinctFrom u.name $"Ann":string)"`,
    );
  });

  test("the result is loaded as a boolean and is never redacted", () => {
    const e = u.passwordHash.eq("x");
    expect(e.type?.name).toBe("boolean");
    expect(e.redact).toBe(false);
  });

  test("a value takes the type of the other side", () => {
    expect(shown(u.role.eq("admin"))).toMatchInlineSnapshot(`"(eq u.role $"admin":enum)"`);
    const now = new Date("2026-10-14T12:00:00.000Z");
    expect(shown(u.createdAt.gt(now))).toMatchInlineSnapshot(
      `"(gt u.created_at $Date(2026-10-14T12:00:00.000Z):timestamp)"`,
    );
    const node = u.createdAt.gt(now).node;
    expect(node.kind === "binary" && node.right.kind === "param" && node.right.type).toBe(
      meta(User).fieldsByName.get("createdAt")!.type,
    );
  });

  test("a value compared with a redacted field is redacted, and so is a named parameter", () => {
    expect(shown(u.passwordHash.eq("hash"))).toMatchInlineSnapshot(`"(eq u.password_hash $"hash":string!)"`);
    expect(shown(u.passwordHash.eq(param("hash", t.string())))).toMatchInlineSnapshot(
      `"(eq u.password_hash :hash:string!)"`,
    );
    expect(shown(u.passwordHash.in(["a", "b"]))).toMatchInlineSnapshot(
      `"(in u.password_hash $["a","b"]:string!)"`,
    );
    expect(shown(u.passwordHash.between("a", "b"))).toMatchInlineSnapshot(
      `"(between u.password_hash $"a":string! $"b":string!)"`,
    );
    const named = u.passwordHash.eq(param("hash", t.string()));
    const right = named.node.kind === "binary" ? named.node.right : undefined;
    expect(right).toMatchObject({ kind: "namedParam", redact: true });
    // A named parameter that is redacted already is used as it is.
    const redacted = new Expr(namedParamNode("hash", undefined, true), undefined, false, NONE, NONE, 0);
    const again = u.passwordHash.eq(redacted as never);
    expect(again.node.kind === "binary" && again.node.right).toBe(redacted.node);
  });

  test("an expression on the right is used as it is", () => {
    expect(shown(u.name.eq(u.email))).toMatchInlineSnapshot(`"(eq u.name u.email)"`);
    expect(shown(u.age.gte(param("minAge", t.integer())))).toMatchInlineSnapshot(
      `"(gte u.age :minAge:integer)"`,
    );
    const explicit = val(18, t.integer());
    const e = u.age.gte(explicit);
    expect(e.node.kind === "binary" && e.node.right).toBe(explicit.node);
  });

  test("between builds one node with both ends as parameters", () => {
    expect(shown(u.age.between(18, 65))).toMatchInlineSnapshot(`"(between u.age $18:integer $65:integer)"`);
    expect(shown(u.age.between(p.views, val(99)))).toMatchInlineSnapshot(`"(between u.age p.views $99)"`);
  });

  test("isNull and isNotNull are unary", () => {
    expect(shown(u.name.isNull())).toMatchInlineSnapshot(`"(isNull u.name)"`);
    expect(shown(u.name.isNotNull())).toMatchInlineSnapshot(`"(isNotNull u.name)"`);
  });
});

describe("null is refused in comparisons", () => {
  const message = /comparison with null is always unknown in SQL.*isNull\(\)/;
  test.each([
    ["eq", () => u.name.eq(null as never)],
    ["neq", () => u.name.neq(undefined as never)],
    ["gt", () => u.age.gt(null as never)],
    ["gte", () => u.age.gte(null as never)],
    ["lt", () => u.age.lt(null as never)],
    ["lte", () => u.age.lte(null as never)],
    ["between (low)", () => u.age.between(null as never, 1)],
    ["between (high)", () => u.age.between(1, null as never)],
    ["has", () => p.tagList.has(null as never)],
  ])("%s throws QueryError", (_name, build) => {
    expect(build).toThrow(QueryError);
    expect(build).toThrow(message);
  });

  test("an explicit val(null) is refused as well", () => {
    expect(() => u.name.eq(val(null))).toThrow(message);
    expect(() => u.age.between(val(null), 3)).toThrow(message);
  });

  test("the message names the method", () => {
    expect(() => u.name.eq(null as never)).toThrow(/^eq\(\) was given null/);
  });

  test("isDistinctFrom takes null, bound as a parameter", () => {
    expect(shown(u.name.isDistinctFrom(null))).toMatchInlineSnapshot(
      `"(isDistinctFrom u.name $null:string)"`,
    );
    expect(() => u.name.isDistinctFrom(undefined as never)).toThrow(QueryError);
  });

  test("the other operators refuse null and undefined with their own message", () => {
    expect(() => p.views.add(null as never)).toThrow(/^add\(\) was given null or undefined/);
    expect(() => u.email.like(undefined as never)).toThrow(/^like\(\) was given null or undefined/);
    expect(() => u.email.concat("a", null as never)).toThrow(/^concat\(\) was given null or undefined/);
    expect(() => p.tagList.contains(null as never)).toThrow(QueryError);
    expect(() => p.tagList.append(undefined as never)).toThrow(QueryError);
  });
});

describe("in and notIn", () => {
  test("an array is one list parameter typed with the column's type", () => {
    expect(shown(u.role.in(["admin", "member"]))).toMatchInlineSnapshot(
      `"(in u.role $["admin","member"]:enum)"`,
    );
    expect(shown(u.id.notIn([1, 2, 3]))).toMatchInlineSnapshot(`"(notIn u.id $[1,2,3]:bigint(number))"`);
    expect(u.id.in([1, 2, 3]).lists).toEqual([3]);
  });

  test("an empty list is false for in and true for notIn, with no parameter", () => {
    expect(shown(u.id.in([]))).toBe("FALSE");
    expect(shown(u.id.notIn([]))).toBe("TRUE");
    expect(u.age.add(val(1)).in([]).params).toEqual([]);
  });

  test("the list is copied: changing the array afterwards does not change the query", () => {
    const ids = [1, 2];
    const e = u.id.in(ids);
    ids.push(3);
    expect(e.params).toEqual([[1, 2]]);
    expect(e.lists).toEqual([2]);
  });

  test("a list holding null or undefined is refused", () => {
    expect(() => u.name.in(["a", null] as never)).toThrow(/in\(\) was given a list holding null/);
    expect(() => u.name.notIn([undefined] as never)).toThrow(/notIn\(\) was given a list holding null/);
  });

  test("an expression of array type is used as it is", () => {
    expect(shown(u.email.in(p.tagList))).toMatchInlineSnapshot(`"(in u.email p.tags)"`);
  });

  test("a query is a subquery operand, its params included", () => {
    const sub = postsByViews(100);
    const e = u.id.in(asSubquery<number>(sub));
    expect(shown(e)).toMatchInlineSnapshot(`"(in u.id (subquery from posts sp))"`);
    expect(e.params).toEqual([100]);
    expect(u.age.gte(5).and(u.id.notIn(asSubquery<number>(sub))).params).toEqual([5, 100]);
  });

  test("anything else is refused", () => {
    expect(() => u.id.in(1 as never)).toThrow(
      /in\(\) takes an array of values, an expression of array type, or a query/,
    );
    expect(() => u.id.in({} as never)).toThrow(QueryError);
    const broken = { [Symbol.for("egon.asSubquery")]: () => u.id };
    expect(() => u.id.in(broken as never)).toThrow(/did not produce a subquery/);
  });
});

describe("boolean operators", () => {
  test("and, or and not", () => {
    expect(shown(u.age.gte(18).and(u.role.eq("admin")))).toMatchInlineSnapshot(
      `"(and (gte u.age $18:integer) (eq u.role $"admin":enum))"`,
    );
    expect(shown(u.age.gte(18).or(p.published))).toMatchInlineSnapshot(
      `"(or (gte u.age $18:integer) p.published)"`,
    );
    expect(shown(p.published.not())).toMatchInlineSnapshot(`"(not p.published)"`);
  });

  test("chained calls of one operator make one flat node; mixed ones nest", () => {
    expect(shown(u.age.gte(18).and(p.published).and(u.name.isNull()))).toMatchInlineSnapshot(
      `"(and (gte u.age $18:integer) p.published (isNull u.name))"`,
    );
    expect(shown(u.age.gte(18).or(p.published).and(u.name.isNull()))).toMatchInlineSnapshot(
      `"(and (or (gte u.age $18:integer) p.published) (isNull u.name))"`,
    );
  });

  test("a boolean value is a boolean parameter", () => {
    expect(shown(p.published.and(true))).toMatchInlineSnapshot(`"(and p.published $true:boolean)"`);
  });

  test("anything else is refused", () => {
    expect(() => p.published.and("yes" as never)).toThrow(/and\(\) takes a boolean expression/);
    expect(() => p.published.or(null as never)).toThrow(/or\(\) takes a boolean expression/);
  });
});

describe("text operators", () => {
  test("the pattern is a text parameter, whatever the column's own type", () => {
    expect(shown(u.email.like("%@example.com"))).toMatchInlineSnapshot(
      `"(like u.email $"%@example.com":string)"`,
    );
    expect(shown(u.email.notLike("%@example.com"))).toMatchInlineSnapshot(
      `"(notLike u.email $"%@example.com":string)"`,
    );
    expect(shown(u.name.ilike("%ann%"))).toMatchInlineSnapshot(`"(ilike u.name $"%ann%":string)"`);
    expect(shown(u.role.like("adm%"))).toMatchInlineSnapshot(`"(like u.role $"adm%":string)"`);
  });

  test("concat chains each part; lower and upper are functions", () => {
    expect(shown(u.email.concat(" <", u.name, ">"))).toMatchInlineSnapshot(
      `"(concat (concat (concat u.email $" <":string) u.name) $">":string)"`,
    );
    expect(shown(u.email.lower())).toMatchInlineSnapshot(`"lower(u.email)"`);
    expect(shown(u.email.upper())).toMatchInlineSnapshot(`"upper(u.email)"`);
    expect(u.email.lower().type?.name).toBe("string");
    expect(() => u.email.concat()).toThrow(/concat\(\) needs at least one part/);
  });

  test("a redacted column's pattern is redacted", () => {
    expect(shown(l.secret.like("a%"))).toMatchInlineSnapshot(`"(like l.secret $"a%":string!)"`);
    expect(l.secret.lower().redact).toBe(true);
  });
});

describe("arithmetic operators", () => {
  test("each keeps the column's type, for the operand and the result", () => {
    expect(shown(u.lockVersion.add(1))).toMatchInlineSnapshot(`"(add u.lock_version $1:integer)"`);
    expect(shown(p.views.sub(1))).toMatchInlineSnapshot(`"(sub p.views $1:integer)"`);
    expect(shown(p.views.mul(2))).toMatchInlineSnapshot(`"(mul p.views $2:integer)"`);
    expect(shown(p.views.div(2))).toMatchInlineSnapshot(`"(div p.views $2:integer)"`);
    expect(shown(u.id.mod(2))).toMatchInlineSnapshot(`"(mod u.id $2:bigint(number))"`);
    expect(shown(p.views.neg())).toMatchInlineSnapshot(`"(neg p.views)"`);
    expect(p.views.add(1).type).toBe(p.views.type);
    expect(shown(p.views.add(u.age).mul(2))).toMatchInlineSnapshot(`"(mul (add p.views u.age) $2:integer)"`);
  });
});

describe("array operators", () => {
  test("contains, containedBy and overlaps take an array parameter of the column's type", () => {
    expect(shown(p.tagList.contains(["ts"]))).toMatchInlineSnapshot(
      `"(contains p.tags $["ts"]:array(string))"`,
    );
    expect(shown(p.tagList.containedBy(["ts", "sql"]))).toMatchInlineSnapshot(
      `"(containedBy p.tags $["ts","sql"]:array(string))"`,
    );
    expect(shown(p.tagList.overlaps(["ts"]))).toMatchInlineSnapshot(
      `"(overlaps p.tags $["ts"]:array(string))"`,
    );
    expect(p.tagList.contains(["ts"]).lists).toEqual([]);
  });

  test("has, append and remove take an element of the element type", () => {
    expect(shown(p.tagList.has("ts"))).toMatchInlineSnapshot(`"(has p.tags $"ts":string)"`);
    expect(shown(l.scores.has(3))).toMatchInlineSnapshot(`"(has l.scores $3:integer)"`);
    expect(shown(p.tagList.append("ts"))).toMatchInlineSnapshot(`"arrayAppend(p.tags, $"ts":string)"`);
    expect(shown(p.tagList.remove("draft"))).toMatchInlineSnapshot(`"arrayRemove(p.tags, $"draft":string)"`);
    expect(p.tagList.append("ts").type).toBe(p.tagList.type);
  });

  test("append and remove take null (a null element)", () => {
    expect(shown(p.tagList.remove(null))).toMatchInlineSnapshot(`"arrayRemove(p.tags, $null:string)"`);
  });

  test("an element of a redacted array is redacted", () => {
    expect(shown(l.secretTags.has("x"))).toMatchInlineSnapshot(`"(has l.secret_tags $"x":string!)"`);
  });

  test("an element of an expression with no known type has none", () => {
    const untyped = val(["a"]).as<string[]>();
    expect(shown(untyped.has("a"))).toMatchInlineSnapshot(`"(has $["a"] $"a")"`);
  });
});

describe("JSON operators", () => {
  test("path and pathText bind every key", () => {
    expect(shown(u.settings.path("theme"))).toMatchInlineSnapshot(`"(#> u.settings $"theme")"`);
    expect(shown(l.meta.pathText("limits", 0))).toMatchInlineSnapshot(`"(#>> l.meta $"limits" $0)"`);
    expect(u.settings.path("theme").type?.name).toBe("json");
    expect(u.settings.pathText("theme").type?.name).toBe("string");
  });

  test("key values are params: two paths with different keys share a shape", () => {
    expect(l.meta.path("a", "b").shape).toBe(l.meta.path("c", 1).shape);
    expect(l.meta.path("a").shape).not.toBe(l.meta.path("a", "b").shape);
    expect(l.meta.path("a").shape).not.toBe(l.meta.pathText("a").shape);
  });

  test("a path is refused on a known non-JSON type, without keys, or with a bad key", () => {
    const email = u.email as unknown as Col<unknown>;
    expect(() => email.path("a")).toThrow(
      /path\(\) reads inside a JSON value, and this expression has the type string/,
    );
    expect(() => (u.settings.path as (...keys: unknown[]) => unknown).call(u.settings)).toThrow(
      /path\(\) needs at least one key/,
    );
    expect(() => u.settings.path(1.5)).toThrow(/keys that are strings, or whole numbers/);
    expect(() => u.settings.pathText(true as never)).toThrow(/pathText\(\) takes keys/);
  });

  test("an expression with no known type may hold JSON", () => {
    expect(shown(val({}).path("a"))).toMatchInlineSnapshot(`"(#> \${} $"a")"`);
  });
});

describe("typing", () => {
  test("cast takes a field type, which the result is loaded with", () => {
    const e = u.age.cast(t.string());
    expect(shown(e)).toMatchInlineSnapshot(`"(cast u.age :string)"`);
    expect(e.type?.name).toBe("string");
    expect(l.secret.cast(t.string()).redact).toBe(true);
  });

  test("cast refuses anything but a field type", () => {
    expect(() => u.age.cast("text" as never)).toThrow(/cast\(\) takes a field type such as t.integer\(\)/);
  });

  test("as changes nothing at run time", () => {
    const e = u.age.add(1);
    expect(e.as<string>()).toBe(e);
  });

  test("a cast type with another name is another shape", () => {
    expect(u.age.cast(t.string()).shape).not.toBe(u.age.cast(t.integer()).shape);
  });
});

describe("ordering", () => {
  test("asc and desc, then nullsFirst or nullsLast", () => {
    expect(shown(u.createdAt.desc())).toMatchInlineSnapshot(`"(desc u.created_at)"`);
    expect(shown(u.createdAt.desc().nullsLast())).toMatchInlineSnapshot(`"(desc u.created_at nulls last)"`);
    expect(shown(u.name.asc().nullsFirst())).toMatchInlineSnapshot(`"(asc u.name nulls first)"`);
    expect(shown(u.age.add(param("shift", t.integer())).asc().nullsLast())).toMatchInlineSnapshot(
      `"(asc (add u.age :shift:integer) nulls last)"`,
    );
  });

  test("order items of different directions or nulls have different shapes", () => {
    const shapes = new Set([
      u.name.asc().shape,
      u.name.desc().shape,
      u.name.asc().nullsFirst().shape,
      u.name.asc().nullsLast().shape,
      u.name.desc().nullsLast().shape,
    ]);
    expect(shapes.size).toBe(5);
  });
});

describe("immutability", () => {
  test("operators never change their operands", () => {
    const left = u.age.gte(18);
    const snapshot = JSON.stringify({
      node: left.node,
      params: left.params,
      lists: left.lists,
      shape: left.shape,
    });
    left.and(p.published);
    left.and(p.published).and(u.name.isNull());
    left.or(p.published);
    left.not();
    left.eq(true);
    expect(
      JSON.stringify({ node: left.node, params: left.params, lists: left.lists, shape: left.shape }),
    ).toBe(snapshot);
  });

  test("flattening an and does not change the earlier and", () => {
    const both = u.age.gte(18).and(p.published);
    const before = both.node.kind === "nary" ? both.node.args.length : -1;
    const three = both.and(u.name.isNull());
    expect(both.node.kind === "nary" && both.node.args.length).toBe(before);
    expect(three.node.kind === "nary" && three.node.args.length).toBe(3);
    expect(both.params).toEqual([18]);
  });

  test("params arrays are never shared in a way that lets one expression change another", () => {
    const a = u.age.gte(1);
    const b = a.and(u.age.lte(2));
    const c = a.and(u.age.lte(3));
    expect(a.params).toEqual([1]);
    expect(b.params).toEqual([1, 2]);
    expect(c.params).toEqual([1, 3]);
  });

  test("an order item is not changed by nullsLast", () => {
    const desc = u.createdAt.desc();
    desc.nullsLast();
    expect(desc.node.nulls).toBeUndefined();
  });

  test("every expression of one kind has its own keys in one order", () => {
    const keys = (value: object) => Object.keys(value).join(",");
    expect(keys(u.age.gte(1))).toBe(keys(u.email.lower()));
    expect(keys(u.age.gte(1))).toBe("node,type,redact,params,lists,shape");
    expect(keys(u.age)).toBe("node,type,redact,params,lists,shape,binding,field");
    expect(keys(u.age.asc())).toBe("node,params,lists,shape,exprShape");
    expect(u.age.gte(1)).toBeInstanceOf(Expr);
  });
});
