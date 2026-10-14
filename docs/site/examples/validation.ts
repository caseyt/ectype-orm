// The checked sources of the code blocks in guide/validation.md. Each `#region` is
// included in the page by name; everything outside a region is the scaffolding that makes
// the regions compile.
import { castWith, toZod, type ZodHint } from "@egon-orm/zod";
import { type } from "arktype";
import {
  BASE,
  type Changeset,
  cast,
  defineType,
  type FieldType,
  Schema,
  t,
  timestamps,
  type ValidationIssue,
  type ValidatorFn,
} from "egon-orm";
import * as v from "valibot";
import * as yup from "yup";
import { z } from "zod";

declare const params: unknown;
declare function isDisposable(email: string): Promise<boolean>;

export class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  age: t.integer().nullable(),
  role: t.enum(["admin", "member"]).default("member"),
  password: t.string().virtual(),
  passwordHash: t.string().nullable().redact(),
  ...timestamps(),
}) {}

export class Talk extends Schema("talks", {
  id: t.integer().primaryKey().dbGenerated(),
  title: t.string(),
  startsAt: t.timestamp(),
  endsAt: t.timestamp(),
}) {}

export async function overview(cs: Changeset<typeof User>, validator: z.ZodType) {
  // #region overview
  cs.validate(validator); //                       synchronous; returns a new changeset
  await cs.validateAsync(validator); //            for validators that answer with a promise
  cs.validateField("email", z.string().email()); // one field, only when it has a change
  await cs.validateFieldAsync("email", z.string().email());
  // #endregion overview
}

export function withZod() {
  // #region zod
  const UserInput = z.object({
    email: z.string().email(),
    age: z.number().int().min(13).nullish(),
  });

  const cs = cast(User, params, ["email", "age"]).validate(UserInput);
  cs.errors.email; // [{ message: "Invalid email address", validation: "schema", meta: { path: [] } }]
  // #endregion zod
  return cs;
}

export function crossFieldZod(cs: Changeset<typeof Talk>) {
  // #region cross-field-zod
  cs.validate(
    z
      .object({ startsAt: z.date(), endsAt: z.date() })
      .refine((v) => v.endsAt > v.startsAt, { path: ["endsAt"], message: "must be after start" }),
  );
  // #endregion cross-field-zod
}

export function withFunction(cs: Changeset<typeof Talk>) {
  // #region function
  cs.validate((values, { isChanged }) =>
    isChanged("endsAt") && values.endsAt <= values.startsAt
      ? [{ path: "endsAt", message: "must be after start" }]
      : [],
  );
  // #endregion function
}

export function base(cs: Changeset<typeof Talk>) {
  // #region base
  const checked = cs.validate(() => [{ path: [], message: "overlaps another talk" }]);
  checked.errors[BASE]; // [{ message: "overlaps another talk", validation: "schema", meta: { path: [] } }]
  checked.errorMessages(); // { $base: ["overlaps another talk"] }
  // #endregion base
}

export function options(cs: Changeset<typeof User>) {
  // #region options
  const Profile = z.object({ email: z.string().email(), name: z.string().min(2).nullable() });

  cs.validate(Profile, { scope: "changed" }); // only issues on fields that changed
  cs.validate(Profile, { only: ["name"] }); //  only the name: the object and the issues
  // #endregion options
}

export function apply() {
  // #region apply
  const Normalized = z.object({ email: z.string().trim().toLowerCase() });

  const cs = cast(User, { email: "  Ada@Example.COM " }, ["email"]).validate(Normalized, { apply: true });
  cs.changes; // { email: "ada@example.com" }
  // #endregion apply
}

export async function asyncValidation(cs: Changeset<typeof User>) {
  // #region async
  const checked = await cs.validateAsync(async (v) =>
    (await isDisposable(v.email)) ? [{ path: "email", message: "is not allowed" }] : [],
  );
  // #endregion async
  return checked;
}

export function validateField(cs: Changeset<typeof User>) {
  // #region validate-field
  cs.validateField("email", z.string().email()); //   a schema for the value
  cs.validateField("age", (age) => (age % 2 === 0 ? [] : [{ path: [], message: "must be even" }]));
  // #endregion validate-field
}

export function valibot(cs: Changeset<typeof User>) {
  // #region valibot
  cs.validate(v.object({ email: v.pipe(v.string(), v.email()), age: v.nullish(v.number()) }));
  // #endregion valibot
}

export function arktype(cs: Changeset<typeof User>) {
  // #region arktype
  cs.validate(type({ email: "string.email", "age?": "number.integer >= 13 | null" }));
  // #endregion arktype
}

export async function yupAsync(cs: Changeset<typeof User>) {
  // #region yup
  // Yup's Standard Schema always answers with a promise: use validateAsync.
  await cs.validateAsync(yup.object({ email: yup.string().email().required() }));
  // #endregion yup
}

// #region yup-sync
/** Yup's path text (`settings.theme`, `tags[0]`, `["a.b"]` for a key with a dot) as a list of keys. */
function yupPath(path: string | undefined): PropertyKey[] {
  const keys: PropertyKey[] = [];
  for (const [, quoted, index, plain] of (path ?? "").matchAll(
    /\["((?:[^"\\]|\\.)*)"\]|\[(\d+)\]|([^.[\]]+)/g,
  )) {
    keys.push(quoted ?? (index !== undefined ? Number(index) : (plain as string)));
  }
  return keys;
}

/** Runs a Yup schema synchronously, as a validator function. */
export function yupSync(schema: yup.AnyObjectSchema) {
  return (values: object): ValidationIssue[] => {
    try {
      schema.validateSync(values, { abortEarly: false });
      return [];
    } catch (error) {
      if (!(error instanceof yup.ValidationError)) throw error;
      const errors = error.inner.length > 0 ? error.inner : [error];
      return errors.map((e) => ({ path: yupPath(e.path), message: e.message }));
    }
  };
}
// #endregion yup-sync

export function yupSyncUse(cs: Changeset<typeof User>) {
  // #region yup-sync-use
  cs.validate(yupSync(yup.object({ email: yup.string().email().required() })));
  // #endregion yup-sync-use
}

export function deriving() {
  // #region to-zod
  const UserZ = toZod(User); //                                 every field, as in a row
  const CreateUser = toZod(User, { mode: "insert", pick: ["email", "name", "age"] }).extend({
    email: z.string().email(),
  });
  type CreateUser = z.infer<typeof CreateUser>; //             { email: string; name?: string | null; age?: number | null }

  const draft: CreateUser = { email: "ada@example.com", name: null };
  cast(User, draft, ["email", "name", "age"]).validate(CreateUser);
  // #endregion to-zod
  return UserZ;
}

export function castWithExample() {
  // #region cast-with
  const SignUp = toZod(User, { mode: "insert", pick: ["email", "name"] }).extend({
    email: z.string().email(),
  });

  const cs = castWith(User, params, SignUp); // cast(User, params, ["email", "name"]).validate(SignUp)
  // #endregion cast-with
  return cs;
}

declare function isSlug(input: unknown): input is string;

export function zodHint() {
  // #region zod-hint
  const Slug = defineType<string>({
    name: "slug",
    db: { kind: "text" },
    cast: (input) => (isSlug(input) ? { success: true, data: input } : { success: false }),
  });
  // defineType keeps only the members it knows: add the hint to the type it returns.
  const SlugType: FieldType<string, string> & ZodHint<string> = {
    ...Slug,
    zod: z.string().regex(/^[a-z0-9-]+$/),
  };

  class Article extends Schema("articles", {
    id: t.integer().primaryKey().dbGenerated(),
    slug: t.type(SlugType),
  }) {}
  toZod(Article).shape.slug; // the hint, not a check built from the type
  // #endregion zod-hint
}

// #region reusable
/** Rejects a range whose end is not after its start. Works with any schema that has the two fields. */
export function endsAfterStarts<T extends { startsAt: Date; endsAt: Date }>(): ValidatorFn<T> {
  return (values) =>
    values.endsAt > values.startsAt ? [] : [{ path: "endsAt", message: "must be after start" }];
}

export function talkChangeset(talk: Talk | typeof Talk, params: unknown) {
  return cast(talk, params, ["title", "startsAt", "endsAt"])
    .validateRequired(["title", "startsAt", "endsAt"])
    .validate(endsAfterStarts());
}
// #endregion reusable
