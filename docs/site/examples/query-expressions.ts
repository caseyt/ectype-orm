// The checked sources of the code blocks in guide/query-expressions.md. Each `#region` is
// included in the page by name; everything outside a region is the scaffolding that makes
// the regions compile.
//
// The query builder (`from`, `where`, `select`) arrives with the next step, so the
// bindings `u` and `p` that a clause callback receives are declared here with the type
// they will have.
import {
  type AnySchema,
  and,
  arrayAgg,
  avg,
  type Col,
  caseWhen,
  coalesce,
  count,
  countDistinct,
  type Expr,
  type FieldNames,
  fragment,
  hasMany,
  lit,
  max,
  min,
  not,
  now,
  or,
  param,
  type Row,
  Schema,
  type SomeParams,
  stringAgg,
  sum,
  t,
  timestamps,
  val,
} from "egon-orm";

class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  authorId: t.integer(),
  title: t.string(),
  published: t.boolean().nullable().default(false),
  views: t.integer().nullable().default(0),
  tags: t.array(t.string()).nullable(),
  ...timestamps(),
}) {}

class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  firstName: t.string(),
  lastName: t.string(),
  age: t.integer().nullable(),
  role: t.enum(["admin", "member"]).default("member"),
  loginCount: t.integer().default(0),
  banned: t.boolean().default(false),
  settings: t.json<{ theme: string; limits: number[] }>().nullable(),
  ...timestamps(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });
}

/** A binding as a clause callback receives it: one column per field. */
type Binding<S extends AnySchema> = {
  readonly [K in FieldNames<S>]: Col<K extends keyof Row<S> ? Row<S>[K] : never>;
};
declare const u: Binding<typeof User>;
declare const p: Binding<typeof Post>;
declare const a: Expr<boolean>;
declare const b: Expr<boolean>;
declare const c: Expr<boolean>;
declare const search: string;
declare const column: string;
declare const terms: string;
// A query that selects user ids, as `from(Post, "p").select(({ p }) => p.authorId)` will be.
declare const subqueryOfIds: Exclude<
  Parameters<Col<number>["in"]>[0],
  readonly unknown[] | Expr<unknown, SomeParams>
>;

export function overview() {
  // #region overview
  u.age.gte(18);
  u.email.eq("a@b.c");
  u.role.in(["admin", "member"]);
  u.name.isNull();
  u.name.ilike("%ann%");
  u.age.between(18, 65);
  u.age.gte(18).and(u.role.eq("admin"));
  or(a, b, c);
  u.loginCount.add(1);
  coalesce(u.name, u.email);
  count(p.id);
  sum(p.views).filter(p.published);
  u.createdAt.desc().nullsLast();
  caseWhen(u.age.lt(18), "minor").else("adult");
  // #endregion overview
}

export function bound() {
  // #region bound
  u.role.eq("admin"); //            "admin" is written with the enum type of role
  u.createdAt.gt(new Date()); //    the Date is written with the timestamp type
  u.email.like("%@example.com"); // a pattern is text, whatever the column
  // #endregion bound
}

export function nulls() {
  // #region null
  u.name.isNull(); //                     name IS NULL
  u.name.isDistinctFrom(null); //         name IS DISTINCT FROM $1: null-safe, takes null
  p.views.add(1); //                      Expr<number | null>: null in, null out
  // u.name.eq(null)                      compile error, and QueryError at run time
  // #endregion null
}

export function lists() {
  // #region lists
  u.id.in([1, 2, 3]); //        one array parameter on Postgres: the SQL is the same for any length
  u.id.in([]); //               false
  u.id.notIn([]); //            true
  u.id.in(subqueryOfIds); //    IN (SELECT …)
  // #endregion lists
}

export function arrays() {
  // #region arrays
  p.tags.contains(["ts"]); //       tags @> $1
  p.tags.overlaps(["ts", "sql"]); // tags && $1
  p.tags.has("ts"); //              $1 = ANY(tags)
  p.tags.append("ts"); //           array_append(tags, $1): for bulk updates
  // #endregion arrays
}

export function json() {
  // #region json
  u.settings.path("theme"); //                          Expr<unknown>
  u.settings.pathText("theme"); //                      Expr<string | null>
  u.settings.path("limits", 0).cast(t.integer()); //    Expr<number>
  // #endregion json
}

export function aggregates() {
  // #region aggregates
  count(); //                              count(*): number
  count(p.id); //                          rows where p.id is not null: number
  countDistinct(p.authorId); //            number
  sum(p.views); //                         number | null
  avg(u.age); //                           number | null
  min(p.createdAt); //                     Date | null
  max(p.createdAt); //                     Date | null
  arrayAgg(p.title); //                    string[] | null
  stringAgg(p.title, ", "); //             string | null
  sum(p.views).filter(p.published); //     sum(views) FILTER (WHERE published)
  coalesce(sum(p.views), 0); //            number: 0 when there are no rows
  // #endregion aggregates
}

export function fragments() {
  // #region fragments
  fragment`lower(${u.email})`.as<string>();
  fragment`similarity(${u.name}, ${search}) > ${0.3}`.as<boolean>();
  fragment`${fragment.ident(column)} @@ plainto_tsquery(${terms})`.as<boolean>();
  // #endregion fragments
}

export function explicit() {
  // #region explicit
  val(new Date(), t.timestamp()); //   a bound parameter with a type
  val("member"); //                    a bound parameter, passed to the driver as it is
  lit(true); //                        TRUE, written into the SQL
  u.age.cast(t.string()); //           CAST(age AS text): Expr<string | null>
  sum(p.views).cast(t.bigint()); //    for a sum past Number.MAX_SAFE_INTEGER
  now(); //                            the database's current time
  // #endregion explicit
}

export function cases() {
  // #region case
  caseWhen(u.age.lt(13), "child").when(u.age.lt(18), "teen").else("adult"); // Expr<string>
  caseWhen(u.age.lt(18), "minor"); //                                       Expr<string | null>
  // #endregion case
}

export function namedParams() {
  // #region named-params
  const condition = and(
    u.age.gte(param("minAge", t.integer())),
    u.role.eq(param("role", t.enum(["admin", "member"]))),
  );
  // Expr<boolean, { minAge: number; role: "admin" | "member" }>
  // #endregion named-params
  return condition;
}

// #region named-params-helper
function adults(): Expr<boolean, { minAge: number }> {
  return u.age.gte(param("minAge", t.integer()));
}

function anyCondition(condition: Expr<boolean | null, SomeParams>) {
  return condition;
}
// #endregion named-params-helper

export function helpers() {
  return anyCondition(adults());
}

export function logic() {
  // #region logic
  and(u.age.gte(18), not(u.banned), p.published);
  or(); //   false
  and(); //  true
  // #endregion logic
}
