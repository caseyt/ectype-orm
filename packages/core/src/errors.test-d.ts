import { describe, expectTypeOf, test } from "vitest";
import type { ChangesetLike } from "./contracts/changeset.js";
import {
  AdapterError,
  type AdapterErrorCode,
  ConstraintError,
  type ConstraintViolationType,
  type EctypeError,
  type ErrorCode,
  InvalidChangesetError,
  isEctypeError,
  MultipleResultsError,
  NoResultsError,
  NotLoadedError,
  QueryError,
  StaleEntryError,
} from "./errors.js";

describe("error codes", () => {
  test("each class has its literal code", () => {
    expectTypeOf(new NoResultsError().code).toEqualTypeOf<"no_results">();
    expectTypeOf(new QueryError("x").code).toEqualTypeOf<"query">();
    expectTypeOf(new AdapterError("x").code).toEqualTypeOf<AdapterErrorCode>();
    expectTypeOf<EctypeError["code"]>().toEqualTypeOf<ErrorCode>();
    expectTypeOf<AdapterErrorCode>().toExtend<ErrorCode>();
  });

  test("the code discriminates a union of errors", () => {
    const error = {} as NoResultsError | MultipleResultsError | StaleEntryError;
    if (error.code === "multiple_results") expectTypeOf(error).toEqualTypeOf<MultipleResultsError>();
    if (error.code === "stale_entry") expectTypeOf(error.schema).toEqualTypeOf<string>();
  });

  test("isEctypeError narrows unknown and takes only real codes", () => {
    const caught: unknown = undefined;
    if (isEctypeError(caught)) {
      expectTypeOf(caught).toEqualTypeOf<EctypeError>();
      expectTypeOf(caught.code).toEqualTypeOf<ErrorCode>();
    }
    isEctypeError(caught, "deadlock");
    // @ts-expect-error not an error code
    isEctypeError(caught, "nope");
  });
});

describe("constructors", () => {
  test("InvalidChangesetError keeps the changeset's own type", () => {
    interface UserChangeset extends ChangesetLike<{ email: string }> {
      readonly extra: number;
    }
    const changeset = {} as UserChangeset;
    const error = new InvalidChangesetError({ action: "insert", changeset });
    expectTypeOf(error.changeset).toEqualTypeOf<UserChangeset>();
    expectTypeOf(error.changeset.data.email).toEqualTypeOf<string>();
    expectTypeOf(error.changeset).not.toBeAny();
    // @ts-expect-error not a changeset
    new InvalidChangesetError({ action: "insert", changeset: { valid: false } });
  });

  test("required details are required", () => {
    // @ts-expect-error count is required
    new MultipleResultsError({});
    // @ts-expect-error schema is required
    new StaleEntryError({ action: "update" });
    // @ts-expect-error association is required
    new NotLoadedError({ schema: "User" });
    // @ts-expect-error a message is required
    new QueryError();
    // @ts-expect-error table, column and detail must be passed, even as undefined
    new ConstraintError({ type: "unique", constraint: "x" });
  });

  test("ConstraintError and AdapterError take only their own kinds", () => {
    expectTypeOf<ConstraintError["type"]>().toEqualTypeOf<ConstraintViolationType>();
    const unreported = { constraint: undefined, table: undefined, column: undefined, detail: undefined };
    new ConstraintError({ type: "notNull", ...unreported });
    // @ts-expect-error noAssoc is a changeset declaration, not a database violation
    new ConstraintError({ type: "noAssoc", ...unreported });
    // @ts-expect-error not an adapter code
    new AdapterError("x", { code: "query" });
    expectTypeOf(new AdapterError("x").retryable).toEqualTypeOf<boolean>();
    expectTypeOf(new AdapterError("x").sql).toEqualTypeOf<string | undefined>();
  });
});
