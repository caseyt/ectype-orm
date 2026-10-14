/**
 * The expression functions: `and`, `or`, `not`, the aggregates, `coalesce`, `caseWhen`,
 * `exists`, `now`, and the three ways to put a value or SQL into a query: `val` (a bound
 * parameter), `lit` (a literal written into the SQL, for the few kinds that are safe) and
 * `fragment` (raw SQL from a tagged template, whose interpolations are bound too).
 *
 * @module
 */
import type { AggregateNode, ExprNode, OrderNode } from "../contracts/query.js";
import type { FieldBuilder, FieldFlags } from "../contracts/schema.js";
import type { AnyFieldType } from "../contracts/type.js";
import { QueryError } from "../errors.js";
import {
  arrayType,
  bigintType,
  booleanType,
  floatType,
  jsonType,
  stringType,
  timestampType,
} from "../types/index.js";
import {
  aggregateNode,
  caseBranch,
  caseNode,
  castNode,
  collectParams,
  endCase,
  existsNode,
  fnNode,
  foldShape,
  fragmentNode,
  identNode,
  literalNode,
  namedParamNode,
  naryNode,
  orderNode,
  paramNode,
  STAR,
  shapeOf,
  shapeOfAggregate,
  shapeOfCast,
  shapeOfFragment,
  shapeOfIdent,
  shapeOfLiteral,
  shapeOfNamedParam,
  shapeOfParam,
  shapeOfSubquery,
  shapeOfUnary,
  startCase,
  startFn,
  startNary,
  unaryNode,
  windowNode,
} from "./ast.js";
import {
  type AnyExpr,
  AS_SUBQUERY,
  booleanLiteral,
  Expr,
  join,
  type MergeParams,
  NONE,
  type NoParams,
  type Operand,
  OrderExpr,
  type ParamsOf,
  type ParamsOfAll,
  type SubqueryOperand,
  subqueryOf,
  toOperand,
  typeArgument,
  type ValueOf,
} from "./expr.js";

const BOOLEAN: AnyFieldType = booleanType();
const STRING: AnyFieldType = stringType();
const FLOAT: AnyFieldType = floatType();
const JSON_VALUE: AnyFieldType = jsonType();
const TIMESTAMP: AnyFieldType = timestampType();
/** `count` and `sum` over integers: the database returns a 64-bit integer, read as a `number`. */
const BIG_COUNT: AnyFieldType = bigintType({ mode: "number" });

type NullOf<T> = null extends T ? null : never;

type Last<A extends readonly unknown[]> = A extends readonly [...unknown[], infer L] ? L : never;

/** A plain value's type widened to its primitive: a `caseWhen` branch of `"minor"` is a `string`. */
type Widen<V> = V extends string
  ? string
  : V extends number
    ? number
    : V extends boolean
      ? boolean
      : V extends bigint
        ? bigint
        : V;

/** The type a `caseWhen` value contributes: an expression's own type, or a plain value's widened type. */
type CaseValue<V> = V extends { readonly "~expr": { readonly type: infer T } } ? T : Widen<V>;

/** Anything but `undefined`: what a branch of `caseWhen` and an interpolation of `fragment` take. */
type Value = NonNullable<unknown> | null;

/** A boolean expression, as `filter`, `caseWhen` and the logical functions take it. */
type Condition = Expr<boolean | null, object>;

/** What `sum` and `avg` take: numbers, and decimals (which are strings). */
type Summable = Expr<number | bigint | string | null, object>;

type SumOf<T> = NonNullable<T> extends bigint ? bigint : NonNullable<T> extends number ? number : string;

type AvgOf<T> = NonNullable<T> extends string ? string : number;

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

/**
 * The window an aggregate is computed over (`OVER (…)`), when it is not a named one.
 *
 * @example
 * ```ts
 * const window: WindowSpec = { partitionBy: [p.authorId], orderBy: [p.createdAt.desc()] };
 * ```
 */
export interface WindowSpec {
  /** `PARTITION BY`. */
  readonly partitionBy?: readonly Expr<unknown, object>[];
  /** `ORDER BY`; a bare expression is ascending. */
  readonly orderBy?: readonly (Expr<unknown, object> | OrderExpr<object>)[];
  /** The frame clause, as a fragment: fragment`ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. */
  readonly frame?: Expr<unknown, object>;
}

type ElementOf<X> = X extends readonly (infer E)[] ? E : never;

type WindowParams<W extends WindowSpec> = ParamsOfAll<
  readonly (ElementOf<W["partitionBy"]> | ElementOf<W["orderBy"]> | Exclude<W["frame"], undefined>)[]
>;

/**
 * An aggregate call: `count(p.id)`, `sum(p.views)`. Beside every expression method it has
 * `filter`, and `over` to become a window function.
 *
 * @example
 * ```ts
 * const published: Aggregate<number | null> = sum(p.views).filter(p.published);
 * ```
 */
export class Aggregate<T, P = NoParams> extends Expr<T, P> {
  /**
   * `FILTER (WHERE condition)`: aggregate only the rows that match. A second `filter`
   * is ANDed with the first.
   *
   * @example
   * ```ts
   * count(p.id).filter(p.published);
   * ```
   *
   * @throws QueryError when `condition` is not an expression.
   */
  filter<C extends Condition>(condition: C): Aggregate<T, MergeParams<P, ParamsOf<C>>> {
    if (!(condition instanceof Expr)) {
      throw new QueryError("filter() takes a boolean expression, such as p.published or p.views.gt(10).");
    }
    const agg = aggregatePart(this);
    const filter = agg.filter === undefined ? condition.node : naryNode("and", [agg.filter, condition.node]);
    return rebuild(this, aggregateNode(agg.name, agg.args, agg.distinct, filter, agg.over)) as never;
  }

  /**
   * `OVER (…)`: computes the aggregate over a window of rows instead of a group. With no
   * argument the window is every row of the result; a string names a window declared on
   * the query; an object gives `partitionBy`, `orderBy` and `frame`.
   *
   * @example
   * ```ts
   * sum(p.views).over({ partitionBy: [p.authorId] });
   * count().over("w");
   * ```
   *
   * @throws QueryError when the aggregate already has a window, or the window is malformed.
   */
  over(): Aggregate<T, P>;
  over(name: string): Aggregate<T, P>;
  over<W extends WindowSpec>(spec: W): Aggregate<T, MergeParams<P, WindowParams<W>>>;
  over(window?: string | WindowSpec): AnyExpr {
    const agg = aggregatePart(this);
    if (agg.over !== undefined) throw new QueryError("over() was already called on this aggregate.");
    return rebuild(this, aggregateNode(agg.name, agg.args, agg.distinct, agg.filter, windowOf(window)));
  }
}

/** The aggregate node of an aggregate expression (`avg` wraps its node in a cast). */
function aggregatePart(expr: AnyExpr): AggregateNode {
  const node = expr.node;
  return (node.kind === "cast" ? node.expr : node) as AggregateNode;
}

/** A changed aggregate. It is small, so its params and shape are collected again by walking it. */
function rebuild(previous: AnyExpr, agg: AggregateNode): AnyExpr {
  const node: ExprNode = previous.node.kind === "cast" ? castNode(agg, previous.node.type) : agg;
  const params: unknown[] = [];
  const lists: number[] = [];
  collectParams(node, params, lists);
  return new Aggregate(
    node,
    previous.type,
    previous.redact,
    params.length === 0 ? NONE : params,
    lists.length === 0 ? NONE : lists,
    shapeOf(node),
  );
}

function windowOf(window: string | WindowSpec | undefined): AggregateNode["over"] {
  if (window === undefined) return windowNode(NONE, NONE, undefined);
  if (typeof window === "string") {
    if (window === "")
      throw new QueryError("over() takes the name of a window declared on the query, or a window.");
    return window;
  }
  if (typeof window !== "object" || window === null) {
    throw new QueryError("over() takes the name of a window, or { partitionBy, orderBy, frame }.");
  }
  const partitionBy: ExprNode[] = [];
  for (const item of window.partitionBy ?? NONE) partitionBy.push(expressionArgument(item, "over").node);
  const orderBy: OrderNode[] = [];
  for (const item of window.orderBy ?? NONE) {
    if (item instanceof OrderExpr) orderBy.push(item.node);
    else orderBy.push(orderNode(expressionArgument(item, "over").node, "asc", undefined));
  }
  let frame: ExprNode | undefined;
  if (window.frame !== undefined) {
    frame = expressionArgument(window.frame, "over").node;
    if (frame.kind !== "fragment") {
      throw new QueryError(
        "over(): frame is a fragment, such as fragment`ROWS BETWEEN 1 PRECEDING AND CURRENT ROW`.",
      );
    }
  }
  return windowNode(partitionBy, orderBy, frame?.kind === "fragment" ? frame : undefined);
}

function expressionArgument(value: unknown, method: string): AnyExpr {
  if (value instanceof Expr) return value;
  throw new QueryError(`${method}() takes an expression, such as p.views.`);
}

function aggregate(
  name: string,
  args: readonly AnyExpr[],
  distinct: boolean,
  type: AnyFieldType | undefined,
  redact: boolean,
): AnyExpr {
  const nodes: ExprNode[] = [];
  const shapes: number[] = [];
  let params: readonly unknown[] = NONE;
  let lists: readonly number[] = NONE;
  for (const arg of args) {
    nodes.push(arg.node);
    shapes.push(arg.shape);
    params = join(params, arg.params);
    lists = join(lists, arg.lists);
  }
  if (args.length === 0) {
    nodes.push(STAR);
    shapes.push(STAR_SHAPE);
  }
  return new Aggregate(
    aggregateNode(name, nodes, distinct, undefined, undefined),
    type,
    redact,
    params,
    lists,
    shapeOfAggregate(name, shapes, distinct, undefined, undefined),
  );
}

const STAR_SHAPE = shapeOf(STAR);

/** `count(*)`, shared: expressions are immutable, and it has no parts to vary. */
const COUNT_ROWS: AnyExpr = aggregate("count", NONE, false, BIG_COUNT, false);

const NUMERIC_KINDS: ReadonlySet<string> = new Set(["integer", "bigint", "float", "decimal", "custom"]);

function numericArgument(value: unknown, method: string): AnyExpr {
  const expr = expressionArgument(value, method);
  if (expr.type !== undefined && !NUMERIC_KINDS.has(expr.type.db.kind)) {
    throw new QueryError(`${method}() adds up numbers, and this expression has the type ${expr.type.name}.`);
  }
  return expr;
}

/**
 * `count(*)` with no argument: the number of rows. `count(x)`: the number of rows where
 * `x` is not `null`. Always a `number`.
 *
 * @example
 * ```ts
 * count();
 * count(p.id);
 * ```
 *
 * @throws QueryError when the argument is not an expression.
 */
export function count(): Aggregate<number>;
export function count<X extends Expr<unknown, object>>(expr: X): Aggregate<number, ParamsOf<X>>;
export function count(...args: readonly unknown[]): AnyExpr {
  if (args.length === 0) return COUNT_ROWS;
  return aggregate("count", [expressionArgument(args[0], "count")], false, BIG_COUNT, false);
}

/**
 * `count(DISTINCT x)`: the number of different non-null values.
 *
 * @example
 * ```ts
 * countDistinct(p.authorId);
 * ```
 *
 * @throws QueryError when the argument is not an expression.
 */
export function countDistinct<X extends Expr<unknown, object>>(expr: X): Aggregate<number, ParamsOf<X>> {
  return aggregate("count", [expressionArgument(expr, "countDistinct")], true, BIG_COUNT, false) as never;
}

/**
 * `sum(x)`: `null` over no rows. Over integers the result is a `number`; a sum that may
 * pass `Number.MAX_SAFE_INTEGER` should be cast: `sum(p.views).cast(t.bigint())`.
 *
 * @example
 * ```ts
 * sum(p.views);
 * ```
 *
 * @throws QueryError when the argument is not an expression, or has a known type that is not a number.
 */
export function sum<X extends Summable>(expr: X): Aggregate<SumOf<ValueOf<X>> | null, ParamsOf<X>> {
  const arg = numericArgument(expr, "sum");
  // The database widens a sum of integers (to bigint on Postgres); read it back as a number.
  const type = arg.type?.db.kind === "integer" ? BIG_COUNT : arg.type;
  return aggregate("sum", [arg], false, type, arg.redact) as never;
}

/**
 * `avg(x)`: `null` over no rows. Over numbers the result is a `number` (the SQL casts the
 * average to a float, since the database computes it as a decimal); over decimals it stays
 * a decimal string.
 *
 * @example
 * ```ts
 * avg(u.age);
 * ```
 *
 * @throws QueryError when the argument is not an expression, or has a known type that is not a number.
 */
export function avg<X extends Summable>(expr: X): Aggregate<AvgOf<ValueOf<X>> | null, ParamsOf<X>> {
  const arg = numericArgument(expr, "avg");
  if (arg.type?.db.kind === "decimal") return aggregate("avg", [arg], false, arg.type, arg.redact) as never;
  const agg = aggregate("avg", [arg], false, FLOAT, arg.redact);
  return new Aggregate(
    castNode(agg.node, FLOAT),
    FLOAT,
    arg.redact,
    agg.params,
    agg.lists,
    shapeOfCast(agg.shape, FLOAT),
  ) as never;
}

/**
 * `min(x)`: the smallest value; `null` over no rows.
 *
 * @example
 * ```ts
 * min(p.createdAt);
 * ```
 *
 * @throws QueryError when the argument is not an expression.
 */
export function min<X extends Expr<unknown, object>>(
  expr: X,
): Aggregate<NonNullable<ValueOf<X>> | null, ParamsOf<X>> {
  const arg = expressionArgument(expr, "min");
  return aggregate("min", [arg], false, arg.type, arg.redact) as never;
}

/**
 * `max(x)`: the largest value; `null` over no rows.
 *
 * @example
 * ```ts
 * max(p.createdAt);
 * ```
 *
 * @throws QueryError when the argument is not an expression.
 */
export function max<X extends Expr<unknown, object>>(
  expr: X,
): Aggregate<NonNullable<ValueOf<X>> | null, ParamsOf<X>> {
  const arg = expressionArgument(expr, "max");
  return aggregate("max", [arg], false, arg.type, arg.redact) as never;
}

/**
 * `array_agg(x)`: the values as an array; `null` over no rows.
 *
 * @example
 * ```ts
 * arrayAgg(p.title);
 * ```
 *
 * @throws QueryError when the argument is not an expression.
 */
export function arrayAgg<X extends Expr<unknown, object>>(
  expr: X,
): Aggregate<ValueOf<X>[] | null, ParamsOf<X>> {
  const arg = expressionArgument(expr, "arrayAgg");
  const type = arg.type === undefined ? undefined : arrayType(arg.type);
  return aggregate("arrayAgg", [arg], false, type, arg.redact) as never;
}

/**
 * `json_agg(x)`: the values as a JSON array; `null` over no rows. Values come back as
 * JSON (a date as a string), so the elements are `unknown`; assert them with `as`.
 *
 * @example
 * ```ts
 * jsonAgg(p.title).as<string[] | null>();
 * ```
 *
 * @throws QueryError when the argument is not an expression.
 */
export function jsonAgg<X extends Expr<unknown, object>>(expr: X): Aggregate<unknown[] | null, ParamsOf<X>> {
  const arg = expressionArgument(expr, "jsonAgg");
  return aggregate("jsonAgg", [arg], false, JSON_VALUE, arg.redact) as never;
}

/**
 * `string_agg(x, separator)`: the values joined with `separator`; `null` over no rows.
 *
 * @example
 * ```ts
 * stringAgg(p.title, ", ");
 * ```
 *
 * @throws QueryError when the first argument is not an expression, or the separator is `null` or `undefined`.
 */
export function stringAgg<
  X extends Expr<string | null, object>,
  S extends string | Expr<string | null, object>,
>(expr: X, separator: S): Aggregate<string | null, MergeParams<ParamsOf<X>, ParamsOf<S>>> {
  const arg = expressionArgument(expr, "stringAgg");
  const sep = toOperand(separator, STRING, false, "stringAgg", false);
  return aggregate("stringAgg", [arg, sep], false, STRING, arg.redact) as never;
}

// ---------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------

function conditions(values: readonly unknown[], method: string): AnyExpr[] {
  const out: AnyExpr[] = [];
  for (const value of values) {
    if (!(value instanceof Expr)) {
      throw new QueryError(`${method}() takes boolean expressions, such as u.age.gte(18).`);
    }
    out.push(value);
  }
  return out;
}

function nary(op: "and" | "or", values: readonly unknown[]): AnyExpr {
  const args = conditions(values, op);
  const first = args[0];
  if (first === undefined) return booleanLiteral(op === "and");
  if (args.length === 1) return first;
  const nodes: ExprNode[] = [];
  let params: readonly unknown[] = NONE;
  let lists: readonly number[] = NONE;
  let shape = startNary(op);
  for (const arg of args) {
    nodes.push(arg.node);
    params = join(params, arg.params);
    lists = join(lists, arg.lists);
    shape = foldShape(shape, arg.shape);
  }
  return new Expr(naryNode(op, nodes), BOOLEAN, false, params, lists, shape);
}

/**
 * `a AND b AND …`. With no argument it is `true`; with one, that argument.
 *
 * @example
 * ```ts
 * and(u.age.gte(18), u.role.eq("admin"), p.published);
 * ```
 *
 * @throws QueryError when an argument is not an expression.
 */
export function and<const A extends readonly Condition[]>(...conditions: A): Expr<boolean, ParamsOfAll<A>> {
  return nary("and", conditions) as never;
}

/**
 * `a OR b OR …`. With no argument it is `false`; with one, that argument.
 *
 * @example
 * ```ts
 * or(u.role.eq("admin"), u.age.gte(65));
 * ```
 *
 * @throws QueryError when an argument is not an expression.
 */
export function or<const A extends readonly Condition[]>(...conditions: A): Expr<boolean, ParamsOfAll<A>> {
  return nary("or", conditions) as never;
}

/**
 * `NOT x`.
 *
 * @example
 * ```ts
 * not(p.published);
 * ```
 *
 * @throws QueryError when the argument is not an expression.
 */
export function not<X extends Condition>(condition: X): Expr<boolean, ParamsOf<X>> {
  const [arg] = conditions([condition], "not");
  const operand = arg as AnyExpr;
  return new Expr(
    unaryNode("not", operand.node),
    BOOLEAN,
    false,
    operand.params,
    operand.lists,
    shapeOfUnary("not", operand.shape),
  ) as never;
}

// ---------------------------------------------------------------------------
// Other functions
// ---------------------------------------------------------------------------

/**
 * `coalesce(a, b, …)`: the first argument that is not `null`. The result is nullable only
 * when the last argument is. Plain values are bound with the type of `first`.
 *
 * @example
 * ```ts
 * coalesce(u.name, u.email); // Expr<string>
 * coalesce(sum(p.views), 0); // Expr<number>
 * ```
 *
 * @throws QueryError when `first` is not an expression or an argument is `null` or `undefined`.
 */
export function coalesce<
  F extends Expr<unknown, object>,
  const R extends readonly [Operand<ValueOf<F>>, ...Operand<ValueOf<F>>[]],
>(
  first: F,
  ...rest: R
): Expr<NonNullable<ValueOf<F>> | NullOf<ValueOf<Last<R>>>, MergeParams<ParamsOf<F>, ParamsOfAll<R>>> {
  const head = expressionArgument(first, "coalesce");
  if (rest.length === 0) throw new QueryError("coalesce() needs at least two arguments.");
  const nodes: ExprNode[] = [head.node];
  let params = head.params;
  let lists = head.lists;
  let shape = foldShape(startFn("coalesce"), head.shape);
  for (const value of rest) {
    const arg = toOperand(value, head.type, head.redact, "coalesce", false);
    nodes.push(arg.node);
    params = join(params, arg.params);
    lists = join(lists, arg.lists);
    shape = foldShape(shape, arg.shape);
  }
  return new Expr(fnNode("coalesce", nodes), head.type, head.redact, params, lists, shape) as never;
}

const NOW: AnyExpr = new Expr(fnNode("now", NONE), TIMESTAMP, false, NONE, NONE, startFn("now"));

/**
 * `now()`: the database's current time (the start of the transaction on Postgres).
 *
 * @example
 * ```ts
 * p.publishedAt.lte(now());
 * ```
 */
export function now(): Expr<Date> {
  return NOW as never;
}

/**
 * `CASE WHEN … THEN … [WHEN …] [ELSE …] END`. Without `else` the result is `null` when no
 * branch matches. Plain values are bound, with the type of an earlier expression branch.
 *
 * @example
 * ```ts
 * caseWhen(u.age.lt(13), "child").when(u.age.lt(18), "teen").else("adult");
 * ```
 *
 * @throws QueryError when a condition is not an expression or a value is `undefined`.
 */
export class Case<T, P = NoParams> extends Expr<T | null, P> {
  /** The shape of the branches so far, before the `ELSE`. */
  readonly branchesShape: number;

  /**
   * Internal: made by {@link caseWhen}.
   *
   * @example
   * ```ts
   * new Case(node, type, false, params, lists, shape, branchesShape);
   * ```
   */
  constructor(
    node: ExprNode,
    type: AnyFieldType | undefined,
    redact: boolean,
    params: readonly unknown[],
    lists: readonly number[],
    shape: number,
    branchesShape: number,
  ) {
    super(node, type, redact, params, lists, shape);
    this.branchesShape = branchesShape;
  }

  /**
   * Another `WHEN condition THEN value`.
   *
   * @example
   * ```ts
   * caseWhen(u.age.lt(13), "child").when(u.age.lt(18), "teen");
   * ```
   *
   * @throws QueryError when `condition` is not an expression or `value` is `undefined`.
   */
  when<C extends Condition, V extends Value>(
    condition: C,
    value: V,
  ): Case<T | CaseValue<V>, MergeParams<P, MergeParams<ParamsOf<C>, ParamsOf<V>>>> {
    return branch(this, condition, value) as never;
  }

  /**
   * `ELSE value`, which ends the expression.
   *
   * @example
   * ```ts
   * caseWhen(u.age.lt(18), "minor").else("adult");
   * ```
   *
   * @throws QueryError when `value` is `undefined`.
   */
  else<V extends Value>(value: V): Expr<T | CaseValue<V>, MergeParams<P, ParamsOf<V>>> {
    const node = this.node as Extract<ExprNode, { kind: "case" }>;
    const otherwise = toOperand(value, this.type, false, "else", false, true);
    return new Expr(
      caseNode(node.whens, otherwise.node),
      this.type ?? otherwise.type,
      false,
      join(this.params, otherwise.params),
      join(this.lists, otherwise.lists),
      endCase(this.branchesShape, otherwise.shape),
    ) as never;
  }
}

function branch(previous: Case<unknown, unknown> | undefined, condition: unknown, value: unknown): AnyExpr {
  if (!(condition instanceof Expr)) {
    throw new QueryError("caseWhen() takes a boolean expression as its condition, such as u.age.lt(18).");
  }
  const then = toOperand(value, previous?.type, false, "caseWhen", false, true);
  const whens =
    previous === undefined ? [] : (previous.node as Extract<ExprNode, { kind: "case" }>).whens.slice();
  whens.push({ when: condition.node, result: then.node });
  const branchesShape = caseBranch(previous?.branchesShape ?? startCase(), condition.shape, then.shape);
  return new Case(
    caseNode(whens, undefined),
    previous?.type ?? then.type,
    false,
    join(join(previous?.params ?? NONE, condition.params), then.params),
    join(join(previous?.lists ?? NONE, condition.lists), then.lists),
    endCase(branchesShape, undefined),
    branchesShape,
  );
}

/**
 * Starts a `CASE` expression: `WHEN condition THEN value`. Chain `.when(…)` for more
 * branches and `.else(…)` for the value when none matches.
 *
 * @example
 * ```ts
 * caseWhen(u.age.lt(18), "minor").else("adult");
 * ```
 *
 * @throws QueryError when `condition` is not an expression or `value` is `undefined`.
 */
export function caseWhen<C extends Condition, V extends Value>(
  condition: C,
  value: V,
): Case<CaseValue<V>, MergeParams<ParamsOf<C>, ParamsOf<V>>> {
  return branch(undefined, condition, value) as never;
}

/**
 * `EXISTS (query)`: whether the query returns any row.
 *
 * @example
 * ```ts
 * exists(from(Post, "p").where(({ p }) => p.authorId.eq(outerRef("u", User).id)));
 * ```
 *
 * @throws QueryError when the argument is not a query.
 */
export function exists<Q extends SubqueryOperand<unknown, object>>(query: Q): Expr<boolean, ParamsOf<Q>> {
  if (typeof query !== "object" || query === null || typeof query[AS_SUBQUERY] !== "function") {
    throw new QueryError("exists() takes a query.");
  }
  const sub = subqueryOf(query, "exists");
  return new Expr(
    existsNode(sub.node.query),
    BOOLEAN,
    false,
    sub.params,
    sub.lists,
    shapeOfSubquery("exists", sub.node.query.shape),
  ) as never;
}

// ---------------------------------------------------------------------------
// Values and raw SQL
// ---------------------------------------------------------------------------

/**
 * An explicit bound parameter, for a value whose type cannot come from the other side of
 * an operator (in a `select`, in a fragment, as the first argument). Pass a field type to
 * dump the value with it.
 *
 * @example
 * ```ts
 * val(new Date(), t.timestamp());
 * val("member");
 * ```
 *
 * @throws QueryError when `value` is `undefined`, or `type` is not a field type.
 */
export function val<T, F extends FieldFlags>(value: NoInfer<T>, type: FieldBuilder<T, F>): Expr<T>;
export function val<const T>(value: T): Expr<T>;
export function val(value: unknown, type?: unknown): AnyExpr {
  if (value === undefined) throw new QueryError("val() was given undefined. Pass a value, or null.");
  const fieldType = type === undefined ? undefined : typeArgument(type, "val");
  return new Expr(
    paramNode(value, fieldType, false),
    fieldType,
    false,
    [value],
    NONE,
    shapeOfParam(fieldType, false),
  );
}

/**
 * A literal written into the SQL text, for the kinds that are safe there: `true`, `false`,
 * `null` and finite numbers. Everything else is a bound parameter (`val`).
 *
 * @example
 * ```ts
 * lit(true);
 * lit(0);
 * ```
 *
 * @throws QueryError for any other value.
 */
export function lit<const V extends boolean | number | null>(
  value: V,
): Expr<V extends boolean ? boolean : V extends number ? number : null> {
  const node = literalNode(value);
  return new Expr(
    node,
    typeof value === "boolean" ? BOOLEAN : undefined,
    false,
    NONE,
    NONE,
    shapeOfLiteral(node.value),
  ) as never;
}

/**
 * A named parameter: a placeholder whose value is supplied when the query runs,
 * `repo.all(q, { minAge: 18 })`. The query's type requires every name it uses.
 *
 * @example
 * ```ts
 * u.age.gte(param("minAge", t.integer()));
 * ```
 *
 * @throws QueryError when `name` is empty or `type` is not a field type.
 */
export function param<const N extends string, T, F extends FieldFlags>(
  name: N,
  type: FieldBuilder<T, F>,
): Expr<T, { [K in N]: T }> {
  if (typeof name !== "string" || name === "") {
    throw new QueryError('param() takes a name and a field type: param("minAge", t.integer()).');
  }
  const fieldType = typeArgument(type, "param");
  return new Expr(
    namedParamNode(name, fieldType, false),
    fieldType,
    false,
    NONE,
    NONE,
    shapeOfNamedParam(name, fieldType, false),
  ) as never;
}

/**
 * The `fragment` tag, and `fragment.ident` for a dynamic identifier.
 *
 * @example
 * ```ts
 * const lowerEmail: Expr<unknown> = fragment`lower(${u.email})`;
 * ```
 */
export interface FragmentFunction {
  /** Raw SQL: the template's literal parts are SQL text, every interpolation is an expression or a bound value. */
  <const A extends readonly Value[]>(
    strings: TemplateStringsArray,
    ...args: A
  ): Expr<unknown, ParamsOfAll<A>>;
  /**
   * An identifier (a column, table or function name) chosen at run time, checked against
   * `/^[A-Za-z_][A-Za-z0-9_$]*$/` and quoted.
   */
  ident(name: string): Expr<unknown>;
}

function isTemplate(strings: unknown, args: number): strings is TemplateStringsArray {
  if (!Array.isArray(strings) || !Object.isFrozen(strings) || strings.length !== args + 1) return false;
  const raw: unknown = (strings as { readonly raw?: unknown }).raw;
  if (!Array.isArray(raw) || raw.length !== strings.length) return false;
  for (const text of strings as readonly unknown[]) if (typeof text !== "string") return false;
  return true;
}

function fragmentTag(strings: TemplateStringsArray, ...args: unknown[]): AnyExpr {
  if (!isTemplate(strings, args.length)) {
    throw new QueryError(
      "fragment is a tagged template: write the SQL between backquotes, fragment`lower(…)`, not fragment(text). Calling it as a function would turn a string into SQL text, so it is refused.",
    );
  }
  const nodes: ExprNode[] = [];
  const shapes: number[] = [];
  let params: readonly unknown[] = NONE;
  let lists: readonly number[] = NONE;
  for (const value of args) {
    const arg =
      typeof value === "object" && value !== null && !(value instanceof Expr) && AS_SUBQUERY in value
        ? subqueryOf(value as SubqueryOperand<unknown, unknown>, "fragment")
        : toOperand(value, undefined, false, "fragment", false, true);
    nodes.push(arg.node);
    shapes.push(arg.shape);
    params = join(params, arg.params);
    lists = join(lists, arg.lists);
  }
  return new Expr(
    fragmentNode(strings, nodes),
    undefined,
    false,
    params,
    lists,
    shapeOfFragment(strings, shapes),
  );
}

function ident(name: string): AnyExpr {
  const node = identNode(name);
  return new Expr(node, undefined, false, NONE, NONE, shapeOfIdent(node.name));
}

/**
 * Raw SQL, as a tagged template. The literal parts become SQL text; every interpolation
 * becomes an expression or a bound parameter, never text. The result is `unknown` until
 * typed with `.as<T>()` or `.cast(type)`.
 *
 * @example
 * ```ts
 * fragment`lower(${u.email})`.as<string>();
 * fragment`similarity(${u.name}, ${search}) > ${0.3}`.as<boolean>();
 * fragment`${fragment.ident(column)} @@ plainto_tsquery(${query})`.as<boolean>();
 * ```
 *
 * @throws QueryError when called as an ordinary function, when an interpolation is
 * `undefined`, and (`ident`) when a name is not a plain identifier.
 */
export const fragment: FragmentFunction = Object.assign(fragmentTag, { ident }) as FragmentFunction;
