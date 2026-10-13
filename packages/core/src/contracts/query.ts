/**
 * The query AST contract: what a query **is**, as plain data, between the builder that
 * creates it and the compiler that turns it into SQL.
 *
 * Step 07 (`query/ast.ts`, `query/expr.ts`) implements the expression nodes and may refine
 * their fields until it merges; steps 08 and 09 build `QueryAst` values; step 10 compiles
 * them; steps 12 to 14 read `select` and `preloads`. The top-level shape of
 * {@link QueryAst} and the rules below are frozen by this step.
 *
 * ## Rules for every node
 *
 * 1. **Plain objects.** A node is an object literal: no classes, no prototypes, no
 *    methods, no `Proxy`.
 * 2. **Frozen by convention.** Nobody mutates a node after creating it. `Object.freeze`
 *    is not called, because it costs time on every node of every query; the `readonly`
 *    modifiers below are the enforcement.
 * 3. **A string `kind`** on every node, as its first property. Code dispatches on it.
 * 4. **Monomorphic shapes.** A constructor assigns every property of a node, always in
 *    the order the interface declares them, using `undefined` for an absent optional
 *    part. Properties are never added or deleted later.
 * 5. **No values in the tree's structure (decision D9).** A value supplied by the caller
 *    lives only in the `value` of a {@link ParamNode} or {@link ListNode}; it is always
 *    sent as a bound parameter and never becomes SQL text. The only literals that are
 *    emitted as text are the ones a {@link LiteralNode} can hold. Names that end up as
 *    identifiers (tables, columns, aliases) are quoted by the compiler; operator and
 *    function names are looked up in the compiler's own tables; the static strings of a
 *    {@link FragmentNode} come from a template literal in the program text.
 * 6. **Structural sharing.** A builder method returns a new `QueryAst` that reuses every
 *    array and node it did not change (`next.joins === prev.joins`).
 *
 * ## Parameter order
 *
 * {@link QueryAst.params} holds the values of all {@link ParamNode}s and {@link ListNode}s
 * of the query in **canonical order**: a depth-first walk that visits the properties of
 * each node in the order its interface declares them, and arrays in index order. For a
 * query that is the order of the properties of {@link QueryAst}; a nested query
 * contributes its own params at the point where it sits. The one exception is
 * {@link QueryAst.preloads}, which the walk skips: a preload's query is a separate
 * statement with its own `params`.
 *
 * It is a cache of what that walk would collect, kept so that binding parameters never
 * walks the tree. The invariant is `ast.params` equals `collectParams(ast)` (step 07),
 * and both the builders and the compiler rely on it: the compiler numbers the parameter
 * nodes it meets on the same walk, and a compiled plan refers to values by that number
 * (see `ParamSlot` in `./adapter.ts`). Two queries of the same shape therefore have their
 * values at the same indexes, which is what lets them share a plan.
 *
 * {@link NamedParamNode}s have no value and no entry in `params`. Neither have the
 * constants of a select (`SelectNode.constants`): they are not sent to the database.
 *
 * {@link QueryAst.listLengths} is the same kind of cache for the lengths of the
 * {@link ListNode}s, in the same order.
 *
 * ### Who keeps the order when a query is built
 *
 * A builder may add clauses in any order (`.limit(10)` and then `.where(…)`), so the
 * values of a new clause do not always go at the end of `params`: they go where the
 * clause sits in the canonical order. Finding that position must not need a walk
 * (building is O(size of the added clause)). The AST deliberately holds no per-clause
 * counts, so **the builder keeps them**: the `Query` object that wraps a `QueryAst`
 * (step 08) carries, outside the AST, the number of params (and of lists) that each
 * top-level property contributes, and derives the insertion offset from those. An
 * expression knows its own params in canonical order (step 07), so adding a clause
 * splices that array in at the offset. Code that builds a `QueryAst` by hand (tests,
 * the compiler's own rewrites) computes `params` with `collectParams`.
 *
 * ## Shape
 *
 * {@link QueryAst.shape} is a 32-bit structural hash, and it is **canonical**: two
 * queries with the same structure have the same shape, in whatever order their clauses
 * were added. Two such queries also have the same `params` layout, so they share one
 * plan, which is what the plan cache of step 10 assumes.
 *
 * What contributes: every node's kind, operators, function names, identifiers (source,
 * alias, column, the prefix of every source and of every query, nested ones included;
 * wherever a node holds a schema's `meta` (a table or CTE source, a whole-binding
 * select) also that schema's `name` and the prefix it declares),
 * boolean and enumerated properties (`distinct`, `direction`, `asText`, `recursive`, …),
 * the `value` of a {@link LiteralNode} (it becomes SQL text),
 * the **type** and the **`redact`** flag of a parameter (both end up in the slots of the
 * shared plan, so two queries that differ in either must not share one), and of each
 * preload its `assoc`, its `from` and its
 * nested preloads (a join preload adds columns to the select list, and any preload
 * changes how rows are built). What never contributes: the `value` of a {@link ParamNode}
 * or {@link ListNode}, the length of a list, a select constant, and the `query` of a
 * preload (a separate statement with its own shape). Queries that differ only in those
 * have equal shapes.
 *
 * A running hash is order-dependent, so a canonical shape cannot be one hash threaded
 * through the builder calls. The builder keeps one hash per top-level property of
 * {@link QueryAst} (next to the counts above; extending one is O(added clause)) and
 * `shape` is those hashes combined in declaration order, which is a fixed, small number
 * of `hashInt` calls per builder method.
 *
 * The plan cache uses `shape` as a key and confirms a hit structurally, because hashes
 * can collide. In that comparison two sources are the same only if they have the **same
 * `meta` object**: a plan holds the schema metadata of the rows it builds (and each
 * table's resolved prefix), so it can be shared only by queries over the same schemas.
 * The schema's name is in the hash so that this is rare and not routine: two schema
 * classes over one table (a read model next to a write model) would otherwise hash alike
 * and keep evicting each other from one cache entry, each time counted as a collision.
 * On a dialect that expands lists (`capabilities.arrayParams` false) the SQL depends on
 * the list lengths, so the cache key there is `shape` combined with `listLengths`; on
 * Postgres `listLengths` is ignored.
 *
 * @module
 */
import type { SchemaMeta } from "./schema.js";
import type { AnyEctoType } from "./type.js";

// ---------------------------------------------------------------------------
// Expression nodes
// ---------------------------------------------------------------------------

/**
 * A column of a binding: `"u"."inserted_at"`.
 *
 * @example
 * ```ts
 * const node: ColumnNode = { kind: "column", binding: "u", field: "insertedAt", column: "inserted_at" };
 * ```
 */
export interface ColumnNode {
  readonly kind: "column";
  /** The alias of the binding the column belongs to. */
  readonly binding: string;
  /** The field name, for error messages. */
  readonly field: string;
  /** The column name in the database. */
  readonly column: string;
}

/**
 * A bound value: `$1`. The value is dumped with `type` when there is one, and passed to
 * the driver unchanged otherwise.
 *
 * `redact` marks a value that must not appear in logs or telemetry: an operand takes it
 * from the redacted field it is compared with or assigned to (`FieldMeta.redact`), the
 * way it takes its type.
 *
 * @example
 * ```ts
 * const node: ParamNode = { kind: "param", value: 18, type: undefined, redact: false };
 * ```
 */
export interface ParamNode {
  readonly kind: "param";
  /** The caller's value. Never part of the shape; never SQL text. */
  readonly value: unknown;
  readonly type: AnyEctoType | undefined;
  readonly redact: boolean;
}

/**
 * A bound value supplied by name at execution time: `repo.all(query, { minAge: 18 })`.
 *
 * @example
 * ```ts
 * const node: NamedParamNode = { kind: "namedParam", name: "minAge", type: undefined, redact: false };
 * ```
 */
export interface NamedParamNode {
  readonly kind: "namedParam";
  readonly name: string;
  readonly type: AnyEctoType | undefined;
  readonly redact: boolean;
}

/**
 * A bound array, used with `in`: `= ANY($1)` where the dialect binds arrays, otherwise
 * `IN ($1, $2, …)`. It is one entry of `params` either way. `type` is the element type.
 *
 * @example
 * ```ts
 * const node: ListNode = { kind: "list", value: ["admin", "member"], type: undefined, redact: false };
 * ```
 */
export interface ListNode {
  readonly kind: "list";
  readonly value: readonly unknown[];
  readonly type: AnyEctoType | undefined;
  readonly redact: boolean;
}

/**
 * A literal that is written into the SQL text: `NULL`, `TRUE`, `FALSE` or a finite number.
 * Nothing else may be inlined; in particular, never a string.
 *
 * @example
 * ```ts
 * const node: LiteralNode = { kind: "literal", value: true };
 * ```
 */
export interface LiteralNode {
  readonly kind: "literal";
  readonly value: null | boolean | number;
}

/**
 * The operators of a {@link UnaryNode}: `NOT x`, `-x`, `x IS NULL`, `x IS NOT NULL`.
 *
 * @example
 * ```ts
 * const op: UnaryOp = "isNull";
 * ```
 */
export type UnaryOp = "not" | "neg" | "isNull" | "isNotNull";

/**
 * An operator with one operand: `NOT "u"."banned"`, `"u"."name" IS NULL`.
 *
 * @example
 * ```ts
 * declare const name: ColumnNode;
 * const node: UnaryNode = { kind: "unary", op: "isNull", operand: name };
 * ```
 */
export interface UnaryNode {
  readonly kind: "unary";
  readonly op: UnaryOp;
  readonly operand: ExprNode;
}

/**
 * The operators of a {@link BinaryNode}. Each is the name of an entry in the compiler's
 * operator table, not SQL text.
 *
 * @example
 * ```ts
 * const op: BinaryOp = "gte";
 * ```
 */
export type BinaryOp =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "isDistinctFrom"
  | "like"
  | "notLike"
  | "ilike"
  | "in"
  | "notIn"
  | "add"
  | "sub"
  | "mul"
  | "div"
  | "mod"
  | "concat"
  | "contains"
  | "containedBy"
  | "overlaps"
  | "has";

/**
 * An operator with two operands: `"u"."age" >= $1`.
 *
 * @example
 * ```ts
 * declare const age: ColumnNode;
 * declare const eighteen: ParamNode;
 * const node: BinaryNode = { kind: "binary", op: "gte", left: age, right: eighteen };
 * ```
 */
export interface BinaryNode {
  readonly kind: "binary";
  readonly op: BinaryOp;
  readonly left: ExprNode;
  readonly right: ExprNode;
}

/**
 * `a AND b AND …` or `a OR b OR …`. With no arguments, `and` is `TRUE` and `or` is `FALSE`.
 *
 * @example
 * ```ts
 * declare const a: ExprNode;
 * declare const b: ExprNode;
 * const node: NaryNode = { kind: "nary", op: "and", args: [a, b] };
 * ```
 */
export interface NaryNode {
  readonly kind: "nary";
  readonly op: "and" | "or";
  readonly args: readonly ExprNode[];
}

/**
 * A function call: `coalesce("u"."name", "u"."email")`. `name` is the name of an entry in
 * the compiler's function table.
 *
 * @example
 * ```ts
 * declare const name: ColumnNode;
 * declare const email: ColumnNode;
 * const node: FnNode = { kind: "fn", name: "coalesce", args: [name, email] };
 * ```
 */
export interface FnNode {
  readonly kind: "fn";
  readonly name: string;
  readonly args: readonly ExprNode[];
}

/**
 * A window specification: `PARTITION BY … ORDER BY … [frame]`.
 *
 * @example
 * ```ts
 * declare const authorId: ColumnNode;
 * const node: WindowNode = { kind: "window", partitionBy: [authorId], orderBy: [], frame: undefined };
 * ```
 */
export interface WindowNode {
  readonly kind: "window";
  readonly partitionBy: readonly ExprNode[];
  readonly orderBy: readonly OrderNode[];
  /** The frame clause (`ROWS BETWEEN …`), as a fragment. */
  readonly frame: FragmentNode | undefined;
}

/**
 * An aggregate or window function call:
 * `count(DISTINCT "p"."id") FILTER (WHERE "p"."published") OVER (…)`.
 *
 * @example
 * ```ts
 * declare const id: ColumnNode;
 * const node: AggregateNode = {
 *   kind: "aggregate",
 *   name: "count",
 *   args: [id],
 *   distinct: false,
 *   filter: undefined,
 *   over: undefined,
 * };
 * ```
 */
export interface AggregateNode {
  readonly kind: "aggregate";
  readonly name: string;
  readonly args: readonly ExprNode[];
  readonly distinct: boolean;
  readonly filter: ExprNode | undefined;
  /** An inline window, or the name of a window in {@link QueryAst.windows}. */
  readonly over: WindowNode | string | undefined;
}

/**
 * A dynamic identifier inside a fragment (`fragment.ident(name)`), quoted by the compiler.
 *
 * @example
 * ```ts
 * const node: IdentNode = { kind: "ident", name: "search_vector" };
 * ```
 */
export interface IdentNode {
  readonly kind: "ident";
  /** Validated against `/^[A-Za-z_][A-Za-z0-9_$]*$/` when the node is created. */
  readonly name: string;
}

/**
 * Raw SQL from the `fragment` tagged template: the static strings are emitted as written
 * and the interpolations are expressions (values among them are {@link ParamNode}s).
 * There is one more string than there are arguments.
 *
 * @example
 * ```ts
 * // fragment`lower(${u.email})`
 * declare const email: ColumnNode;
 * const node: FragmentNode = { kind: "fragment", strings: ["lower(", ")"], args: [email] };
 * ```
 */
export interface FragmentNode {
  readonly kind: "fragment";
  readonly strings: readonly string[];
  readonly args: readonly ExprNode[];
}

/**
 * A type cast: `CAST(x AS type)`. The SQL type is derived from `type.db`.
 *
 * Ecto equivalent: `type/2`.
 *
 * @example
 * ```ts
 * declare const age: ColumnNode;
 * declare const stringType: AnyEctoType;
 * const node: CastNode = { kind: "cast", expr: age, type: stringType };
 * ```
 */
export interface CastNode {
  readonly kind: "cast";
  readonly expr: ExprNode;
  readonly type: AnyEctoType;
}

/**
 * `CASE WHEN … THEN … [ELSE …] END`.
 *
 * @example
 * ```ts
 * declare const isMinor: ExprNode;
 * declare const minor: ParamNode;
 * declare const adult: ParamNode;
 * const node: CaseNode = { kind: "case", whens: [{ when: isMinor, then: minor }], else: adult };
 * ```
 */
export interface CaseNode {
  readonly kind: "case";
  readonly whens: readonly { readonly when: ExprNode; readonly then: ExprNode }[];
  readonly else: ExprNode | undefined;
}

/**
 * A path into a JSON value: `"u"."settings" -> $1 ->> $2`. The keys are bound parameters.
 *
 * @example
 * ```ts
 * declare const settings: ColumnNode;
 * declare const theme: ParamNode;
 * const node: JsonPathNode = { kind: "jsonPath", expr: settings, path: [theme], asText: true };
 * ```
 */
export interface JsonPathNode {
  readonly kind: "jsonPath";
  readonly expr: ExprNode;
  readonly path: readonly ExprNode[];
  /** `true` extracts text (`->>`), `false` extracts JSON (`->`). */
  readonly asText: boolean;
}

/**
 * A query used as an expression: `(SELECT …)`.
 *
 * @example
 * ```ts
 * declare const query: QueryAst;
 * const node: SubqueryNode = { kind: "subquery", query };
 * ```
 */
export interface SubqueryNode {
  readonly kind: "subquery";
  readonly query: QueryAst;
}

/**
 * `EXISTS (SELECT …)`.
 *
 * @example
 * ```ts
 * declare const query: QueryAst;
 * const node: ExistsNode = { kind: "exists", query };
 * ```
 */
export interface ExistsNode {
  readonly kind: "exists";
  readonly query: QueryAst;
}

/**
 * A row value: `("p"."author_id", "p"."id")`, for keyset pagination.
 *
 * @example
 * ```ts
 * declare const authorId: ColumnNode;
 * declare const id: ColumnNode;
 * const node: TupleNode = { kind: "tuple", items: [authorId, id] };
 * ```
 */
export interface TupleNode {
  readonly kind: "tuple";
  readonly items: readonly ExprNode[];
}

/**
 * A name for a selected expression, or a reference to one. With `expr` it defines the
 * alias in the select list; without, it refers to it from `GROUP BY` or `ORDER BY`.
 *
 * Ecto equivalent: `selected_as/2` and `selected_as/1`.
 *
 * @example
 * ```ts
 * const reference: SelectedAsNode = { kind: "selectedAs", name: "total", expr: undefined };
 * ```
 */
export interface SelectedAsNode {
  readonly kind: "selectedAs";
  readonly name: string;
  readonly expr: ExprNode | undefined;
}

/**
 * `*`, as in `count(*)`.
 *
 * @example
 * ```ts
 * const node: StarNode = { kind: "star" };
 * ```
 */
export interface StarNode {
  readonly kind: "star";
}

/**
 * Any expression.
 *
 * @example
 * ```ts
 * function isParameter(node: ExprNode): node is ParamNode | ListNode | NamedParamNode {
 *   return node.kind === "param" || node.kind === "list" || node.kind === "namedParam";
 * }
 * ```
 */
export type ExprNode =
  | ColumnNode
  | ParamNode
  | NamedParamNode
  | ListNode
  | LiteralNode
  | UnaryNode
  | BinaryNode
  | NaryNode
  | FnNode
  | AggregateNode
  | IdentNode
  | FragmentNode
  | CastNode
  | CaseNode
  | JsonPathNode
  | SubqueryNode
  | ExistsNode
  | TupleNode
  | SelectedAsNode
  | StarNode;

/**
 * The `kind` of every expression node.
 *
 * @example
 * ```ts
 * const kind: ExprKind = "binary";
 * ```
 */
export type ExprKind = ExprNode["kind"];

// ---------------------------------------------------------------------------
// Clause nodes
// ---------------------------------------------------------------------------

/**
 * One `ORDER BY` item: `"u"."inserted_at" DESC NULLS LAST`.
 *
 * @example
 * ```ts
 * declare const insertedAt: ColumnNode;
 * const node: OrderNode = { kind: "order", expr: insertedAt, direction: "desc", nulls: "last" };
 * ```
 */
export interface OrderNode {
  readonly kind: "order";
  readonly expr: ExprNode;
  readonly direction: "asc" | "desc";
  readonly nulls: "first" | "last" | undefined;
}

/**
 * A table as a source: `"users" AS "u"`.
 *
 * @example
 * ```ts
 * declare const meta: SchemaMeta;
 * const node: TableSourceNode = { kind: "table", source: "users", meta, prefix: undefined, alias: "u" };
 * ```
 */
export interface TableSourceNode {
  readonly kind: "table";
  /** The table name. */
  readonly source: string;
  /** The schema the binding was created from; `undefined` for a schemaless table. */
  readonly meta: SchemaMeta | undefined;
  /** A prefix for this source alone; it wins over every other (see "Prefixes" on `Adapter`). */
  readonly prefix: string | undefined;
  /** The binding alias. */
  readonly alias: string;
}

/**
 * A reference to a common table expression of the query as a source: `"tree" AS "t"`.
 * It is a separate kind from a table because no prefix applies to it: the name is the
 * CTE's, not a table's in some schema.
 *
 * @example
 * ```ts
 * const node: CteSourceNode = { kind: "cteSource", name: "tree", meta: undefined, alias: "t" };
 * ```
 */
export interface CteSourceNode {
  readonly kind: "cteSource";
  /** The name of a {@link CteNode} of this query or of an enclosing one. */
  readonly name: string;
  /** The schema whose rows the CTE yields, when it was declared with one (`cte("tree", Category)`). */
  readonly meta: SchemaMeta | undefined;
  /** The binding alias. */
  readonly alias: string;
}

/**
 * A query as a source: `(SELECT …) AS "s"`.
 *
 * @example
 * ```ts
 * declare const query: QueryAst;
 * const node: SubquerySourceNode = { kind: "subquerySource", query, alias: "s" };
 * ```
 */
export interface SubquerySourceNode {
  readonly kind: "subquerySource";
  readonly query: QueryAst;
  readonly alias: string;
}

/**
 * An inline `VALUES` list as a source: `(VALUES ($1, $2), ($3, $4)) AS "v" ("id", "name")`.
 * Every cell is a bound parameter.
 *
 * Ecto equivalent: `values/2`.
 *
 * @example
 * ```ts
 * declare const one: ParamNode;
 * declare const a: ParamNode;
 * const node: ValuesSourceNode = { kind: "values", columns: ["id", "name"], rows: [[one, a]], alias: "v" };
 * ```
 */
export interface ValuesSourceNode {
  readonly kind: "values";
  readonly columns: readonly string[];
  readonly rows: readonly (readonly ExprNode[])[];
  readonly alias: string;
}

/**
 * A fragment as a source: `generate_series($1, $2) AS "g"`.
 *
 * @example
 * ```ts
 * declare const fragment: FragmentNode;
 * const node: FragmentSourceNode = { kind: "fragmentSource", fragment, columns: ["n"], alias: "g" };
 * ```
 */
export interface FragmentSourceNode {
  readonly kind: "fragmentSource";
  readonly fragment: FragmentNode;
  /** The column names the fragment produces. */
  readonly columns: readonly string[];
  readonly alias: string;
}

/**
 * Anything a query can select from or join.
 *
 * @example
 * ```ts
 * function aliasOf(source: SourceNode): string {
 *   return source.alias;
 * }
 * ```
 */
export type SourceNode =
  | TableSourceNode
  | CteSourceNode
  | SubquerySourceNode
  | ValuesSourceNode
  | FragmentSourceNode;

/**
 * The join kinds.
 *
 * @example
 * ```ts
 * const type: JoinType = "left";
 * ```
 */
export type JoinType = "inner" | "left" | "right" | "full" | "cross" | "innerLateral" | "leftLateral";

/**
 * One join: `LEFT JOIN "posts" AS "p" ON …`.
 *
 * @example
 * ```ts
 * declare const posts: TableSourceNode;
 * declare const on: ExprNode;
 * const node: JoinNode = { kind: "join", type: "left", source: posts, on };
 * ```
 */
export interface JoinNode {
  readonly kind: "join";
  readonly type: JoinType;
  readonly source: SourceNode;
  /** `undefined` for a cross join. */
  readonly on: ExprNode | undefined;
}

/**
 * One `where` or `having` call. `op` says how it combines with everything before it,
 * with Ecto's precedence: `where(a).where(b).orWhere(c)` is `(a AND b) OR c`. The `op` of
 * the first entry is ignored.
 *
 * @example
 * ```ts
 * declare const condition: ExprNode;
 * const node: BoolNode = { kind: "bool", op: "and", expr: condition };
 * ```
 */
export interface BoolNode {
  readonly kind: "bool";
  readonly op: "and" | "or";
  readonly expr: ExprNode;
}

/**
 * The shape of what a query selects, mirroring what the user's `select` callback
 * returned. The compiler flattens it into the select list and step 12 builds the row
 * decoder from it.
 *
 * - `expr`: one expression; `type` loads the value when present.
 * - `binding`: a whole binding, which expands to the persisted columns of its schema.
 * - `constant`: a plain value the callback returned (`{ kind: "user" }`). It is returned
 *   as it is and never sent to the database: no select-list entry, no parameter. The
 *   value is `constants[index]` of the enclosing {@link SelectNode}, so that it stays
 *   out of the tree's structure and queries that differ only in it share a plan.
 * - `object`: an object literal; `keys[i]` belongs to `values[i]`.
 * - `tuple`: an array literal.
 *
 * @example
 * ```ts
 * // select(({ u }) => ({ id: u.id, author: u, kind: "user" }))
 * declare const id: ColumnNode;
 * declare const meta: SchemaMeta;
 * const shape: SelectShape = {
 *   kind: "object",
 *   keys: ["id", "author", "kind"],
 *   values: [
 *     { kind: "expr", expr: id, type: undefined },
 *     { kind: "binding", binding: "u", meta },
 *     { kind: "constant", index: 0 },
 *   ],
 * };
 * ```
 */
export type SelectShape =
  | { readonly kind: "expr"; readonly expr: ExprNode; readonly type: AnyEctoType | undefined }
  | { readonly kind: "binding"; readonly binding: string; readonly meta: SchemaMeta }
  | { readonly kind: "constant"; readonly index: number }
  | { readonly kind: "object"; readonly keys: readonly string[]; readonly values: readonly SelectShape[] }
  | { readonly kind: "tuple"; readonly items: readonly SelectShape[] };

/**
 * The `select` clause: its shape, and the values of the shape's `constant` leaves.
 *
 * @example
 * ```ts
 * declare const shape: SelectShape;
 * const node: SelectNode = { kind: "select", shape, constants: ["user"] };
 * ```
 */
export interface SelectNode {
  readonly kind: "select";
  readonly shape: SelectShape;
  /** The plain values the select returns as they are; empty when it has none. Not part of the shape hash. */
  readonly constants: readonly unknown[];
}

/**
 * `DISTINCT` (empty `on`) or `DISTINCT ON (…)`.
 *
 * @example
 * ```ts
 * const node: DistinctNode = { kind: "distinct", on: [] };
 * ```
 */
export interface DistinctNode {
  readonly kind: "distinct";
  readonly on: readonly ExprNode[];
}

/**
 * A row lock: `FOR UPDATE`. A string is one of the adapter's `capabilities.lockModes`;
 * anything else is a fragment.
 *
 * @example
 * ```ts
 * const node: LockNode = { kind: "lock", clause: "FOR UPDATE" };
 * ```
 */
export interface LockNode {
  readonly kind: "lock";
  readonly clause: string | FragmentNode;
}

/**
 * A set operation with another query: `UNION ALL (SELECT …)`.
 *
 * @example
 * ```ts
 * declare const other: QueryAst;
 * const node: CombinationNode = { kind: "combination", op: "union", all: true, query: other };
 * ```
 */
export interface CombinationNode {
  readonly kind: "combination";
  readonly op: "union" | "intersect" | "except";
  readonly all: boolean;
  readonly query: QueryAst;
}

/**
 * A common table expression: `WITH [RECURSIVE] "name" AS [NOT] [MATERIALIZED] (…)`.
 *
 * `operation` says what the query inside does. `"all"` is a `SELECT`. `"updateAll"` and
 * `"deleteAll"` make a data-modifying CTE (`WITH "moved" AS (DELETE FROM … RETURNING …)`):
 * the query's `updates` are the assignments and its `select` is the `RETURNING` list. A
 * fragment is always `"all"`.
 *
 * @example
 * ```ts
 * declare const query: QueryAst;
 * const node: CteNode = {
 *   kind: "cte",
 *   name: "recent",
 *   query,
 *   operation: "all",
 *   recursive: false,
 *   materialized: undefined,
 * };
 * ```
 */
export interface CteNode {
  readonly kind: "cte";
  readonly name: string;
  readonly query: QueryAst | FragmentNode;
  readonly operation: QueryOperation;
  readonly recursive: boolean;
  /** `undefined` leaves the choice to the database. */
  readonly materialized: boolean | undefined;
}

/**
 * A named window: `WINDOW "w" AS (…)`.
 *
 * @example
 * ```ts
 * declare const spec: WindowNode;
 * const node: WindowDefNode = { kind: "windowDef", name: "w", spec };
 * ```
 */
export interface WindowDefNode {
  readonly kind: "windowDef";
  readonly name: string;
  readonly spec: WindowNode;
}

/**
 * One association to preload (step 14). It produces no SQL in the query itself, unless
 * `from` names a binding that the query already joins.
 *
 * @example
 * ```ts
 * const node: PreloadNode = { kind: "preload", assoc: "posts", from: undefined, query: undefined, nested: [] };
 * ```
 */
export interface PreloadNode {
  readonly kind: "preload";
  /** The association name on the schema being preloaded. */
  readonly assoc: string;
  /** The alias of a joined binding to take the rows from, for a join preload. */
  readonly from: string | undefined;
  /** A custom query for the associated rows. */
  readonly query: QueryAst | undefined;
  readonly nested: readonly PreloadNode[];
}

/**
 * One assignment of an `updateAll`: `SET "views" = "views" + $1`.
 *
 * Ecto equivalent: the `:set`, `:inc`, `:push` and `:pull` keys of `update/3`.
 *
 * @example
 * ```ts
 * declare const one: ParamNode;
 * const node: UpdateNode = { kind: "update", op: "inc", field: "views", column: "views", value: one };
 * ```
 */
export interface UpdateNode {
  readonly kind: "update";
  readonly op: "set" | "inc" | "push" | "pull";
  readonly field: string;
  readonly column: string;
  readonly value: ExprNode;
}

/**
 * What a `QueryAst` is compiled as: a `SELECT`, an `UPDATE` or a `DELETE`. The AST does
 * not record it; the caller says so (`Adapter.compile`, {@link CteNode.operation}).
 *
 * Ecto equivalent: the `:all`, `:update_all` and `:delete_all` operations of an adapter's `prepare/2`.
 *
 * @example
 * ```ts
 * const operation: QueryOperation = "all";
 * ```
 */
export type QueryOperation = "all" | "updateAll" | "deleteAll";

/**
 * A query, as data. See the module documentation for the rules, for the order of
 * `params` and for `shape`.
 *
 * Ecto equivalent: the `%Ecto.Query{}` struct.
 *
 * @example
 * ```ts
 * // from(User, "u")
 * declare const users: TableSourceNode;
 * const ast: QueryAst = {
 *   kind: "query",
 *   from: users,
 *   joins: [],
 *   wheres: [],
 *   select: undefined,
 *   distinct: undefined,
 *   groupBys: [],
 *   havings: [],
 *   orderBys: [],
 *   limit: undefined,
 *   offset: undefined,
 *   lock: undefined,
 *   combinations: [],
 *   ctes: [],
 *   windows: [],
 *   preloads: [],
 *   updates: [],
 *   prefix: undefined,
 *   hints: [],
 *   params: [],
 *   listLengths: [],
 *   shape: 0,
 * };
 * ```
 */
export interface QueryAst {
  readonly kind: "query";
  /** The root source. */
  readonly from: SourceNode;
  readonly joins: readonly JoinNode[];
  readonly wheres: readonly BoolNode[];
  /** `undefined` selects the whole root row. */
  readonly select: SelectNode | undefined;
  readonly distinct: DistinctNode | undefined;
  readonly groupBys: readonly ExprNode[];
  readonly havings: readonly BoolNode[];
  readonly orderBys: readonly OrderNode[];
  readonly limit: ExprNode | undefined;
  readonly offset: ExprNode | undefined;
  readonly lock: LockNode | undefined;
  readonly combinations: readonly CombinationNode[];
  readonly ctes: readonly CteNode[];
  readonly windows: readonly WindowDefNode[];
  readonly preloads: readonly PreloadNode[];
  /** The assignments of an `updateAll`; empty for every other operation. */
  readonly updates: readonly UpdateNode[];
  /**
   * The query-level prefix (Postgres schema, MySQL database). It does not override a
   * prefix that a schema declares. A query nested in this one (a subquery, a CTE body, a
   * set-operation branch) that sets none inherits it ("Prefixes" on `Adapter`, rule 1).
   */
  readonly prefix: string | undefined;
  /** Table hints, each a fragment. */
  readonly hints: readonly FragmentNode[];
  /** The bound values in canonical order. See "Parameter order" in the module documentation. */
  readonly params: readonly unknown[];
  /**
   * The lengths of the query's {@link ListNode}s in canonical order; empty when it has
   * none. Part of the plan-cache key on dialects that expand lists.
   */
  readonly listLengths: readonly number[];
  /** The structural hash. See "Shape" in the module documentation. */
  readonly shape: number;
}

/**
 * Every node that is not an expression.
 *
 * @example
 * ```ts
 * function describe(node: ClauseNode): string {
 *   return node.kind;
 * }
 * ```
 */
export type ClauseNode =
  | OrderNode
  | WindowNode
  | SourceNode
  | JoinNode
  | BoolNode
  | SelectNode
  | DistinctNode
  | LockNode
  | CombinationNode
  | CteNode
  | WindowDefNode
  | PreloadNode
  | UpdateNode
  | QueryAst;

/**
 * Any node of the query AST.
 *
 * @example
 * ```ts
 * function kindOf(node: QueryNode): string {
 *   return node.kind;
 * }
 * ```
 */
export type QueryNode = ExprNode | ClauseNode;
