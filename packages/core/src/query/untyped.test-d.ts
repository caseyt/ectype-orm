// A value with no type that is not text cannot be selected (owner decision, 2026-10-15):
// in a select list nothing gives it a type, and the database would return it as text.
import { Post, User } from "@egon-orm/test-support";
import { describe, expectTypeOf, test } from "vitest";
import { caseWhen, from, lit, t, val } from "../index.js";
import type { Expr, Untyped } from "./expr.js";

const users = from(User, "u");

describe("untyped values in a select", () => {
  test("val() of a non-text value is marked; of text, null or with a type it is not", () => {
    expectTypeOf(val(5)).toEqualTypeOf<Expr<5> & Untyped>();
    expectTypeOf(val(true)).toEqualTypeOf<Expr<true> & Untyped>();
    expectTypeOf(val("member")).toEqualTypeOf<Expr<"member">>();
    expectTypeOf(val(null)).toEqualTypeOf<Expr<null>>();
    expectTypeOf(val(5, t.integer())).toEqualTypeOf<Expr<number>>();
  });

  test("an untyped non-text value does not compile in select or selectMerge, at any depth", () => {
    // @ts-expect-error: val(5) has no type
    users.select(() => val(5));
    // @ts-expect-error: val(true) has no type
    users.select(({ u }) => ({ id: u.id, flag: val(true) }));
    // @ts-expect-error: nested in an object and an array
    users.select(({ u }) => ({ id: u.id, inner: { list: [u.email, val(1)] } }));
    // @ts-expect-error: caseWhen with an untyped number
    users.select(({ u }) => caseWhen(u.age.lt(18), 1));
    // @ts-expect-error: the mark is kept through when() and else()
    users.select(({ u }) => caseWhen(u.age.lt(18), 1).when(u.age.lt(30), 2).else(3));
    // @ts-expect-error: an untyped val() as a later branch of a typed CASE
    users.select(({ u }) => caseWhen(u.age.lt(18), u.age).else(val(0)));
    // @ts-expect-error: selectMerge too
    users.select(({ u }) => ({ id: u.id })).selectMerge(() => ({ n: val(5) }));
  });

  test("typed values, text, null, literals and columns compile", () => {
    const q = users.select(({ u }) => ({
      id: u.id,
      n: val(5, t.integer()),
      label: val("member"),
      none: val(null),
      one: lit(1),
      kind: caseWhen(u.age.lt(18), "minor").else("adult"),
      age: caseWhen(u.age.lt(18), u.age).else(0),
      typed: caseWhen(u.age.lt(18), val(1, t.integer())).else(2),
    }));
    expectTypeOf(q.ast).not.toBeAny();
    users.select(({ u }) => ({ id: u.id })).selectMerge(() => ({ n: val(5, t.integer()) }));
  });

  test("an untyped value is fine where the other side types it", () => {
    users.where(({ u }) => u.age.eq(val(5))).select(({ u }) => u.id);
    from(Post, "p").where(({ p }) => p.views.gt(val(1)));
  });
});
