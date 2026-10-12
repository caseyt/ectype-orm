// Type tests for the query AST contract: a real query is written out as data, and the
// node unions are checked to discriminate, to be read-only and to reject wrong shapes.
import { describe, expectTypeOf, test } from "vitest";
import type {
  AggregateNode,
  BinaryNode,
  BoolNode,
  ClauseNode,
  ColumnNode,
  ExprKind,
  ExprNode,
  FragmentNode,
  JoinNode,
  ListNode,
  LiteralNode,
  NamedParamNode,
  OrderNode,
  ParamNode,
  QueryAst,
  QueryNode,
  SelectShape,
  SourceNode,
  TableSourceNode,
} from "./query.js";
import type { SchemaMeta } from "./schema.js";
import type { AnyEctoType } from "./type.js";

declare const userMeta: SchemaMeta;
declare const postMeta: SchemaMeta;
declare const integerType: AnyEctoType;

const EMPTY: Omit<QueryAst, "from"> = {
  kind: "query",
  joins: [],
  wheres: [],
  select: undefined,
  distinct: undefined,
  groupBys: [],
  havings: [],
  orderBys: [],
  limit: undefined,
  offset: undefined,
  lock: undefined,
  combinations: [],
  ctes: [],
  windows: [],
  preloads: [],
  updates: [],
  prefix: undefined,
  hints: [],
  params: [],
  shape: 0,
};

const col = (binding: string, field: string, column: string): ColumnNode => ({
  kind: "column",
  binding,
  field,
  column,
});
const param = (value: unknown, type?: AnyEctoType): ParamNode => ({ kind: "param", value, type });

describe("QueryAst", () => {
  test("expresses the reference query of the plan as plain data", () => {
    // SELECT u.id AS c0, count(p.id) AS c1 FROM users u JOIN posts p ON p.author_id = u.id
    // WHERE u.age >= $1 AND p.published GROUP BY u.id ORDER BY u.inserted_at DESC LIMIT $2
    const users: TableSourceNode = {
      kind: "table",
      source: "users",
      meta: userMeta,
      prefix: undefined,
      alias: "u",
    };
    const posts: TableSourceNode = {
      kind: "table",
      source: "posts",
      meta: postMeta,
      prefix: undefined,
      alias: "p",
    };
    const count: AggregateNode = {
      kind: "aggregate",
      name: "count",
      args: [col("p", "id", "id")],
      distinct: false,
      filter: undefined,
      over: undefined,
    };
    const ast: QueryAst = {
      ...EMPTY,
      from: users,
      joins: [
        {
          kind: "join",
          type: "inner",
          source: posts,
          on: {
            kind: "binary",
            op: "eq",
            left: col("p", "authorId", "author_id"),
            right: col("u", "id", "id"),
          },
        },
      ],
      wheres: [
        {
          kind: "bool",
          op: "and",
          expr: { kind: "binary", op: "gte", left: col("u", "age", "age"), right: param(18, integerType) },
        },
        { kind: "bool", op: "and", expr: col("p", "published", "published") },
      ],
      select: {
        kind: "select",
        shape: {
          kind: "object",
          keys: ["id", "posts"],
          values: [
            { kind: "expr", expr: col("u", "id", "id"), type: integerType },
            { kind: "expr", expr: count, type: integerType },
          ],
        },
      },
      groupBys: [col("u", "id", "id")],
      orderBys: [
        { kind: "order", expr: col("u", "insertedAt", "inserted_at"), direction: "desc", nulls: undefined },
      ],
      limit: param(10, integerType),
      params: [18, 10],
      shape: 123,
    };
    expectTypeOf(ast.wheres[0]!.expr).toEqualTypeOf<ExprNode>();
    expectTypeOf(ast.params).toEqualTypeOf<readonly unknown[]>();
    expectTypeOf(ast).not.toBeAny();
  });

  test("requires every clause, so that all queries have one shape", () => {
    const users: TableSourceNode = {
      kind: "table",
      source: "users",
      meta: undefined,
      prefix: undefined,
      alias: "u",
    };
    // @ts-expect-error params and shape are missing
    const partial: QueryAst = { kind: "query", from: users, joins: [], wheres: [] };
    // @ts-expect-error an absent clause is undefined, never left out
    const noLimit: QueryAst = { ...EMPTY, from: users, limit: null };
    void [partial, noLimit];
  });

  test("is read-only all the way down", () => {
    const ast = {} as QueryAst;
    // @ts-expect-error clauses are replaced, not mutated
    ast.wheres.push({ kind: "bool", op: "and", expr: param(1) });
    // @ts-expect-error read-only
    ast.limit = undefined;
    // @ts-expect-error read-only
    ast.params[0] = 1;
    const node = {} as BinaryNode;
    // @ts-expect-error read-only
    node.op = "eq";
  });

  test("nests: subqueries, CTEs and combinations hold whole queries", () => {
    const inner = {} as QueryAst;
    const outer: QueryAst = {
      ...EMPTY,
      from: { kind: "subquerySource", query: inner, alias: "s" },
      wheres: [{ kind: "bool", op: "and", expr: { kind: "exists", query: inner } }],
      combinations: [{ kind: "combination", op: "union", all: true, query: inner }],
      ctes: [{ kind: "cte", name: "recent", query: inner, recursive: false, materialized: undefined }],
      preloads: [{ kind: "preload", assoc: "posts", from: undefined, query: inner, nested: [] }],
    };
    void outer;
  });
});

describe("ExprNode", () => {
  test("discriminates on kind", () => {
    const node = {} as ExprNode;
    if (node.kind === "param") expectTypeOf(node).toEqualTypeOf<ParamNode>();
    if (node.kind === "list") expectTypeOf(node.value).toEqualTypeOf<readonly unknown[]>();
    if (node.kind === "binary") expectTypeOf(node.left).toEqualTypeOf<ExprNode>();
    if (node.kind === "column") expectTypeOf(node.column).toEqualTypeOf<string>();
    if (node.kind === "literal") expectTypeOf(node.value).toEqualTypeOf<null | boolean | number>();
    if (node.kind === "namedParam") expectTypeOf(node).toEqualTypeOf<NamedParamNode>();
    expectTypeOf(node).not.toBeAny();
  });

  test("a switch over every kind is exhaustive", () => {
    function isLeaf(node: ExprNode): boolean {
      switch (node.kind) {
        case "column":
        case "param":
        case "namedParam":
        case "list":
        case "literal":
        case "ident":
        case "star":
          return true;
        case "unary":
        case "binary":
        case "nary":
        case "fn":
        case "aggregate":
        case "fragment":
        case "cast":
        case "case":
        case "jsonPath":
        case "subquery":
        case "exists":
        case "tuple":
        case "selectedAs":
          return false;
        default:
          expectTypeOf(node).toBeNever();
          return false;
      }
    }
    void isLeaf;
    expectTypeOf<ExprKind>().toEqualTypeOf<
      | "column"
      | "param"
      | "namedParam"
      | "list"
      | "literal"
      | "unary"
      | "binary"
      | "nary"
      | "fn"
      | "aggregate"
      | "ident"
      | "fragment"
      | "cast"
      | "case"
      | "jsonPath"
      | "subquery"
      | "exists"
      | "tuple"
      | "selectedAs"
      | "star"
    >();
  });

  test("a value can only live in a param or a list node (decision D9)", () => {
    // @ts-expect-error a string literal cannot be inlined
    const text: LiteralNode = { kind: "literal", value: "admin" };
    // @ts-expect-error a binary node takes nodes, not values
    const raw: BinaryNode = { kind: "binary", op: "eq", left: col("u", "role", "role"), right: "admin" };
    // @ts-expect-error a fragment interpolates nodes, not values
    const fragment: FragmentNode = { kind: "fragment", strings: ["lower(", ")"], args: ["x"] };
    // @ts-expect-error a list holds an array
    const list: ListNode = { kind: "list", value: "a,b", type: undefined };
    void [text, raw, fragment, list];
  });

  test("operators come from the fixed tables", () => {
    // @ts-expect-error not an operator name; in particular not SQL text
    const sql: BinaryNode = { kind: "binary", op: ">=", left: param(1), right: param(2) };
    // @ts-expect-error not a unary operator
    const unary: ExprNode = { kind: "unary", op: "exists", operand: param(1) };
    // @ts-expect-error no such node kind
    const unknown: ExprNode = { kind: "raw", sql: "1 = 1" };
    void [sql, unary, unknown];
  });

  test("optional parts are present and undefined, not absent", () => {
    // @ts-expect-error type must be given, even as undefined
    const bare: ParamNode = { kind: "param", value: 1 };
    // @ts-expect-error nulls must be given, even as undefined
    const order: OrderNode = { kind: "order", expr: param(1), direction: "asc" };
    void [bare, order];
  });
});

describe("clause nodes", () => {
  test("every source has an alias and discriminates on kind", () => {
    const source = {} as SourceNode;
    expectTypeOf(source.alias).toEqualTypeOf<string>();
    if (source.kind === "table") expectTypeOf(source.meta).toEqualTypeOf<SchemaMeta | undefined>();
    if (source.kind === "subquerySource") expectTypeOf(source.query).toEqualTypeOf<QueryAst>();
    if (source.kind === "values") expectTypeOf(source.rows).toEqualTypeOf<readonly (readonly ExprNode[])[]>();
  });

  test("joins, wheres and select shapes take only their own values", () => {
    // @ts-expect-error not a join type
    const join: JoinNode = { kind: "join", type: "outer", source: {} as SourceNode, on: undefined };
    // @ts-expect-error a where is tagged and/or
    const bool: BoolNode = { kind: "bool", op: "not", expr: param(true) };
    // @ts-expect-error an object shape needs keys and values
    const shape: SelectShape = { kind: "object", values: [] };
    void [join, bool, shape];
  });

  test("a select shape nests objects, tuples, whole bindings and expressions", () => {
    const shape: SelectShape = {
      kind: "object",
      keys: ["author", "pair"],
      values: [
        { kind: "binding", binding: "u", meta: userMeta },
        {
          kind: "tuple",
          items: [
            { kind: "expr", expr: col("u", "id", "id"), type: integerType },
            { kind: "expr", expr: col("p", "title", "title"), type: undefined },
          ],
        },
      ],
    };
    if (shape.kind === "object") expectTypeOf(shape.values).toEqualTypeOf<readonly SelectShape[]>();
  });

  test("every node has a string kind", () => {
    expectTypeOf<QueryNode["kind"]>().toBeString();
    expectTypeOf<ClauseNode["kind"]>().toBeString();
    expectTypeOf<QueryNode>().not.toBeAny();
  });
});
