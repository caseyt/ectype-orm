// The checked sources of the code blocks in guide/changesets.md (and of the changeset
// block in guide/schemas.md). Each `#region` is included in the page by name; everything
// outside a region is the scaffolding that makes the regions compile.
import {
  applyAction,
  type Changeset,
  type ChangesetError,
  cast,
  change,
  hasMany,
  Schema,
  t,
  timestamps,
  traverseErrors,
} from "egon-orm";

declare const params: unknown;
declare const input: unknown;

class Post extends Schema("posts", {
  id: t.integer().primaryKey().dbGenerated(),
  authorId: t.integer(),
  title: t.string(),
}) {}

// #region schema
export class User extends Schema("users", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  age: t.integer().nullable(),
  role: t.enum(["admin", "member"]).default("member"),
  password: t.string().virtual(),
  passwordHash: t.string().nullable().redact(),
  lockVersion: t.integer().default(1),
  ...timestamps(),
}) {
  static posts = hasMany(() => Post, { foreignKey: "authorId" });

  // A changeset function: pass the class for a new record, a loaded row for an update.
  static changeset(user: User | typeof User, params: unknown) {
    return cast(user, params, ["email", "name"]).validateRequired(["email"]);
  }
}
// #endregion schema

export function overview() {
  // #region overview
  const cs = cast(User, params, ["email", "name", "age"])
    .validateRequired(["email"])
    .validateFormat("email", /^[^@\s]+@[^@\s]+$/)
    .validateLength("name", { min: 2, max: 80 })
    .validateNumber("age", { greaterThanOrEqualTo: 13 })
    .uniqueConstraint("email");

  cs.valid; //            boolean
  cs.changes; //          { email?: string; name?: string | null; age?: number | null }
  cs.errors; //           { [field]: ChangesetError[] }
  cs.errorMessages(); //  { email: ["can't be blank"] }
  cs.data; //             the loaded row, or null for a new record
  cs.model; //            the schema class
  cs.action; //           null | "insert" | "update" | "delete" | "replace" | "ignore"
  // #endregion overview
  return cs;
}

export function newRecord() {
  // #region new-record
  cast(User, params, ["email", "name"]); //   from untrusted input
  change(User, { email: "a@b.c" }); //        from trusted values
  // #endregion new-record
}

export function changesetFunction(user: User) {
  // #region changeset-function
  User.changeset(User, input); //   new record
  User.changeset(user, input); //   existing row
  // #endregion changeset-function
}

export function castExample() {
  // #region cast
  const cs = cast(User, { email: "ada@example.com", age: "36", role: "admin" }, ["email", "age"]);
  cs.changes; // { email: "ada@example.com", age: 36 }: "role" is not permitted, "36" became 36
  // #endregion cast
  return cs;
}

export function required(user: User) {
  // #region required
  cast(user, { email: null }, ["email"]).errors;
  // { email: [{ message: "can't be blank", validation: "required", meta: {} }] }

  cast(user, { name: "   " }, ["name"]).validateRequired(["name"]).valid; // false: whitespace only
  // #endregion required
}

export function validations() {
  const cs = cast(User, params, ["email", "name", "age", "role", "password"]);
  // #region validations
  cs.validateRequired(["email", "name"]); //               can't be blank
  cs.validateRequired(); //                                every non-nullable field with no default
  cs.validateFormat("email", /^[^@\s]+@[^@\s]+$/); //      has invalid format
  cs.validateInclusion("role", ["admin", "member"]); //    is invalid
  cs.validateExclusion("name", ["admin", "root"]); //      is reserved
  cs.validateLength("name", { min: 2, max: 80 }); //       should be at least {count} character(s), ...
  cs.validateLength("password", { max: 72, count: "bytes" }); // should be at most {count} byte(s)
  cs.validateNumber("age", { greaterThanOrEqualTo: 13 }); // must be greater than or equal to {number}
  cs.validateConfirmation("password"); //                  does not match confirmation (on passwordConfirmation)
  cs.validateAcceptance("termsOfService"); //              must be accepted
  // #endregion validations

  // #region custom-validation
  cs.validateChange("email", (email) => (email.endsWith("@example.com") ? "is not allowed" : undefined));
  cs.validateLength("name", { min: 2, message: "is too short" });
  cs.validateLength("name", { min: 2, message: (meta) => `needs ${String(meta.count)} characters` });
  // #endregion custom-validation
}

export function errors() {
  const cs = cast(User, { name: "A" }, ["name"]).validateLength("name", { min: 2 });
  // #region error-shape
  cs.errors.name;
  // [{ message: "should be at least {count} character(s)",
  //    validation: "length",
  //    meta: { count: 2, kind: "min", type: "string" } }]

  cs.errorMessages(); // { name: ["should be at least 2 character(s)"] }
  // #endregion error-shape

  // #region traverse-errors
  const translate = (error: ChangesetError) =>
    error.message === "should be at least {count} character(s)" && error.meta.count === 1
      ? "should be at least 1 character"
      : error.message.replace(/\{(\w+)\}/g, (_, key: string) => String(error.meta[key] ?? key));

  traverseErrors(cs, translate); // { name: ["should be at least 2 character(s)"] }
  // #endregion traverse-errors
}

export function changes(user: User) {
  // #region pipe
  const normalizeEmail = (cs: Changeset<typeof User>) =>
    cs.updateChange("email", (email) => email.trim().toLowerCase());

  cast(User, params, ["email"]).pipe(normalizeEmail);
  // #endregion pipe

  // #region apply
  const rename = change(user, { name: "Ada" });
  rename.applyChanges().name; // "Ada": a new User, the loaded one is untouched

  const result = applyAction(rename, "update");
  if (result.success)
    result.data; // the User with the changes applied
  else result.error.errors; //         the changeset, with action "update"
  // #endregion apply
}

export function hooks(user: User) {
  // #region constraints
  cast(user, params, ["email"])
    .uniqueConstraint("email") //                       users_email_key: has already been taken
    .uniqueConstraint("email", { name: "uq_users_email" });
  // #endregion constraints

  // #region lock
  cast(user, params, ["name"]).optimisticLock("lockVersion");
  // #endregion lock
}

export function schemaless() {
  // #region schemaless
  const cs = cast({ data: {}, types: { q: t.string(), page: t.integer().default(1) } }, params, [
    "q",
    "page",
  ]).validateNumber("page", { greaterThan: 0 });

  const result = applyAction(cs, "insert");
  if (result.success) result.data; // { q: string | undefined; page: number | undefined }
  // #endregion schemaless
}
