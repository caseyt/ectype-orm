/**
 * `castWith`: `cast` with the permitted keys taken from a Zod object schema, followed by
 * `validate` with that schema.
 *
 * @module
 */
import type { AnySchema, Changeset, ChangesetSource, FieldValues, Row, RowSchema } from "egon-orm";
import { cast } from "egon-orm";
import { z } from "zod";

/**
 * `Z` when every key of the Zod object is a field of `S`; otherwise a type that names the
 * keys that are not, so the call does not compile.
 */
type ObjectOf<S, Z extends z.ZodObject> = [Exclude<keyof Z["shape"], keyof FieldValues<S>>] extends [never]
  ? Z
  : { readonly "keys of the schema that are not fields": Exclude<keyof Z["shape"], keyof FieldValues<S>> };

type IsClass<T> = T extends abstract new (...args: never[]) => unknown ? true : false;
type RowOnly<R> = true extends IsClass<R> ? never : R extends Changeset<ChangesetSource, boolean> ? never : R;
type ClassOf<T> = Extract<T, AnySchema>;
type ClassOrRow<T> = [ClassOf<T>] extends [never]
  ? never
  : [Exclude<T, AnySchema>] extends [Row<ClassOf<T>>]
    ? unknown
    : never;

/**
 * Casts `params` with the keys of a Zod object schema as the permitted fields, then
 * validates the changeset with that schema: shorthand for
 * `cast(target, params, Object.keys(schema.shape)).validate(schema)`. Every key of the
 * schema must be a field of the target.
 *
 * @example
 * ```ts
 * const SignUp = toZod(User, { mode: "insert", pick: ["email", "name"] }).extend({ email: z.string().email() });
 * const cs = castWith(User, params, SignUp);
 * ```
 *
 * @throws TypeError when `schema` is not a Zod object schema.
 * @throws QueryError when a key of the schema is not a field of the target.
 */
export function castWith<S extends AnySchema, Z extends z.ZodObject>(
  target: S,
  params: unknown,
  schema: ObjectOf<S, Z>,
): Changeset<S, true>;
export function castWith<S extends ChangesetSource, New extends boolean, Z extends z.ZodObject>(
  target: Changeset<S, New>,
  params: unknown,
  schema: ObjectOf<S, Z>,
): Changeset<S, New>;
export function castWith<R extends object, Z extends z.ZodObject>(
  target: RowOnly<R>,
  params: unknown,
  schema: ObjectOf<RowSchema<R>, Z>,
): Changeset<RowSchema<R>, false>;
export function castWith<T extends object, Z extends z.ZodObject>(
  target: T & ClassOrRow<T>,
  params: unknown,
  schema: ObjectOf<ClassOf<T>, Z>,
): Changeset<ClassOf<T>, boolean>;
export function castWith(
  target: unknown,
  params: unknown,
  schema: unknown,
): Changeset<ChangesetSource, boolean> {
  if (!(schema instanceof z.ZodObject)) {
    throw new TypeError(
      "castWith() takes a Zod object schema (z.object({ ... }) or toZod(...)), whose keys are the permitted fields.",
    );
  }
  const permitted = Object.keys(schema.shape);
  return (
    cast as (
      target: unknown,
      params: unknown,
      permitted: readonly string[],
    ) => Changeset<ChangesetSource, boolean>
  )(target, params, permitted).validate(schema);
}
