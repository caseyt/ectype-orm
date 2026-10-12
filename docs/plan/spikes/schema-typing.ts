// ACCEPTED design (decision D1): class mixin for fields + static thunks for associations.
// Compiles clean: tsc --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --target es2022 schema-typing.ts
// Also proves: Loaded<S, K> preload typing, named-binding query typing, joinAssoc target inference, select inference.
interface FieldDef<T> { __t: T }
interface Assoc<K extends string, T> { kind: K; target: () => T }
declare const t: { id(): FieldDef<number>; string(): FieldDef<string>; int(): FieldDef<number | null> };
declare function hasMany<T>(t: () => T, o?: object): Assoc<"hasMany", T>;
declare function belongsTo<T>(t: () => T, o?: object): Assoc<"belongsTo", T>;
type RowOf<F> = { [K in keyof F]: F[K] extends FieldDef<infer T> ? T : never };
interface SchemaStatic<F = {}> { readonly source: string; readonly fields: F }
declare function Schema<const F extends Record<string, FieldDef<any>>>(source: string, fields: F): SchemaStatic<F> & (new (init?: Partial<RowOf<F>>) => RowOf<F>);

export class User extends Schema("users", { id: t.id(), name: t.string(), age: t.int() }) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });
  static manager = belongsTo(() => User);
  get display() { return `${this.name} (${this.age})`; }
}
export class Post extends Schema("posts", { id: t.id(), title: t.string(), authorId: t.id() }) {
  static author = belongsTo(() => User);
  static comments = hasMany(() => Comment);
}
export class Comment extends Schema("comments", { id: t.id(), body: t.string() }) {
  static post = belongsTo(() => Post);
}

type AnySchema = SchemaStatic<any> & (abstract new (...a: any) => any);
type AssocKeys<S> = { [K in keyof S]: S[K] extends Assoc<any, any> ? K : never }[keyof S];
type Target<S, K extends keyof S> = S[K] extends Assoc<any, infer T extends AnySchema> ? T : never;
type Row<S extends AnySchema> = InstanceType<S>;
type Loaded<S extends AnySchema, K extends AssocKeys<S>> = Row<S> & {
  [P in K]: S[P] extends Assoc<"hasMany", infer T extends AnySchema> ? Row<T>[] : S[P] extends Assoc<any, infer T extends AnySchema> ? Row<T> | null : never };

declare const u: Loaded<typeof User, "posts" | "manager">;
const title: string = u.posts[0]!.title; const n: string = u.name; const d: string = u.display;
const mn: string | undefined = u.manager?.name;
// @ts-expect-error
u.nope;
// @ts-expect-error
type Bad = Loaded<typeof User, "name">;
declare const p: Loaded<typeof Post, "author" | "comments">;
const an: string = p.author!.name; const cb: string = p.comments[0]!.body;
const nu = new User({ name: "a" }); const nn: string = nu.name;

// query builder bindings
interface Expr<T> { __expr: T }
interface Col<T> extends Expr<T> { gt(v: NonNullable<T> | Expr<T>): Expr<boolean>; eq(v: NonNullable<T> | Expr<T>): Expr<boolean> }
type FieldsOf<S> = S extends SchemaStatic<infer F> ? F : never;
type Binding<S extends AnySchema> = { readonly [K in keyof FieldsOf<S>]: Col<RowOf<FieldsOf<S>>[K]> } & { readonly $schema: S };
type Sel<X> = X extends { readonly $schema: infer S extends AnySchema } ? Row<S> : X extends Expr<infer T> ? T : X extends readonly unknown[] ? { [K in keyof X]: Sel<X[K]> } : X extends object ? { [K in keyof X]: Sel<X[K]> } : X;
type SchemaOf<B> = B extends { readonly $schema: infer S extends AnySchema } ? S : never;
interface Query<B, R> {
  join<A extends string, S extends AnySchema>(s: S, as: A, on: (b: B & Record<A, Binding<S>>) => Expr<boolean>): Query<B & Record<A, Binding<S>>, R>;
  joinAssoc<F extends keyof B, K extends AssocKeys<SchemaOf<B[F]>>, A extends string>(from: F, assoc: K, as: A): Query<B & Record<A, Binding<Target<SchemaOf<B[F]>, K>>>, R>;
  where(f: (b: B) => Expr<boolean>): Query<B, R>;
  select<X>(f: (b: B) => X): Query<B, Sel<X>>;
}
declare function from<S extends AnySchema, A extends string>(s: S, as: A): Query<Record<A, Binding<S>>, Row<S>>;
declare function all<R>(q: Query<any, R>): R[];
const base = all(from(User, "u")); const bd: string = base[0]!.display;
const q = from(User, "u").joinAssoc("u", "posts", "p").join(Comment, "c", ({ c, p }) => c.id.eq(p.id))
  .where(({ u }) => u.age.gt(18)).select(({ u, p, c }) => ({ name: u.name, title: p.title, c, pair: [u.id, p.title] as const }));
const r = all(q); const s1: string = r[0]!.title; const s2: string = r[0]!.c.body; const s3: string = r[0]!.pair[1];
// @ts-expect-error wrong value type
from(User, "u").where(({ u }) => u.age.gt("x"));
// @ts-expect-error unknown binding
from(User, "u").where(({ z }) => z.age.gt(1));
// @ts-expect-error unknown assoc
from(User, "u").joinAssoc("u", "nope", "p");
// @ts-expect-error assoc is not a column
from(User, "u").where(({ u }) => u.posts.eq(1));
