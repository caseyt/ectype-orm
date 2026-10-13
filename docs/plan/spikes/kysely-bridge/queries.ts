// The statements the spike lowers, as functions from values to a hand-built AST. The
// values go into parameter nodes; the statement's parameter array is `collectParams(ast)`.
// Calling a function twice gives two ASTs of the same shape, which must share a plan.
import {
  agg,
  bin,
  col,
  fragment,
  type InsertAst,
  list,
  named,
  param,
  type SelectAst,
  select,
  table,
  type UpdateAst,
} from "./ast.js";

/**
 * The reference query of question 1:
 *
 *   SELECT u.id AS c0, count(p.id) AS c1 FROM users u JOIN posts p ON p.author_id = u.id
 *   WHERE u.age >= $1 AND p.published GROUP BY u.id ORDER BY u.inserted_at DESC LIMIT $2
 *
 * (`u.inserted_at` is functionally dependent on the grouped primary key, so Postgres accepts it.)
 */
export const reference = (minAge: number, limit: number): SelectAst =>
  select({
    from: table("users", "u"),
    joins: [
      { type: "inner", source: table("posts", "p"), on: bin(col("p", "author_id"), "=", col("u", "id")) },
    ],
    wheres: [bin(col("u", "age"), ">=", param(minAge)), col("p", "published")],
    select: [col("u", "id"), agg("count", col("p", "id"))],
    groupBys: [col("u", "id")],
    orderBys: [{ expr: col("u", "inserted_at"), direction: "desc" }],
    limit: param(limit),
  });
export const REFERENCE_SQL =
  'select "u"."id" as "c0", count("p"."id") as "c1" from "users" as "u" inner join "posts" as "p" on "p"."author_id" = "u"."id" where "u"."age" >= $1 and "p"."published" group by "u"."id" order by "u"."inserted_at" desc limit $2';

/** INSERT ... ON CONFLICT ... RETURNING. */
export const upsert = (email: string | null, name: string, age: number, bump: number): InsertAst => ({
  kind: "insert",
  table: "users",
  columns: ["email", "name", "age"],
  rows: [[param(email), param(name), param(age)]],
  onConflict: {
    target: ["email"],
    set: [
      { column: "name", value: { kind: "excluded", column: "name" } },
      { column: "lock_version", value: bin(col("users", "lock_version"), "+", param(bump)) },
    ],
  },
  returning: ["id", "email", "name", "lock_version"],
});
export const UPSERT_SQL =
  'insert into "users" ("email", "name", "age") values ($1, $2, $3) on conflict ("email") do update set "name" = "excluded"."name", "lock_version" = "users"."lock_version" + $4 returning "id" as "c0", "email" as "c1", "name" as "c2", "lock_version" as "c3"';

/** UPDATE ... RETURNING. Canonical parameter order: the SET values, then the WHERE values. */
export const update = (name: string, bump: number, id: unknown, lockVersion: number): UpdateAst => ({
  kind: "update",
  table: "users",
  alias: "u",
  set: [
    { column: "name", value: param(name) },
    { column: "lock_version", value: bin(col("u", "lock_version"), "+", param(bump)) },
  ],
  wheres: [bin(col("u", "id"), "=", param(id)), bin(col("u", "lock_version"), "=", param(lockVersion))],
  returning: ["id", "name", "lock_version"],
});
export const UPDATE_SQL =
  'update "users" as "u" set "name" = $1, "lock_version" = "u"."lock_version" + $2 where "u"."id" = $3 and "u"."lock_version" = $4 returning "u"."id" as "c0", "u"."name" as "c1", "u"."lock_version" as "c2"';

/** A CTE (MATERIALIZED) joined back to a table. */
export const cte = (minViews: number, limit: number): SelectAst =>
  select({
    ctes: [
      {
        name: "busy",
        materialized: true,
        query: select({
          from: table("posts", "p"),
          wheres: [bin(col("p", "views"), ">=", param(minViews))],
          select: [col("p", "author_id"), agg("count", col("p", "id"))],
          groupBys: [col("p", "author_id")],
        }),
      },
    ],
    from: table("users", "u"),
    joins: [{ type: "inner", source: table("busy", "b"), on: bin(col("b", "c0"), "=", col("u", "id")) }],
    select: [col("u", "id"), col("b", "c1")],
    orderBys: [{ expr: col("u", "id"), direction: "asc" }],
    limit: param(limit),
  });
export const CTE_SQL =
  'with "busy" as materialized (select "p"."author_id" as "c0", count("p"."id") as "c1" from "posts" as "p" where "p"."views" >= $1 group by "p"."author_id") select "u"."id" as "c0", "b"."c1" as "c1" from "users" as "u" inner join "busy" as "b" on "b"."c0" = "u"."id" order by "u"."id" asc limit $2';

/** A window function. */
export const windowed = (authorId: number): SelectAst =>
  select({
    from: table("posts", "p"),
    wheres: [bin(col("p", "author_id"), "=", param(authorId))],
    select: [
      col("p", "id"),
      {
        kind: "aggregate",
        fn: "row_number",
        args: [],
        over: {
          partitionBy: [col("p", "author_id")],
          orderBys: [{ expr: col("p", "views"), direction: "desc" }],
        },
      },
    ],
    orderBys: [{ expr: col("p", "id"), direction: "asc" }],
  });
export const WINDOW_SQL =
  'select "p"."id" as "c0", row_number() over(partition by "p"."author_id" order by "p"."views" desc) as "c1" from "posts" as "p" where "p"."author_id" = $1 order by "p"."id" asc';

/** A raw fragment with a column and a value interpolated. */
export const fragmented = (emailPrefix: string): SelectAst =>
  select({
    from: table("users", "u"),
    wheres: [fragment`starts_with(lower(${col("u", "email")}), ${param(emailPrefix)})`],
    select: [col("u", "id"), fragment`upper(${col("u", "name")})`],
    orderBys: [{ expr: col("u", "id"), direction: "asc" }],
  });
export const FRAGMENT_SQL =
  'select "u"."id" as "c0", upper("u"."name") as "c1" from "users" as "u" where starts_with(lower("u"."email"), $1) order by "u"."id" asc';

/** Precedence: (a OR b) AND c must keep its parentheses. */
export const precedence = (age1: number, age2: number, role: string): SelectAst =>
  select({
    from: table("users", "u"),
    wheres: [
      {
        kind: "nary",
        op: "or",
        args: [bin(col("u", "age"), "=", param(age1)), bin(col("u", "age"), "=", param(age2))],
      },
      bin(col("u", "role"), "=", param(role)),
    ],
    select: [col("u", "id")],
    orderBys: [{ expr: col("u", "id"), direction: "asc" }],
  });
export const PRECEDENCE_SQL =
  'select "u"."id" as "c0" from "users" as "u" where ("u"."age" = $1 or "u"."age" = $2) and "u"."role" = $3 order by "u"."id" asc';

/**
 * For question 2: a statement whose placeholder order is as far from its canonical
 * parameter order as the subset allows. Canonical order (the order of `collectParams`):
 *
 *   0 minViews      CTE: WHERE p.views >= ?
 *   1 minPosts      CTE: HAVING count(p.id) >= ?
 *   2 commentIds    join subquery: EXISTS (… c.id = ANY(?))
 *   3 maxAge        WHERE u.age <= ?
 *   4 tagIds        WHERE EXISTS (… pt.tag_id = ANY(?))
 *   5 bonus         SELECT list: b.c1 + ?        (emitted FIRST in the SQL text)
 *   6 limit         LIMIT ?
 *   7 offset        OFFSET ?
 *   8 unionMinPosts UNION ALL branch: WHERE b.c1 >= ?
 *   and the named parameter `minAge`, which is used twice.
 *
 * In the SQL text the select list comes before FROM and WHERE, and the UNION ALL branch
 * before ORDER BY, LIMIT and OFFSET, so the placeholders appear in the order
 * 0, 1, 5, 2, 3, minAge, 4, 8, minAge, 6, 7.
 */
export interface SlotValues {
  readonly minViews: number;
  readonly minPosts: number;
  readonly commentIds: readonly number[];
  readonly maxAge: number;
  readonly tagIds: readonly number[];
  readonly bonus: number;
  readonly limit: number;
  readonly offset: number;
  readonly unionMinPosts: number;
  readonly minAge: number;
}
export const slots = (v: SlotValues): SelectAst =>
  select({
    ctes: [
      {
        name: "busy",
        query: select({
          from: table("posts", "p"),
          wheres: [bin(col("p", "views"), ">=", param(v.minViews))],
          select: [col("p", "author_id"), agg("count", col("p", "id"))],
          groupBys: [col("p", "author_id")],
          havings: [bin(agg("count", col("p", "id")), ">=", param(v.minPosts))],
        }),
      },
    ],
    from: table("users", "u"),
    joins: [
      { type: "inner", source: table("busy", "b"), on: bin(col("b", "c0"), "=", col("u", "id")) },
      {
        type: "left",
        source: {
          kind: "subquery",
          alias: "cp",
          query: select({
            from: table("posts", "p2"),
            wheres: [
              {
                kind: "exists",
                query: select({
                  from: table("comments", "c"),
                  wheres: [
                    bin(col("c", "post_id"), "=", col("p2", "id")),
                    { kind: "in", left: col("c", "id"), list: list(v.commentIds) },
                  ],
                  select: [col("c", "id")],
                }),
              },
            ],
            select: [col("p2", "author_id"), agg("count", col("p2", "id"))],
            groupBys: [col("p2", "author_id")],
          }),
        },
        on: bin(col("cp", "c0"), "=", col("u", "id")),
      },
    ],
    wheres: [
      bin(col("u", "age"), "<=", param(v.maxAge)),
      bin(col("u", "age"), ">=", named("minAge")),
      {
        kind: "exists",
        query: select({
          from: table("posts", "p3"),
          joins: [
            {
              type: "inner",
              source: table("posts_tags", "pt"),
              on: bin(col("pt", "post_id"), "=", col("p3", "id")),
            },
          ],
          wheres: [
            bin(col("p3", "author_id"), "=", col("u", "id")),
            { kind: "in", left: col("pt", "tag_id"), list: list(v.tagIds) },
          ],
          select: [col("p3", "id")],
        }),
      },
    ],
    select: [col("u", "id"), bin(col("b", "c1"), "+", param(v.bonus)), col("cp", "c1")],
    unionAll: [
      select({
        from: table("users", "u"),
        joins: [{ type: "inner", source: table("busy", "b"), on: bin(col("b", "c0"), "=", col("u", "id")) }],
        wheres: [
          bin(col("b", "c1"), ">=", param(v.unionMinPosts)),
          bin(col("u", "age"), "<", named("minAge")),
        ],
        select: [col("u", "id"), col("b", "c1"), fragment`null::bigint`],
      }),
    ],
    orderBys: [
      { expr: fragment`c0`, direction: "asc" },
      { expr: fragment`c1`, direction: "asc" },
    ],
    limit: param(v.limit),
    offset: param(v.offset),
  });

/** The same statement written by hand, with the values in the order of ITS placeholders. */
export const SLOTS_HAND_WRITTEN = `
  WITH busy AS (
    SELECT p.author_id AS c0, count(p.id) AS c1 FROM posts p
    WHERE p.views >= $1 GROUP BY p.author_id HAVING count(p.id) >= $2
  )
  SELECT u.id AS c0, b.c1 + $3 AS c1, cp.c1 AS c2
  FROM users u
  JOIN busy b ON b.c0 = u.id
  LEFT JOIN (
    SELECT p2.author_id AS c0, count(p2.id) AS c1 FROM posts p2
    WHERE EXISTS (SELECT c.id FROM comments c WHERE c.post_id = p2.id AND c.id = ANY($4))
    GROUP BY p2.author_id
  ) cp ON cp.c0 = u.id
  WHERE u.age <= $5 AND u.age >= $6
    AND EXISTS (
      SELECT p3.id FROM posts p3 JOIN posts_tags pt ON pt.post_id = p3.id
      WHERE p3.author_id = u.id AND pt.tag_id = ANY($7)
    )
  UNION ALL
  SELECT u.id, b.c1, null::bigint FROM users u JOIN busy b ON b.c0 = u.id
  WHERE b.c1 >= $8 AND u.age < $6
  ORDER BY c0, c1 LIMIT $9 OFFSET $10`;
export const slotsHandWrittenParams = (v: SlotValues): unknown[] => [
  v.minViews,
  v.minPosts,
  v.bonus,
  v.commentIds,
  v.maxAge,
  v.minAge,
  v.tagIds,
  v.unionMinPosts,
  v.limit,
  v.offset,
];
