import { describe, expect, test } from "vitest";
import { readFixture, uniqueDatabaseName } from "./db.js";

describe("uniqueDatabaseName", () => {
  test("is different on every call", () => {
    const names = new Set(Array.from({ length: 200 }, () => uniqueDatabaseName("same")));
    expect(names.size).toBe(200);
  });

  test("needs no quoting and fits every dialect's identifier limit", () => {
    for (const label of [undefined, "", "users", "Weird Label!! -- drop", "x".repeat(200), "___"]) {
      const name = uniqueDatabaseName(label);
      expect(name).toMatch(/^ectype_[a-z0-9_]+_\d+_[0-9a-f]{12}$/);
      expect(name.length).toBeLessThanOrEqual(63);
    }
  });

  test("includes the label and the process id", () => {
    expect(uniqueDatabaseName("Repo Read")).toMatch(new RegExp(`^ectype_repo_read_${process.pid}_`));
  });
});

describe("readFixture", () => {
  test("reads the blog schema", async () => {
    const sql = await readFixture("blog");
    for (const table of [
      "users",
      "profiles",
      "posts",
      "comments",
      "tags",
      "posts_tags",
      "orgs",
      "memberships",
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table} (`);
    }
  });

  test("rejects names that could escape the fixtures directory", async () => {
    expect(() => readFixture("../env")).toThrow(/invalid fixture name/);
  });
});
