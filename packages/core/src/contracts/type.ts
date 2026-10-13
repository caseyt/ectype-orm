/**
 * The type contract: how one kind of value is cast from untrusted input,
 * loaded from the driver, dumped to the driver, and compared.
 *
 * Implemented by step 03 (`types/`). Consumed by schemas (04), changesets (05), query
 * expressions (07), the compiler (10), adapters (11, 17) and hydration (12).
 *
 * @module
 */

/**
 * The outcome of {@link FieldType.cast}: the cast value, or a failure with an optional
 * message and metadata. A failure never throws and never carries the offending value.
 *
 * `message` may contain `{key}` placeholders that are filled from `meta`, like every
 * changeset error message. When `message` is omitted the changeset uses `"is invalid"`.
 *
 * @example
 * ```ts
 * const good: CastResult<number> = { success: true, data: 42 };
 * const bad: CastResult<number> = { success: false, message: "must be a whole number", meta: { kind: "integer" } };
 * ```
 */
export type CastResult<T> =
  | { readonly success: true; readonly data: T }
  | {
      readonly success: false;
      readonly message?: string;
      readonly meta?: Readonly<Record<string, unknown>>;
    };

/**
 * The logical column type of a {@link FieldType}. Adapters map it to a concrete SQL type
 * (for `CAST` and for migrations) and use it to choose driver-level conversions.
 *
 * `custom.sql` is a SQL type name, and it is **trusted input**: the one place besides the
 * `fragment` template where text supplied from outside the compiler reaches the SQL
 * (decision D9, ADR 0002 rule 2). It must be a constant written by the developer who
 * defines the type, or assembled by a parameterized type from options that are
 * themselves developer-written constants (a precision, a known type name). It must never
 * be derived from user data. As a second line of defence the compiler refuses a
 * `custom.sql` that is not a plain type name: identifiers separated by single spaces or
 * dots, optionally followed by `(n)` or `(n, m)` and by `[]` pairs, such as `money`,
 * `citext`, `numeric(10, 2)`, `timestamp with time zone` or `public.mood[]`
 * (see {@link CUSTOM_SQL_TYPE}).
 *
 * @example
 * ```ts
 * const tags: DbType = { kind: "array", of: { kind: "text" } };
 * const money: DbType = { kind: "custom", sql: "money" };
 * ```
 */
export type DbType =
  | {
      readonly kind:
        | "integer"
        | "bigint"
        | "float"
        | "decimal"
        | "boolean"
        | "text"
        | "uuid"
        | "binary"
        | "date"
        | "time"
        | "timestamp"
        | "timestamptz"
        | "json"
        | "jsonb";
    }
  | { readonly kind: "array"; readonly of: DbType }
  | { readonly kind: "custom"; readonly sql: string };

/**
 * What a `custom` {@link DbType}'s `sql` must match to be emitted: a type name and
 * nothing else. No quotes, semicolons, comments or operators can pass it.
 *
 * @example
 * ```ts
 * CUSTOM_SQL_TYPE.test("numeric(10, 2)"); // true
 * CUSTOM_SQL_TYPE.test("public.mood[]"); // true
 * CUSTOM_SQL_TYPE.test("text; drop table users"); // false
 * ```
 */
export const CUSTOM_SQL_TYPE: RegExp =
  /^[A-Za-z_][A-Za-z0-9_]*(?:[ .][A-Za-z_][A-Za-z0-9_]*)*(?:\(\d+(?:, ?\d+)?\))?(?:\[\])*$/;

/**
 * The `kind` of a {@link DbType}.
 *
 * @example
 * ```ts
 * const kind: DbTypeKind = "timestamptz";
 * ```
 */
export type DbTypeKind = DbType["kind"];

/**
 * A type: the conversions between external input, application values and driver values
 * for one kind of data. `TApp` is the value in application code; `TDb` is what the driver
 * sends and receives.
 *
 * Rules every implementation follows:
 *
 * - `null` and `undefined` never reach `cast`, `fromDb`, `toDb` or `equal`; the caller
 *   handles nullability.
 * - `cast` never throws, whatever it is given; it returns `{ success: false }` instead.
 * - `fromDb` and `toDb` are on the hot path. When the driver already produces or accepts
 *   the application representation they must be the {@link IDENTITY} function itself, so
 *   that callers can skip the call with a reference check (`type.fromDb !== IDENTITY`).
 * - A type is immutable and shared: it holds no per-value state.
 *
 * The members are declared with method syntax on purpose: it makes a specific type such
 * as `FieldType<Date, string>` assignable to {@link AnyFieldType}, which is how metadata
 * stores types whose parameters are not known statically.
 *
 * @example
 * ```ts
 * const upperString: FieldType<string, string> = {
 *   name: "upperString",
 *   db: { kind: "text" },
 *   cast: (input) =>
 *     typeof input === "string" ? { success: true, data: input.toUpperCase() } : { success: false },
 *   fromDb: IDENTITY,
 *   toDb: IDENTITY,
 *   equal: Object.is,
 * };
 * ```
 */
export interface FieldType<TApp, TDb = unknown> {
  /** A stable name for error messages and adapter overrides: `"string"`, `"integer"`, `"timestamp"`, … */
  readonly name: string;
  /** The logical column type; used for `CAST`, for migrations and by adapter type overrides. */
  readonly db: DbType;
  /** Converts untrusted external input (JSON, form data) to an application value. Used by changesets. */
  cast(input: unknown): CastResult<TApp>;
  /** Converts a non-null driver value to an application value. Hot path: once per column per row. */
  fromDb(value: TDb): TApp;
  /** Converts a non-null application value to a driver parameter. */
  toDb(value: TApp): TDb;
  /** Whether two non-null application values are the same value. Drives change detection in changesets. */
  equal(a: TApp, b: TApp): boolean;
}

/**
 * A {@link FieldType} whose type parameters are not known statically. This is the type
 * that schema metadata, AST nodes and plans store.
 *
 * Every `FieldType<A, D>` is assignable to it. Values read through it are `unknown`, and
 * the caller is responsible for passing `toDb` and `equal` values of the right type.
 *
 * @example
 * ```ts
 * declare const dateType: FieldType<Date, string>;
 * const stored: AnyFieldType = dateType;
 * const loaded: unknown = stored.fromDb("2026-01-01");
 * ```
 */
export type AnyFieldType = FieldType<unknown, unknown>;

/**
 * The application type of a {@link FieldType}.
 *
 * @example
 * ```ts
 * declare const dateType: FieldType<Date, string>;
 * type App = AppTypeOf<typeof dateType>; // Date
 * ```
 */
export type AppTypeOf<T> = T extends FieldType<infer TApp, infer _TDb> ? TApp : never;

/**
 * The driver type of a {@link FieldType}.
 *
 * @example
 * ```ts
 * declare const dateType: FieldType<Date, string>;
 * type Db = DbTypeOf<typeof dateType>; // string
 * ```
 */
export type DbTypeOf<T> = T extends FieldType<infer _TApp, infer TDb> ? TDb : never;

/**
 * The identity function, and a marker: a `fromDb` or `toDb` that is this exact function
 * converts nothing, so hot paths compare by reference and skip the call.
 *
 * Always use this export for an identity conversion. Another function that happens to
 * return its argument is called for every value. That includes the `IDENTITY` of a second
 * installed copy of the package: the marker is one function per copy (a function cannot
 * be registered process-wide the way `META` and `ROW` are), so a type created with one
 * copy and used by another is still correct, only without the shortcut.
 *
 * @example
 * ```ts
 * function loadColumn(type: AnyFieldType, value: unknown): unknown {
 *   if (value === null) return null;
 *   return type.fromDb === IDENTITY ? value : type.fromDb(value);
 * }
 * ```
 */
export const IDENTITY = <T>(value: T): T => value;

/**
 * A pair of driver conversions: what an adapter supplies to override a type's own
 * `fromDb`/`toDb` for its dialect, and what `resolveCodec` (step 03) returns. Either member
 * may be {@link IDENTITY}.
 *
 * @example
 * ```ts
 * // Postgres sends int8 as text; read it as a bigint.
 * const int8: Codec = { fromDb: (text) => BigInt(text as string), toDb: IDENTITY };
 * ```
 */
export interface Codec {
  /** Driver value to application value. Never called with `null`. */
  readonly fromDb: (value: unknown) => unknown;
  /** Application value to driver parameter. Never called with `null`. */
  readonly toDb: (value: unknown) => unknown;
}
