import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import * as api from "./index.js";
import { VERSION } from "./index.js";

test("VERSION matches the version in package.json", () => {
  const pkg: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(pkg).toMatchObject({ version: VERSION });
});

test("the public entry point exports exactly these values", () => {
  // Adding a public export is a decision: update this list in the same change.
  expect(Object.keys(api).sort()).toEqual([
    "CastError",
    "ConstraintError",
    "DatabaseError",
    "EgonError",
    "InvalidChangesetError",
    "MultipleResultsError",
    "NoResultsError",
    "NotLoadedError",
    "QueryError",
    "SchemaDefinitionError",
    "StaleEntryError",
    "VERSION",
    "failure",
    "isEgonError",
    "success",
  ]);
});

test("nothing from contracts/ or internal/ leaks out beyond the Result helpers", () => {
  for (const name of ["IDENTITY", "META", "ROW", "LruCache", "hashString", "camelToSnake", "formatValue"]) {
    expect(Object.hasOwn(api, name)).toBe(false);
  }
});
