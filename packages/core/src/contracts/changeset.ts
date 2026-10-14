/**
 * The changeset contract: the plain-data shapes that changesets, validators and the repo
 * exchange.
 *
 * Implemented by step 05 (`changeset/`), step 06 (validators) and step 15 (nested
 * changesets). Consumed by repo writes (13) and Batch (16).
 *
 * @module
 */
import type { StandardSchemaV1 } from "./standard-schema.js";

/**
 * One validation or constraint error on a field. Plain and serialisable.
 *
 * `message` may contain `{key}` placeholders, filled from `meta` when the error is
 * rendered (`traverseErrors`). Keeping the template and the values apart is what makes
 * translation and pluralisation possible.
 *
 * `meta` never holds a value of a redacted field.
 *
 * @example
 * ```ts
 * const tooShort: ChangesetError = {
 *   message: "should be at least {count} character(s)",
 *   validation: "length",
 *   meta: { count: 12, kind: "min", type: "string" },
 * };
 * ```
 */
export interface ChangesetError {
  readonly message: string;
  /** The validation that produced the error: `"required"`, `"length"`, `"cast"`, … */
  readonly validation?: string;
  /** The {@link ConstraintType} of the declared constraint that produced the error: `"unique"`, `"foreignKey"`, … */
  readonly constraint?: string;
  readonly meta: Readonly<Record<string, unknown>>;
}

/**
 * The kinds of constraint a changeset can declare. `"noAssoc"` is a foreign-key
 * violation seen from the referenced side ("is still associated with this entry").
 *
 * @example
 * ```ts
 * const type: ConstraintType = "unique";
 * ```
 */
export type ConstraintType = "unique" | "foreignKey" | "check" | "exclusion" | "noAssoc";

/**
 * A constraint declared on a changeset: "if the database reports a violation of this
 * constraint, add `message` to `field` instead of throwing". Step 13 does the matching.
 *
 * `match` says how `name` is compared with the constraint name the database reports:
 * the whole name, or only its end or its start (for names generated per partition or tenant).
 *
 * @example
 * ```ts
 * const uniqueEmail: Constraint = {
 *   type: "unique",
 *   name: "users_email_key",
 *   match: "exact",
 *   field: "email",
 *   message: "has already been taken",
 * };
 * ```
 */
export interface Constraint {
  readonly type: ConstraintType;
  readonly name: string;
  readonly match: "exact" | "suffix" | "prefix";
  /** The key in `changeset.errors` that receives the error. */
  readonly field: string;
  readonly message: string;
}

/**
 * What a changeset is being used for. Set by the repo, or by `applyAction`.
 *
 * @example
 * ```ts
 * const action: Action = "insert";
 * ```
 */
export type Action = "insert" | "update" | "delete" | "replace" | "ignore";

/**
 * The part of a changeset that code outside `changeset/` may rely on: enough for the
 * repo to refuse an invalid changeset and for `InvalidChangesetError` to describe it.
 * The real `Changeset<S>` class (step 05) has much more.
 *
 * @example
 * ```ts
 * function firstError(changeset: ChangesetLike): string | undefined {
 *   for (const errors of Object.values(changeset.errors)) {
 *     if (errors[0] !== undefined) return errors[0].message;
 *   }
 *   return undefined;
 * }
 * ```
 */
export interface ChangesetLike<TData = unknown> {
  readonly valid: boolean;
  readonly action: Action | null;
  /** The row (or plain data) the changes apply to. */
  readonly data: TData;
  /** The changed fields. */
  readonly changes: Readonly<Record<string, unknown>>;
  /** The errors by field name. */
  readonly errors: Readonly<Record<string, readonly ChangesetError[]>>;
}

/**
 * One problem reported by a {@link ValidatorFn}. `path` names the field (a key, or a
 * path whose first element is the field); an empty path reports on the changeset as a whole.
 *
 * @example
 * ```ts
 * const issue: ValidationIssue = { path: "endsAt", message: "must be after start" };
 * ```
 */
export interface ValidationIssue {
  readonly path: PropertyKey | readonly PropertyKey[];
  readonly message: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * What a {@link ValidatorFn} is told besides the values.
 *
 * @example
 * ```ts
 * function changedEmail(ctx: ValidatorContext<{ email: string }>): boolean {
 *   return ctx.isChanged("email");
 * }
 * ```
 */
export interface ValidatorContext<T> {
  /** Only the changed fields. */
  readonly changes: Readonly<Partial<T>>;
  /** The data before the changes. */
  readonly data: Readonly<T>;
  isChanged(field: keyof T): boolean;
  readonly action: Action | null;
}

/**
 * A validator written as a plain function: it receives the data with the changes applied
 * and returns the issues it found, or an empty array or nothing when there are none. It
 * may be asynchronous, in which case it has to be run with `validateAsync`.
 *
 * "Nothing" is `void`, exactly as step 06 specifies, so that every ordinary way of
 * writing such a function is accepted: no `return` at all, a `: void` annotation, an
 * `async` function typed `Promise<void>`, and a body that returns issues on some paths
 * only (under `noImplicitReturns`, annotate such a function with {@link ValidatorResult}).
 * A function that returns something else, such as a single issue without its array, a
 * string or a malformed issue, makes the validation throw a `TypeError` (see
 * {@link ValidatorResult}).
 *
 * Step 06 specifies how the issues become changeset errors.
 *
 * @example
 * ```ts
 * interface Event {
 *   startsAt: Date;
 *   endsAt: Date;
 * }
 * const endsAfterStart: ValidatorFn<Event> = (values, { isChanged }) =>
 *   isChanged("endsAt") && values.endsAt <= values.startsAt
 *     ? [{ path: "endsAt", message: "must be after start" }]
 *     : [];
 * ```
 */
export type ValidatorFn<T> = (
  values: Readonly<T>,
  ctx: ValidatorContext<T>,
) => ValidatorResult | Promise<ValidatorResult>;

/**
 * What a {@link ValidatorFn} returns: an array of issues (empty when there are none), or
 * nothing. Code that receives one accepts an array, `undefined`, and also `null`, which
 * untyped code may return for "nothing". Anything else, such as a single issue without
 * its array (`{ path, message }` instead of `[{ path, message }]`), a string or a number,
 * is a mistake in the validator and makes the validation throw a `TypeError`; it never
 * counts as "no issues". The same holds for what an asynchronous validator's promise
 * resolves to.
 *
 * @example
 * ```ts
 * const none: ValidatorResult = undefined;
 * const some: ValidatorResult = [{ path: "email", message: "is not allowed" }];
 * ```
 */
// biome-ignore lint/suspicious/noConfusingVoidType: owner-approved (step 02 review, decision C). `void` is what makes a validator with no return value assignable; `undefined` rejects `: void` functions, `Promise<void>` and partial returns under noImplicitReturns.
export type ValidatorResult = readonly ValidationIssue[] | void;

/**
 * Anything a changeset can be validated with: a Standard Schema (Zod, Valibot, ArkType,
 * recent Yup) or a {@link ValidatorFn}.
 *
 * @example
 * ```ts
 * declare const zodSchema: StandardSchemaV1<unknown, { email: string }>;
 * const validators: Validator<{ email: string }>[] = [zodSchema, () => []];
 * ```
 */
export type Validator<T> = StandardSchemaV1<unknown, unknown> | ValidatorFn<T>;
