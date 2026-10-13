import { describe, expect, test } from "vitest";
import type { ChangesetLike } from "./contracts/changeset.js";
import {
  CastError,
  ConstraintError,
  type ConstraintViolationType,
  DatabaseError,
  EgonError,
  type ErrorCode,
  InvalidChangesetError,
  isEgonError,
  MultipleResultsError,
  NoResultsError,
  NotLoadedError,
  QueryError,
  SchemaDefinitionError,
  StaleEntryError,
} from "./errors.js";

const driverError = Object.assign(new Error("duplicate key value violates unique constraint"), {
  code: "23505",
});

const changeset: ChangesetLike = {
  valid: false,
  action: "insert",
  data: {},
  changes: { email: "taken@example.com", password: "hunter2" },
  errors: {
    email: [{ message: "has already been taken", constraint: "unique", meta: {} }],
    password: [
      {
        message: "should be at least {count} character(s)",
        validation: "length",
        meta: { count: 12, kind: "min" },
      },
      { message: "needs {missing} filled in", meta: {} },
    ],
  },
};

/** One instance of every error class, with the code and name it must have. */
const EVERY_ERROR: [error: EgonError, name: string, code: ErrorCode][] = [
  [new NoResultsError(), "NoResultsError", "noResults"],
  [new MultipleResultsError({ count: 2 }), "MultipleResultsError", "multipleResults"],
  [new InvalidChangesetError({ action: "insert", changeset }), "InvalidChangesetError", "invalidChangeset"],
  [new StaleEntryError({ action: "update", schema: "User" }), "StaleEntryError", "staleEntry"],
  [
    new ConstraintError({
      type: "unique",
      constraint: "c",
      table: "t",
      column: undefined,
      detail: undefined,
    }),
    "ConstraintError",
    "constraint",
  ],
  [new QueryError("bad query"), "QueryError", "query"],
  [new CastError("bad cast"), "CastError", "cast"],
  [new NotLoadedError({ schema: "User", association: "posts" }), "NotLoadedError", "notLoaded"],
  [new DatabaseError("driver failed"), "DatabaseError", "database"],
  [new SchemaDefinitionError("bad schema"), "SchemaDefinitionError", "schemaDefinition"],
];

describe("every error class", () => {
  test.each(EVERY_ERROR)("%o has its own stable name and code", (error, name, code) => {
    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
    expect(error.constructor.name).toBe(name);
  });

  test("codes are unique across the classes", () => {
    const codes = EVERY_ERROR.map(([, , code]) => code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test.each(EVERY_ERROR)("%o is an Error and an EgonError with a stack and a message", (error) => {
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(EgonError);
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.stack).toContain(error.name);
    expect(String(error)).toBe(`${error.name}: ${error.message}`);
  });

  test("has no cause unless one is given", () => {
    for (const [error] of EVERY_ERROR) {
      expect(error.cause).toBeUndefined();
      expect(Object.hasOwn(error, "cause")).toBe(false);
    }
  });

  test("keeps the cause it is given, by identity", () => {
    const withCause: EgonError[] = [
      new NoResultsError({ cause: driverError }),
      new MultipleResultsError({ count: 2, cause: driverError }),
      new InvalidChangesetError({ action: "insert", changeset, cause: driverError }),
      new StaleEntryError({ action: "delete", schema: "User", cause: driverError }),
      new ConstraintError({
        type: "unique",
        constraint: undefined,
        table: undefined,
        column: undefined,
        detail: undefined,
        cause: driverError,
      }),
      new QueryError("bad query", driverError),
      new CastError("bad cast", driverError),
      new NotLoadedError({ schema: "User", association: "posts", cause: driverError }),
      new DatabaseError("driver failed", { cause: driverError }),
      new SchemaDefinitionError("bad schema", driverError),
    ];
    expect(withCause).toHaveLength(EVERY_ERROR.length);
    for (const error of withCause) expect(error.cause).toBe(driverError);
  });

  test("a cause chain survives several levels", () => {
    const adapter = new DatabaseError("Lost the connection.", { code: "connection", cause: driverError });
    const query = new QueryError("Could not run the query.", adapter);
    expect(query.cause).toBe(adapter);
    expect((query.cause as DatabaseError).cause).toBe(driverError);
  });

  test("a falsy cause other than undefined is kept", () => {
    expect(new QueryError("bad query", null).cause).toBeNull();
    expect(Object.hasOwn(new QueryError("bad query", 0), "cause")).toBe(true);
  });
});

describe("isEgonError", () => {
  test("recognises every Egon error and nothing else", () => {
    for (const [error] of EVERY_ERROR) expect(isEgonError(error)).toBe(true);
    for (const other of [
      new Error("x"),
      driverError,
      null,
      undefined,
      "QueryError",
      42,
      {},
      { code: "query" },
    ]) {
      expect(isEgonError(other)).toBe(false);
    }
  });

  test("matches on the code when one is given", () => {
    const error = new QueryError("bad query");
    expect(isEgonError(error, "query")).toBe(true);
    expect(isEgonError(error, "cast")).toBe(false);
    expect(isEgonError(new DatabaseError("x", { code: "deadlock" }), "deadlock")).toBe(true);
    expect(isEgonError(new DatabaseError("x", { code: "deadlock" }), "database")).toBe(false);
  });

  test("recognises an error from another copy of the package, where instanceof fails", () => {
    // What a second installed copy of this module would create: a different
    // class, the same process-wide brand.
    const foreign = Object.assign(new Error("from another copy"), {
      code: "query",
      [Symbol.for("egon.error")]: true,
    });
    expect(foreign).not.toBeInstanceOf(EgonError);
    expect(isEgonError(foreign)).toBe(true);
    expect(isEgonError(foreign, "query")).toBe(true);
  });
});

describe("NoResultsError", () => {
  test("says what was expected and how to make a missing row acceptable", () => {
    expect(new NoResultsError().message).toMatchInlineSnapshot(
      `"Expected at least one result but got none. Use the variant without "OrThrow" (it returns null) if a missing row is not an error."`,
    );
  });

  test("includes the query when it is known", () => {
    const error = new NoResultsError({ query: 'from(User, "u").where(u.id = $1)' });
    expect(error.query).toBe('from(User, "u").where(u.id = $1)');
    expect(error.message).toMatchInlineSnapshot(
      `"Expected at least one result but got none in query: from(User, "u").where(u.id = $1). Use the variant without "OrThrow" (it returns null) if a missing row is not an error."`,
    );
    expect(new NoResultsError().query).toBeUndefined();
  });
});

describe("MultipleResultsError", () => {
  test("reports the count and the ways out", () => {
    const error = new MultipleResultsError({ count: 3, query: 'from(User, "u")' });
    expect(error.count).toBe(3);
    expect(error.query).toBe('from(User, "u")');
    expect(error.message).toMatchInlineSnapshot(
      `"Expected at most one result but got 3 in query: from(User, "u"). Narrow the query until it matches a single row, add limit(1), or use all()."`,
    );
    expect(new MultipleResultsError({ count: 2 }).message).toMatchInlineSnapshot(
      `"Expected at most one result but got 2. Narrow the query until it matches a single row, add limit(1), or use all()."`,
    );
  });
});

describe("InvalidChangesetError", () => {
  test("carries the changeset and the action", () => {
    const error = new InvalidChangesetError({ action: "insert", changeset });
    expect(error.changeset).toBe(changeset);
    expect(error.action).toBe("insert");
  });

  test("lists every error by field, with placeholders filled from meta", () => {
    expect(new InvalidChangesetError({ action: "insert", changeset }).message).toMatchInlineSnapshot(`
      "Could not perform insert because the changeset is invalid.

      Errors:
        email: has already been taken
        password: should be at least 12 character(s)
        password: needs {missing} filled in

      Fix the input, or call the variant without "OrThrow" to get the changeset back as a Result instead of an exception."
    `);
  });

  test("never puts a field value in the message", () => {
    const message = new InvalidChangesetError({ action: "insert", changeset }).message;
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("taken@example.com");
  });

  test("does not read placeholders from the prototype chain", () => {
    const tricky: ChangesetLike = {
      ...changeset,
      errors: { name: [{ message: "is {toString} and {constructor}", meta: {} }] },
    };
    expect(new InvalidChangesetError({ action: "update", changeset: tricky }).message).toContain(
      "name: is {toString} and {constructor}",
    );
  });

  test("says so when an invalid changeset lists no errors", () => {
    const empty: ChangesetLike = { ...changeset, errors: {} };
    expect(new InvalidChangesetError({ action: "update", changeset: empty }).message).toMatchInlineSnapshot(`
      "Could not perform update because the changeset is invalid.

      Errors:
        (the changeset is marked invalid but lists no errors)

      Fix the input, or call the variant without "OrThrow" to get the changeset back as a Result instead of an exception."
    `);
  });
});

describe("StaleEntryError", () => {
  test("explains an update that matched nothing", () => {
    const error = new StaleEntryError({ action: "update", schema: "User" });
    expect([error.action, error.schema]).toEqual(["update", "User"]);
    expect(error.message).toMatchInlineSnapshot(
      `"Attempted to update a stale User row: no row matched its primary key and lock version. It was deleted or changed since it was loaded. Reload it and try again, or pass allowStale: true to ignore this."`,
    );
  });

  test("does not mention the lock version for a delete", () => {
    expect(new StaleEntryError({ action: "delete", schema: "Post" }).message).toMatchInlineSnapshot(
      `"Attempted to delete a stale Post row: no row matched its primary key. It was deleted or changed since it was loaded. Reload it and try again, or pass allowStale: true to ignore this."`,
    );
  });
});

describe("ConstraintError", () => {
  test("carries type, constraint, table, column and detail", () => {
    const error = new ConstraintError({
      type: "foreignKey",
      constraint: "posts_author_id_fkey",
      table: "posts",
      column: "author_id",
      detail: 'Key (author_id)=(99) is not present in table "users".',
      cause: driverError,
    });
    expect(error).toMatchObject({
      type: "foreignKey",
      constraint: "posts_author_id_fkey",
      table: "posts",
      column: "author_id",
      detail: 'Key (author_id)=(99) is not present in table "users".',
    });
  });

  test("keeps the database's detail line, which may quote row values, out of the message", () => {
    const error = new ConstraintError({
      type: "unique",
      constraint: "users_email_index",
      table: "users",
      column: undefined,
      detail: "Key (email)=(secret@example.com) already exists.",
    });
    expect(error.message).not.toContain("secret@example.com");
  });

  const cases: [ConstraintViolationType, string][] = [
    [
      "unique",
      `The database rejected the write: unique constraint "c1" on table "t", column "col" was violated. To report this as a changeset error instead of an exception, call uniqueConstraint on the changeset before the write.`,
    ],
    [
      "foreignKey",
      `The database rejected the write: foreign-key constraint "c1" on table "t", column "col" was violated. To report this as a changeset error instead of an exception, call foreignKeyConstraint (or noAssocConstraint on the referenced side) on the changeset before the write.`,
    ],
    [
      "check",
      `The database rejected the write: check constraint "c1" on table "t", column "col" was violated. To report this as a changeset error instead of an exception, call checkConstraint on the changeset before the write.`,
    ],
    [
      "exclusion",
      `The database rejected the write: exclusion constraint "c1" on table "t", column "col" was violated. To report this as a changeset error instead of an exception, call exclusionConstraint on the changeset before the write.`,
    ],
    [
      "notNull",
      `The database rejected the write: not-null constraint "c1" on table "t", column "col" was violated. To report this as a changeset error instead of an exception, call validateRequired on the changeset before the write.`,
    ],
  ];
  test.each(cases)("names the changeset call that handles a %s violation", (type, message) => {
    const error = new ConstraintError({
      type,
      constraint: "c1",
      table: "t",
      column: "col",
      detail: undefined,
    });
    expect(error.message).toBe(message);
  });

  test("leaves out what the database did not report", () => {
    const bare = { constraint: undefined, table: undefined, column: undefined, detail: undefined };
    expect(new ConstraintError({ type: "unique", ...bare }).message).toMatchInlineSnapshot(
      `"The database rejected the write: unique constraint was violated. To report this as a changeset error instead of an exception, call uniqueConstraint on the changeset before the write."`,
    );
    expect(new ConstraintError({ type: "check", ...bare, table: "users" }).message).toContain(
      'check constraint on table "users" was violated',
    );
    expect(new ConstraintError({ type: "check", ...bare, column: "age" }).message).toContain(
      "check constraint was violated",
    );
  });

  test("accepts a message that replaces the default", () => {
    const error = new ConstraintError({
      type: "unique",
      constraint: "users_email_index",
      table: "users",
      column: undefined,
      detail: undefined,
      message: 'Add .uniqueConstraint("email") to User.changeset.',
    });
    expect(error.message).toBe('Add .uniqueConstraint("email") to User.changeset.');
    expect(error.constraint).toBe("users_email_index");
  });
});

describe("NotLoadedError", () => {
  test("names the association and both ways to load it", () => {
    const error = new NotLoadedError({ schema: "User", association: "posts" });
    expect([error.schema, error.association]).toEqual(["User", "posts"]);
    expect(error.message).toMatchInlineSnapshot(
      `"Association "posts" of User is not loaded. Preload it first: add .preload("posts") to the query, or call repo.preload(rows, "posts")."`,
    );
  });
});

describe("DatabaseError", () => {
  test("defaults to the generic code, not retryable, no sql", () => {
    const error = new DatabaseError("The driver reported an error.");
    expect([error.code, error.retryable, error.sql]).toEqual(["database", false, undefined]);
    expect(error.message).toBe("The driver reported an error.");
  });

  test.each([
    ["serializationFailure", true],
    ["deadlock", true],
    ["connection", false],
    ["aborted", false],
    ["timeout", false],
    ["database", false],
  ] as const)("code %s is retryable by default: %s", (code, retryable) => {
    const error = new DatabaseError("x", { code });
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
  });

  test("an explicit retryable wins over the default", () => {
    expect(new DatabaseError("x", { code: "connection", retryable: true }).retryable).toBe(true);
    expect(new DatabaseError("x", { code: "deadlock", retryable: false }).retryable).toBe(false);
  });

  test("keeps the sql and the driver error", () => {
    const error = new DatabaseError("Lost the connection.", {
      code: "connection",
      sql: 'select "u"."id" from "users" as "u" where "u"."id" = $1',
      cause: driverError,
    });
    expect(error.sql).toBe('select "u"."id" from "users" as "u" where "u"."id" = $1');
    expect(error.cause).toBe(driverError);
    expect((error.cause as { code: string }).code).toBe("23505");
  });
});

describe("message-only errors", () => {
  test.each([
    [QueryError, "FULL JOIN is not supported by sqlite. Use a LEFT JOIN, or UNION two LEFT JOINs."],
    [CastError, 'Cannot cast params of type "string" to a changeset: expected a plain object.'],
    [SchemaDefinitionError, 'Post.author: belongsTo expects the foreign key field "authorId" on Post.'],
  ] as const)("%o keeps the message it is given, unchanged", (ErrorClass, message) => {
    expect(new ErrorClass(message).message).toBe(message);
  });
});
