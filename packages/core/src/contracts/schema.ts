/**
 * The schema contract: runtime metadata (`FieldMeta`, `AssocMeta`, `SchemaMeta`, …) and
 * the type-level design that derives row, insert and preload types from a schema class.
 *
 * The type-level half is lifted from `docs/plan/spikes/schema-typing.ts`, the proof for
 * decision D1 (schemas are classes; associations are static thunks).
 *
 * Implemented by step 04 (`schema/`). Consumed by changesets (05, 06, 15), the query
 * builder (07, 08, 09), the compiler (10), the repo (12, 13, 14, 16) and migrations (18).
 *
 * @module
 */
import type { AnyEctoType } from "./type.js";

// ---------------------------------------------------------------------------
// Runtime metadata
// ---------------------------------------------------------------------------

/**
 * The key under which a schema class holds its {@link SchemaMeta}: `User[META]`.
 *
 * Created with `Symbol.for`, so the ESM and the CommonJS build of the package (and two
 * installed copies of it) agree on the key.
 *
 * @example
 * ```ts
 * declare const User: AnySchema;
 * const source = User[META].source; // "users"
 * ```
 */
export const META: unique symbol = Symbol.for("ectype.meta");

/**
 * The key under which a row holds its {@link RowMeta}: `user[ROW]`. It is the last own
 * property of every row and the only symbol-keyed one, so it never shows up in
 * `Object.keys`, `JSON.stringify` or `for…in`.
 *
 * Ecto equivalent: the `__meta__` field of a schema struct.
 *
 * @example
 * ```ts
 * declare const user: { readonly [ROW]: RowMeta };
 * if (user[ROW].state === "loaded") {
 *   // the row came from the database
 * }
 * ```
 */
export const ROW: unique symbol = Symbol.for("ectype.row");

/**
 * Where a row stands relative to the database.
 *
 * - `"built"`: created in memory with `new User()`; never persisted.
 * - `"loaded"`: read from, or written to, the database.
 * - `"deleted"`: deleted through the repo.
 *
 * Ecto equivalent: `Ecto.Schema.Metadata` `:state`.
 *
 * @example
 * ```ts
 * const state: RowState = "built";
 * ```
 */
export type RowState = "built" | "loaded" | "deleted";

/**
 * Per-row metadata, stored under {@link ROW}. One frozen object is shared by every row
 * with the same state, source and prefix, so a row costs one property, not one object.
 *
 * Ecto equivalent: `Ecto.Schema.Metadata`.
 *
 * @example
 * ```ts
 * const loadedUser: RowMeta = { state: "loaded", source: "users", prefix: undefined };
 * ```
 */
export interface RowMeta {
  readonly state: RowState;
  /** The table the row belongs to; `null` for a row of an embedded schema. */
  readonly source: string | null;
  /** The schema (Postgres) or database (MySQL) prefix the row was read from, if any. */
  readonly prefix: string | undefined;
}

/**
 * When a field may be written. `"insert"` means on insert only (never updated);
 * `"never"` means the database owns it.
 *
 * Ecto equivalent: the `:writable` field option.
 *
 * @example
 * ```ts
 * const mode: Writable = "insert";
 * ```
 */
export type Writable = "always" | "insert" | "never";

/**
 * Everything known about one field of a schema. Built once, when the schema class is
 * created; never mutated.
 *
 * Ecto equivalent: what `Schema.__schema__(:type, field)` and its siblings return.
 *
 * @example
 * ```ts
 * declare const stringType: AnyEctoType;
 * const insertedAt: FieldMeta = {
 *   name: "insertedAt",
 *   column: "inserted_at",
 *   type: stringType,
 *   nullable: false,
 *   primaryKey: false,
 *   virtual: false,
 *   redact: false,
 *   writable: "always",
 *   readAfterWrites: false,
 *   default: undefined,
 *   autogenerate: undefined,
 *   index: 3,
 * };
 * ```
 */
export interface FieldMeta {
  /** The property name on rows: `"insertedAt"`. */
  readonly name: string;
  /** The column name in the database: `"inserted_at"`. Meaningless for a virtual field. */
  readonly column: string;
  readonly type: AnyEctoType;
  /** Whether `null` is a legal value. Fields are non-null unless declared `.nullable()` (decision D3). */
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  /** A virtual field is never read from or written to the database. */
  readonly virtual: boolean;
  /** A redacted field is hidden from inspect output, `toJSON` and logs. */
  readonly redact: boolean;
  readonly writable: Writable;
  /** The database generates the value: include the column in `RETURNING` after a write. */
  readonly readAfterWrites: boolean;
  /**
   * The value a new row starts with: a constant, or a function called for every new row
   * (so that rows do not share one mutable default).
   */
  readonly default:
    | undefined
    | { readonly kind: "value"; readonly value: unknown }
    | { readonly kind: "fn"; readonly fn: () => unknown };
  /** A client-side generator run by the repo at write time when the field is unset. */
  readonly autogenerate:
    | undefined
    | { readonly on: "insert" | "insertAndUpdate"; readonly fn: () => unknown };
  /** The position of this field in {@link SchemaMeta.fields}. */
  readonly index: number;
}

/**
 * The four association kinds.
 *
 * Ecto equivalent: `belongs_to`, `has_one`, `has_many`, `many_to_many`.
 *
 * @example
 * ```ts
 * const kind: AssocKind = "hasMany";
 * ```
 */
export type AssocKind = "belongsTo" | "hasOne" | "hasMany" | "manyToMany";

/**
 * What happens to associated rows that a parent changeset no longer mentions (step 15).
 *
 * Ecto equivalent: the `:on_replace` association option.
 *
 * @example
 * ```ts
 * const onReplace: OnReplace = "delete";
 * ```
 */
export type OnReplace = "raise" | "markAsInvalid" | "nilify" | "update" | "delete" | "deleteIfExists";

/**
 * What the database is expected to do with associated rows when the owner is deleted.
 * Documentation only: Ectype never acts on it; the foreign key in a migration does.
 *
 * Ecto equivalent: the `:on_delete` association option.
 *
 * @example
 * ```ts
 * const onDelete: OnDelete = "deleteAll";
 * ```
 */
export type OnDelete = "nothing" | "nilifyAll" | "deleteAll";

/**
 * The join table of a `manyToMany` association.
 *
 * @example
 * ```ts
 * const postsTags: JoinThroughMeta = { source: "posts_tags", prefix: undefined, schema: undefined };
 * ```
 */
export interface JoinThroughMeta {
  /** The join table's name. */
  readonly source: string;
  readonly prefix: string | undefined;
  /** The join schema, when the association was declared with one instead of a table name. */
  readonly schema: (() => AnySchema) | undefined;
}

/**
 * One side of a `manyToMany` join: a column of the join table and the field it references.
 *
 * @example
 * ```ts
 * // posts_tags.post_id references posts.id
 * const ownerSide: JoinKeyMeta = { column: "post_id", field: "id" };
 * ```
 */
export interface JoinKeyMeta {
  /** The column in the join table. */
  readonly column: string;
  /** The field it references: on the owner for the first pair, on the target for the second. */
  readonly field: string;
}

/**
 * One entry of an association's default preload order.
 *
 * @example
 * ```ts
 * const newestFirst: PreloadOrderMeta = { field: "insertedAt", direction: "desc" };
 * ```
 */
export interface PreloadOrderMeta {
  /** A field name of the target schema. */
  readonly field: string;
  readonly direction: "asc" | "desc";
}

/**
 * Everything known about one association, resolved lazily: the target class may not exist
 * yet when the owner class is defined (decision D1), so {@link SchemaMeta.assocs} builds
 * these on its first call.
 *
 * Keys are **field names**, not column names, and are arrays so that composite keys work.
 * `ownerKey[i]` on the owner matches `relatedKey[i]` on the target:
 *
 * | Kind                | `ownerKey`                    | `relatedKey`                   |
 * |---------------------|-------------------------------|--------------------------------|
 * | `belongsTo`         | the foreign key (`authorId`)  | the referenced key (`id`)      |
 * | `hasOne`, `hasMany` | the referenced key (`id`)     | the foreign key (`authorId`)   |
 * | `manyToMany`        | the key `joinKeys[0]` points at | the key `joinKeys[1]` points at |
 *
 * For a has-through association (`through` set) the keys are empty: the chain is resolved
 * through the named associations.
 *
 * Ecto equivalent: `Ecto.Association.BelongsTo`, `.Has`, `.ManyToMany`, `.HasThrough`.
 *
 * @example
 * ```ts
 * declare const Post: AnySchema;
 * declare const User: AnySchema;
 * const author: AssocMeta = {
 *   name: "author",
 *   kind: "belongsTo",
 *   owner: Post,
 *   target: () => User,
 *   ownerKey: ["authorId"],
 *   relatedKey: ["id"],
 *   joinThrough: undefined,
 *   joinKeys: undefined,
 *   through: undefined,
 *   onReplace: "raise",
 *   onDelete: "nothing",
 *   where: undefined,
 *   joinWhere: undefined,
 *   preloadOrder: [],
 *   defaults: undefined,
 * };
 * ```
 */
export interface AssocMeta {
  /** The static member name on the owner class: `"posts"`. */
  readonly name: string;
  readonly kind: AssocKind;
  /** The schema class that declares the association. */
  readonly owner: AnySchema;
  /** The associated schema class. A method, so the class is looked up when needed. */
  target(): AnySchema;
  readonly ownerKey: readonly string[];
  readonly relatedKey: readonly string[];
  /** `manyToMany` only. */
  readonly joinThrough: JoinThroughMeta | undefined;
  /** `manyToMany` only: `[owner side, target side]`. */
  readonly joinKeys: readonly [JoinKeyMeta, JoinKeyMeta] | undefined;
  /** Has-through only: the association names to follow, starting from the owner. */
  readonly through: readonly string[] | undefined;
  readonly onReplace: OnReplace;
  readonly onDelete: OnDelete;
  /**
   * A filter on the target that is always applied, as field name to value: a value means
   * equality, `null` means `IS NULL`, an array means `IN`. Values are bound parameters.
   */
  readonly where: Readonly<Record<string, unknown>> | undefined;
  /** `manyToMany` only: the same kind of filter, on the join table's columns. */
  readonly joinWhere: Readonly<Record<string, unknown>> | undefined;
  /** The order preloaded rows come in when the preload has no query of its own. */
  readonly preloadOrder: readonly PreloadOrderMeta[];
  /** Field values given to a target row that is built through this association (step 15). */
  readonly defaults: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Everything known about one embed. An embed is also a field (stored as `jsonb`), so it
 * appears in {@link SchemaMeta.fields} as well; this record adds what a plain field lacks.
 *
 * Ecto equivalent: `Ecto.Embedded`.
 *
 * @example
 * ```ts
 * declare const Address: AnySchema;
 * const address: EmbedMeta = {
 *   name: "address",
 *   cardinality: "one",
 *   schema: () => Address,
 *   onReplace: "update",
 *   column: "address",
 * };
 * ```
 */
export interface EmbedMeta {
  /** The field name on the owner. */
  readonly name: string;
  readonly cardinality: "one" | "many";
  /** The embedded schema class. A method, so the class is looked up when needed. */
  schema(): AnySchema;
  readonly onReplace: OnReplace;
  /** The column that stores the embed. */
  readonly column: string;
}

/**
 * Everything derived from a schema definition, computed once and cached on the class
 * under {@link META}. Hot paths read these precomputed tables instead of deriving them
 * again per query or per row.
 *
 * Ecto equivalent: the `__schema__/1` and `__schema__/2` reflection functions.
 *
 * @example
 * ```ts
 * function columnsOf(meta: SchemaMeta): string[] {
 *   return meta.persisted.map((field) => field.column);
 * }
 * ```
 */
export interface SchemaMeta {
  /** The class name, for error messages. */
  readonly name: string;
  /** The table name; `null` for an embedded schema. */
  readonly source: string | null;
  readonly prefix: string | undefined;
  /** Every field in declaration order. This order is the row shape: rows assign their properties in it. */
  readonly fields: readonly FieldMeta[];
  readonly fieldsByName: ReadonlyMap<string, FieldMeta>;
  /** The non-virtual fields, in declaration order: what `SELECT` reads and what {@link SchemaMeta.create} takes. */
  readonly persisted: readonly FieldMeta[];
  /** The primary-key fields, in declaration order. Empty for a schema without a primary key. */
  readonly primaryKey: readonly FieldMeta[];
  readonly embeds: readonly EmbedMeta[];
  /**
   * The associations by name. Resolved and validated on the first call, then cached. It
   * is a method because the classes an association points at may be defined later.
   *
   * @throws SchemaDefinitionError when an association is declared wrongly.
   */
  assocs(): ReadonlyMap<string, AssocMeta>;
  /**
   * The generated row factory (decision D2): builds a row in state `"loaded"` from the
   * values of the {@link SchemaMeta.persisted} fields, in that order. It never runs a user
   * constructor and never applies defaults. Virtual fields start out `undefined`.
   */
  readonly create: (values: readonly unknown[]) => object;
}

// ---------------------------------------------------------------------------
// Type-level contract
// ---------------------------------------------------------------------------

/**
 * The facts about a field that the type system tracks, as a record of booleans.
 *
 * - `nullable`: declared `.nullable()`.
 * - `defaulted`: has a value without the caller supplying one, through `.default()`,
 *   `.autogenerate()` or `.readAfterWrites()`. Such a field is optional in {@link InsertShape}.
 * - `virtual`: declared `.virtual()`; excluded from {@link InsertShape}.
 * - `primaryKey`: declared `.primaryKey()`; drives {@link PrimaryKeyOf}.
 *
 * @example
 * ```ts
 * type IdFlags = { nullable: false; defaulted: true; virtual: false; primaryKey: true };
 * const check: FieldFlags = {} as IdFlags;
 * ```
 */
export interface FieldFlags {
  readonly nullable: boolean;
  readonly defaulted: boolean;
  readonly virtual: boolean;
  readonly primaryKey: boolean;
}

/**
 * The flags of a field with no modifier applied.
 *
 * @example
 * ```ts
 * declare const email: FieldBuilder<string, DefaultFieldFlags>;
 * ```
 */
export interface DefaultFieldFlags {
  readonly nullable: false;
  readonly defaulted: false;
  readonly virtual: false;
  readonly primaryKey: false;
}

/**
 * `F` with the flag `K` set to `true`.
 *
 * @example
 * ```ts
 * type Flags = WithFlag<DefaultFieldFlags, "nullable">;
 * // { nullable: true; defaulted: false; virtual: false; primaryKey: false }
 * ```
 */
export type WithFlag<F extends FieldFlags, K extends keyof FieldFlags> = {
  readonly [P in keyof FieldFlags]: P extends K ? true : F[P];
};

/**
 * A field declaration: what `t.string()`, `t.id()` and the rest return. `T` is the type
 * of the property on a row (it includes `null` once `.nullable()` was called) and `F`
 * records which modifiers were applied.
 *
 * Every modifier returns a new builder and leaves the receiver untouched.
 *
 * `"~field"` exists only in the type system (it is never set at runtime). It is what
 * {@link FieldType} and {@link FieldFlagsOf} read.
 *
 * Ecto equivalent: the `field/3` macro and its options.
 *
 * @example
 * ```ts
 * declare const t: { string(): FieldBuilder<string>; integer(): FieldBuilder<number> };
 *
 * const fields = {
 *   email: t.string(),
 *   name: t.string().nullable(),
 *   loginCount: t.integer().default(0),
 * };
 * type Name = FieldType<(typeof fields)["name"]>; // string | null
 * ```
 */
export interface FieldBuilder<T, F extends FieldFlags = DefaultFieldFlags> {
  readonly "~field"?: { readonly type: T; readonly flags: F };
  /** Allows `null`: adds `| null` to the row type, and makes `null` the default. */
  nullable(): FieldBuilder<T | null, WithFlag<F, "nullable">>;
  /** The value of the field on `new S()`: a constant, or a function called per row. */
  default(value: T | (() => T)): FieldBuilder<T, WithFlag<F, "defaulted">>;
  /** Makes the field part of the primary key (several fields form a composite key). */
  primaryKey(): FieldBuilder<T, WithFlag<F, "primaryKey">>;
  /** Generates the value client-side at insert when it is unset. */
  autogenerate(fn?: () => T): FieldBuilder<T, WithFlag<F, "defaulted">>;
  /** Keeps the field out of the database: never selected, never written. */
  virtual(): FieldBuilder<T, WithFlag<F, "virtual">>;
  /** Overrides the column name (decision D4). */
  source(column: string): FieldBuilder<T, F>;
  /** Hides the value from inspect output, `toJSON` and logs. */
  redact(): FieldBuilder<T, F>;
  /** Marks the value as generated by the database: it is read back after a write. */
  readAfterWrites(): FieldBuilder<T, WithFlag<F, "defaulted">>;
  /** Restricts when the field may be written. */
  writable(mode: Writable): FieldBuilder<T, F>;
}

/**
 * A field builder of any type and flags.
 *
 * @example
 * ```ts
 * declare const email: FieldBuilder<string>;
 * const any: AnyFieldBuilder = email;
 * ```
 */
export type AnyFieldBuilder = FieldBuilder<unknown, FieldFlags>;

/**
 * The fields object passed to `Schema(source, fields)`.
 *
 * @example
 * ```ts
 * declare const t: { id(): AnyFieldBuilder; string(): AnyFieldBuilder };
 * const fields: FieldsShape = { id: t.id(), email: t.string() };
 * ```
 */
export type FieldsShape = Readonly<Record<string, AnyFieldBuilder>>;

/**
 * The row property type of a field builder.
 *
 * @example
 * ```ts
 * declare const name: FieldBuilder<string | null, WithFlag<DefaultFieldFlags, "nullable">>;
 * type Name = FieldType<typeof name>; // string | null
 * ```
 */
export type FieldType<B> = B extends FieldBuilder<infer T, infer _F> ? T : never;

/**
 * The flags of a field builder.
 *
 * @example
 * ```ts
 * declare const id: FieldBuilder<number, WithFlag<DefaultFieldFlags, "primaryKey">>;
 * type IsKey = FieldFlagsOf<typeof id>["primaryKey"]; // true
 * ```
 */
export type FieldFlagsOf<B> = B extends FieldBuilder<infer _T, infer F> ? F : never;

/**
 * The object type of a row with the fields `F`: one property per field, virtual fields
 * included, associations excluded.
 *
 * @example
 * ```ts
 * declare const fields: { id: FieldBuilder<number>; name: FieldBuilder<string | null> };
 * type UserRow = RowOf<typeof fields>; // { id: number; name: string | null }
 * ```
 */
export type RowOf<F> = { -readonly [K in keyof F]: FieldType<F[K]> };

/**
 * The static side that every schema class has: its metadata and its field builders.
 *
 * @example
 * ```ts
 * function sourceOf(schema: SchemaStatic): string | null {
 *   return schema[META].source;
 * }
 * ```
 */
export interface SchemaStatic<F extends FieldsShape = FieldsShape> {
  readonly [META]: SchemaMeta;
  /** The field builders the class was defined with, for type inference and reflection. */
  readonly fields: F;
}

/**
 * What `Schema(source, fields)` returns: a base class to extend. Its instances are rows;
 * `new S({ … })` builds one in state `"built"` with defaults applied (decision D2).
 *
 * Ecto equivalent: a module that calls `use Ecto.Schema`; `new User({...})` is `%User{}`.
 *
 * @example
 * ```ts
 * declare function Schema<const F extends FieldsShape>(source: string, fields: F): SchemaClass<F>;
 * declare const t: { id(): FieldBuilder<number>; string(): FieldBuilder<string> };
 *
 * class User extends Schema("users", { id: t.id(), email: t.string() }) {
 *   get domain(): string {
 *     return this.email.split("@")[1] ?? "";
 *   }
 * }
 * const user = new User({ email: "ada@example.com" });
 * ```
 */
export type SchemaClass<F extends FieldsShape> = SchemaStatic<F> &
  (new (
    init?: Partial<RowOf<F>>,
  ) => RowOf<F>);

/**
 * Any schema class: the constraint for "a schema" in every generic signature.
 *
 * @example
 * ```ts
 * function tableName<S extends AnySchema>(schema: S): string | null {
 *   return schema[META].source;
 * }
 * ```
 */
export type AnySchema = SchemaStatic & (abstract new (...args: never[]) => object);

/**
 * The fields object of a schema class.
 *
 * @example
 * ```ts
 * declare const User: SchemaClass<{ id: FieldBuilder<number> }>;
 * type Fields = FieldsOf<typeof User>; // { id: FieldBuilder<number> }
 * ```
 */
export type FieldsOf<S> = S extends SchemaStatic<infer F> ? F : never;

/**
 * The field names of a schema class.
 *
 * @example
 * ```ts
 * declare const User: SchemaClass<{ id: FieldBuilder<number>; email: FieldBuilder<string> }>;
 * type Names = FieldNames<typeof User>; // "id" | "email"
 * ```
 */
export type FieldNames<S> = keyof FieldsOf<S> & string;

/**
 * The type of a row of schema `S`: an instance of the class. It has every field
 * (virtual ones included) and whatever getters and methods the class adds. Associations
 * are **not** properties of a plain row: reading one that was not preloaded is a compile
 * error, where Ecto would hand back `%Ecto.Association.NotLoaded{}`. See {@link Loaded}.
 *
 * Ecto equivalent: the schema struct type, `%User{}` / `User.t()`.
 *
 * @example
 * ```ts
 * declare const User: SchemaClass<{ id: FieldBuilder<number>; email: FieldBuilder<string> }>;
 * type UserRow = Row<typeof User>; // { id: number; email: string }
 * ```
 */
export type Row<S extends AnySchema> = InstanceType<S>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type InsertRequiredKeys<F> = {
  [K in keyof F]: FieldFlagsOf<F[K]> extends { readonly virtual: true }
    ? never
    : FieldFlagsOf<F[K]> extends { readonly nullable: false; readonly defaulted: false }
      ? K
      : never;
}[keyof F];

type InsertOptionalKeys<F> = {
  [K in keyof F]: FieldFlagsOf<F[K]> extends { readonly virtual: true }
    ? never
    : FieldFlagsOf<F[K]> extends { readonly nullable: false; readonly defaulted: false }
      ? never
      : K;
}[keyof F];

/**
 * The object a caller supplies to insert a row of schema `S`: every persisted field, where
 * a field is optional when it is nullable, has a default, is autogenerated or is read
 * back from the database. Virtual fields are excluded.
 *
 * @example
 * ```ts
 * type Flags<K extends keyof FieldFlags> = WithFlag<DefaultFieldFlags, K>;
 * declare const User: SchemaClass<{
 *   id: FieldBuilder<number, Flags<"defaulted" | "primaryKey">>;
 *   email: FieldBuilder<string>;
 *   name: FieldBuilder<string | null, Flags<"nullable">>;
 * }>;
 * type NewUser = InsertShape<typeof User>; // { email: string; id?: number; name?: string | null }
 * ```
 */
export type InsertShape<S extends AnySchema> = Simplify<
  { -readonly [K in InsertRequiredKeys<FieldsOf<S>>]: FieldType<FieldsOf<S>[K]> } & {
    -readonly [K in InsertOptionalKeys<FieldsOf<S>>]?: FieldType<FieldsOf<S>[K]>;
  }
>;

/**
 * The names of the primary-key fields of schema `S`.
 *
 * @example
 * ```ts
 * type Key = WithFlag<DefaultFieldFlags, "primaryKey">;
 * declare const Membership: SchemaClass<{
 *   orgId: FieldBuilder<string, Key>;
 *   userId: FieldBuilder<number, Key>;
 *   role: FieldBuilder<string>;
 * }>;
 * type Names = PrimaryKeyNames<typeof Membership>; // "orgId" | "userId"
 * ```
 */
export type PrimaryKeyNames<S> = {
  [K in keyof FieldsOf<S>]: FieldFlagsOf<FieldsOf<S>[K]> extends { readonly primaryKey: true } ? K : never;
}[keyof FieldsOf<S>];

type IsUnion<T, U = T> = [T] extends [never] ? false : T extends U ? ([U] extends [T] ? false : true) : never;

/**
 * The value that identifies one row of schema `S`: the key's own type for a single-field
 * primary key, an object of the key fields for a composite key, `never` without a key.
 *
 * Ecto equivalent: the `id` argument of `Repo.get/3` (Ecto has no composite form).
 *
 * @example
 * ```ts
 * type Key = WithFlag<DefaultFieldFlags, "primaryKey">;
 * declare const User: SchemaClass<{ id: FieldBuilder<number, Key>; email: FieldBuilder<string> }>;
 * declare const Membership: SchemaClass<{ orgId: FieldBuilder<string, Key>; userId: FieldBuilder<number, Key> }>;
 * type UserKey = PrimaryKeyOf<typeof User>; // number
 * type MembershipKey = PrimaryKeyOf<typeof Membership>; // { orgId: string; userId: number }
 * ```
 */
export type PrimaryKeyOf<S> =
  IsUnion<PrimaryKeyNames<S>> extends true
    ? { [K in PrimaryKeyNames<S>]: FieldType<FieldsOf<S>[K]> }
    : PrimaryKeyNames<S> extends infer K extends keyof FieldsOf<S>
      ? FieldType<FieldsOf<S>[K]>
      : never;

/**
 * An association declaration: what `hasMany(() => Post)` and its siblings return, held in
 * a `static` member of the owner class (decision D1). `K` is the kind and `T` the target
 * class. `FK` is the foreign-key field name (or names) when it was given as a literal,
 * and `undefined` when the default name applies; {@link Loaded} uses it to decide whether
 * a preloaded `belongsTo` can be `null`.
 *
 * Ecto equivalent: `has_many/3`, `has_one/3`, `belongs_to/3`, `many_to_many/3`.
 *
 * @example
 * ```ts
 * declare function hasMany<T>(target: () => T): Assoc<"hasMany", T, undefined>;
 * declare const Post: AnySchema;
 *
 * const posts = hasMany(() => Post); // Assoc<"hasMany", typeof Post, undefined>
 * ```
 */
export interface Assoc<
  K extends AssocKind = AssocKind,
  T = unknown,
  FK extends string | readonly string[] | undefined = string | readonly string[] | undefined,
> {
  readonly kind: K;
  /** The thunk given at declaration; called lazily, so circular associations work. */
  readonly target: () => T;
  /** Type-level only; never set at runtime. */
  readonly "~foreignKey"?: FK;
}

/**
 * The names of the associations of schema class `S`: the static members that hold an {@link Assoc}.
 *
 * @example
 * ```ts
 * declare const User: AnySchema & { posts: Assoc<"hasMany", AnySchema>; count: number };
 * type Names = AssocKeys<typeof User>; // "posts"
 * ```
 */
export type AssocKeys<S> = { [K in keyof S]: S[K] extends Assoc ? K : never }[keyof S] & string;

/**
 * The target schema class of association `K` of schema class `S`.
 *
 * @example
 * ```ts
 * declare const Post: AnySchema;
 * declare const User: AnySchema & { posts: Assoc<"hasMany", typeof Post> };
 * type T = Target<typeof User, "posts">; // typeof Post
 * ```
 */
export type Target<S, K extends keyof S> =
  S[K] extends Assoc<AssocKind, infer T extends AnySchema> ? T : never;

/**
 * Which associations of schema `S` are loaded, to any depth. One of:
 *
 * - an association name: `"posts"`;
 * - an object from association name to what is loaded beneath it, where `true` means
 *   "loaded, nothing nested": `{ posts: "comments" }`, `{ posts: { comments: "author" } }`,
 *   `{ profile: true }`;
 * - an array of these: `["profile", { posts: "comments" }]`;
 * - a union of these: `"profile" | { posts: "comments" }`.
 *
 * An unknown association name is a compile error at every depth.
 *
 * Ecto equivalent: the argument of `Ecto.Query.preload/3` and `Repo.preload/3`.
 *
 * @example
 * ```ts
 * declare const Comment: AnySchema;
 * declare const Post: AnySchema & { comments: Assoc<"hasMany", typeof Comment> };
 * declare const User: AnySchema & { posts: Assoc<"hasMany", typeof Post> };
 *
 * const one: PreloadSpec<typeof User> = "posts";
 * const nested: PreloadSpec<typeof User> = { posts: "comments" };
 * ```
 */
export type PreloadSpec<S> =
  | AssocKeys<S>
  | { readonly [K in AssocKeys<S>]?: true | PreloadSpec<Target<S, K>> }
  | readonly PreloadSpec<S>[];

type PreloadedKeys<P> = P extends readonly (infer E)[] ? PreloadedKeys<E> : P extends string ? P : keyof P;

type NestedPreload<P, K> = P extends readonly (infer E)[]
  ? NestedPreload<E, K>
  : P extends string
    ? never
    : K extends keyof P
      ? Exclude<P[K], true | undefined>
      : never;

// `Loaded` without the constraint on `P`. The public type checks `P` once, at the top, and
// that check already covers every nested level; repeating it per level would make the
// compiler expand `PreloadSpec` through every cycle of associations.
type LoadedUnchecked<S extends AnySchema, P> = Row<S> & {
  [K in PreloadedKeys<P> & AssocKeys<S>]: LoadedAssoc<S, K, NestedPreload<P, K>>;
};

type LoadedRow<T extends AnySchema, N> = [N] extends [never] ? Row<T> : LoadedUnchecked<T, N>;

type FieldIsNullable<S extends AnySchema, Name> = Name extends keyof Row<S>
  ? null extends Row<S>[Name]
    ? true
    : false
  : true;

/** Whether the foreign key behind `belongsTo` association `K` of `S` can be null (or is not known). */
type ForeignKeyIsNullable<S extends AnySchema, K extends string, FK> = [FK] extends [undefined]
  ? FieldIsNullable<S, `${K}Id`>
  : FK extends readonly (infer Name)[]
    ? true extends FieldIsNullable<S, Name>
      ? true
      : false
    : string extends FK
      ? true
      : true extends FieldIsNullable<S, FK>
        ? true
        : false;

type LoadedAssoc<S extends AnySchema, K extends string, N> = K extends keyof S
  ? S[K] extends Assoc<infer Kind, infer T extends AnySchema, infer FK>
    ? Kind extends "hasMany" | "manyToMany"
      ? LoadedRow<T, N>[]
      : Kind extends "belongsTo"
        ? ForeignKeyIsNullable<S, K, FK> extends true
          ? LoadedRow<T, N> | null
          : LoadedRow<T, N>
        : LoadedRow<T, N> | null
    : never
  : never;

/**
 * A row of schema `S` with the associations in `P` loaded: {@link Row} plus one property
 * per loaded association, to any depth.
 *
 * - `hasMany` and `manyToMany` become an array of the target's rows.
 * - `hasOne` becomes the target's row or `null`.
 * - `belongsTo` becomes the target's row, or `| null` when the foreign-key field is
 *   nullable. The foreign key is the `foreignKey` given to `belongsTo`, by default
 *   `<association name>Id`; when it cannot be determined the result is `| null`.
 *
 * Ecto equivalent: a struct whose association fields were filled by `Repo.preload/3`.
 * Unlike Ecto there is no `NotLoaded` placeholder: the property is simply absent from the type.
 *
 * @example
 * ```ts
 * declare const Comment: AnySchema;
 * declare const Post: AnySchema & { comments: Assoc<"hasMany", typeof Comment> };
 * declare const User: AnySchema & { posts: Assoc<"hasMany", typeof Post> };
 *
 * declare const user: Loaded<typeof User, { posts: "comments" }>;
 * user.posts[0]?.comments; // Row<typeof Comment>[] | undefined
 * ```
 */
export type Loaded<S extends AnySchema, P extends PreloadSpec<S>> = LoadedUnchecked<S, P>;
