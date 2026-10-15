// The emitter decides every parenthesis by operator precedence. This test lets Postgres
// evaluate random expression trees and compares the answers with JavaScript's evaluation
// of the same trees: a missing parenthesis changes the grouping, and so the value.
import { createTestDatabase, type TestDatabaseHandle } from "@egon-orm/test-support";
import fc from "fast-check";
import { afterAll, beforeAll, expect, test } from "vitest";
import type { ExprNode } from "../contracts/query.js";
import { betweenNode, binaryNode, literalNode, naryNode, unaryNode } from "../query/ast.js";
import { createCompiler } from "./compiler.js";
import { postgresDialect } from "./dialect.js";
import { bareQuery, rebuild, selectObject } from "./sql-fixtures.js";

interface Tree<T> {
  readonly node: ExprNode;
  readonly value: T;
}

const COMPARISONS = {
  eq: (a: number, b: number) => a === b,
  neq: (a: number, b: number) => a !== b,
  lt: (a: number, b: number) => a < b,
  lte: (a: number, b: number) => a <= b,
  gt: (a: number, b: number) => a > b,
  gte: (a: number, b: number) => a >= b,
} as const;

function integer(depth: number): fc.Arbitrary<Tree<number>> {
  const leaf = fc.integer({ min: -9, max: 9 }).map((n) => ({ node: literalNode(n), value: n }));
  if (depth === 0) return leaf;
  const inner = integer(depth - 1);
  return fc.oneof(
    leaf,
    fc
      .tuple(fc.constantFrom("add", "sub", "mul") as fc.Arbitrary<"add" | "sub" | "mul">, inner, inner)
      .map(([op, a, b]) => ({
        node: binaryNode(op, a.node, b.node),
        value: op === "add" ? a.value + b.value : op === "sub" ? a.value - b.value : a.value * b.value,
      })),
    inner.map((a) => ({ node: unaryNode("neg", a.node), value: -a.value })),
  );
}

function boolean(depth: number): fc.Arbitrary<Tree<boolean>> {
  const ints = integer(Math.min(depth, 2));
  const comparison = fc
    .tuple(fc.constantFrom(...(Object.keys(COMPARISONS) as (keyof typeof COMPARISONS)[])), ints, ints)
    .map(([op, a, b]) => ({
      node: binaryNode(op, a.node, b.node),
      value: COMPARISONS[op](a.value, b.value),
    }));
  const between = fc.tuple(ints, ints, ints).map(([x, low, high]) => ({
    node: betweenNode(x.node, low.node, high.node),
    value: x.value >= low.value && x.value <= high.value,
  }));
  const leaf = fc.oneof(
    comparison,
    between,
    fc.boolean().map((b) => ({ node: literalNode(b), value: b })),
  );
  if (depth === 0) return leaf;
  const inner = boolean(depth - 1);
  return fc.oneof(
    leaf,
    fc
      .tuple(
        fc.constantFrom("and", "or") as fc.Arbitrary<"and" | "or">,
        fc.array(inner, { minLength: 2, maxLength: 3 }),
      )
      .map(([op, args]) => ({
        node: naryNode(
          op,
          args.map((a) => a.node),
        ),
        value: op === "and" ? args.every((a) => a.value) : args.some((a) => a.value),
      })),
    inner.map((a) => ({ node: unaryNode("not", a.node), value: !a.value })),
    fc
      .tuple(inner, inner)
      .map(([a, b]) => ({ node: binaryNode("eq", a.node, b.node), value: a.value === b.value })),
  );
}

let handle: TestDatabaseHandle;

beforeAll(async () => {
  handle = await createTestDatabase("postgres", { label: "precedence" });
});

afterAll(async () => {
  await handle?.drop();
});

test("Postgres evaluates every emitted expression as it was built", async () => {
  const compiler = createCompiler(postgresDialect);
  const one = bareQuery({ kind: "values", columns: ["x"], rows: [[literalNode(1)]], alias: "v" });
  await fc.assert(
    fc.asyncProperty(boolean(3), integer(3), async (condition, number) => {
      const ast = rebuild(one, { select: selectObject({ b: condition.node, n: number.node }) });
      const plan = compiler.compile(ast, "all", undefined);
      const rows = await handle.db.query(plan.sql, []);
      // `+ 0` turns JavaScript's -0 into 0; the database has no negative zero for integers.
      expect(rows).toEqual([{ c0: condition.value, c1: number.value + 0 }]);
    }),
    { numRuns: 300 },
  );
});
