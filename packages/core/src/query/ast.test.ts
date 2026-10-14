// Unit tests for the AST module: node constructors, the canonical parameter walk over
// every node kind and over a whole query, and the shape hash of every node kind.
import { Post, User } from "@egon-orm/test-support";
import { describe, expect, test } from "vitest";
import type {
  ExprNode,
  FragmentNode,
  QueryAst,
  QueryNode,
  SelectShape,
  TableSourceNode,
} from "../contracts/query.js";
import { QueryError } from "../errors.js";
import { HASH_SEED } from "../internal/hash.js";
import { meta } from "../schema/index.js";
import { booleanType, integerType, stringType } from "../types/index.js";
import {
  AGGREGATE_NAMES,
  aggregateNode,
  betweenNode,
  binaryNode,
  caseNode,
  castNode,
  clauseListShape,
  collectParams,
  columnNode,
  combineQueryShape,
  existsNode,
  FUNCTION_NAMES,
  fnNode,
  foldShape,
  fragmentNode,
  IDENTIFIER,
  identNode,
  jsonPathNode,
  listNode,
  literalNode,
  namedParamNode,
  naryNode,
  optionalNodeShape,
  orderNode,
  paramNode,
  QUERY_SHAPE_PROPERTIES,
  queryPropertyShapes,
  STAR,
  selectedAsNode,
  shapeOf,
  shapeOfSelect,
  subqueryNode,
  tupleNode,
  unaryNode,
  windowNode,
} from "./ast.js";
import { emptyQuery, finish, show } from "./expr-fixtures.js";

const int = integerType();
const text = stringType();
const users: TableSourceNode = {
  kind: "table",
  source: "users",
  meta: meta(User),
  schema: undefined,
  alias: "u",
};
const posts: TableSourceNode = {
  kind: "table",
  source: "posts",
  meta: meta(Post),
  schema: undefined,
  alias: "p",
};
const age = columnNode("u", "age", "age");
const id = columnNode("u", "id", "id");
/** A parameter whose value names its position in canonical order. */
const v = (n: number): ExprNode => paramNode(`v${n}`, int, false);

function params(node: QueryNode): unknown[] {
  const out: unknown[] = [];
  collectParams(node, out);
  return out;
}

describe("constructors", () => {
  test("assign every property, in the order the contract declares them", () => {
    const keys = (node: object) => Object.keys(node).join(",");
    expect(keys(columnNode("u", "a", "a"))).toBe("kind,binding,field,column");
    expect(keys(paramNode(1, undefined, false))).toBe("kind,value,type,redact");
    expect(keys(namedParamNode("a", undefined, false))).toBe("kind,name,type,redact");
    expect(keys(listNode([1], undefined, false))).toBe("kind,value,type,redact");
    expect(keys(literalNode(1))).toBe("kind,value");
    expect(keys(unaryNode("not", age))).toBe("kind,op,operand");
    expect(keys(binaryNode("eq", age, age))).toBe("kind,op,left,right");
    expect(keys(betweenNode(age, age, age))).toBe("kind,expr,low,high");
    expect(keys(naryNode("and", []))).toBe("kind,op,args");
    expect(keys(fnNode("lower", []))).toBe("kind,name,args");
    expect(keys(aggregateNode("count", [STAR], false, undefined, undefined))).toBe(
      "kind,name,args,distinct,filter,over",
    );
    expect(keys(windowNode([], [], undefined))).toBe("kind,partitionBy,orderBy,frame");
    expect(keys(identNode("a"))).toBe("kind,name");
    expect(keys(fragmentNode(["a"], []))).toBe("kind,strings,args");
    expect(keys(castNode(age, int))).toBe("kind,expr,type");
    expect(keys(caseNode([], undefined))).toBe("kind,whens,else");
    expect(keys(jsonPathNode(age, [], false))).toBe("kind,expr,path,asText");
    expect(keys(subqueryNode(emptyQuery(users)))).toBe("kind,query");
    expect(keys(existsNode(emptyQuery(users)))).toBe("kind,query");
    expect(keys(tupleNode([]))).toBe("kind,items");
    expect(keys(selectedAsNode("a", undefined))).toBe("kind,name,expr");
    expect(keys(STAR)).toBe("kind");
    expect(keys(orderNode(age, "asc", undefined))).toBe("kind,expr,direction,nulls");
  });

  test("literalNode takes only the kinds that are safe as SQL text", () => {
    expect(literalNode(null).value).toBeNull();
    expect(literalNode(false).value).toBe(false);
    expect(literalNode(-0.5).value).toBe(-0.5);
    for (const value of ["1", Number.NaN, Number.NEGATIVE_INFINITY, undefined, {}]) {
      expect(() => literalNode(value as never)).toThrow(QueryError);
    }
  });

  test("identNode checks the identifier pattern", () => {
    expect(identNode("search_vector").name).toBe("search_vector");
    expect(() => identNode('x"; drop table users; --')).toThrow(QueryError);
    expect(IDENTIFIER.test("a$1")).toBe(true);
    expect(IDENTIFIER.test("$a")).toBe(false);
  });

  test("the function and aggregate names are table keys, not SQL", () => {
    expect([...FUNCTION_NAMES]).toEqual(["lower", "upper", "coalesce", "now", "arrayAppend", "arrayRemove"]);
    expect([...AGGREGATE_NAMES]).toEqual([
      "count",
      "sum",
      "avg",
      "min",
      "max",
      "arrayAgg",
      "jsonAgg",
      "stringAgg",
    ]);
  });
});

/** One node of every expression kind, holding params v1 … in canonical order. */
function everyExpression(): ExprNode {
  const fragment: FragmentNode = fragmentNode(["f(", ", ", ")"], [v(16), identNode("x")]);
  return naryNode("and", [
    unaryNode("not", binaryNode("eq", age, v(1))),
    betweenNode(age, v(2), v(3)),
    binaryNode("in", id, listNode(["v4a", "v4b"], int, false)),
    fnNode("coalesce", [columnNode("u", "name", "name"), v(5)]),
    aggregateNode(
      "sum",
      [v(6)],
      true,
      v(7),
      windowNode([v(8)], [orderNode(v(9), "desc", "last")], fragmentNode(["ROWS ", ""], [v(10)])),
    ),
    aggregateNode("count", [STAR], false, undefined, "w"),
    castNode(v(11), text),
    caseNode(
      [
        { when: v(12), result: v(13) },
        { when: v(14), result: namedParamNode("named", int, false) },
      ],
      v(15),
    ),
    fragment,
    jsonPathNode(columnNode("u", "settings", "settings"), [v(17), v(18)], true),
    subqueryNode(finishedSubquery(19)),
    existsNode(finishedSubquery(20)),
    tupleNode([v(21), literalNode(1)]),
    selectedAsNode("total", v(22)),
    selectedAsNode("total", undefined),
  ]);
}

function finishedSubquery(n: number): QueryAst {
  return finish({ ...emptyQuery(posts), wheres: [{ kind: "bool", op: "and", expr: v(n) }] });
}

const EXPECTED = [
  "v1",
  "v2",
  "v3",
  ["v4a", "v4b"],
  "v5",
  "v6",
  "v7",
  "v8",
  "v9",
  "v10",
  "v11",
  "v12",
  "v13",
  "v14",
  "v15",
  "v16",
  "v17",
  "v18",
  "v19",
  "v20",
  "v21",
  "v22",
];

describe("collectParams", () => {
  test("visits every expression kind depth first, in declaration order", () => {
    const lists: number[] = [];
    const out: unknown[] = [];
    collectParams(everyExpression(), out, lists);
    expect(out).toEqual(EXPECTED);
    expect(lists).toEqual([2]);
  });

  test("works without a lists array", () => {
    expect(params(listNode([1, 2], undefined, false))).toEqual([[1, 2]]);
  });

  test("visits a whole query in the order of its properties, skipping preloads", () => {
    const shape: SelectShape = {
      kind: "object",
      keys: ["a", "b", "c", "d"],
      values: [
        { kind: "expr", expr: v(5), type: undefined },
        { kind: "binding", binding: "u", meta: meta(User) },
        { kind: "constant", index: 0 },
        { kind: "tuple", items: [{ kind: "expr", expr: v(6), type: undefined }] },
      ],
    };
    const ast: QueryAst = {
      ...emptyQuery(users),
      joins: [
        { kind: "join", type: "left", source: posts, on: v(1) },
        {
          kind: "join",
          type: "cross",
          source: { kind: "subquerySource", query: finishedSubquery(2), alias: "s" },
          on: undefined,
        },
        {
          kind: "join",
          type: "inner",
          source: { kind: "values", columns: ["a"], rows: [[v(3)]], alias: "vv" },
          on: undefined,
        },
      ],
      wheres: [{ kind: "bool", op: "and", expr: v(4) }],
      select: { kind: "select", shape, constants: ["not a param"] },
      distinct: { kind: "distinct", on: [v(7)] },
      groupBys: [v(8)],
      havings: [{ kind: "bool", op: "or", expr: v(9) }],
      orderBys: [orderNode(v(10), "asc", undefined)],
      limit: v(11),
      offset: v(12),
      lock: { kind: "lock", clause: fragmentNode(["FOR UPDATE OF ", ""], [v(13)]) },
      combinations: [{ kind: "combination", op: "union", all: false, query: finishedSubquery(14) }],
      ctes: [
        {
          kind: "cte",
          name: "c",
          query: finishedSubquery(15),
          operation: "all",
          recursive: false,
          materialized: undefined,
        },
        {
          kind: "cte",
          name: "f",
          query: fragmentNode(["SELECT ", ""], [v(16)]),
          operation: "all",
          recursive: false,
          materialized: true,
        },
      ],
      windows: [{ kind: "windowDef", name: "w", spec: windowNode([v(17)], [], undefined) }],
      preloads: [
        { kind: "preload", assoc: "posts", from: undefined, query: finishedSubquery(99), nested: [] },
      ],
      updates: [{ kind: "update", field: "age", column: "age", value: v(18) }],
      hints: [fragmentNode(["USE INDEX (", ")"], [v(19)])],
    };
    expect(params(ast)).toEqual(Array.from({ length: 19 }, (_, i) => `v${i + 1}`));
    const fragmentSource: QueryNode = {
      kind: "fragmentSource",
      fragment: fragmentNode(["generate_series(", ")"], [v(1)]),
      columns: ["n"],
      alias: "g",
    };
    expect(params(fragmentSource)).toEqual(["v1"]);
    expect(params({ kind: "cteSource", name: "c", meta: undefined, alias: "t" })).toEqual([]);
    expect(params({ kind: "lock", clause: "FOR UPDATE" })).toEqual([]);
    expect(
      params({ kind: "preload", assoc: "posts", from: undefined, query: finishedSubquery(1), nested: [] }),
    ).toEqual([]);
  });

  test("a finished query's params are what the walk collects", () => {
    const ast = finish({
      ...emptyQuery(users),
      wheres: [{ kind: "bool", op: "and", expr: everyExpression() }],
    });
    expect(ast.params).toEqual(EXPECTED);
    expect(ast.listLengths).toEqual([2]);
  });
});

describe("shapeOf", () => {
  test("ignores parameter values and list lengths", () => {
    const a = shapeOf(binaryNode("in", id, listNode([1], int, false)));
    const b = shapeOf(binaryNode("in", id, listNode([1, 2, 3], int, false)));
    expect(a).toBe(b);
    expect(shapeOf(paramNode(1, int, false))).toBe(shapeOf(paramNode("other", int, false)));
  });

  test("tells apart a parameter's type and redaction", () => {
    const shapes = new Set([
      shapeOf(paramNode(1, int, false)),
      shapeOf(paramNode(1, text, false)),
      shapeOf(paramNode(1, undefined, false)),
      shapeOf(paramNode(1, int, true)),
      shapeOf(listNode([1], int, false)),
      shapeOf(listNode([1], int, true)),
      shapeOf(namedParamNode("a", int, false)),
      shapeOf(namedParamNode("a", int, true)),
      shapeOf(namedParamNode("b", int, false)),
      shapeOf(namedParamNode("a", undefined, false)),
    ]);
    expect(shapes.size).toBe(10);
  });

  test("gives every expression kind its own shape", () => {
    const nodes: ExprNode[] = [
      age,
      columnNode("u", "age", "years"),
      columnNode("x", "age", "age"),
      v(1),
      literalNode(1),
      literalNode(2),
      literalNode(true),
      literalNode(false),
      literalNode(null),
      unaryNode("not", age),
      unaryNode("neg", age),
      binaryNode("eq", age, age),
      binaryNode("neq", age, age),
      betweenNode(age, age, age),
      naryNode("and", [age, age]),
      naryNode("or", [age, age]),
      naryNode("and", [age, age, age]),
      fnNode("lower", [age]),
      fnNode("upper", [age]),
      aggregateNode("count", [age], false, undefined, undefined),
      aggregateNode("count", [age], true, undefined, undefined),
      aggregateNode("count", [age], false, age, undefined),
      aggregateNode("count", [age], false, undefined, "w"),
      aggregateNode("count", [age], false, undefined, windowNode([], [], undefined)),
      aggregateNode("count", [age], false, undefined, windowNode([age], [], undefined)),
      aggregateNode(
        "count",
        [age],
        false,
        undefined,
        windowNode([], [orderNode(age, "asc", undefined)], undefined),
      ),
      aggregateNode("count", [age], false, undefined, windowNode([], [], fragmentNode(["ROWS 1"], []))),
      identNode("a"),
      fragmentNode(["a"], []),
      fragmentNode(["a", ""], [age]),
      castNode(age, int),
      castNode(age, text),
      caseNode([{ when: age, result: age }], undefined),
      caseNode([{ when: age, result: age }], age),
      jsonPathNode(age, [v(1)], false),
      jsonPathNode(age, [v(1)], true),
      jsonPathNode(age, [v(1), v(2)], false),
      subqueryNode(finishedSubquery(1)),
      existsNode(finishedSubquery(1)),
      tupleNode([age]),
      selectedAsNode("a", undefined),
      selectedAsNode("a", age),
      STAR,
    ];
    expect(new Set(nodes.map(shapeOf)).size).toBe(nodes.length);
  });

  test("gives every clause kind its own shape", () => {
    const sub = finishedSubquery(1);
    const nodes: QueryNode[] = [
      orderNode(age, "asc", undefined),
      orderNode(age, "desc", undefined),
      orderNode(age, "asc", "first"),
      orderNode(age, "asc", "last"),
      users,
      { ...users, alias: "v" },
      { ...users, schema: "tenant_1" },
      { ...users, meta: undefined },
      { ...users, meta: meta(Post) },
      { kind: "cteSource", name: "tree", meta: undefined, alias: "t" },
      { kind: "cteSource", name: "tree", meta: meta(User), alias: "t" },
      { kind: "subquerySource", query: sub, alias: "s" },
      { kind: "values", columns: ["a"], rows: [[v(1)]], alias: "vv" },
      { kind: "values", columns: ["a"], rows: [[v(1)], [v(2)]], alias: "vv" },
      { kind: "fragmentSource", fragment: fragmentNode(["g()"], []), columns: ["n"], alias: "g" },
      { kind: "join", type: "left", source: posts, on: age },
      { kind: "join", type: "inner", source: posts, on: age },
      { kind: "join", type: "cross", source: posts, on: undefined },
      { kind: "bool", op: "and", expr: age },
      { kind: "bool", op: "or", expr: age },
      { kind: "select", shape: { kind: "expr", expr: age, type: undefined }, constants: [] },
      { kind: "select", shape: { kind: "expr", expr: age, type: int }, constants: [] },
      { kind: "distinct", on: [] },
      { kind: "distinct", on: [age] },
      { kind: "lock", clause: "FOR UPDATE" },
      { kind: "lock", clause: "FOR SHARE" },
      { kind: "lock", clause: fragmentNode(["FOR UPDATE"], []) },
      { kind: "combination", op: "union", all: false, query: sub },
      { kind: "combination", op: "union", all: true, query: sub },
      { kind: "combination", op: "except", all: false, query: sub },
      { kind: "cte", name: "c", query: sub, operation: "all", recursive: false, materialized: undefined },
      { kind: "cte", name: "c", query: sub, operation: "all", recursive: true, materialized: undefined },
      { kind: "cte", name: "c", query: sub, operation: "all", recursive: false, materialized: true },
      { kind: "cte", name: "c", query: sub, operation: "all", recursive: false, materialized: false },
      {
        kind: "cte",
        name: "c",
        query: sub,
        operation: "deleteAll",
        recursive: false,
        materialized: undefined,
      },
      { kind: "windowDef", name: "w", spec: windowNode([], [], undefined) },
      { kind: "preload", assoc: "posts", from: undefined, query: undefined, nested: [] },
      { kind: "preload", assoc: "posts", from: "p", query: undefined, nested: [] },
      { kind: "update", field: "age", column: "age", value: age },
      { kind: "update", field: "age", column: "years", value: age },
      emptyQuery(users),
    ];
    expect(new Set(nodes.map(shapeOf)).size).toBe(nodes.length);
  });

  test("ignores what never reaches SQL: select constants and a preload's query", () => {
    const constants = (values: unknown[]) =>
      shapeOf({ kind: "select", shape: { kind: "constant", index: 0 }, constants: values });
    expect(constants(["user"])).toBe(constants(["admin"]));
    const preload = (n: number) =>
      shapeOf({ kind: "preload", assoc: "posts", from: undefined, query: finishedSubquery(n), nested: [] });
    expect(preload(1)).toBe(preload(2));
    expect(
      shapeOf({ kind: "preload", assoc: "posts", from: undefined, query: undefined, nested: [] }),
    ).not.toBe(
      shapeOf({
        kind: "preload",
        assoc: "posts",
        from: undefined,
        query: undefined,
        nested: [{ kind: "preload", assoc: "comments", from: undefined, query: undefined, nested: [] }],
      }),
    );
  });

  test("tells select shapes apart, including a binding's schema", () => {
    const shapes: SelectShape[] = [
      { kind: "expr", expr: age, type: undefined },
      { kind: "binding", binding: "u", meta: meta(User) },
      { kind: "binding", binding: "u", meta: meta(Post) },
      { kind: "binding", binding: "x", meta: meta(User) },
      { kind: "constant", index: 0 },
      { kind: "object", keys: ["a"], values: [{ kind: "constant", index: 0 }] },
      { kind: "object", keys: ["b"], values: [{ kind: "constant", index: 0 }] },
      { kind: "tuple", items: [{ kind: "constant", index: 0 }] },
      { kind: "tuple", items: [] },
    ];
    expect(new Set(shapes.map(shapeOfSelect)).size).toBe(shapes.length);
  });

  test("a query's shape is its property shapes combined, so a builder can keep them", () => {
    const ast = finish({
      ...emptyQuery(users),
      wheres: [
        { kind: "bool", op: "and", expr: binaryNode("gte", age, v(1)) },
        { kind: "bool", op: "or", expr: binaryNode("lt", age, v(2)) },
      ],
      limit: v(3),
      schema: "tenant_1",
    });
    expect(QUERY_SHAPE_PROPERTIES).toHaveLength(18);
    const properties = queryPropertyShapes(ast);
    expect(properties).toHaveLength(QUERY_SHAPE_PROPERTIES.length);
    expect(combineQueryShape(properties)).toBe(ast.shape);
    // Adding a clause extends one property by one fold.
    const [first, second] = ast.wheres;
    expect(properties[2]).toBe(foldShape(clauseListShape([first!]), shapeOf(second!)));
    expect(clauseListShape([])).toBe(HASH_SEED);
    expect(properties[8]).toBe(optionalNodeShape(ast.limit));
    // The database schema and the order of clauses count.
    expect(shapeOf({ ...ast, schema: undefined })).not.toBe(ast.shape);
    expect(shapeOf({ ...ast, wheres: [second!, first!] })).not.toBe(ast.shape);
    // Values do not.
    expect(shapeOf({ ...ast, limit: paramNode(1000, int, false) })).toBe(ast.shape);
  });

  test("a whole query's shape includes nested queries' structure but not their values", () => {
    const outer = (n: number, op: "gt" | "lt") =>
      finish({
        ...emptyQuery(users),
        wheres: [
          {
            kind: "bool",
            op: "and",
            expr: existsNode(
              finish({
                ...emptyQuery(posts),
                wheres: [{ kind: "bool", op: "and", expr: binaryNode(op, age, paramNode(n, int, false)) }],
              }),
            ),
          },
        ],
      });
    expect(outer(1, "gt").shape).toBe(outer(2, "gt").shape);
    expect(outer(1, "gt").shape).not.toBe(outer(1, "lt").shape);
  });
});

describe("the test printer", () => {
  test("renders every kind", () => {
    expect(show(undefined)).toBe("_");
    expect(show(literalNode(null))).toBe("NULL");
    expect(show(literalNode(2))).toBe("2");
    expect(show(tupleNode([age, STAR]))).toBe("(tuple u.age *)");
    expect(show(selectedAsNode("n", age))).toBe("(as n u.age)");
    expect(show(paramNode(1n, booleanType(), true))).toBe("$1n:boolean!");
    expect(show({ kind: "bool", op: "and", expr: age })).toBe("bool");
    expect(show(users)).toBe("users u");
    expect(
      show(
        aggregateNode("count", [STAR], false, undefined, windowNode([], [], fragmentNode(["ROWS 1"], []))),
      ),
    ).toBe('count(*) OVER(partition [] order [] frame fragment["ROWS 1"])');
  });
});
