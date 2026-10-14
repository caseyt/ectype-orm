// Properties of expressions over generated trees:
//
// 1. An expression's cached `params`, `lists` and `shape` are what walking its node gives.
// 2. The shape does not change when only bound values change.
// 3. The shape changes when the structure changes anywhere in the tree.
// 4. No value supplied by the caller ends up anywhere in a node but the `value` of a
//    parameter or list node (decision D9): not in a string the compiler writes as SQL.
import { Post, User } from "@egon-orm/test-support";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { t } from "../schema/index.js";
import { collectParams, shapeOf } from "./ast.js";
import type { AnyExpr } from "./expr.js";
import { columns } from "./expr-fixtures.js";
import {
  and,
  arrayAgg,
  caseWhen,
  coalesce,
  count,
  countDistinct,
  fragment,
  lit,
  max,
  min,
  or,
  param,
  val,
} from "./functions.js";

/** Marks every string a "user" supplies, so that test 4 can look for it. */
const MARK = "§";

type Value = string | number | boolean;
type Raw = { readonly k: "raw"; readonly v: Value };
type Operand = Desc | Raw;
type Desc =
  | { readonly k: "col"; readonly c: number }
  | { readonly k: "val"; readonly v: Value; readonly typed: boolean }
  | { readonly k: "lit"; readonly v: number | boolean | null }
  | { readonly k: "param"; readonly name: string }
  | { readonly k: "bin"; readonly op: number; readonly l: Desc; readonly r: Operand }
  | { readonly k: "in"; readonly not: boolean; readonly l: Desc; readonly values: readonly Value[] }
  | { readonly k: "between"; readonly e: Desc; readonly lo: Operand; readonly hi: Operand }
  | { readonly k: "un"; readonly op: number; readonly e: Desc }
  | { readonly k: "nary"; readonly or: boolean; readonly args: readonly Desc[] }
  | { readonly k: "fn"; readonly upper: boolean; readonly e: Desc }
  | { readonly k: "coalesce"; readonly first: Desc; readonly rest: readonly Operand[] }
  | { readonly k: "agg"; readonly name: number; readonly e: Desc; readonly filter: Desc | null }
  | { readonly k: "cast"; readonly type: number; readonly e: Desc }
  | {
      readonly k: "case";
      readonly whens: readonly (readonly [Desc, Operand])[];
      readonly otherwise: Operand | null;
    }
  | { readonly k: "frag"; readonly variant: boolean; readonly args: readonly Operand[] }
  | {
      readonly k: "path";
      readonly json: number;
      readonly keys: readonly (string | number)[];
      readonly text: boolean;
    };

const u = columns(User, "u");
const p = columns(Post, "p");
const v = columns(User, "v");
const COLUMNS: readonly AnyExpr[] = [u.age, u.email, u.name, p.views, p.title, u.id, v.age];
const JSON_COLUMNS: readonly AnyExpr[] = [u.settings, v.settings];
const BINARY = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "notLike",
  "add",
  "sub",
  "mul",
  "div",
  "mod",
  "isDistinctFrom",
  "concat",
] as const;
const UNARY = ["isNull", "isNotNull", "not", "neg"] as const;
const AGGREGATES = [count, countDistinct, min, max, arrayAgg] as const;
const TYPES = [() => t.string(), () => t.integer(), () => t.boolean()] as const;
const NAMES = ["a", "b", "minAge"] as const;

type Dynamic = Record<string, (...args: unknown[]) => AnyExpr>;
const call = (target: AnyExpr, method: string, ...args: unknown[]): AnyExpr =>
  (target as unknown as Dynamic)[method]!(...args);

// --- generation ----------------------------------------------------------------

const value: fc.Arbitrary<Value> = fc.oneof(
  fc.string().map((s) => MARK + s),
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
);
const raw: fc.Arbitrary<Raw> = value.map((x) => ({ k: "raw", v: x }));

const { desc } = fc.letrec<{ desc: Desc; operand: Operand }>((tie) => {
  const d = tie("desc");
  const operand = tie("operand");
  return {
    operand: fc.oneof({ depthSize: "small" }, raw, d),
    desc: fc.oneof(
      { depthSize: "small", withCrossShrink: true },
      fc.record({ k: fc.constant("col" as const), c: fc.nat(COLUMNS.length - 1) }),
      fc.record({ k: fc.constant("val" as const), v: value, typed: fc.boolean() }),
      fc.record({
        k: fc.constant("lit" as const),
        v: fc.oneof(fc.integer({ min: -100, max: 100 }), fc.boolean(), fc.constant(null)),
      }),
      fc.record({ k: fc.constant("param" as const), name: fc.constantFrom(...NAMES) }),
      fc.record({ k: fc.constant("bin" as const), op: fc.nat(BINARY.length - 1), l: d, r: operand }),
      fc.record({
        k: fc.constant("in" as const),
        not: fc.boolean(),
        l: d,
        values: fc.array(value, { minLength: 1, maxLength: 4 }),
      }),
      fc.record({ k: fc.constant("between" as const), e: d, lo: operand, hi: operand }),
      fc.record({ k: fc.constant("un" as const), op: fc.nat(UNARY.length - 1), e: d }),
      fc.record({
        k: fc.constant("nary" as const),
        or: fc.boolean(),
        args: fc.array(d, { minLength: 2, maxLength: 3 }),
      }),
      fc.record({ k: fc.constant("fn" as const), upper: fc.boolean(), e: d }),
      fc.record({
        k: fc.constant("coalesce" as const),
        first: d,
        rest: fc.array(operand, { minLength: 1, maxLength: 2 }),
      }),
      fc.record({
        k: fc.constant("agg" as const),
        name: fc.nat(AGGREGATES.length - 1),
        e: d,
        filter: fc.option(d, { nil: null }),
      }),
      fc.record({ k: fc.constant("cast" as const), type: fc.nat(TYPES.length - 1), e: d }),
      fc.record({
        k: fc.constant("case" as const),
        whens: fc.array(fc.tuple(d, operand), { minLength: 1, maxLength: 2 }),
        otherwise: fc.option(operand, { nil: null }),
      }),
      fc.record({
        k: fc.constant("frag" as const),
        variant: fc.boolean(),
        args: fc.array(operand, { maxLength: 2 }),
      }),
      fc.record({
        k: fc.constant("path" as const),
        json: fc.nat(JSON_COLUMNS.length - 1),
        keys: fc.array(
          fc.oneof(
            fc.string().map((s) => MARK + s),
            fc.nat(5),
          ),
          { minLength: 1, maxLength: 3 },
        ),
        text: fc.boolean(),
      }),
    ),
  };
});

// --- building --------------------------------------------------------------------

const TEMPLATES: readonly (readonly [TemplateStringsArray, TemplateStringsArray])[] = [
  [tag`now()`, tag`current_date`],
  [tag`f(${0})`, tag`g(${0})`],
  [tag`f(${0}, ${0})`, tag`${0} + ${0}`],
];

function tag(strings: TemplateStringsArray, ..._args: unknown[]): TemplateStringsArray {
  return strings;
}

function operand(o: Operand): unknown {
  return o.k === "raw" ? o.v : build(o);
}

function build(d: Desc): AnyExpr {
  switch (d.k) {
    case "col":
      return COLUMNS[d.c]!;
    case "val":
      return d.typed ? val(d.v, t.string() as never) : val(d.v);
    case "lit":
      return lit(d.v);
    case "param":
      return param(d.name, t.integer());
    case "bin":
      return call(build(d.l), BINARY[d.op]!, operand(d.r));
    case "in":
      return call(build(d.l), d.not ? "notIn" : "in", d.values);
    case "between":
      return call(build(d.e), "between", operand(d.lo), operand(d.hi));
    case "un":
      return call(build(d.e), UNARY[d.op]!);
    case "nary": {
      const args = d.args.map(build) as never[];
      return d.or ? or(...args) : and(...args);
    }
    case "fn":
      return call(build(d.e), d.upper ? "upper" : "lower");
    case "coalesce":
      return (coalesce as (...args: unknown[]) => AnyExpr)(build(d.first), ...d.rest.map(operand));
    case "agg": {
      const agg = (AGGREGATES[d.name] as (e: unknown) => AnyExpr)(build(d.e));
      return d.filter === null ? agg : call(agg, "filter", build(d.filter));
    }
    case "cast":
      return call(build(d.e), "cast", TYPES[d.type]!());
    case "case": {
      const [first, ...others] = d.whens;
      let result: AnyExpr = caseWhen(build(first![0]) as never, operand(first![1]) as never);
      for (const [when, then] of others) result = call(result, "when", build(when), operand(then));
      return d.otherwise === null ? result : call(result, "else", operand(d.otherwise));
    }
    case "frag": {
      const strings = TEMPLATES[d.args.length]![d.variant ? 1 : 0];
      return (fragment as unknown as (s: TemplateStringsArray, ...a: unknown[]) => AnyExpr)(
        strings,
        ...d.args.map(operand),
      );
    }
    case "path":
      return call(JSON_COLUMNS[d.json]!, d.text ? "pathText" : "path", ...d.keys);
  }
}

// --- value changes (structure kept) ------------------------------------------------

function bump(x: Value): Value {
  if (typeof x === "string") return `${x}!`;
  if (typeof x === "number") return x + 1;
  return !x;
}

function bumpOperand(o: Operand): Operand {
  return o.k === "raw" ? { k: "raw", v: bump(o.v) } : bumpValues(o);
}

/** The same tree with every bound value changed, and every list one element longer. */
function bumpValues(d: Desc): Desc {
  switch (d.k) {
    case "col":
    case "lit":
    case "param":
      return d;
    case "val":
      return { ...d, v: bump(d.v) };
    case "bin":
      return { ...d, l: bumpValues(d.l), r: bumpOperand(d.r) };
    case "in":
      return { ...d, l: bumpValues(d.l), values: [...d.values.map(bump), MARK] };
    case "between":
      return { ...d, e: bumpValues(d.e), lo: bumpOperand(d.lo), hi: bumpOperand(d.hi) };
    case "un":
    case "fn":
    case "cast":
      return { ...d, e: bumpValues(d.e) };
    case "nary":
      return { ...d, args: d.args.map(bumpValues) };
    case "coalesce":
      return { ...d, first: bumpValues(d.first), rest: d.rest.map(bumpOperand) };
    case "agg":
      return { ...d, e: bumpValues(d.e), filter: d.filter === null ? null : bumpValues(d.filter) };
    case "case":
      return {
        ...d,
        whens: d.whens.map(([w, x]) => [bumpValues(w), bumpOperand(x)] as const),
        otherwise: d.otherwise === null ? null : bumpOperand(d.otherwise),
      };
    case "frag":
      return { ...d, args: d.args.map(bumpOperand) };
    case "path":
      return { ...d, keys: d.keys.map((key) => (typeof key === "string" ? `${key}!` : key + 1)) };
  }
}

// --- structural changes --------------------------------------------------------

/** Counts the places a structural change can be made: every node and every operand. */
function sites(d: Operand): number {
  if (d.k === "raw") return 1;
  switch (d.k) {
    case "col":
    case "val":
    case "lit":
    case "param":
    case "path":
      return 1;
    case "bin":
      return 1 + sites(d.l) + sites(d.r);
    case "in":
      return 1 + sites(d.l);
    case "between":
      return 1 + sites(d.e) + sites(d.lo) + sites(d.hi);
    case "un":
    case "fn":
    case "cast":
      return 1 + sites(d.e);
    case "nary":
      return 1 + d.args.reduce((n, a) => n + sites(a), 0);
    case "coalesce":
      return 1 + sites(d.first) + d.rest.reduce((n, a) => n + sites(a), 0);
    case "agg":
      return 1 + sites(d.e) + (d.filter === null ? 0 : sites(d.filter));
    case "case":
      return (
        1 +
        d.whens.reduce((n, [w, x]) => n + sites(w) + sites(x), 0) +
        (d.otherwise === null ? 0 : sites(d.otherwise))
      );
    case "frag":
      return 1 + d.args.reduce((n, a) => n + sites(a), 0);
  }
}

/** A change to one node itself (not its children) that changes the SQL it stands for. */
function changeNode(d: Operand, wrap: boolean): Operand {
  if (d.k === "raw") return { k: "col", c: 0 };
  // Any expression can be wrapped in another operator.
  if (wrap) return { k: "un", op: 0, e: d };
  switch (d.k) {
    case "col":
      return { ...d, c: (d.c + 1) % COLUMNS.length };
    case "val":
      return { ...d, typed: !d.typed };
    case "lit":
      return { ...d, v: d.v === null ? 0 : typeof d.v === "boolean" ? !d.v : d.v + 1 };
    case "param":
      return { ...d, name: `${d.name}x` };
    case "bin":
      return { ...d, op: (d.op + 1) % BINARY.length };
    case "in":
      return { ...d, not: !d.not };
    case "between":
      return { ...d, e: { k: "un", op: 3, e: d.e } };
    case "un":
      return { ...d, op: (d.op + 1) % UNARY.length };
    case "nary":
      return { ...d, or: !d.or };
    case "fn":
      return { ...d, upper: !d.upper };
    case "coalesce":
      return { ...d, rest: [...d.rest, { k: "col", c: 1 }] };
    case "agg":
      return { ...d, name: (d.name + 1) % AGGREGATES.length };
    case "cast":
      return { ...d, type: (d.type + 1) % TYPES.length };
    case "case":
      return { ...d, otherwise: d.otherwise === null ? { k: "col", c: 1 } : null };
    case "frag":
      return { ...d, variant: !d.variant };
    case "path":
      return { ...d, text: !d.text };
  }
}

/** The tree with the node at pre-order position `target` changed. */
function mutate(root: Desc, target: number, wrap: boolean): Desc {
  let position = 0;
  const visitOperand = (o: Operand): Operand =>
    o.k === "raw" ? (position++ === target ? changeNode(o, wrap) : o) : visit(o);
  const visit = (d: Desc): Desc => {
    if (position++ === target) return changeNode(d, wrap) as Desc;
    switch (d.k) {
      case "col":
      case "val":
      case "lit":
      case "param":
      case "path":
        return d;
      case "bin":
        return { ...d, l: visit(d.l), r: visitOperand(d.r) };
      case "in":
        return { ...d, l: visit(d.l) };
      case "between":
        return { ...d, e: visit(d.e), lo: visitOperand(d.lo), hi: visitOperand(d.hi) };
      case "un":
      case "fn":
      case "cast":
        return { ...d, e: visit(d.e) };
      case "nary":
        return { ...d, args: d.args.map(visit) };
      case "coalesce":
        return { ...d, first: visit(d.first), rest: d.rest.map(visitOperand) };
      case "agg":
        return { ...d, e: visit(d.e), filter: d.filter === null ? null : visit(d.filter) };
      case "case":
        return {
          ...d,
          whens: d.whens.map(([w, x]) => [visit(w), visitOperand(x)] as const),
          otherwise: d.otherwise === null ? null : visitOperand(d.otherwise),
        };
      case "frag":
        return { ...d, args: d.args.map(visitOperand) };
    }
  };
  return visit(root);
}

// --- inspection ---------------------------------------------------------------------

/** Every string in a node tree outside the `value` of parameters and lists, and outside types. */
function textOf(node: unknown, out: string[]): string[] {
  if (typeof node === "string") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) textOf(item, out);
    return out;
  }
  if (typeof node !== "object" || node === null) return out;
  const kind = (node as { readonly kind?: unknown }).kind;
  for (const [key, child] of Object.entries(node)) {
    if ((kind === "param" || kind === "list") && key === "value") continue;
    if (key === "type" || key === "meta" || key === "params") continue;
    textOf(child, out);
  }
  return out;
}

const RUNS = 5_000;

describe("expressions over generated trees", () => {
  test("cached params, lists and shape agree with walking the node", () => {
    fc.assert(
      fc.property(desc, (d) => {
        const expr = build(d);
        const params: unknown[] = [];
        const lists: number[] = [];
        collectParams(expr.node, params, lists);
        expect(expr.params).toEqual(params);
        expect(expr.lists).toEqual(lists);
        expect(expr.shape).toBe(shapeOf(expr.node));
      }),
      { numRuns: RUNS },
    );
  });

  test("the shape is invariant under changing bound values", () => {
    fc.assert(
      fc.property(desc, (d) => {
        const before = build(d);
        const after = build(bumpValues(d));
        expect(after.shape).toBe(before.shape);
        expect(after.params.length).toBe(before.params.length);
        if (before.params.length > 0) expect(after.params).not.toEqual(before.params);
      }),
      { numRuns: RUNS },
    );
  });

  test("the shape changes with any structural change", () => {
    fc.assert(
      fc.property(desc, fc.nat(), fc.boolean(), (d, at, wrap) => {
        const changed = mutate(d, at % sites(d), wrap);
        expect(build(changed).shape).not.toBe(build(d).shape);
      }),
      { numRuns: RUNS },
    );
  });

  test("no value supplied by the caller reaches a string of the tree (decision D9)", () => {
    fc.assert(
      fc.property(desc, (d) => {
        const expr = build(d);
        for (const text of textOf(expr.node, [])) expect(text.includes(MARK)).toBe(false);
      }),
      { numRuns: RUNS },
    );
  });

  test("the generators reach the values they claim to (the D9 check is not vacuous)", () => {
    const sample = fc.sample(desc, { numRuns: 500, seed: 7 });
    const carried = sample
      .map(build)
      .filter((e) => e.params.some((x) => typeof x === "string" && x.includes(MARK)));
    expect(carried.length).toBeGreaterThan(100);
  });
});
