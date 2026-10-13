// Question 5 — Gaps.
//
// For each SQL feature Ecto queries need, can Kysely's node set express it? Every case
// below builds a node tree with Kysely's factories, compiles it with PostgresQueryCompiler,
// compares the SQL with the expected text and EXECUTES it against Postgres.
//
// How a case is classified:
//   native     only Kysely nodes that model the construct.
//   keyword    a Kysely node models the construct; one fixed keyword, operator or type name
//              is supplied as a RawNode because Kysely's typed list lacks it.
//   raw glue   no node models the construct: a RawNode supplies its fixed SQL text, while
//              every identifier and value inside stays a real node (quoted / bound).
//   inline     no node and no raw text needed: the lowering rewrites it to an equivalent form.
//
// In every class the raw text is a constant of the lowering code. No case needs a user
// value or identifier in SQL text.
import assert from "node:assert/strict";
import {
  AggregateFunctionNode,
  AliasNode,
  AndNode,
  BinaryOperationNode,
  CaseNode,
  CastNode,
  ColumnNode,
  ColumnUpdateNode,
  CommonTableExpressionNameNode,
  CommonTableExpressionNode,
  DataTypeNode,
  DefaultInsertValueNode,
  type DeleteQueryNode,
  ExplainNode,
  FromNode,
  FunctionNode,
  GroupByItemNode,
  GroupByNode,
  HavingNode,
  IdentifierNode,
  type InsertQueryNode,
  JoinNode,
  LimitNode,
  OffsetNode,
  OnConflictNode,
  type OperationNode,
  OperatorNode,
  OrderByItemNode,
  OrderByNode,
  OverNode,
  ParensNode,
  PartitionByItemNode,
  PartitionByNode,
  RawNode,
  ReferenceNode,
  ReturningNode,
  type RootOperationNode,
  SelectAllNode,
  SelectionNode,
  SelectModifierNode,
  type SelectQueryNode,
  SetOperationNode,
  TableNode,
  TupleNode,
  UnaryOperationNode,
  type UpdateQueryNode,
  UsingNode,
  ValueListNode,
  ValueNode,
  ValuesNode,
  WhenNode,
  WhereNode,
  WithNode,
} from "kysely";
import pg from "pg";
import { compileNode, type ParamSlot } from "./bridge.js";
import { Bridge, main } from "./db.js";

type Class = "native" | "keyword" | "raw glue" | "inline";

interface Case {
  readonly feature: string;
  readonly class: Class;
  /** What the lowering has to do, for the ADR table. */
  readonly how: string;
  readonly sql: string;
  readonly params?: readonly unknown[];
  readonly node: RootOperationNode;
  /** Optional hand-written statement whose rows must equal this case's rows. */
  readonly sameRowsAs?: string;
  /** Rolled back after running (statements that write). */
  readonly writes?: boolean;
}

// --- Small helpers over Kysely's factories. ---

const created = new Set<ParamSlot>();
/** A bound parameter: the slot technique of question 2. */
function v(index: number): OperationNode {
  const slot: ParamSlot = { kind: "inline", index };
  created.add(slot);
  return ValueNode.create(slot);
}
const table = (name: string) => TableNode.create(name);
const column = (name: string) => ColumnNode.create(name);
const ref = (binding: string, name: string) => ReferenceNode.create(column(name), table(binding));
const ident = (name: string) => IdentifierNode.create(name);
const as = (node: OperationNode, alias: string) => AliasNode.create(node, ident(alias));
const from = (name: string, alias: string) => FromNode.create([as(table(name), alias)]);
const op = (left: OperationNode, operator: Parameters<typeof OperatorNode.create>[0], right: OperationNode) =>
  BinaryOperationNode.create(left, OperatorNode.create(operator), right);
const sel = (...nodes: OperationNode[]) => nodes.map((node, i) => SelectionNode.create(as(node, `c${i}`)));
const order = (node: OperationNode, direction: "asc" | "desc" = "asc") =>
  OrderByItemNode.create(node, RawNode.createWithSql(direction));
const orderBy = (...items: ReturnType<typeof order>[]) => OrderByNode.create(items);
const where = (node: OperationNode) => WhereNode.create(node);
const count = (...args: OperationNode[]) => AggregateFunctionNode.create("count", args);
const TRUE = ValueNode.createImmediate(true);
const NULL = ValueNode.createImmediate(null);
const select = (props: Omit<SelectQueryNode, "kind">): SelectQueryNode => ({
  kind: "SelectQueryNode",
  ...props,
});
const lock = (...endModifiers: SelectModifierNode[]): SelectQueryNode =>
  select({
    from: from("users", "u"),
    selections: sel(ref("u", "id")),
    where: where(op(ref("u", "id"), "=", v(0))),
    endModifiers,
  });
const LOCK_SQL = 'select "u"."id" as "c0" from "users" as "u" where "u"."id" = $1';

const publishedPosts = select({
  from: from("posts", "p"),
  selections: sel(ref("p", "id"), ref("p", "views")),
  where: where(AndNode.create(op(ref("p", "author_id"), "=", ref("u", "id")), ref("p", "published"))),
  orderBy: orderBy(order(ref("p", "views"), "desc")),
  limit: LimitNode.create(v(0)),
});

const postsWindow = (over: OperationNode): SelectQueryNode =>
  select({
    from: from("posts", "p"),
    selections: sel(ref("p", "id"), over),
    where: where(op(ref("p", "author_id"), "<=", v(0))),
    orderBy: orderBy(order(ref("p", "id"))),
  });

const partitionAndOrder = [
  PartitionByNode.create([PartitionByItemNode.create(ref("p", "author_id"))]),
  orderBy(order(ref("p", "id"))),
] as const;
const overAuthor = OverNode.cloneWithOrderByItems(
  OverNode.cloneWithPartitionByItems(OverNode.create(), [PartitionByItemNode.create(ref("p", "author_id"))]),
  [order(ref("p", "id"))],
);

const CASES: Case[] = [
  // ---- Lock clauses -------------------------------------------------------
  {
    feature: "lock: FOR UPDATE",
    class: "native",
    how: "SelectModifierNode in endModifiers",
    node: lock(SelectModifierNode.create("ForUpdate")),
    sql: `${LOCK_SQL} for update`,
    params: [1],
  },
  {
    feature: "lock: FOR UPDATE OF u SKIP LOCKED",
    class: "native",
    how: "SelectModifierNode with `of`, plus a SkipLocked modifier",
    node: lock(SelectModifierNode.create("ForUpdate", [table("u")]), SelectModifierNode.create("SkipLocked")),
    sql: `${LOCK_SQL} for update of "u" skip locked`,
    params: [1],
  },
  {
    feature: "lock: FOR NO KEY UPDATE NOWAIT",
    class: "native",
    how: "SelectModifierNode",
    node: lock(SelectModifierNode.create("ForNoKeyUpdate"), SelectModifierNode.create("NoWait")),
    sql: `${LOCK_SQL} for no key update nowait`,
    params: [1],
  },
  {
    feature: "lock: FOR KEY SHARE",
    class: "native",
    how: "SelectModifierNode",
    node: lock(SelectModifierNode.create("ForKeyShare")),
    sql: `${LOCK_SQL} for key share`,
    params: [1],
  },
  {
    feature: "lock: any other lock text (Ecto lock: fragment)",
    class: "raw glue",
    how: "SelectModifierNode.createWithExpression(RawNode) with text from an allowlist or a fragment",
    node: lock(SelectModifierNode.createWithExpression(RawNode.createWithSql("for share of u nowait"))),
    sql: `${LOCK_SQL} for share of u nowait`,
    params: [1],
  },

  // ---- DISTINCT -----------------------------------------------------------
  {
    feature: "DISTINCT",
    class: "native",
    how: "SelectModifierNode('Distinct') in frontModifiers",
    node: select({
      from: from("users", "u"),
      frontModifiers: [SelectModifierNode.create("Distinct")],
      selections: sel(ref("u", "role")),
    }),
    sql: 'select distinct "u"."role" as "c0" from "users" as "u"',
  },
  {
    feature: "DISTINCT ON (expr, …)",
    class: "native",
    how: "SelectQueryNode.distinctOn",
    node: select({
      from: from("posts", "p"),
      distinctOn: [ref("p", "author_id")],
      selections: sel(ref("p", "author_id"), ref("p", "id")),
      orderBy: orderBy(order(ref("p", "author_id")), order(ref("p", "views"), "desc")),
    }),
    sql: 'select distinct on ("p"."author_id") "p"."author_id" as "c0", "p"."id" as "c1" from "posts" as "p" order by "p"."author_id" asc, "p"."views" desc',
    sameRowsAs:
      "SELECT DISTINCT ON (p.author_id) p.author_id AS c0, p.id AS c1 FROM posts p ORDER BY p.author_id, p.views DESC",
  },

  // ---- Joins --------------------------------------------------------------
  {
    feature: "LEFT JOIN LATERAL (subquery) ON true",
    class: "native",
    how: "JoinNode('LateralLeftJoin') over an aliased SelectQueryNode",
    node: select({
      from: from("users", "u"),
      joins: [JoinNode.createWithOn("LateralLeftJoin", as(publishedPosts, "top"), TRUE)],
      selections: sel(ref("u", "id"), ref("top", "c0")),
      orderBy: orderBy(order(ref("u", "id")), order(ref("top", "c0"))),
    }),
    sql: 'select "u"."id" as "c0", "top"."c0" as "c1" from "users" as "u" left join lateral (select "p"."id" as "c0", "p"."views" as "c1" from "posts" as "p" where "p"."author_id" = "u"."id" and "p"."published" order by "p"."views" desc limit $1) as "top" on true order by "u"."id" asc, "top"."c0" asc',
    params: [2],
    sameRowsAs:
      "SELECT u.id AS c0, top.c0 AS c1 FROM users u LEFT JOIN LATERAL (SELECT p.id AS c0 FROM posts p WHERE p.author_id = u.id AND p.published ORDER BY p.views DESC LIMIT 2) top ON true ORDER BY u.id, top.c0",
  },
  {
    feature: "CROSS JOIN LATERAL (subquery)",
    class: "native",
    how: "JoinNode('LateralCrossJoin')",
    node: select({
      from: from("users", "u"),
      joins: [JoinNode.create("LateralCrossJoin", as(publishedPosts, "top"))],
      selections: sel(ref("u", "id"), ref("top", "c0")),
    }),
    sql: 'select "u"."id" as "c0", "top"."c0" as "c1" from "users" as "u" cross join lateral (select "p"."id" as "c0", "p"."views" as "c1" from "posts" as "p" where "p"."author_id" = "u"."id" and "p"."published" order by "p"."views" desc limit $1) as "top"',
    params: [1],
  },
  {
    feature: "FULL JOIN and CROSS JOIN",
    class: "native",
    how: "JoinNode('FullJoin' | 'CrossJoin')",
    node: select({
      from: from("users", "u"),
      joins: [
        JoinNode.createWithOn(
          "FullJoin",
          as(table("profiles"), "pr"),
          op(ref("pr", "user_id"), "=", ref("u", "id")),
        ),
        JoinNode.create("CrossJoin", as(table("tags"), "t")),
      ],
      selections: sel(count(SelectAllNode.create())),
    }),
    sql: 'select count(*) as "c0" from "users" as "u" full join "profiles" as "pr" on "pr"."user_id" = "u"."id" cross join "tags" as "t"',
  },
  {
    feature: "schema prefix on a table",
    class: "native",
    how: "TableNode.createWithSchema",
    node: select({
      from: FromNode.create([as(TableNode.createWithSchema("public", "users"), "u")]),
      selections: sel(count(SelectAllNode.create())),
    }),
    sql: 'select count(*) as "c0" from "public"."users" as "u"',
  },
  {
    feature: "TABLESAMPLE (Ecto hints)",
    class: "raw glue",
    how: "RawNode around the aliased table",
    node: select({
      from: FromNode.create([
        RawNode.create(["", " tablesample system (", ")"], [as(table("posts"), "p"), v(0)]),
      ]),
      selections: sel(count(SelectAllNode.create())),
    }),
    sql: 'select count(*) as "c0" from "posts" as "p" tablesample system ($1)',
    params: [50],
  },

  // ---- Aggregates and windows --------------------------------------------
  {
    feature: "aggregate FILTER (WHERE …)",
    class: "native",
    how: "AggregateFunctionNode.filter",
    node: select({
      from: from("posts", "p"),
      selections: sel(
        ref("p", "author_id"),
        AggregateFunctionNode.cloneWithFilter(count(ref("p", "id")), ref("p", "published")),
      ),
      groupBy: GroupByNode.create([GroupByItemNode.create(ref("p", "author_id"))]),
      having: HavingNode.create(op(count(ref("p", "id")), ">", v(0))),
      orderBy: orderBy(order(ref("p", "author_id"))),
    }),
    sql: 'select "p"."author_id" as "c0", count("p"."id") filter(where "p"."published") as "c1" from "posts" as "p" group by "p"."author_id" having count("p"."id") > $1 order by "p"."author_id" asc',
    params: [1],
    sameRowsAs:
      "SELECT p.author_id AS c0, count(p.id) FILTER (WHERE p.published) AS c1 FROM posts p GROUP BY p.author_id HAVING count(p.id) > 1 ORDER BY p.author_id",
  },
  {
    feature: "count(DISTINCT x), agg(x ORDER BY y)",
    class: "native",
    how: "AggregateFunctionNode.distinct / .orderBy",
    node: select({
      from: from("posts", "p"),
      selections: sel(
        AggregateFunctionNode.cloneWithDistinct(count(ref("p", "author_id"))),
        AggregateFunctionNode.cloneWithOrderBy(AggregateFunctionNode.create("array_agg", [ref("p", "id")]), [
          order(ref("p", "id"), "desc"),
        ]),
      ),
      where: where(op(ref("p", "author_id"), "=", v(0))),
    }),
    sql: 'select count(distinct "p"."author_id") as "c0", array_agg("p"."id" order by "p"."id" desc) as "c1" from "posts" as "p" where "p"."author_id" = $1',
    params: [1],
  },
  {
    feature: "window: fn() OVER (PARTITION BY col ORDER BY …)",
    class: "native",
    how: "AggregateFunctionNode.over with OverNode",
    node: postsWindow(
      AggregateFunctionNode.cloneWithOver(
        AggregateFunctionNode.create("sum", [ref("p", "views")]),
        overAuthor,
      ),
    ),
    sql: 'select "p"."id" as "c0", sum("p"."views") over(partition by "p"."author_id" order by "p"."id" asc) as "c1" from "posts" as "p" where "p"."author_id" <= $1 order by "p"."id" asc',
    params: [3],
  },
  {
    feature: "window frame (ROWS BETWEEN …)",
    class: "raw glue",
    how: "OverNode has no frame: the whole OVER (…) is a RawNode around the function, partition and order nodes",
    node: postsWindow(
      RawNode.create(
        ["", " over (", " ", " rows between unbounded preceding and current row)"],
        [AggregateFunctionNode.create("sum", [ref("p", "views")]), ...partitionAndOrder],
      ),
    ),
    sql: 'select "p"."id" as "c0", sum("p"."views") over (partition by "p"."author_id" order by "p"."id" asc rows between unbounded preceding and current row) as "c1" from "posts" as "p" where "p"."author_id" <= $1 order by "p"."id" asc',
    params: [3],
    sameRowsAs:
      "SELECT p.id AS c0, sum(p.views) OVER (PARTITION BY p.author_id ORDER BY p.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS c1 FROM posts p WHERE p.author_id <= 3 ORDER BY p.id",
  },
  {
    feature: "named windows (WINDOW w AS (…), OVER w)",
    class: "inline",
    how: "SelectQueryNode has no WINDOW clause: the lowering expands the named definition at each use",
    node: postsWindow(
      AggregateFunctionNode.cloneWithOver(AggregateFunctionNode.create("row_number", []), overAuthor),
    ),
    sql: 'select "p"."id" as "c0", row_number() over(partition by "p"."author_id" order by "p"."id" asc) as "c1" from "posts" as "p" where "p"."author_id" <= $1 order by "p"."id" asc',
    params: [3],
    sameRowsAs:
      "SELECT p.id AS c0, row_number() OVER w AS c1 FROM posts p WHERE p.author_id <= 3 WINDOW w AS (PARTITION BY p.author_id ORDER BY p.id) ORDER BY p.id",
  },
  {
    feature: "PARTITION BY an expression",
    class: "raw glue",
    how: "PartitionByItemNode is typed for column references only: raw OVER (…) as for frames",
    node: postsWindow(
      RawNode.create(
        ["", " over (partition by ", ")"],
        [AggregateFunctionNode.create("count", [SelectAllNode.create()]), op(ref("p", "views"), "%", v(1))],
      ),
    ),
    sql: 'select "p"."id" as "c0", count(*) over (partition by "p"."views" % $1) as "c1" from "posts" as "p" where "p"."author_id" <= $2 order by "p"."id" asc',
    params: [3, 2],
  },

  // ---- Operators ----------------------------------------------------------
  {
    feature: "array operators @> and &&; col = ANY($1); $1 = ANY(col)",
    class: "native",
    how: "OperatorNode; FunctionNode('any') around one array parameter",
    node: select({
      from: from("posts", "p"),
      selections: sel(count(SelectAllNode.create())),
      where: where(
        AndNode.create(
          AndNode.create(
            AndNode.create(op(ref("p", "tags"), "@>", v(0)), op(ref("p", "tags"), "&&", v(1))),
            op(ref("p", "id"), "=", FunctionNode.create("any", [v(2)])),
          ),
          op(v(3), "=", FunctionNode.create("any", [ref("p", "tags")])),
        ),
      ),
    }),
    sql: 'select count(*) as "c0" from "posts" as "p" where "p"."tags" @> $1 and "p"."tags" && $2 and "p"."id" = any($3) and $4 = any("p"."tags")',
    params: [["all"], ["t1", "zzz"], [1, 2, 3, 4, 5, 6], "all"],
    sameRowsAs:
      "SELECT count(*) AS c0 FROM posts p WHERE p.tags @> ARRAY['all'] AND p.tags && ARRAY['t1','zzz'] AND p.id = ANY(ARRAY[1,2,3,4,5,6]) AND 'all' = ANY(p.tags)",
  },
  {
    feature: "ILIKE, IS DISTINCT FROM, IS NULL, BETWEEN, NOT",
    class: "native",
    how: "OperatorNode, UnaryOperationNode, immediate NULL",
    node: select({
      from: from("users", "u"),
      selections: sel(count(SelectAllNode.create())),
      where: where(
        AndNode.create(
          AndNode.create(
            AndNode.create(
              AndNode.create(
                op(ref("u", "email"), "ilike", v(0)),
                op(ref("u", "name"), "is distinct from", v(1)),
              ),
              op(ref("u", "settings"), "is", NULL),
            ),
            op(ref("u", "age"), "between", AndNode.create(v(2), v(3))),
          ),
          UnaryOperationNode.create(
            OperatorNode.create("not"),
            ParensNode.create(op(ref("u", "role"), "=", v(4))),
          ),
        ),
      ),
    }),
    sql: 'select count(*) as "c0" from "users" as "u" where "u"."email" ilike $1 and "u"."name" is distinct from $2 and "u"."settings" is null and "u"."age" between $3 and $4 and not ("u"."role" = $5)',
    params: ["USER1%", "User 10", 18, 60, "admin"],
    sameRowsAs:
      "SELECT count(*) AS c0 FROM users u WHERE u.email ILIKE 'USER1%' AND u.name IS DISTINCT FROM 'User 10' AND u.settings IS NULL AND u.age BETWEEN 18 AND 60 AND NOT (u.role = 'admin')",
  },
  {
    feature: "JSON -> and ->>, jsonb @>",
    class: "native",
    how: "OperatorNode with bound keys",
    node: select({
      from: from("users", "u"),
      selections: sel(op(op(ref("u", "settings"), "->", v(0)), "->>", v(1))),
      where: where(op(ref("u", "settings"), "@>", CastNode.create(v(2), DataTypeNode.create("jsonb")))),
    }),
    sql: 'select "u"."settings" -> $1 ->> $2 as "c0" from "users" as "u" where "u"."settings" @> cast($3 as jsonb)',
    params: ["ui", "theme", '{"ui":{"theme":"dark"}}'],
  },
  {
    feature: "JSON #>> (path as text[])",
    class: "keyword",
    how: "operator text from RawNode (not in Kysely's operator list)",
    node: select({
      from: from("users", "u"),
      selections: sel(BinaryOperationNode.create(ref("u", "settings"), RawNode.createWithSql("#>>"), v(0))),
      where: where(op(ref("u", "id"), "=", v(1))),
    }),
    sql: 'select "u"."settings" #>> $1 as "c0" from "users" as "u" where "u"."id" = $2',
    params: [["ui", "theme"], 1],
  },
  {
    feature: "CAST(x AS text) and CAST($1 AS int8[]), a type Kysely does not list",
    class: "keyword",
    how: "CastNode; DataTypeNode for listed types, RawNode from an allowlist for others (int8[], citext, …)",
    node: select({
      from: from("users", "u"),
      selections: sel(CastNode.create(ref("u", "age"), DataTypeNode.create("text"))),
      where: where(
        op(
          ref("u", "id"),
          "=",
          FunctionNode.create("any", [CastNode.create(v(0), RawNode.createWithSql("int8[]"))]),
        ),
      ),
      orderBy: orderBy(order(ref("u", "id"))),
    }),
    sql: 'select cast("u"."age" as text) as "c0" from "users" as "u" where "u"."id" = any(cast($1 as int8[])) order by "u"."id" asc',
    params: [["1", "2"]],
    sameRowsAs: "SELECT u.age::text AS c0 FROM users u WHERE u.id IN (1, 2) ORDER BY u.id",
  },
  {
    feature: "tuple comparison (a, b) > ($1, $2)",
    class: "native",
    how: "TupleNode",
    node: select({
      from: from("posts", "p"),
      selections: sel(ref("p", "id")),
      where: where(
        op(TupleNode.create([ref("p", "author_id"), ref("p", "id")]), ">", TupleNode.create([v(0), v(1)])),
      ),
      orderBy: orderBy(order(ref("p", "author_id")), order(ref("p", "id"))),
      limit: LimitNode.create(v(2)),
      offset: OffsetNode.create(v(3)),
    }),
    sql: 'select "p"."id" as "c0" from "posts" as "p" where ("p"."author_id", "p"."id") > ($1, $2) order by "p"."author_id" asc, "p"."id" asc limit $3 offset $4',
    params: [2, 3, 5, 1],
    sameRowsAs:
      "SELECT p.id AS c0 FROM posts p WHERE (p.author_id, p.id) > (2, 3) ORDER BY p.author_id, p.id LIMIT 5 OFFSET 1",
  },
  {
    feature: "CASE WHEN … THEN … ELSE … END, coalesce()",
    class: "native",
    how: "CaseNode / WhenNode, FunctionNode",
    node: select({
      from: from("users", "u"),
      selections: sel(
        CaseNode.cloneWith(
          CaseNode.cloneWithWhen(
            CaseNode.create(),
            WhenNode.cloneWithResult(WhenNode.create(op(ref("u", "age"), "<", v(0))), v(1)),
          ),
          { else: v(2) },
        ),
        FunctionNode.create("coalesce", [ref("u", "name"), ref("u", "email")]),
      ),
      orderBy: orderBy(order(ref("u", "id"))),
      limit: LimitNode.create(v(3)),
    }),
    sql: 'select case when "u"."age" < $1 then $2 else $3 end as "c0", coalesce("u"."name", "u"."email") as "c1" from "users" as "u" order by "u"."id" asc limit $4',
    params: [18, "minor", "adult", 4],
    sameRowsAs:
      "SELECT CASE WHEN u.age < 18 THEN 'minor' ELSE 'adult' END AS c0, coalesce(u.name, u.email) AS c1 FROM users u ORDER BY u.id LIMIT 4",
  },
  {
    feature: "EXISTS (subquery), IN (subquery), scalar subquery",
    class: "native",
    how: "UnaryOperationNode('exists'), nested SelectQueryNode (parenthesised by the compiler)",
    node: select({
      from: from("users", "u"),
      selections: sel(
        ref("u", "id"),
        select({
          from: from("posts", "p"),
          selections: [SelectionNode.create(as(count(SelectAllNode.create()), "n"))],
          where: where(op(ref("p", "author_id"), "=", ref("u", "id"))),
        }),
      ),
      where: where(
        AndNode.create(
          UnaryOperationNode.create(
            OperatorNode.create("exists"),
            select({
              from: from("posts", "p"),
              selections: sel(v(0)),
              where: where(op(ref("p", "author_id"), "=", ref("u", "id"))),
            }),
          ),
          op(
            ref("u", "id"),
            "in",
            select({
              from: from("posts", "p"),
              selections: sel(ref("p", "author_id")),
              where: where(op(ref("p", "views"), ">", v(1))),
            }),
          ),
        ),
      ),
      orderBy: orderBy(order(ref("u", "id"))),
      limit: LimitNode.create(v(2)),
    }),
    sql: 'select "u"."id" as "c0", (select count(*) as "n" from "posts" as "p" where "p"."author_id" = "u"."id") as "c1" from "users" as "u" where exists (select $1 as "c0" from "posts" as "p" where "p"."author_id" = "u"."id") and "u"."id" in (select "p"."author_id" as "c0" from "posts" as "p" where "p"."views" > $2) order by "u"."id" asc limit $3',
    params: [1, 10, 3],
  },
  {
    feature: "ORDER BY … NULLS LAST",
    class: "native",
    how: "OrderByItemNode.nulls",
    node: select({
      from: from("users", "u"),
      selections: sel(ref("u", "id")),
      orderBy: orderBy(
        OrderByItemNode.cloneWith(order(ref("u", "name"), "desc"), { nulls: "last" }),
        order(ref("u", "id")),
      ),
      limit: LimitNode.create(v(0)),
    }),
    sql: 'select "u"."id" as "c0" from "users" as "u" order by "u"."name" desc nulls last, "u"."id" asc limit $1',
    params: [3],
  },

  // ---- CTEs and combinations ---------------------------------------------
  {
    feature: "WITH … AS NOT MATERIALIZED",
    class: "native",
    how: "CommonTableExpressionNode.materialized = false",
    node: select({
      with: WithNode.create(
        CommonTableExpressionNode.cloneWith(
          CommonTableExpressionNode.create(
            CommonTableExpressionNameNode.create("adults"),
            select({
              from: from("users", "u"),
              selections: sel(ref("u", "id")),
              where: where(op(ref("u", "age"), ">=", v(0))),
            }),
          ),
          { materialized: false },
        ),
      ),
      from: from("adults", "a"),
      selections: sel(count(SelectAllNode.create())),
    }),
    sql: 'with "adults" as not materialized (select "u"."id" as "c0" from "users" as "u" where "u"."age" >= $1) select count(*) as "c0" from "adults" as "a"',
    params: [18],
  },
  {
    feature: "WITH RECURSIVE name(columns) … UNION ALL",
    class: "native",
    how: "WithNode.recursive, CommonTableExpressionNameNode with columns, SetOperationNode",
    node: select({
      with: WithNode.create(
        CommonTableExpressionNode.create(
          CommonTableExpressionNameNode.create("n", ["i"]),
          select({
            // A bare parameter in a select list has no type and Postgres takes it as text
            // ("operator does not exist: text + unknown"), so a selected parameter is cast.
            // That is a rule for the lowering (it knows the EctoType), whatever the back end.
            selections: [
              SelectionNode.create(as(CastNode.create(v(0), DataTypeNode.create("integer")), "i")),
            ],
            setOperations: [
              SetOperationNode.create(
                "union",
                select({
                  from: FromNode.create([table("n")]),
                  selections: [SelectionNode.create(as(op(ref("n", "i"), "+", v(1)), "i"))],
                  where: where(op(ref("n", "i"), "<", v(2))),
                }),
                true,
              ),
            ],
          }),
        ),
        { recursive: true },
      ),
      from: FromNode.create([table("n")]),
      selections: sel(FunctionNode.create("sum", [ref("n", "i")])),
    }),
    sql: 'with recursive "n"("i") as (select cast($1 as integer) as "i" union all select "n"."i" + $2 as "i" from "n" where "n"."i" < $3) select sum("n"."i") as "c0" from "n"',
    params: [1, 1, 10],
    sameRowsAs: "SELECT 55::bigint AS c0",
  },
  {
    feature: "EXCEPT, with ORDER BY and LIMIT on the combined result",
    class: "native",
    how: "SelectQueryNode.setOperations",
    node: select({
      from: from("users", "u"),
      selections: sel(ref("u", "id")),
      where: where(op(ref("u", "age"), "<", v(0))),
      setOperations: [
        SetOperationNode.create(
          "except",
          select({
            from: from("posts", "p"),
            selections: sel(ref("p", "author_id")),
            where: where(op(ref("p", "views"), ">", v(1))),
          }),
          false,
        ),
      ],
      orderBy: orderBy(OrderByItemNode.create(ident("c0"), RawNode.createWithSql("desc"))),
      limit: LimitNode.create(v(2)),
    }),
    sql: 'select "u"."id" as "c0" from "users" as "u" where "u"."age" < $1 except select "p"."author_id" as "c0" from "posts" as "p" where "p"."views" > $2 order by "c0" desc limit $3',
    params: [30, 1000, 4],
    sameRowsAs:
      "SELECT u.id AS c0 FROM users u WHERE u.age < 30 EXCEPT SELECT p.author_id FROM posts p WHERE p.views > 1000 ORDER BY c0 DESC LIMIT 4",
  },
  {
    feature: "VALUES list as a source, with a column alias list (Ecto values/2)",
    class: "raw glue",
    how: "ValuesNode in parentheses; the alias `v(a, b)` is a RawNode over IdentifierNodes",
    node: select({
      from: FromNode.create([
        AliasNode.create(
          ParensNode.create(
            ValuesNode.create([ValueListNode.create([v(0), v(1)]), ValueListNode.create([v(2), v(3)])]),
          ),
          RawNode.create(["", "(", ", ", ")"], [ident("v"), ident("id"), ident("label")]),
        ),
      ]),
      joins: [
        JoinNode.createWithOn(
          "InnerJoin",
          as(table("users"), "u"),
          op(ref("u", "id"), "=", CastNode.create(ref("v", "id"), DataTypeNode.create("bigint"))),
        ),
      ],
      selections: sel(ref("u", "email"), ref("v", "label")),
      orderBy: orderBy(order(ref("u", "id"))),
    }),
    sql: 'select "u"."email" as "c0", "v"."label" as "c1" from (values ($1, $2), ($3, $4)) as "v"("id", "label") inner join "users" as "u" on "u"."id" = cast("v"."id" as bigint) order by "u"."id" asc',
    params: ["1", "one", "2", "two"],
    sameRowsAs:
      "SELECT u.email AS c0, v.label AS c1 FROM (VALUES (1, 'one'), (2, 'two')) AS v(id, label) JOIN users u ON u.id = v.id ORDER BY u.id",
  },

  // ---- Writes -------------------------------------------------------------
  {
    feature: "ON CONFLICT ON CONSTRAINT name DO NOTHING",
    class: "native",
    how: "OnConflictNode.constraint + doNothing",
    writes: true,
    node: {
      kind: "InsertQueryNode",
      into: table("users"),
      columns: [column("email")],
      values: ValuesNode.create([ValueListNode.create([v(0)])]),
      onConflict: OnConflictNode.cloneWith(OnConflictNode.create(), {
        constraint: ident("users_email_key"),
        doNothing: true,
      }),
      returning: ReturningNode.create(sel(column("id"))),
    } satisfies InsertQueryNode,
    sql: 'insert into "users" ("email") values ($1) on conflict on constraint "users_email_key" do nothing returning "id" as "c0"',
    params: ["user1@example.com"],
  },
  {
    feature: "ON CONFLICT (expr) WHERE … DO UPDATE SET … WHERE … (partial / expression index)",
    class: "native",
    how: "OnConflictNode.indexExpression, indexWhere, updates, updateWhere",
    writes: true,
    node: {
      kind: "InsertQueryNode",
      into: table("tags"),
      columns: [column("name")],
      values: ValuesNode.create([ValueListNode.create([v(0)])]),
      onConflict: OnConflictNode.cloneWithUpdateWhere(
        OnConflictNode.cloneWithIndexWhere(
          OnConflictNode.cloneWith(OnConflictNode.create(), {
            indexExpression: FunctionNode.create("lower", [column("name")]),
            updates: [ColumnUpdateNode.create(column("name"), ref("excluded", "name"))],
          }),
          op(column("name"), "is not", NULL),
        ),
        op(ref("tags", "name"), "<>", ref("excluded", "name")),
      ),
      returning: ReturningNode.create(sel(column("name"))),
    } satisfies InsertQueryNode,
    sql: 'insert into "tags" ("name") values ($1) on conflict (lower("name")) where "name" is not null do update set "name" = "excluded"."name" where "tags"."name" <> "excluded"."name" returning "name" as "c0"',
    params: ["TypeScript"],
  },
  {
    feature: "ON CONFLICT DO NOTHING (no target)",
    class: "native",
    how: "OnConflictNode.doNothing",
    writes: true,
    node: {
      kind: "InsertQueryNode",
      into: table("users"),
      columns: [column("email")],
      values: ValuesNode.create([ValueListNode.create([v(0)])]),
      onConflict: OnConflictNode.cloneWith(OnConflictNode.create(), { doNothing: true }),
    } satisfies InsertQueryNode,
    sql: 'insert into "users" ("email") values ($1) on conflict do nothing',
    params: ["user2@example.com"],
  },
  {
    feature: "multi-row INSERT with DEFAULT in a cell",
    class: "native",
    how: "DefaultInsertValueNode",
    writes: true,
    node: {
      kind: "InsertQueryNode",
      into: table("users"),
      columns: [column("email"), column("role")],
      values: ValuesNode.create([
        ValueListNode.create([v(0), DefaultInsertValueNode.create()]),
        ValueListNode.create([v(1), v(2)]),
      ]),
      returning: ReturningNode.create(sel(column("role"))),
    } satisfies InsertQueryNode,
    sql: 'insert into "users" ("email", "role") values ($1, default), ($2, $3) returning "role" as "c0"',
    params: ["d1@example.com", "d2@example.com", "admin"],
  },
  {
    feature: "INSERT … DEFAULT VALUES",
    class: "native",
    how: "InsertQueryNode.defaultValues",
    writes: true,
    node: {
      kind: "InsertQueryNode",
      into: table("tags"),
      defaultValues: true,
      returning: ReturningNode.create(sel(column("id"))),
    } satisfies InsertQueryNode,
    sql: 'insert into "tags" default values returning "id" as "c0"',
  },
  {
    feature: "INSERT … SELECT (insert_all from a query)",
    class: "native",
    how: "InsertQueryNode.values = SelectQueryNode",
    writes: true,
    node: {
      kind: "InsertQueryNode",
      into: table("tags"),
      columns: [column("name")],
      values: select({
        from: from("users", "u"),
        selections: [SelectionNode.create(ref("u", "email"))],
        where: where(op(ref("u", "id"), "<=", v(0))),
      }),
    } satisfies InsertQueryNode,
    sql: 'insert into "tags" ("name") select "u"."email" from "users" as "u" where "u"."id" <= $1',
    params: [3],
  },
  {
    feature: "UPDATE … FROM … (update_all with a join)",
    class: "native",
    how: "UpdateQueryNode.from",
    writes: true,
    node: {
      kind: "UpdateQueryNode",
      table: as(table("posts"), "p"),
      updates: [ColumnUpdateNode.create(column("views"), op(ref("p", "views"), "+", v(0)))],
      from: from("users", "u"),
      where: where(
        AndNode.create(op(ref("u", "id"), "=", ref("p", "author_id")), op(ref("u", "age"), ">=", v(1))),
      ),
      returning: ReturningNode.create(sel(ref("p", "id"))),
    } satisfies UpdateQueryNode,
    sql: 'update "posts" as "p" set "views" = "p"."views" + $1 from "users" as "u" where "u"."id" = "p"."author_id" and "u"."age" >= $2 returning "p"."id" as "c0"',
    params: [1, 60],
  },
  {
    feature: "DELETE … USING … RETURNING (delete_all with a join)",
    class: "native",
    how: "DeleteQueryNode.using",
    writes: true,
    node: {
      kind: "DeleteQueryNode",
      from: from("posts", "p"),
      using: UsingNode.create([as(table("users"), "u")]),
      where: where(
        AndNode.create(op(ref("u", "id"), "=", ref("p", "author_id")), op(ref("u", "age"), "<", v(0))),
      ),
      returning: ReturningNode.create(sel(ref("p", "id"))),
    } satisfies DeleteQueryNode,
    sql: 'delete from "posts" as "p" using "users" as "u" where "u"."id" = "p"."author_id" and "u"."age" < $1 returning "p"."id" as "c0"',
    params: [17],
  },

  // ---- Introspection ------------------------------------------------------
  {
    feature: "EXPLAIN (ANALYZE, FORMAT JSON)",
    class: "keyword",
    how: "ExplainNode on the root query; the option list is a RawNode from an allowlist",
    node: select({
      explain: ExplainNode.create("json", RawNode.createWithSql("analyze")),
      from: from("users", "u"),
      selections: sel(ref("u", "id")),
      where: where(op(ref("u", "id"), "=", v(0))),
    }),
    sql: 'explain (analyze, format json) select "u"."id" as "c0" from "users" as "u" where "u"."id" = $1',
    params: [1],
  },
];

await main("Question 5: gaps", { users: 40, postsPerUser: 6 }, async (db) => {
  const bridge = await Bridge.open(db.config);
  const direct = new pg.Pool(db.config);
  // The JSON cases need one row with settings.
  await direct.query(`UPDATE users SET settings = '{"ui":{"theme":"dark"}}' WHERE id = 1`);
  // The expression-index ON CONFLICT case needs a matching partial unique index.
  await direct.query(
    "CREATE UNIQUE INDEX tags_lower_name_index ON tags (lower(name)) WHERE name IS NOT NULL",
  );
  const table: string[] = ["| Feature | Kysely | How |", "|---|---|---|"];
  const counts: Record<Class, number> = { native: 0, keyword: 0, "raw glue": 0, inline: 0 };
  try {
    for (const c of CASES) {
      const plan = compileNode(c.node, created, "postgres");
      assert.equal(plan.sql, c.sql, c.feature);
      const params = c.params ?? [];
      assert.equal(
        new Set(plan.slots.map((slot) => (slot as { index: number }).index)).size,
        params.length,
        `${c.feature}: every parameter is used`,
      );

      const connection = await bridge.acquire();
      let rows: unknown[];
      try {
        if (c.writes) await bridge.begin(connection);
        rows = (await bridge.run(connection, plan, params)).rows;
        if (c.writes) await bridge.rollback(connection);
      } finally {
        await bridge.release(connection);
      }
      let compared = "";
      if (c.sameRowsAs !== undefined) {
        const expected = await direct.query(c.sameRowsAs);
        assert.deepStrictEqual(rows, expected.rows, `${c.feature}: rows`);
        assert.ok(expected.rows.length > 0, `${c.feature}: the comparison is empty`);
        compared = `, rows equal the hand-written statement's (${expected.rows.length})`;
      }
      counts[c.class] += 1;
      console.log(`  ok  [${c.class}] ${c.feature}: executed${compared}`);
      table.push(`| ${c.feature.replaceAll("|", "\\|")} | ${c.class} | ${c.how.replaceAll("|", "\\|")} |`);
    }
  } finally {
    await bridge.close();
    await direct.end();
  }
  const summary = Object.entries(counts)
    .map(([name, n]) => `${n} ${name}`)
    .join(", ");
  console.log(`\n${CASES.length} features compiled to the expected SQL and executed: ${summary}.\n`);
  console.log(table.join("\n"));
  console.log(
    "\nQuestion 5: every feature tried is expressible; the keyword, raw-glue and inline cases are listed above.",
  );
});
