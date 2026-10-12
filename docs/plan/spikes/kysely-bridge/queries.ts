// The statements the spike lowers, as hand-built ASTs with their parameter arrays.
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
export const REFERENCE: SelectAst = select({
  from: { table: "users", alias: "u" },
  joins: [
    {
      type: "inner",
      source: { table: "posts", alias: "p" },
      on: bin(col("p", "author_id"), "=", col("u", "id")),
    },
  ],
  wheres: [bin(col("u", "age"), ">=", param(0)), col("p", "published")],
  select: [col("u", "id"), agg("count", col("p", "id"))],
  groupBys: [col("u", "id")],
  orderBys: [{ expr: col("u", "inserted_at"), direction: "desc" }],
  limit: param(1),
});
export const REFERENCE_SQL =
  'select "u"."id" as "c0", count("p"."id") as "c1" from "users" as "u" inner join "posts" as "p" on "p"."author_id" = "u"."id" where "u"."age" >= $1 and "p"."published" group by "u"."id" order by "u"."inserted_at" desc limit $2';

/** INSERT ... ON CONFLICT ... RETURNING. Params: [email, name, age]. */
export const UPSERT: InsertAst = {
  kind: "insert",
  table: "users",
  columns: ["email", "name", "age"],
  rows: [[param(0), param(1), param(2)]],
  onConflict: {
    target: ["email"],
    set: [
      { column: "name", value: { kind: "excluded", column: "name" } },
      { column: "lock_version", value: bin(col("users", "lock_version"), "+", param(3)) },
    ],
  },
  returning: ["id", "email", "name", "lock_version"],
};
export const UPSERT_SQL =
  'insert into "users" ("email", "name", "age") values ($1, $2, $3) on conflict ("email") do update set "name" = "excluded"."name", "lock_version" = "users"."lock_version" + $4 returning "id" as "c0", "email" as "c1", "name" as "c2", "lock_version" as "c3"';

/** UPDATE ... RETURNING. Params: [name, id, lockVersion]. */
export const UPDATE: UpdateAst = {
  kind: "update",
  table: "users",
  alias: "u",
  set: [
    { column: "name", value: param(0) },
    { column: "lock_version", value: bin(col("u", "lock_version"), "+", param(3)) },
  ],
  wheres: [bin(col("u", "id"), "=", param(1)), bin(col("u", "lock_version"), "=", param(2))],
  returning: ["id", "name", "lock_version"],
};
export const UPDATE_SQL =
  'update "users" as "u" set "name" = $1, "lock_version" = "u"."lock_version" + $2 where "u"."id" = $3 and "u"."lock_version" = $4 returning "u"."id" as "c0", "u"."name" as "c1", "u"."lock_version" as "c2"';

/** A CTE (MATERIALIZED) joined back to a table. Params: [minViews, limit]. */
export const CTE: SelectAst = select({
  ctes: [
    {
      name: "busy",
      materialized: true,
      query: select({
        from: { table: "posts", alias: "p" },
        wheres: [bin(col("p", "views"), ">=", param(0))],
        select: [col("p", "author_id"), agg("count", col("p", "id"))],
        groupBys: [col("p", "author_id")],
      }),
    },
  ],
  from: { table: "users", alias: "u" },
  joins: [
    { type: "inner", source: { table: "busy", alias: "b" }, on: bin(col("b", "c0"), "=", col("u", "id")) },
  ],
  select: [col("u", "id"), col("b", "c1")],
  orderBys: [{ expr: col("u", "id"), direction: "asc" }],
  limit: param(1),
});
export const CTE_SQL =
  'with "busy" as materialized (select "p"."author_id" as "c0", count("p"."id") as "c1" from "posts" as "p" where "p"."views" >= $1 group by "p"."author_id") select "u"."id" as "c0", "b"."c1" as "c1" from "users" as "u" inner join "busy" as "b" on "b"."c0" = "u"."id" order by "u"."id" asc limit $2';

/** A window function. Params: [authorId]. */
export const WINDOW: SelectAst = select({
  from: { table: "posts", alias: "p" },
  wheres: [bin(col("p", "author_id"), "=", param(0))],
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

/** A raw fragment with a column and a value interpolated. Params: [emailPrefix]. */
export const FRAGMENT: SelectAst = select({
  from: { table: "users", alias: "u" },
  wheres: [fragment`starts_with(lower(${col("u", "email")}), ${param(0)})`],
  select: [col("u", "id"), fragment`upper(${col("u", "name")})`],
  orderBys: [{ expr: col("u", "id"), direction: "asc" }],
});
export const FRAGMENT_SQL =
  'select "u"."id" as "c0", upper("u"."name") as "c1" from "users" as "u" where starts_with(lower("u"."email"), $1) order by "u"."id" asc';

/**
 * For question 2: one parameter used twice, out of order, next to a named parameter and a list.
 * Params: [maxAge, ids]; named: { minAge }.
 * The first placeholder in the SQL text is the `params[1]` list, and `params[0]` appears twice.
 */
export const SLOTS: SelectAst = select({
  from: { table: "users", alias: "u" },
  wheres: [
    { kind: "in", left: col("u", "id"), list: list(1) },
    bin(col("u", "age"), ">=", named("minAge")),
    bin(col("u", "age"), "<=", param(0)),
    bin(col("u", "age"), "<>", param(0)),
  ],
  select: [col("u", "id"), col("u", "age")],
  orderBys: [{ expr: col("u", "id"), direction: "asc" }],
});

/** Precedence: (a OR b) AND c must keep its parentheses. Params: [age1, age2, role]. */
export const PRECEDENCE: SelectAst = select({
  from: { table: "users", alias: "u" },
  wheres: [
    {
      kind: "nary",
      op: "or",
      args: [bin(col("u", "age"), "=", param(0)), bin(col("u", "age"), "=", param(1))],
    },
    bin(col("u", "role"), "=", param(2)),
  ],
  select: [col("u", "id")],
  orderBys: [{ expr: col("u", "id"), direction: "asc" }],
});
export const PRECEDENCE_SQL =
  'select "u"."id" as "c0" from "users" as "u" where ("u"."age" = $1 or "u"."age" = $2) and "u"."role" = $3 order by "u"."id" asc';
