// A hand-built query AST in the shape of packages/core/src/contracts/query.ts: plain
// readonly objects, a string `kind` on every node, and no value anywhere in the tree.
// Values live in a separate `params` array; `param` nodes hold an index into it (D9).
//
// This is the smallest subset that answers the spike's questions, not the real node set
// (step 07 defines that).

export type Expr =
  /** `"u"."age"`. */
  | { readonly kind: "column"; readonly binding: string; readonly column: string }
  /** A bound value: `params[index]`. */
  | { readonly kind: "param"; readonly index: number }
  /** A bound value supplied by name at execution time. */
  | { readonly kind: "namedParam"; readonly name: string }
  /** A bound array: `params[index]` is an array. `= ANY($1)` or `IN (?, ?, …)`. */
  | { readonly kind: "list"; readonly index: number }
  /** `left op right`, `op` from a fixed table. */
  | { readonly kind: "binary"; readonly op: BinaryOp; readonly left: Expr; readonly right: Expr }
  /** `a AND b AND …` / `a OR b OR …`. */
  | { readonly kind: "nary"; readonly op: "and" | "or"; readonly args: readonly Expr[] }
  /** `left IN list`. */
  | { readonly kind: "in"; readonly left: Expr; readonly list: Expr & { kind: "list" } }
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

export type BinaryOp = "=" | "<>" | ">" | ">=" | "<" | "<=" | "like" | "+" | "@>";

export interface WindowSpec {
  readonly partitionBy: readonly Expr[];
  readonly orderBys: readonly OrderBy[];
}

export interface OrderBy {
  readonly expr: Expr;
  readonly direction: "asc" | "desc";
}

export interface Source {
  /** Table name, or the name of a CTE. */
  readonly table: string;
  readonly alias: string;
}

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
  readonly orderBys: readonly OrderBy[];
  readonly limit: Expr | undefined;
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

// --- Constructors, so the scripts read like the queries they build. ---

export const col = (binding: string, column: string): Expr => ({ kind: "column", binding, column });
export const param = (index: number): Expr => ({ kind: "param", index });
export const named = (name: string): Expr => ({ kind: "namedParam", name });
export const list = (index: number): Expr & { kind: "list" } => ({ kind: "list", index });
export const bin = (left: Expr, op: BinaryOp, right: Expr): Expr => ({ kind: "binary", op, left, right });
export const agg = (fn: string, ...args: Expr[]): Expr => ({ kind: "aggregate", fn, args });

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
    orderBys: parts.orderBys ?? [],
    limit: parts.limit,
  };
}
