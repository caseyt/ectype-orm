// The bridge under test: AST -> Kysely OperationNode tree -> dialect compiler -> cached plan.
//
// Nothing here uses Kysely's fluent builder (`Kysely`, `selectFrom`, `sql` template, …).
// Nodes are created with Kysely's node factories and compiled by a QueryCompiler instance
// that is created once and reused.
import {
  AggregateFunctionNode,
  AliasNode,
  AndNode,
  BinaryOperationNode,
  ColumnNode,
  ColumnUpdateNode,
  CommonTableExpressionNameNode,
  CommonTableExpressionNode,
  FromNode,
  FunctionNode,
  GroupByItemNode,
  GroupByNode,
  IdentifierNode,
  type InsertQueryNode,
  JoinNode,
  LimitNode,
  MysqlQueryCompiler,
  OnConflictNode,
  type OperationNode,
  OperatorNode,
  OrderByItemNode,
  OrderByNode,
  OrNode,
  OverNode,
  ParensNode,
  PartitionByItemNode,
  PostgresQueryCompiler,
  type QueryCompiler,
  RawNode,
  ReferenceNode,
  ReturningNode,
  type RootOperationNode,
  SelectionNode,
  type SelectQueryNode,
  SqliteQueryCompiler,
  TableNode,
  type UpdateQueryNode,
  ValueListNode,
  ValueNode,
  ValuesNode,
  WhereNode,
  WithNode,
} from "kysely";
import type { Ast, Expr, InsertAst, OrderBy, SelectAst, Source, UpdateAst } from "./ast.js";

export type DialectName = "postgres" | "mysql" | "sqlite";

/**
 * Where one placeholder of the compiled SQL gets its value at execution time.
 * Mirrors `ParamSlot` in packages/core/src/contracts/adapter.ts (without the `dump` field).
 */
export type ParamSlot =
  /** `params[index]`. */
  | { readonly kind: "inline"; readonly index: number }
  /** `params[index]`, an array bound as ONE parameter (`= ANY($1)`). */
  | { readonly kind: "list"; readonly index: number }
  /** `params[index][element]`: one placeholder of an expanded `IN (?, ?, …)`. */
  | { readonly kind: "element"; readonly index: number; readonly element: number }
  /** `named[name]`. */
  | { readonly kind: "named"; readonly name: string };

/** What the plan cache would hold: SQL text plus the recipe for the parameter array. */
export interface Plan {
  readonly sql: string;
  readonly slots: readonly ParamSlot[];
  /** Kept only because Kysely's driver API wants a node on every CompiledQuery. */
  readonly node: RootOperationNode;
}

interface Dialect {
  readonly name: DialectName;
  readonly compiler: QueryCompiler;
  /** True when an array can be bound as one parameter (`= ANY($1)`). */
  readonly arrayParams: boolean;
}

// One compiler per dialect for the life of the process. A compiler instance costs ~100
// bound closures to construct (OperationNodeVisitor), so it must not be created per query.
// compileQuery() resets its state and is synchronous, so sharing it is safe.
const DIALECTS: Record<DialectName, Dialect> = {
  postgres: { name: "postgres", compiler: new PostgresQueryCompiler(), arrayParams: true },
  mysql: { name: "mysql", compiler: new MysqlQueryCompiler(), arrayParams: false },
  sqlite: { name: "sqlite", compiler: new SqliteQueryCompiler(), arrayParams: false },
};

/** Operators are emitted from this table only; no operator text ever comes from a caller. */
const OPERATORS = {
  "=": OperatorNode.create("="),
  "<>": OperatorNode.create("<>"),
  ">": OperatorNode.create(">"),
  ">=": OperatorNode.create(">="),
  "<": OperatorNode.create("<"),
  "<=": OperatorNode.create("<="),
  like: OperatorNode.create("like"),
  "+": OperatorNode.create("+"),
  "@>": OperatorNode.create("@>"),
  in: OperatorNode.create("in"),
} as const;

const ASC = RawNode.createWithSql("asc");
const DESC = RawNode.createWithSql("desc");

/** Function names are appended to the SQL unquoted by Kysely, so they are validated here. */
const FUNCTION_NAME = /^[a-z_][a-z0-9_]*$/;

class Lowering {
  /** Every slot object handed to Kysely as a ValueNode value, to verify the output. */
  readonly created = new Set<ParamSlot>();

  constructor(
    readonly dialect: Dialect,
    /** Needed only by dialects that expand lists: the expansion depends on the length. */
    readonly params: readonly unknown[],
  ) {}

  /** The technique under test: the "value" of a ValueNode is the slot object itself. */
  slot(slot: ParamSlot): OperationNode {
    this.created.add(slot);
    return ValueNode.create(slot);
  }

  ref(binding: string, column: string): ReferenceNode {
    return ReferenceNode.create(ColumnNode.create(column), TableNode.create(binding));
  }

  source(source: Source): OperationNode {
    return AliasNode.create(TableNode.create(source.table), IdentifierNode.create(source.alias));
  }

  /** `nested` is true when the result is an operand, so a compound expression needs parentheses. */
  expr(expr: Expr, nested = false): OperationNode {
    switch (expr.kind) {
      case "column":
        return this.ref(expr.binding, expr.column);
      case "param":
        return this.slot({ kind: "inline", index: expr.index });
      case "namedParam":
        return this.slot({ kind: "named", name: expr.name });
      case "list":
        return this.slot({ kind: "list", index: expr.index });
      case "excluded":
        return this.ref("excluded", expr.column);
      case "binary": {
        const node = BinaryOperationNode.create(
          this.expr(expr.left, true),
          OPERATORS[expr.op],
          this.expr(expr.right, true),
        );
        return nested ? ParensNode.create(node) : node;
      }
      case "nary": {
        // Kysely's compiler emits no parentheses of its own: precedence is our job.
        const create = expr.op === "and" ? AndNode.create : OrNode.create;
        const [first, ...rest] = expr.args;
        if (first === undefined) throw new Error("empty and/or");
        let node = this.expr(first, expr.args.length > 1 && first.kind === "nary");
        for (const arg of rest) node = create(node, this.expr(arg, arg.kind === "nary"));
        return nested && expr.args.length > 1 ? ParensNode.create(node) : node;
      }
      case "in": {
        const left = this.expr(expr.left, true);
        if (this.dialect.arrayParams) {
          // One array parameter: the SQL does not depend on the list length.
          return BinaryOperationNode.create(
            left,
            OPERATORS["="],
            FunctionNode.create("any", [this.slot({ kind: "list", index: expr.list.index })]),
          );
        }
        const values = this.params[expr.list.index];
        if (!Array.isArray(values)) throw new Error(`params[${expr.list.index}] is not an array`);
        const index = expr.list.index;
        const items = values.map((_, element) => this.slot({ kind: "element", index, element }));
        return BinaryOperationNode.create(left, OPERATORS.in, ValueListNode.create(items));
      }
      case "aggregate": {
        if (!FUNCTION_NAME.test(expr.fn)) throw new Error(`bad function name ${JSON.stringify(expr.fn)}`);
        let node = AggregateFunctionNode.create(
          expr.fn,
          expr.args.map((arg) => this.expr(arg)),
        );
        if (expr.filter !== undefined) {
          node = AggregateFunctionNode.cloneWithFilter(node, this.expr(expr.filter));
        }
        if (expr.over !== undefined) {
          let over = OverNode.create();
          if (expr.over.partitionBy.length > 0) {
            over = OverNode.cloneWithPartitionByItems(
              over,
              expr.over.partitionBy.map((item) => {
                // Kysely types PARTITION BY items as plain column references. Anything else
                // is a gap: see 05-gaps.ts ("PARTITION BY an expression").
                if (item.kind !== "column") throw new Error("PARTITION BY takes a column in this spike");
                return PartitionByItemNode.create(this.ref(item.binding, item.column));
              }),
            );
          }
          if (expr.over.orderBys.length > 0) {
            over = OverNode.cloneWithOrderByItems(over, this.orderItems(expr.over.orderBys));
          }
          node = AggregateFunctionNode.cloneWithOver(node, over);
        }
        return node;
      }
      case "fragment":
        // The static strings come from a template literal in the program text; every
        // interpolation is lowered as a node, so values inside it are still slots.
        return RawNode.create(
          expr.strings,
          expr.args.map((arg) => this.expr(arg, true)),
        );
    }
  }

  orderItems(orderBys: readonly OrderBy[]) {
    return orderBys.map((o) =>
      OrderByItemNode.create(this.expr(o.expr), o.direction === "desc" ? DESC : ASC),
    );
  }

  where(wheres: readonly Expr[]) {
    return wheres.length === 0
      ? undefined
      : WhereNode.create(this.expr({ kind: "nary", op: "and", args: wheres }));
  }

  returning(table: string | undefined, columns: readonly string[]) {
    return ReturningNode.create(
      columns.map((column, i) =>
        SelectionNode.create(
          AliasNode.create(
            table === undefined ? ColumnNode.create(column) : this.ref(table, column),
            IdentifierNode.create(`c${i}`),
          ),
        ),
      ),
    );
  }

  select(ast: SelectAst): SelectQueryNode {
    let withNode: WithNode | undefined;
    for (const cte of ast.ctes) {
      let node = CommonTableExpressionNode.create(
        CommonTableExpressionNameNode.create(cte.name),
        this.select(cte.query),
      );
      if (cte.materialized !== undefined) {
        node = CommonTableExpressionNode.cloneWith(node, { materialized: cte.materialized });
      }
      withNode =
        withNode === undefined ? WithNode.create(node) : WithNode.cloneWithExpression(withNode, node);
    }
    const where = this.where(ast.wheres);
    // One object literal for the root, checked against Kysely's own interface.
    return {
      kind: "SelectQueryNode",
      ...(withNode !== undefined && { with: withNode }),
      from: FromNode.create([this.source(ast.from)]),
      selections: ast.select.map((expr, i) =>
        SelectionNode.create(AliasNode.create(this.expr(expr), IdentifierNode.create(`c${i}`))),
      ),
      ...(ast.joins.length > 0 && {
        joins: ast.joins.map((join) =>
          JoinNode.createWithOn(
            join.type === "inner" ? "InnerJoin" : "LeftJoin",
            this.source(join.source),
            this.expr(join.on),
          ),
        ),
      }),
      ...(where !== undefined && { where }),
      ...(ast.groupBys.length > 0 && {
        groupBy: GroupByNode.create(ast.groupBys.map((expr) => GroupByItemNode.create(this.expr(expr)))),
      }),
      ...(ast.orderBys.length > 0 && { orderBy: OrderByNode.create(this.orderItems(ast.orderBys)) }),
      ...(ast.limit !== undefined && { limit: LimitNode.create(this.expr(ast.limit)) }),
    } satisfies SelectQueryNode;
  }

  insert(ast: InsertAst): InsertQueryNode {
    let onConflict: OnConflictNode | undefined;
    if (ast.onConflict !== undefined) {
      onConflict = OnConflictNode.cloneWith(OnConflictNode.create(), {
        columns: ast.onConflict.target.map((column) => ColumnNode.create(column)),
        updates: ast.onConflict.set.map((set) =>
          ColumnUpdateNode.create(ColumnNode.create(set.column), this.expr(set.value)),
        ),
      });
    }
    return {
      kind: "InsertQueryNode",
      into: TableNode.create(ast.table),
      columns: ast.columns.map((column) => ColumnNode.create(column)),
      values: ValuesNode.create(
        ast.rows.map((row) => ValueListNode.create(row.map((expr) => this.expr(expr)))),
      ),
      ...(onConflict !== undefined && { onConflict }),
      ...(ast.returning.length > 0 && { returning: this.returning(undefined, ast.returning) }),
    } satisfies InsertQueryNode;
  }

  update(ast: UpdateAst): UpdateQueryNode {
    const where = this.where(ast.wheres);
    return {
      kind: "UpdateQueryNode",
      table: this.source({ table: ast.table, alias: ast.alias }),
      updates: ast.set.map((set) =>
        ColumnUpdateNode.create(ColumnNode.create(set.column), this.expr(set.value)),
      ),
      ...(where !== undefined && { where }),
      ...(ast.returning.length > 0 && { returning: this.returning(ast.alias, ast.returning) }),
    } satisfies UpdateQueryNode;
  }

  root(ast: Ast): RootOperationNode {
    switch (ast.kind) {
      case "select":
        return this.select(ast);
      case "insert":
        return this.insert(ast);
      case "update":
        return this.update(ast);
    }
  }
}

/** AST -> Kysely node tree. Exposed separately so the cost of each stage can be measured. */
export function lower(ast: Ast, dialect: DialectName, params: readonly unknown[] = []) {
  const lowering = new Lowering(DIALECTS[dialect], params);
  return { node: lowering.root(ast), created: lowering.created };
}

/**
 * Compiles a node tree and recovers the parameter slots.
 *
 * Kysely's compiler pushes `ValueNode.value` onto its parameter list untouched, in the
 * order the placeholders appear in the SQL text. Because every value we lowered is a slot
 * object, `compiled.parameters` IS the slot list: no mapping step, no placeholder parsing.
 * Any other entry would mean a value reached the tree by another route, so it is an error.
 */
export function compileNode(
  node: RootOperationNode,
  created: ReadonlySet<ParamSlot>,
  dialect: DialectName,
): Plan {
  const compiled = DIALECTS[dialect].compiler.compileQuery(node, SHARED_QUERY_ID);
  for (const parameter of compiled.parameters) {
    if (!created.has(parameter as ParamSlot)) {
      throw new Error(`compiled parameter is not a slot: ${String(parameter)}`);
    }
  }
  return { sql: compiled.sql, slots: compiled.parameters as readonly ParamSlot[], node };
}

/** Compilation needs a query id only to copy it onto the result; one frozen object will do. */
const SHARED_QUERY_ID = Object.freeze({ queryId: "ectype-spike-compile" });

/** Cold path: lower + compile + slot recovery. */
export function compile(ast: Ast, dialect: DialectName = "postgres", params: readonly unknown[] = []): Plan {
  const { node, created } = lower(ast, dialect, params);
  return compileNode(node, created, dialect);
}

/**
 * Hot path: builds the driver's parameter array for one execution of a cached plan.
 * One allocation (the output array) and one loop.
 */
export function bindParams(
  slots: readonly ParamSlot[],
  params: readonly unknown[],
  named: Readonly<Record<string, unknown>> | undefined,
): unknown[] {
  const out = new Array<unknown>(slots.length);
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i] as ParamSlot;
    switch (slot.kind) {
      case "inline":
      case "list":
        out[i] = params[slot.index];
        break;
      case "element":
        out[i] = (params[slot.index] as readonly unknown[])[slot.element];
        break;
      case "named":
        if (named === undefined || !Object.hasOwn(named, slot.name)) {
          throw new Error(`missing named parameter ${JSON.stringify(slot.name)}`);
        }
        out[i] = named[slot.name];
        break;
    }
  }
  return out;
}
