// A hand-built query AST in the shape of packages/core/src/contracts/query.ts: plain
// readonly objects, a string `kind` on every node, and a caller's value only ever in the
// `value` of a `param` or `list` node (D9).
//
// As in the contract, a parameter node has NO index. Its number is its position in the
// canonical walk: depth-first, the properties of each node in the order the interface
// declares them, arrays in index order. `collectParams` below is that walk; the lowering
// in bridge.ts numbers the parameter nodes it meets on the same walk.
//
// This is the smallest subset that answers the spike's questions, not the real node set
// (step 07 defines that).

export type Expr =
  /** `"u"."age"`. */
  | { readonly kind: "column"; readonly binding: string; readonly column: string }
  /** A bound value. */
  | { readonly kind: "param"; readonly value: unknown }
  /** A bound value supplied by name at execution time. */
  | { readonly kind: "namedParam"; readonly name: string }
  /** A bound array. `= ANY($1)` or `IN (?, ?, …)`. */
  | ListExpr
  /** `left op right`, `op` from a fixed table. */
  | { readonly kind: "binary"; readonly op: BinaryOp; readonly left: Expr; readonly right: Expr }
  /** `a AND b AND …` / `a OR b OR …`. */
  | { readonly kind: "nary"; readonly op: "and" | "or"; readonly args: readonly Expr[] }
  /** `left IN list`. */
  | { readonly kind: "in"; readonly left: Expr; readonly list: ListExpr }
  /** `EXISTS (SELECT …)`. */
  | { readonly kind: "exists"; readonly query: SelectAst }
  /** `count(x)`, `row_number() OVER (…)`, `count(x) FILTER (WHERE …)`. */
  | {
      readonly kind: "aggregate";
      readonly fn: string;
      readonly args: readonly Expr[];
      readonly filter?: Expr;
      readonly over?: WindowSpec;
    }
  /** Raw SQL text with interpolated expressions: fragment`lower(${u.email})`. */
  | { readonly kind: "fragment"; readonly strings: readonly string[]; readonly args: readonly Expr[] }
  /** `excluded."name"` inside ON CONFLICT DO UPDATE. */
  | { readonly kind: "excluded"; readonly column: string };

export interface ListExpr {
  readonly kind: "list";
  readonly value: readonly unknown[];
}

export type BinaryOp = "=" | "<>" | ">" | ">=" | "<" | "<=" | "like" | "+" | "@>";

export interface WindowSpec {
  readonly partitionBy: readonly Expr[];
  readonly orderBys: readonly OrderBy[];
}

export interface OrderBy {
  readonly expr: Expr;
  readonly direction: "asc" | "desc";
}

export type Source =
  /** A table, or the name of a CTE. */
  | { readonly kind: "table"; readonly table: string; readonly alias: string }
  /** `(SELECT …) AS alias`. */
  | { readonly kind: "subquery"; readonly query: SelectAst; readonly alias: string };

export interface Join {
  readonly type: "inner" | "left";
  readonly source: Source;
  readonly on: Expr;
}

export interface Cte {
  readonly name: string;
  readonly query: SelectAst;
  readonly materialized?: boolean;
}

/** The property order here IS the canonical parameter order of a select. */
export interface SelectAst {
  readonly kind: "select";
  readonly ctes: readonly Cte[];
  readonly from: Source;
  readonly joins: readonly Join[];
  /** ANDed together. */
  readonly wheres: readonly Expr[];
  /** In output order; aliased c0, c1, … by the lowering. */
  readonly select: readonly Expr[];
  readonly groupBys: readonly Expr[];
  /** ANDed together. */
  readonly havings: readonly Expr[];
  readonly orderBys: readonly OrderBy[];
  readonly limit: Expr | undefined;
  readonly offset: Expr | undefined;
  /** `UNION ALL` with each of these, in order. */
  readonly unionAll: readonly SelectAst[];
}

export interface InsertAst {
  readonly kind: "insert";
  readonly table: string;
  readonly columns: readonly string[];
  /** One entry per row, one expression per column. */
  readonly rows: readonly (readonly Expr[])[];
  readonly onConflict:
    | undefined
    | {
        readonly target: readonly string[];
        readonly set: readonly { readonly column: string; readonly value: Expr }[];
      };
  readonly returning: readonly string[];
}

export interface UpdateAst {
  readonly kind: "update";
  readonly table: string;
  readonly alias: string;
  readonly set: readonly { readonly column: string; readonly value: Expr }[];
  readonly wheres: readonly Expr[];
  readonly returning: readonly string[];
}

export type Ast = SelectAst | InsertAst | UpdateAst;

// --- The canonical walk -----------------------------------------------------

function collectExpr(expr: Expr, out: unknown[]): void {
  switch (expr.kind) {
    case "param":
    case "list":
      out.push(expr.value);
      return;
    case "column":
    case "namedParam":
    case "excluded":
      return;
    case "binary":
      collectExpr(expr.left, out);
      collectExpr(expr.right, out);
      return;
    case "nary":
      for (const arg of expr.args) collectExpr(arg, out);
      return;
    case "in":
      collectExpr(expr.left, out);
      collectExpr(expr.list, out);
      return;
    case "exists":
      collectSelect(expr.query, out);
      return;
    case "aggregate":
      for (const arg of expr.args) collectExpr(arg, out);
      if (expr.filter !== undefined) collectExpr(expr.filter, out);
      if (expr.over !== undefined) {
        for (const item of expr.over.partitionBy) collectExpr(item, out);
        for (const item of expr.over.orderBys) collectExpr(item.expr, out);
      }
      return;
    case "fragment":
      for (const arg of expr.args) collectExpr(arg, out);
      return;
  }
}

function collectSource(source: Source, out: unknown[]): void {
  if (source.kind === "subquery") collectSelect(source.query, out);
}

function collectSelect(ast: SelectAst, out: unknown[]): void {
  for (const cte of ast.ctes) collectSelect(cte.query, out);
  collectSource(ast.from, out);
  for (const join of ast.joins) {
    collectSource(join.source, out);
    collectExpr(join.on, out);
  }
  for (const where of ast.wheres) collectExpr(where, out);
  for (const item of ast.select) collectExpr(item, out);
  for (const item of ast.groupBys) collectExpr(item, out);
  for (const having of ast.havings) collectExpr(having, out);
  for (const item of ast.orderBys) collectExpr(item.expr, out);
  if (ast.limit !== undefined) collectExpr(ast.limit, out);
  if (ast.offset !== undefined) collectExpr(ast.offset, out);
  for (const other of ast.unionAll) collectSelect(other, out);
}

/**
 * The values of the statement's parameter nodes in canonical order: what the contract
 * calls `QueryAst.params`. Written independently of the lowering, which must agree with
 * it; 02-param-slots.ts checks that it does.
 */
export function collectParams(ast: Ast): unknown[] {
  const out: unknown[] = [];
  switch (ast.kind) {
    case "select":
      collectSelect(ast, out);
      break;
    case "insert":
      for (const row of ast.rows) for (const cell of row) collectExpr(cell, out);
      if (ast.onConflict !== undefined) for (const set of ast.onConflict.set) collectExpr(set.value, out);
      break;
    case "update":
      for (const set of ast.set) collectExpr(set.value, out);
      for (const where of ast.wheres) collectExpr(where, out);
      break;
  }
  return out;
}

// --- Constructors, so the scripts read like the queries they build. ---

export const col = (binding: string, column: string): Expr => ({ kind: "column", binding, column });
export const param = (value: unknown): Expr => ({ kind: "param", value });
export const named = (name: string): Expr => ({ kind: "namedParam", name });
export const list = (value: readonly unknown[]): ListExpr => ({ kind: "list", value });
export const bin = (left: Expr, op: BinaryOp, right: Expr): Expr => ({ kind: "binary", op, left, right });
export const agg = (fn: string, ...args: Expr[]): Expr => ({ kind: "aggregate", fn, args });
export const table = (name: string, alias: string): Source => ({ kind: "table", table: name, alias });

/** The interpolations must be expressions: there is no way to pass a bare value. */
export function fragment(strings: TemplateStringsArray, ...args: Expr[]): Expr {
  return { kind: "fragment", strings: [...strings], args };
}

export function select(
  parts: Partial<Omit<SelectAst, "kind">> & Pick<SelectAst, "from" | "select">,
): SelectAst {
  return {
    kind: "select",
    ctes: parts.ctes ?? [],
    from: parts.from,
    joins: parts.joins ?? [],
    wheres: parts.wheres ?? [],
    select: parts.select,
    groupBys: parts.groupBys ?? [],
    havings: parts.havings ?? [],
    orderBys: parts.orderBys ?? [],
    limit: parts.limit,
    offset: parts.offset,
    unionAll: parts.unionAll ?? [],
  };
}
