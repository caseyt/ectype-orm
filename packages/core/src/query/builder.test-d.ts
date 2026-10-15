// Type tests for the query builder: bindings, the result type of every select shape,
// nullability through joins, named parameters, composition helpers, preload result types,
// and the calls that must not compile.
import { type Comment, type Membership, Org, Post, Profile, Tag, User } from "@egon-orm/test-support";
import { describe, expectTypeOf, test } from "vitest";
import { t } from "../schema/index.js";
import type { Binding } from "./bindings.js";
import {
  from,
  hasNamedBinding,
  type QueryLike,
  type QueryParams,
  type QueryResult,
  type QueryWith,
  type WhereObject,
} from "./builder.js";
import type { Col, Expr, NoParams } from "./expr.js";
import { and, caseWhen, coalesce, count, exists, fragment, or, param, sum } from "./functions.js";

/** The shape the repo's read methods have: params required exactly when the query has some. */
declare function runAll<Q extends QueryLike>(
  query: Q,
  ...params: keyof QueryParams<Q> extends never ? [] : [params: QueryParams<Q>]
): void;

/** A query's type information: its bindings, result, parameters and root. Comparing these compares the query types. */
const info = <Q extends QueryLike>(query: Q): Q["~query"] => query["~query"];

describe("bindings", () => {
  test("from names the root binding after its alias, with one column per persisted field", () => {
    from(User, "u").where(({ u }) => {
      expectTypeOf(u).toEqualTypeOf<Binding<typeof User>>();
      expectTypeOf(u.email).toEqualTypeOf<Col<string>>();
      expectTypeOf(u.age).toEqualTypeOf<Col<number | null>>();
      expectTypeOf(u.role).toEqualTypeOf<Col<"admin" | "member">>();
      expectTypeOf(u.$schema).toEqualTypeOf<typeof User>();
      return u.age.gte(18);
    });
  });

  test("a virtual field and an association are not columns", () => {
    from(User, "u").where(({ u }) => {
      // @ts-expect-error password is virtual: it has no column
      u.password;
      // @ts-expect-error posts is an association, not a column
      u.posts;
      return u.age.gte(18);
    });
  });

  test("an unknown binding or field does not compile", () => {
    // @ts-expect-error there is no binding z
    from(User, "u").where(({ z }) => z.age.gte(1));
    // @ts-expect-error User has no field nope
    from(User, "u").where(({ u }) => u.nope.eq(1));
  });

  test("a joined binding is added under its alias", () => {
    from(User, "u").join(Post, "p", ({ u, p }) => {
      expectTypeOf(p.title).toEqualTypeOf<Col<string>>();
      return p.authorId.eq(u.id);
    });
  });

  test("an alias already in the query does not compile", () => {
    // @ts-expect-error u is taken
    from(User, "u").join(Post, "u", ({ u }) => u.id.eq(1));
  });

  test("a self-join has two bindings of one schema", () => {
    const q = from(User, "a")
      .join(User, "b", ({ a, b }) => a.email.eq(b.email))
      .select(({ a, b }) => ({ a: a.id, b: b.id }));
    expectTypeOf<QueryResult<typeof q>>().toEqualTypeOf<{ a: number; b: number }>();
  });
});

describe("result types", () => {
  test("a query with no select returns rows of its root, with the class's getters", () => {
    const q = from(User, "u");
    expectTypeOf<QueryResult<typeof q>>().toEqualTypeOf<User>();
    expectTypeOf<QueryResult<typeof q>["displayName"]>().toEqualTypeOf<string>();
  });

  test("each select shape gives its result type", () => {
    const base = from(User, "u").joinAssoc("u", "posts", "p");
    const one = base.select(({ u }) => u.email);
    expectTypeOf<QueryResult<typeof one>>().toEqualTypeOf<string>();
    const row = base.select(({ u }) => u);
    expectTypeOf<QueryResult<typeof row>>().toEqualTypeOf<User>();
    const obj = base.select(({ u, p }) => ({ user: u, title: p.title }));
    expectTypeOf<QueryResult<typeof obj>>().toEqualTypeOf<{ user: User; title: string }>();
    const tuple = base.select(({ u, p }) => [u.id, count(p.id)] as const);
    expectTypeOf<QueryResult<typeof tuple>>().toEqualTypeOf<[number, number]>();
    const constant = base.select(({ u }) => ({ id: u.id, kind: "user" }));
    expectTypeOf<QueryResult<typeof constant>>().toEqualTypeOf<{ id: number; kind: string }>();
    const nested = base.select(({ u, p }) => ({ a: { b: [u.name, { c: p.views }] as const } }));
    expectTypeOf<QueryResult<typeof nested>>().toEqualTypeOf<{
      a: { b: [string | null, { c: number | null }] };
    }>();
    const computed = base.select(({ u, p }) => ({ u, total: sum(p.views) }));
    expectTypeOf<QueryResult<typeof computed>>().toEqualTypeOf<{ u: User; total: number | null }>();
    expectTypeOf<QueryResult<typeof computed>>().not.toBeAny();
  });

  test("selectMerge adds and replaces keys", () => {
    const q = from(Post, "p")
      .select(({ p }) => ({ id: p.id, title: p.title }))
      .selectMerge(({ p }) => ({ title: p.views, published: p.published }));
    expectTypeOf<QueryResult<typeof q>>().toEqualTypeOf<{
      id: number;
      title: number | null;
      published: boolean | null;
    }>();
  });

  test("a left join makes the joined binding nullable", () => {
    const q = from(User, "u").leftJoin(Profile, "pr", ({ u, pr }) => {
      expectTypeOf(pr.bio).toEqualTypeOf<Col<string | null>>();
      expectTypeOf(pr.userId).toEqualTypeOf<Col<number | null>>();
      expectTypeOf(u.email).toEqualTypeOf<Col<string>>();
      return pr.userId.eq(u.id);
    });
    const whole = q.select(({ u, pr }) => ({ u, pr }));
    expectTypeOf<QueryResult<typeof whole>>().toEqualTypeOf<{ u: User; pr: Profile | null }>();
  });

  test("a right join makes the existing bindings nullable", () => {
    const q = from(Post, "p").rightJoin(User, "u", ({ u, p }) => {
      expectTypeOf(p.title).toEqualTypeOf<Col<string | null>>();
      expectTypeOf(u.email).toEqualTypeOf<Col<string>>();
      return p.authorId.eq(u.id);
    });
    const whole = q.select(({ u, p }) => ({ u, p }));
    expectTypeOf<QueryResult<typeof whole>>().toEqualTypeOf<{ u: User; p: Post | null }>();
  });

  test("a full join makes every binding nullable", () => {
    const q = from(User, "u").fullJoin(Profile, "pr", ({ u, pr }) => pr.userId.eq(u.id));
    const whole = q.select(({ u, pr }) => [u, pr.bio] as const);
    expectTypeOf<QueryResult<typeof whole>>().toEqualTypeOf<[User | null, string | null]>();
  });

  test("a cross join adds a binding without a condition", () => {
    const q = from(User, "u")
      .crossJoin(Tag, "t")
      .select(({ u, t }) => [u.id, t.name] as const);
    expectTypeOf<QueryResult<typeof q>>().toEqualTypeOf<[number, string | null]>();
  });
});

describe("joinAssoc", () => {
  test("the target binding comes from the association", () => {
    from(User, "u")
      .joinAssoc("u", "posts", "p")
      .joinAssoc("p", "comments", "c")
      .joinAssoc("p", "tags", "tg")
      .joinAssoc("u", "orgs", "o")
      .joinAssoc("u", "comments", "uc")
      .where(({ p, c, tg, o, uc }) => {
        expectTypeOf(p.$schema).toEqualTypeOf<typeof Post>();
        expectTypeOf(c.$schema).toEqualTypeOf<typeof Comment>();
        expectTypeOf(tg.$schema).toEqualTypeOf<typeof Tag>();
        expectTypeOf(o.$schema).toEqualTypeOf<typeof Org>();
        expectTypeOf(uc.$schema).toEqualTypeOf<typeof Comment>();
        return p.published;
      });
  });

  test("leftJoinAssoc makes the target nullable and takes an extra condition", () => {
    const q = from(Post, "p")
      .leftJoinAssoc("p", "comments", "c", ({ c }) => c.body.isNotNull())
      .select(({ c }) => c);
    expectTypeOf<QueryResult<typeof q>>().toEqualTypeOf<Comment | null>();
  });

  test("an unknown association, or a binding the query lacks, does not compile", () => {
    // @ts-expect-error User has no association nope
    from(User, "u").joinAssoc("u", "nope", "p");
    // @ts-expect-error there is no binding x
    from(User, "u").joinAssoc("x", "posts", "p");
  });
});

describe("clauses", () => {
  test("a callback must return a condition", () => {
    // @ts-expect-error a number column is not a condition
    from(User, "u").where(({ u }) => u.age);
    // @ts-expect-error a plain boolean is not an expression
    from(User, "u").where(() => true);
    // @ts-expect-error the value has the wrong type
    from(User, "u").where(({ u }) => u.age.gt("x"));
  });

  test("the object form of where takes the root's fields", () => {
    from(User, "u").where({ role: "admin", name: null, id: [1, 2, 3] });
    // @ts-expect-error not a field
    from(User, "u").where({ nope: 1 });
    // @ts-expect-error email is not nullable
    from(User, "u").where({ email: null });
    // @ts-expect-error undefined is not a value
    from(User, "u").where({ role: undefined });
    // @ts-expect-error the value has the wrong type
    from(User, "u").where({ role: "owner" });
    expectTypeOf<WhereObject<typeof User>>().toHaveProperty("role");
  });

  test("clauses that keep the bindings return the same query type", () => {
    const q = from(User, "u");
    expectTypeOf(info(q.where(({ u }) => u.age.gte(18)))).toEqualTypeOf(info(q));
    expectTypeOf(info(q.where({ role: "admin" }))).toEqualTypeOf(info(q));
    expectTypeOf(info(q.orWhere(({ u }) => u.role.eq("admin")))).toEqualTypeOf(info(q));
    expectTypeOf(info(q.orderBy(({ u }) => [u.createdAt.desc(), u.id]))).toEqualTypeOf(info(q));
    expectTypeOf(info(q.groupBy(({ u }) => u.id).having(({ u }) => count(u.id).gt(1)))).toEqualTypeOf(
      info(q),
    );
    expectTypeOf(info(q.limit(10).offset(20))).toEqualTypeOf(info(q));
    expectTypeOf(info(q.distinct())).toEqualTypeOf(info(q));
    expectTypeOf(info(q.distinct(({ u }) => [u.email]))).toEqualTypeOf(info(q));
    expectTypeOf(info(q.lock("update", { skipLocked: true }))).toEqualTypeOf(info(q));
    expectTypeOf(info(q.lock(fragment`FOR UPDATE OF ${fragment.ident("u")}`))).toEqualTypeOf(info(q));
    expectTypeOf(info(q.schema("tenant_1").reverseOrder())).toEqualTypeOf(info(q));
    expectTypeOf(info(q.exclude("orderBy"))).toEqualTypeOf(info(q));
  });

  test("a lock mode is one of four", () => {
    // @ts-expect-error not a mode
    from(User, "u").lock("exclusive");
    // @ts-expect-error a lock is never a string of SQL
    from(User, "u").lock("FOR UPDATE");
  });

  test("limit and offset take a number or a named parameter", () => {
    // @ts-expect-error not a number
    from(User, "u").limit("10");
    const q = from(User, "u").limit(param("pageSize", t.integer()));
    expectTypeOf<QueryParams<typeof q>>().toEqualTypeOf<{ pageSize: number }>();
  });

  test('exclude("select") returns rows of the root again', () => {
    const q = from(User, "u")
      .select(({ u }) => u.id)
      .exclude("select");
    expectTypeOf<QueryResult<typeof q>>().toEqualTypeOf<User>();
    // @ts-expect-error not a clause exclude removes
    from(User, "u").exclude("join");
  });

  test("pipe returns what the function returns", () => {
    expectTypeOf(info(from(User, "u").pipe((q) => q.limit(1)))).toEqualTypeOf(info(from(User, "u")));
    expectTypeOf(from(User, "u").pipe(() => 1)).toEqualTypeOf<number>();
  });

  test("from does not take a query", () => {
    // @ts-expect-error a query is continued, not used as a source
    from(from(User, "u"), "x");
  });
});

describe("named parameters", () => {
  test("P collects the named parameters of every clause", () => {
    const q = from(User, "u")
      .joinAssoc("u", "posts", "p", ({ p }) => p.views.gte(param("minViews", t.integer())))
      .where(({ u }) => u.age.gte(param("minAge", t.integer())))
      .having(({ p }) => count(p.id).gt(param("minPosts", t.integer())))
      .orderBy(({ u }) => u.id)
      .select(({ u }) => ({ id: u.id, role: u.role.eq(param("role", t.enum(["admin", "member"]))) }))
      .limit(param("pageSize", t.integer()));
    expectTypeOf<QueryParams<typeof q>>().toEqualTypeOf<{
      minViews: number;
      minAge: number;
      minPosts: number;
      role: "admin" | "member";
      pageSize: number;
    }>();
  });

  test("a query without named parameters needs none", () => {
    expectTypeOf<QueryParams<ReturnType<typeof from<typeof User, "u">>>>().toEqualTypeOf<NoParams>();
  });

  test("one name with two types across clauses gives a query that cannot run", () => {
    // Owner decision (2026-10-14): no check at the clause; the params type says `never`,
    // so the query cannot be given its params (and a QueryError is thrown when the clause
    // is added).
    const q = from(User, "u").where(({ u }) => u.age.gte(param("n", t.integer())));
    const clashing = q.where(({ u }) => u.email.eq(param("n", t.string())));
    expectTypeOf<QueryParams<typeof clashing>["n"]>().toBeNever();
    // @ts-expect-error no value is a `never` parameter: the query cannot run
    runAll(clashing, { n: 1 });
    runAll(q, { n: 1 });
  });

  test("one name as nullable and as not nullable within one expression is a compile error", () => {
    from(User, "u").where(({ u }) =>
      // @ts-expect-error n is a number on the left and a number or null on the right
      u.age.gte(param("n", t.integer())).and(u.age.lte(param("n", t.integer().nullable()))),
    );
  });

  test("one name with two types within one expression is a compile error at the clause", () => {
    from(User, "u").where(({ u }) =>
      // @ts-expect-error n is an integer on the left and a string on the right
      u.age.gte(param("n", t.integer())).and(u.email.eq(param("n", t.string()))),
    );
  });

  test("a subquery's named parameters flow into the outer query", () => {
    const authors = from(Post, "p")
      .where(({ p }) => p.views.gte(param("minViews", t.integer())))
      .select(({ p }) => p.authorId);
    const q = from(User, "u").where(({ u }) => u.id.in(authors));
    expectTypeOf<QueryParams<typeof q>>().toEqualTypeOf<{ minViews: number }>();
    const e = from(User, "u").where(({ u }) =>
      exists(
        from(Post, "p").where(({ p }) => p.authorId.eq(u.id).and(p.title.eq(param("title", t.string())))),
      ),
    );
    expectTypeOf<QueryParams<typeof e>>().toEqualTypeOf<{ title: string }>();
  });

  test("a subquery is checked against the column it is compared with", () => {
    const titles = from(Post, "p").select(({ p }) => p.title);
    // @ts-expect-error a query of strings is not a set of ids
    from(User, "u").where(({ u }) => u.id.in(titles));
  });

  test("reducing conditions with and keeps their named parameters", () => {
    type Needed = { minAge: number; maxAge: number };
    const q = from(User, "u").where(({ u }) => {
      const conditions = [u.age.gte(param("minAge", t.integer())), u.age.lte(param("maxAge", t.integer()))];
      return conditions.reduce<Expr<boolean, Needed>>((acc, f) => acc.and(f), u.email.isNotNull());
    });
    expectTypeOf<QueryParams<typeof q>>().toEqualTypeOf<Needed>();
    const both = from(User, "u").where(({ u }) =>
      and(u.age.gte(param("minAge", t.integer())), u.email.isNotNull()),
    );
    expectTypeOf<QueryParams<typeof both>>().toEqualTypeOf<{ minAge: number }>();
  });

  test("an accumulator typed with the wrong parameters does not compile", () => {
    from(User, "u").where(({ u }) => {
      const conditions = [u.age.gte(param("minAge", t.integer()))];
      // @ts-expect-error the accumulator declares no parameters, and the conditions need minAge
      return conditions.reduce<Expr<boolean>>((acc, f) => acc.and(f), u.email.isNotNull());
    });
  });
});

describe("composition", () => {
  const published = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) => q.where(({ p }) => p.published);
  const paginate = <Q extends QueryWith>(q: Q, page: number, size = 20) =>
    q.limit(size).offset((page - 1) * size);

  test("a scope keeps the query's result type and named parameters", () => {
    const base = from(Post, "p")
      .where(({ p }) => p.views.gte(param("minViews", t.integer())))
      .select(({ p }) => ({ id: p.id }));
    const q = base.pipe(published).pipe((x) => paginate(x, 2));
    expectTypeOf(info(q)).toEqualTypeOf(info(base));
    expectTypeOf<QueryResult<typeof q>>().toEqualTypeOf<{ id: number }>();
    expectTypeOf<QueryParams<typeof q>>().toEqualTypeOf<{ minViews: number }>();
  });

  test("a scope works on a joined binding and on a left-joined one", () => {
    published(from(User, "u").joinAssoc("u", "posts", "p"));
    published(from(User, "u").leftJoinAssoc("u", "posts", "p"));
  });

  test("a scope does not compile on a query without the binding", () => {
    // @ts-expect-error no binding p
    published(from(User, "u"));
    // @ts-expect-error p is not a Post
    published(from(User, "p"));
  });

  test("optional criteria keep the type", () => {
    const filters: { role?: "admin" | "member" } = {};
    let q = from(User, "u");
    if (filters.role) q = q.where({ role: filters.role });
    q = q.where(({ u }) => u.age.gte(18));
    expectTypeOf<QueryResult<typeof q>>().toEqualTypeOf<User>();
  });

  test("hasNamedBinding narrows", () => {
    const q = from(User, "u").joinAssoc("u", "posts", "p") as QueryWith;
    if (hasNamedBinding(q, "p", Post)) {
      q.where(({ p }) => p.published);
    }
  });
});

describe("preload", () => {
  test("the short forms type the loaded associations", () => {
    const one = from(User, "u").preload("posts");
    expectTypeOf<QueryResult<typeof one>["posts"]>().toEqualTypeOf<Post[]>();
    const several = from(User, "u").preload(["posts", "profile"]);
    expectTypeOf<QueryResult<typeof several>["profile"]>().toEqualTypeOf<Profile | null>();
    const nested = from(User, "u").preload({ posts: { comments: "author" } });
    type Loaded = QueryResult<typeof nested>;
    expectTypeOf<Loaded["posts"][number]["comments"][number]["author"]>().toEqualTypeOf<User | null>();
    const merged = from(User, "u").preload("posts").preload("profile");
    expectTypeOf<QueryResult<typeof merged>["posts"]>().toEqualTypeOf<Post[]>();
    expectTypeOf<QueryResult<typeof merged>["profile"]>().toEqualTypeOf<Profile | null>();
    expectTypeOf<QueryResult<typeof merged>["displayName"]>().toEqualTypeOf<string>();
  });

  test("an unknown association does not compile, at any depth", () => {
    // @ts-expect-error User has no association nope
    from(User, "u").preload("nope");
    // @ts-expect-error Post has no association nope
    from(User, "u").preload({ posts: "nope" });
    // @ts-expect-error a stray key beside a valid one
    from(User, "u").preload({ posts: true, nope: true });
  });

  test("the callback form types the loaded rows, or the selected shape", () => {
    const rows = from(User, "u").preload("posts", (q) =>
      q
        .where(({ posts }) => posts.published)
        .orderBy(({ posts }) => posts.createdAt.desc())
        .limit(3),
    );
    expectTypeOf<QueryResult<typeof rows>["posts"]>().toEqualTypeOf<Post[]>();
    const shaped = from(User, "u").preload("posts", (q) =>
      q.select(({ posts }) => ({ authorId: posts.authorId, title: posts.title })),
    );
    expectTypeOf<QueryResult<typeof shaped>["posts"]>().toEqualTypeOf<
      { authorId: number; title: string }[]
    >();
    const deeper = from(User, "u").preload("posts", (q) => q.preload("comments"));
    expectTypeOf<QueryResult<typeof deeper>["posts"][number]["comments"]>().toEqualTypeOf<Comment[]>();
  });

  test("a callback select without the association's key does not compile", () => {
    // @ts-expect-error authorId is the key of User.posts
    from(User, "u").preload("posts", (q) => q.select(({ posts }) => ({ title: posts.title })));
  });

  test("the join form fills an association from a binding", () => {
    const q = from(User, "u")
      .joinAssoc("u", "posts", "p")
      .where(({ p }) => p.published)
      .preload({ posts: "p" });
    expectTypeOf<QueryResult<typeof q>["posts"]>().toEqualTypeOf<Post[]>();
    const deep = from(User, "u")
      .joinAssoc("u", "posts", "p")
      .joinAssoc("p", "comments", "c")
      .preload({ posts: { $from: "p", comments: "c" } });
    expectTypeOf<QueryResult<typeof deep>["posts"][number]["comments"]>().toEqualTypeOf<Comment[]>();
  });

  test("a preload callback's named parameters are the query's", () => {
    const q = from(User, "u").preload("posts", (p) =>
      p.where(({ posts }) => posts.views.gte(param("minViews", t.integer()))),
    );
    expectTypeOf<QueryParams<typeof q>>().toEqualTypeOf<{ minViews: number }>();
  });

  test("a join through a join schema keeps its own types", () => {
    from(Org, "o")
      .joinAssoc("o", "memberships", "m")
      .where(({ m }) => {
        expectTypeOf(m.$schema).toEqualTypeOf<typeof Membership>();
        return m.role.eq("owner");
      });
  });
});

describe("expressions built from the query", () => {
  test("a query is a subquery operand of its single selected value", () => {
    const ids = from(Post, "p").select(({ p }) => p.authorId);
    expectTypeOf(info(from(User, "u").where(({ u }) => u.id.in(ids)))).toEqualTypeOf(info(from(User, "u")));
    const e: Expr<boolean, NoParams> = exists(ids);
    expectTypeOf(e).not.toBeAny();
  });
});

describe("review, round 1", () => {
  // A base query with a result type and a named parameter, to see what a scope keeps.
  const base = from(Post, "p")
    .where(({ p }) => p.views.gte(param("minViews", t.integer())))
    .orderBy(({ p }) => p.id);
  type R = QueryResult<typeof base>;
  type P = QueryParams<typeof base>;

  test("every joining method and exclude keep the result type and named parameters in a scope", () => {
    const join = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) =>
      q.join(User, "u", ({ p, u }) => u.id.eq(p.authorId));
    const leftJoin = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) =>
      q.leftJoin(User, "u", ({ p, u }) => u.id.eq(p.authorId));
    const crossJoin = <Q extends QueryWith>(q: Q) => q.crossJoin(Tag, "tg");
    const joinAssoc = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) => q.joinAssoc("p", "author", "a");
    const leftJoinAssoc = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) =>
      q.leftJoinAssoc("p", "comments", "c");
    const exclude = <Q extends QueryWith>(q: Q) => q.exclude("orderBy");
    const j1 = join(base);
    expectTypeOf<QueryResult<typeof j1>>().toEqualTypeOf<R>();
    expectTypeOf<QueryParams<typeof j1>>().toEqualTypeOf<P>();
    const j2 = leftJoin(base);
    expectTypeOf<QueryResult<typeof j2>>().toEqualTypeOf<R>();
    expectTypeOf<QueryParams<typeof j2>>().toEqualTypeOf<P>();
    const j3 = crossJoin(base);
    expectTypeOf<QueryResult<typeof j3>>().toEqualTypeOf<R>();
    expectTypeOf<QueryParams<typeof j3>>().toEqualTypeOf<P>();
    const j4 = joinAssoc(base);
    expectTypeOf<QueryResult<typeof j4>>().toEqualTypeOf<R>();
    expectTypeOf<QueryParams<typeof j4>>().toEqualTypeOf<P>();
    const j5 = leftJoinAssoc(base);
    expectTypeOf<QueryResult<typeof j5>>().toEqualTypeOf<R>();
    expectTypeOf<QueryParams<typeof j5>>().toEqualTypeOf<P>();
    const j6 = exclude(base);
    expectTypeOf<QueryResult<typeof j6>>().toEqualTypeOf<R>();
    expectTypeOf<QueryParams<typeof j6>>().toEqualTypeOf<P>();
    const rightJoin = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) =>
      q.rightJoin(User, "u", ({ p, u }) => u.id.eq(p.authorId));
    const fullJoin = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) =>
      q.fullJoin(User, "u", ({ p, u }) => u.id.eq(p.authorId));
    const j7 = rightJoin(base);
    expectTypeOf<QueryResult<typeof j7>>().toEqualTypeOf<R | null>();
    expectTypeOf<QueryParams<typeof j7>>().toEqualTypeOf<P>();
    const j8 = fullJoin(base);
    expectTypeOf<QueryResult<typeof j8>>().toEqualTypeOf<R | null>();
    expectTypeOf<QueryParams<typeof j8>>().toEqualTypeOf<P>();
    const joined = joinAssoc(base).select(({ p, a }) => ({ title: p.title, email: a.email }));
    expectTypeOf<QueryResult<typeof joined>>().toEqualTypeOf<{ title: string; email: string }>();
    expectTypeOf<QueryParams<typeof joined>>().toEqualTypeOf<P>();
  });

  test("a select in a scope types the scope's columns as nullable", () => {
    const titles = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) => q.select(({ p }) => p.title);
    const q = titles(from(Post, "p"));
    // The scope sees `p` as possibly left-joined: a documented limit of scopes.
    expectTypeOf<QueryResult<typeof q>>().toEqualTypeOf<string | null>();
  });

  test("the object form of where does not compile in a scope, whose root is unknown", () => {
    const byTitle = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) =>
      // @ts-expect-error the root of a scope's query is not known
      q.where({ title: "x" });
    void byTitle;
  });

  test("a scope that adds a named parameter adds it to the query's", () => {
    const withAuthor = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) =>
      q.joinAssoc("p", "author", "a", ({ a }) => a.age.gte(param("minAge", t.integer())));
    const q = withAuthor(base);
    expectTypeOf<QueryParams<typeof q>>().toEqualTypeOf<{ minViews: number; minAge: number }>();
  });

  test("hasNamedBinding narrows a query that a named parameter is then added to", () => {
    const some = base as QueryLike;
    if (hasNamedBinding(some, "p", Post)) {
      const q = some.where(({ p }) => p.views.gte(param("more", t.integer())));
      expectTypeOf<QueryParams<typeof q>>().toHaveProperty("more");
    }
    const concrete = from(User, "u").where(({ u }) => u.age.gte(param("a", t.integer())));
    if (hasNamedBinding(concrete, "u", User)) {
      const q = concrete.where(({ u }) => u.age.gte(param("b", t.integer())));
      expectTypeOf<QueryParams<typeof q>>().toEqualTypeOf<{ a: number; b: number }>();
    }
  });

  test("a preload callback using a name of the query's with another type gives never params", () => {
    const q = from(User, "u")
      .where(({ u }) => u.age.gte(param("n", t.integer())))
      .preload("posts", (p) => p.where(({ posts }) => posts.title.eq(param("n", t.string()))));
    expectTypeOf<QueryParams<typeof q>["n"]>().toBeNever();
  });

  test("the object form takes a whole value for an array or JSON column, and a list for a scalar one", () => {
    from(Post, "p").where({ tagList: ["a", "b"] });
    // @ts-expect-error a list of arrays is not a value of the column
    from(Post, "p").where({ tagList: [["a"], ["b"]] });
    // @ts-expect-error an array column compares whole arrays, not elements
    from(Post, "p").where({ tagList: "a" });
    from(Post, "p").where({ id: [1, 2] });
    from(User, "u").where({ settings: null });
  });

  test("a right or full join with no select makes the root rows nullable", () => {
    const right = from(Post, "p").rightJoin(User, "u", ({ u, p }) => p.authorId.eq(u.id));
    expectTypeOf<QueryResult<typeof right>>().toEqualTypeOf<Post | null>();
    const full = from(User, "u").fullJoin(Profile, "pr", ({ u, pr }) => pr.userId.eq(u.id));
    expectTypeOf<QueryResult<typeof full>>().toEqualTypeOf<User | null>();
    const left = from(User, "u").leftJoin(Profile, "pr", ({ u, pr }) => pr.userId.eq(u.id));
    expectTypeOf<QueryResult<typeof left>>().toEqualTypeOf<User>();
  });

  test("select, selectMerge, orderBy, groupBy and distinct with a clashing name give never params", () => {
    const q = from(User, "u").where(({ u }) => u.age.gte(param("n", t.integer())));
    const s1 = q.select(({ u }) => ({ x: u.email.eq(param("n", t.string())) }));
    expectTypeOf<QueryParams<typeof s1>["n"]>().toBeNever();
    const s2 = q
      .select(({ u }) => ({ id: u.id }))
      .selectMerge(({ u }) => ({ x: u.email.eq(param("n", t.string())) }));
    expectTypeOf<QueryParams<typeof s2>["n"]>().toBeNever();
    const o = q.orderBy(({ u }) => u.email.concat(param("n", t.string())));
    expectTypeOf<QueryParams<typeof o>["n"]>().toBeNever();
    const g = q.groupBy(({ u }) => [u.email.concat(param("n", t.string()))]);
    expectTypeOf<QueryParams<typeof g>["n"]>().toBeNever();
    const d = q.distinct(({ u }) => [u.email.concat(param("n", t.string()))]);
    expectTypeOf<QueryParams<typeof d>["n"]>().toBeNever();
    const same = q.select(({ u }) => ({ x: u.age.lte(param("n", t.integer())) }));
    expectTypeOf<QueryParams<typeof same>>().toEqualTypeOf<{ n: number }>();
  });

  test("selecting the whole root, or excluding the select, keeps what is preloaded", () => {
    const after = from(User, "u")
      .preload("posts")
      .select(({ u }) => u);
    expectTypeOf<QueryResult<typeof after>["posts"]>().toEqualTypeOf<Post[]>();
    const before = from(User, "u")
      .select(({ u }) => u)
      .preload("posts")
      .exclude("select");
    expectTypeOf<QueryResult<typeof before>["posts"]>().toEqualTypeOf<Post[]>();
    const bare = from(User, "u").preload("posts").exclude("preload");
    expectTypeOf<QueryResult<typeof bare>>().toEqualTypeOf<User>();
  });
});

describe("review, round 2", () => {
  const base = from(Post, "p")
    .where(({ p }) => p.views.gte(param("minViews", t.integer())))
    .orderBy(({ p }) => p.id);

  test("the guide's paginate with named parameters, in a scope", () => {
    const paginate = <Q extends QueryWith>(q: Q) =>
      q.limit(param("size", t.integer())).offset(param("skip", t.integer()));
    const q = paginate(base);
    expectTypeOf<QueryParams<typeof q>>().toEqualTypeOf<{ minViews: number; size: number; skip: number }>();
    expectTypeOf<QueryResult<typeof q>>().toEqualTypeOf<Post>();
    const guide = <Q extends QueryWith>(q: Q, page: number, size = 20) =>
      q.limit(size).offset((page - 1) * size);
    expectTypeOf(info(guide(base, 2))).toEqualTypeOf(info(base));
  });

  test("several clauses that add named parameters, chained in one scope", () => {
    const twoWheres = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) =>
      q
        .where(({ p }) => p.views.lte(param("maxViews", t.integer())))
        .where(({ p }) => p.title.eq(param("title", t.string())));
    const a = twoWheres(base);
    expectTypeOf<QueryParams<typeof a>>().toEqualTypeOf<{
      minViews: number;
      maxViews: number;
      title: string;
    }>();
    const whereThenJoin = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) =>
      q
        .where(({ p }) => p.views.lte(param("maxViews", t.integer())))
        .joinAssoc("p", "author", "a", ({ a }) => a.age.gte(param("minAge", t.integer())))
        .where(({ a }) => a.email.eq(param("email", t.string())));
    const b = whereThenJoin(base);
    expectTypeOf<QueryParams<typeof b>>().toEqualTypeOf<{
      minViews: number;
      maxViews: number;
      minAge: number;
      email: string;
    }>();
    expectTypeOf<QueryResult<typeof b>>().toEqualTypeOf<Post>();
    const selecting = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) =>
      q
        .where(({ p }) => p.views.lte(param("maxViews", t.integer())))
        .select(({ p }) => ({ id: p.id, long: p.views.gt(param("long", t.integer())) }))
        .selectMerge(({ p }) => ({ t: p.title.concat(param("suffix", t.string())) }));
    const c = selecting(base);
    expectTypeOf<QueryParams<typeof c>>().toEqualTypeOf<{
      minViews: number;
      maxViews: number;
      long: number;
      suffix: string;
    }>();
  });

  test("a clash is treated the same after hasNamedBinding", () => {
    const concrete = from(User, "u").where(({ u }) => u.age.gte(param("n", t.integer())));
    if (hasNamedBinding(concrete, "u", User)) {
      const o = concrete.orderBy(({ u }) => u.email.concat(param("n", t.string())));
      expectTypeOf<QueryParams<typeof o>["n"]>().toBeNever();
      const s = concrete.select(({ u }) => ({ x: u.email.eq(param("n", t.string())) }));
      expectTypeOf<QueryParams<typeof s>["n"]>().toBeNever();
    }
  });
  test("preload does not compile in a scope, whose root is unknown", () => {
    const withPosts = <Q extends QueryWith<{ u: typeof User }>>(q: Q) =>
      // @ts-expect-error the root of a scope's query is not known
      q.preload("posts");
    void withPosts;
  });

  test('exclude("select") after a right or full join keeps the rows nullable', () => {
    const right = from(Post, "p")
      .rightJoin(User, "u", ({ u, p }) => p.authorId.eq(u.id))
      .select(({ u }) => u.id)
      .exclude("select");
    expectTypeOf<QueryResult<typeof right>>().toEqualTypeOf<Post | null>();
    const full = from(User, "u")
      .fullJoin(Profile, "pr", ({ u, pr }) => pr.userId.eq(u.id))
      .select(({ pr }) => pr.bio)
      .exclude("select");
    expectTypeOf<QueryResult<typeof full>>().toEqualTypeOf<User | null>();
    const left = from(User, "u")
      .leftJoin(Profile, "pr", ({ u, pr }) => pr.userId.eq(u.id))
      .select(({ pr }) => pr.bio)
      .exclude("select");
    expectTypeOf<QueryResult<typeof left>>().toEqualTypeOf<User>();
  });
});

describe("review, round 3", () => {
  test("a clash of overlapping types across clauses still gives a never parameter", () => {
    const nullable = from(User, "u")
      .where(({ u }) => u.age.gte(param("n", t.integer().nullable())))
      .where(({ u }) => u.age.lte(param("n", t.integer())));
    expectTypeOf<QueryParams<typeof nullable>["n"]>().toBeNever();
    // @ts-expect-error the query cannot be given n
    runAll(nullable, { n: 1 });
    const enums = from(User, "u")
      .where(({ u }) => u.role.eq(param("r", t.enum(["admin", "member"]))))
      .where(({ u }) => u.role.eq(param("r", t.enum(["admin"]))));
    expectTypeOf<QueryParams<typeof enums>["r"]>().toBeNever();
    // Two field types that are both `number` in TypeScript cannot be told apart here; the
    // run-time QueryError refuses them (unit test).
    const numbers = from(User, "u")
      .where(({ u }) => u.age.gte(param("k", t.integer())))
      .where(({ u }) => u.id.gte(param("k", t.bigint({ mode: "number" }))));
    expectTypeOf<QueryParams<typeof numbers>>().toEqualTypeOf<{ k: number }>();
    const same = from(User, "u")
      .where(({ u }) => u.age.gte(param("n", t.integer().nullable())))
      .where(({ u }) => u.age.lte(param("n", t.integer().nullable())));
    expectTypeOf<QueryParams<typeof same>>().toEqualTypeOf<{ n: number | null }>();
  });

  test("a clash in a scope chain gives a never parameter too", () => {
    const twice = <Q extends QueryWith<{ u: typeof User }>>(q: Q) =>
      q
        .where(({ u }) => u.age.gte(param("n", t.integer().nullable())))
        .where(({ u }) => u.age.lte(param("n", t.integer())));
    const q = twice(from(User, "u"));
    expectTypeOf<QueryParams<typeof q>["n"]>().toBeNever();
  });

  test("a query that needs a named parameter cannot be assigned to one that does not", () => {
    let q = from(User, "u");
    // @ts-expect-error the result needs minAge, and q's type needs nothing
    q = q.where(({ u }) => u.age.gte(param("minAge", t.integer())));
    const scoped = <Q extends QueryWith<{ u: typeof User }>>(x: Q) =>
      x.where(({ u }) => u.age.gte(param("minAge", t.integer())));
    // @ts-expect-error the same through a scope
    q = scoped(q);
    q = q.where(({ u }) => u.age.gte(18));
    void q;
  });

  test("nested scopes keep the result type and named parameters", () => {
    const withMin = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) =>
      q.where(({ p }) => p.views.gte(param("min", t.integer())));
    const paginate = <Q extends QueryWith>(q: Q) =>
      q.limit(param("size", t.integer())).offset(param("skip", t.integer()));
    const both = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) => paginate(withMin(q));
    const two = both(from(Post, "p"));
    expectTypeOf<QueryResult<typeof two>>().toEqualTypeOf<Post>();
    expectTypeOf<QueryParams<typeof two>>().toEqualTypeOf<{ min: number; size: number; skip: number }>();
    const three = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) =>
      both(q).where(({ p }) => p.title.eq(param("title", t.string())));
    const deep = three(from(Post, "p"));
    expectTypeOf<QueryResult<typeof deep>>().toEqualTypeOf<Post>();
    expectTypeOf<QueryParams<typeof deep>>().toEqualTypeOf<{
      min: number;
      size: number;
      skip: number;
      title: string;
    }>();
  });
});

describe("review, round 4", () => {
  const nullable = () => param("n", t.integer().nullable());
  const plain = () => param("n", t.integer());

  test("two expressions of one clause using overlapping types give a never parameter", () => {
    const s = from(User, "u").select(({ u }) => ({ a: u.age.eq(nullable()), b: u.age.gt(plain()) }));
    expectTypeOf<QueryParams<typeof s>["n"]>().toBeNever();
    const m = from(User, "u")
      .select(({ u }) => ({ id: u.id }))
      .selectMerge(({ u }) => ({ a: u.age.eq(nullable()), b: [u.age.gt(plain())] }));
    expectTypeOf<QueryParams<typeof m>["n"]>().toBeNever();
    const o = from(User, "u").orderBy(({ u }) => [u.age.add(nullable()), u.age.add(plain())]);
    expectTypeOf<QueryParams<typeof o>["n"]>().toBeNever();
    const g = from(User, "u").groupBy(({ u }) => [u.age.add(nullable()), u.age.add(plain())]);
    expectTypeOf<QueryParams<typeof g>["n"]>().toBeNever();
    const d = from(User, "u").distinct(({ u }) => [u.age.add(nullable()), u.age.add(plain())]);
    expectTypeOf<QueryParams<typeof d>["n"]>().toBeNever();
    const tuple = from(User, "u").select(({ u }) => [u.age.add(nullable()), u.age.add(plain())]);
    expectTypeOf<QueryParams<typeof tuple>["n"]>().toBeNever();
    // An array literal is typed element by element, with or without `as const`.
    expectTypeOf<QueryResult<typeof tuple>>().toEqualTypeOf<[number | null, number | null]>();
    const nested = from(User, "u").select(({ u }) => ({ x: [u.age.add(nullable()), u.age.add(plain())] }));
    expectTypeOf<QueryParams<typeof nested>["n"]>().toBeNever();
    const same = from(User, "u").select(({ u }) => ({ a: u.age.eq(plain()), b: u.age.gt(plain()) }));
    expectTypeOf<QueryParams<typeof same>>().toEqualTypeOf<{ n: number }>();
  });

  test("the n-ary expression functions give a never parameter, or do not compile", () => {
    const u = from(User, "u");
    const a = u.where(({ u }) => and(u.age.gte(nullable()), u.age.lte(plain())));
    expectTypeOf<QueryParams<typeof a>["n"]>().toBeNever();
    const o = u.where(({ u }) => or(u.age.gte(nullable()), u.age.lte(plain())));
    expectTypeOf<QueryParams<typeof o>["n"]>().toBeNever();
    const c = u.select(({ u }) => coalesce(u.age.add(nullable()), u.age.add(plain())));
    expectTypeOf<QueryParams<typeof c>["n"]>().toBeNever();
    const f = u.where(({ u }) => fragment`${u.age} > ${nullable()} and ${u.age} < ${plain()}`.as<boolean>());
    expectTypeOf<QueryParams<typeof f>["n"]>().toBeNever();
    u.select(({ u }) =>
      // @ts-expect-error n is a number or null in the condition and a number in the value
      caseWhen(u.age.gte(nullable()), plain()),
    );
    u.select(({ u }) =>
      // @ts-expect-error n is a number or null in the aggregate and a number in the filter
      sum(u.age.add(nullable())).filter(u.age.gte(plain())),
    );
    u.select(({ u }) =>
      // @ts-expect-error n is a number or null in the aggregate and a number in the window
      sum(u.age.add(nullable())).over({ partitionBy: [u.age.add(plain())] }),
    );
    u.select(() =>
      // @ts-expect-error s is a string or null on the left and a string in the parts
      param("s", t.string().nullable()).concat(param("s", t.string())),
    );
  });

  test("the strict fold keeps scopes chaining", () => {
    const listed = <Q extends QueryWith<{ p: typeof Post }>>(q: Q) =>
      q.orderBy(({ p }) => [p.views.add(param("a", t.integer())), p.id]).limit(param("size", t.integer()));
    const q = listed(from(Post, "p"));
    expectTypeOf<QueryParams<typeof q>>().toEqualTypeOf<{ a: number; size: number }>();
  });
});

describe("review, round 5", () => {
  test("past four levels an array literal is inferred as an array, and as const keeps the tuple", () => {
    const four = from(User, "u").select(({ u }) => ({ a: { b: { c: [u.id, u.email] } } }));
    expectTypeOf<QueryResult<typeof four>>().toEqualTypeOf<{ a: { b: { c: [number, string] } } }>();
    const five = from(User, "u").select(({ u }) => ({ a: { b: { c: { d: [u.id, u.email] } } } }));
    expectTypeOf<QueryResult<typeof five>>().toEqualTypeOf<{ a: { b: { c: { d: (number | string)[] } } } }>();
    const constant = from(User, "u").select(({ u }) => ({
      a: { b: { c: { d: [u.id, u.email] as const } } },
    }));
    expectTypeOf<QueryResult<typeof constant>>().toEqualTypeOf<{
      a: { b: { c: { d: [number, string] } } };
    }>();
  });

  test("past four levels a clash between two expressions is lost, unless as const keeps the tuple", () => {
    const lost = from(User, "u").select(({ u }) => ({
      a: {
        b: { c: { d: [u.age.add(param("n", t.integer().nullable())), u.age.add(param("n", t.integer()))] } },
      },
    }));
    // A known gap: the array's element type is reduced to one expression type.
    expectTypeOf<QueryParams<typeof lost>>().toEqualTypeOf<{ n: number }>();
    const kept = from(User, "u").select(({ u }) => ({
      a: {
        b: {
          c: {
            d: [u.age.add(param("n", t.integer().nullable())), u.age.add(param("n", t.integer()))] as const,
          },
        },
      },
    }));
    expectTypeOf<QueryParams<typeof kept>["n"]>().toBeNever();
  });
});
