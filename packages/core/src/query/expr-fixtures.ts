// Test fixtures for the query expression tests: columns of the blog schemas, a compact
// printer for AST nodes (the unit tests snapshot nodes, not SQL), and a hand-built query
// that stands in for the query builder of step 08 wherever a subquery is needed.
// Imported by tests only.
import type {
  ExprNode,
  NamedParamNode,
  QueryAst,
  QueryNode,
  TableSourceNode,
  WindowNode,
} from "../contracts/query.js";
import type { AnySchema, FieldNames, Row } from "../contracts/schema.js";
import { meta } from "../schema/index.js";
import {
  binaryNode,
  collectParams,
  columnNode,
  paramNode,
  shapeOf,
  shapeOfSubquery,
  subqueryNode,
} from "./ast.js";
import { AS_SUBQUERY, Col, Expr, type NoParams, type SubqueryOperand } from "./expr.js";

/** The columns of a binding, as the query builder will hand them to callbacks. */
export type Columns<S extends AnySchema> = {
  readonly [K in FieldNames<S>]: Col<K extends keyof Row<S> ? Row<S>[K] : never>;
};

/** One column per field of `schema`, under `alias`. */
export function columns<S extends AnySchema>(schema: S, alias: string): Columns<S> {
  const out: Record<string, Col<unknown>> = {};
  for (const field of meta(schema).fields) out[field.name] = new Col(alias, field);
  return out as Columns<S>;
}

function value(v: unknown): string {
  if (v instanceof Date) return `Date(${v.toISOString()})`;
  if (typeof v === "bigint") return `${v}n`;
  return JSON.stringify(v);
}

function typed(type: { readonly name: string } | undefined, redact: boolean): string {
  return `${type === undefined ? "" : `:${type.name}`}${redact ? "!" : ""}`;
}

function showWindow(window: WindowNode | string | undefined): string {
  if (window === undefined) return "";
  if (typeof window === "string") return ` OVER ${window}`;
  return ` OVER(${show(window)})`;
}

/**
 * A compact, readable rendering of a node: `(gte u.age $18:integer)`. Parameters show their
 * value, their type after `:` and `!` when redacted; the value is shown so that tests can
 * check where it went, not because it is ever SQL.
 */
export function show(node: QueryNode | undefined): string {
  if (node === undefined) return "_";
  switch (node.kind) {
    case "column":
      return `${node.binding}.${node.column}`;
    case "param":
      return `$${value(node.value)}${typed(node.type, node.redact)}`;
    case "namedParam":
      return `:${node.name}${typed(node.type, node.redact)}`;
    case "list":
      return `$[${node.value.map(value).join(",")}]${typed(node.type, node.redact)}`;
    case "literal":
      return node.value === null
        ? "NULL"
        : typeof node.value === "boolean"
          ? node.value
            ? "TRUE"
            : "FALSE"
          : String(node.value);
    case "unary":
      return `(${node.op} ${show(node.operand)})`;
    case "binary":
      return `(${node.op} ${show(node.left)} ${show(node.right)})`;
    case "between":
      return `(between ${show(node.expr)} ${show(node.low)} ${show(node.high)})`;
    case "nary":
      return `(${[node.op, ...node.args.map(show)].join(" ")})`;
    case "fn":
      return `${node.name}(${node.args.map(show).join(", ")})`;
    case "aggregate":
      return `${node.name}(${node.distinct ? "DISTINCT " : ""}${node.args.map(show).join(", ")})${
        node.filter === undefined ? "" : ` FILTER ${show(node.filter)}`
      }${showWindow(node.over)}`;
    case "window":
      return `partition [${node.partitionBy.map(show).join(", ")}] order [${node.orderBy.map(show).join(", ")}]${
        node.frame === undefined ? "" : ` frame ${show(node.frame)}`
      }`;
    case "ident":
      return `#${node.name}`;
    case "fragment":
      return `fragment[${node.strings.map((text, i) => (i === 0 ? JSON.stringify(text) : `${show(node.args[i - 1])} ${JSON.stringify(text)}`)).join(" ")}]`;
    case "cast":
      return `(cast ${show(node.expr)} :${node.type.name})`;
    case "case":
      return `(case ${node.whens.map((branch) => `(when ${show(branch.when)} ${show(branch.result)})`).join(" ")}${
        node.else === undefined ? "" : ` (else ${show(node.else)})`
      })`;
    case "jsonPath":
      return `(${node.asText ? "#>>" : "#>"} ${show(node.expr)} ${node.path.map(show).join(" ")})`;
    case "subquery":
      return `(subquery from ${show(node.query.from)})`;
    case "exists":
      return `(exists from ${show(node.query.from)})`;
    case "tuple":
      return `(tuple ${node.items.map(show).join(" ")})`;
    case "selectedAs":
      return `(as ${node.name} ${show(node.expr)})`;
    case "star":
      return "*";
    case "order":
      return `(${node.direction} ${show(node.expr)}${node.nulls === undefined ? "" : ` nulls ${node.nulls}`})`;
    case "table":
      return `${node.source} ${node.alias}`;
    default:
      return node.kind;
  }
}

/** A query with every top-level property at its empty value. */
export function emptyQuery(from: TableSourceNode): QueryAst {
  return {
    kind: "query",
    from,
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
    schema: undefined,
    hints: [],
    params: [],
    listLengths: [],
    shape: 0,
  };
}

/** Fills in `params`, `listLengths` and `shape` the way a builder must. */
export function finish(ast: QueryAst): QueryAst {
  const params: unknown[] = [];
  const listLengths: number[] = [];
  collectParams(ast, params, listLengths);
  const done = { ...ast, params, listLengths, shape: 0 };
  return { ...done, shape: shapeOf(done) };
}

/**
 * `SELECT sp.author_id FROM posts sp WHERE sp.views > $1`: a stand-in for a query of step 08,
 * usable as a subquery operand.
 */
export function postsByViews(minViews: number): QueryAst {
  const from: TableSourceNode = {
    kind: "table",
    source: "posts",
    meta: undefined,
    schema: undefined,
    alias: "sp",
  };
  const where: ExprNode = binaryNode(
    "gt",
    columnNode("sp", "views", "views"),
    paramNode(minViews, undefined, false),
  );
  return finish({
    ...emptyQuery(from),
    wheres: [{ kind: "bool", op: "and", expr: where }],
    select: {
      kind: "select",
      shape: { kind: "expr", expr: columnNode("sp", "authorId", "author_id"), type: undefined },
      constants: [],
    },
  });
}

/** Wraps a query as a subquery operand, as the query builder's `Query` will. */
export function asSubquery<R>(ast: QueryAst): SubqueryOperand<R, NoParams> {
  const named: NamedParamNode[] = [];
  collectParams(ast, [], [], named);
  return {
    [AS_SUBQUERY]: () =>
      new Expr(
        subqueryNode(ast),
        undefined,
        false,
        ast.params,
        ast.listLengths,
        named,
        shapeOfSubquery("subquery", ast.shape),
      ) as never,
  };
}
