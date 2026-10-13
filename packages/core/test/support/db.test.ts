import { describe, expect, test } from "vitest";
import { currentRunId, parseDatabaseName, RUN_ID_ENV, readFixture, uniqueDatabaseName } from "./db.js";

describe("uniqueDatabaseName", () => {
  test("is different on every call", () => {
    const names = new Set(Array.from({ length: 200 }, () => uniqueDatabaseName("same")));
    expect(names.size).toBe(200);
  });

  test("needs no quoting and fits every dialect's identifier limit", () => {
    for (const label of [undefined, "", "users", "Weird Label!! -- drop", "x".repeat(200), "___"]) {
      const name = uniqueDatabaseName(label);
      expect(name).toMatch(/^egon_[a-z0-9_]+_[a-z0-9]+_[0-9a-z]{6,8}_[0-9a-f]{8}$/);
      expect(name.length).toBeLessThanOrEqual(63);
    }
  });

  test("includes the label and the run id", () => {
    expect(uniqueDatabaseName("Repo Read")).toMatch(new RegExp(`^egon_repo_read_${currentRunId()}_`));
  });

  test("round-trips the run id and the creation time through parseDatabaseName", () => {
    const now = new Date("2026-10-11T12:34:56.789Z");
    for (const label of [undefined, "users", "with_many_under_scores", "x".repeat(200)]) {
      expect(parseDatabaseName(uniqueDatabaseName(label, now))).toEqual({
        runId: currentRunId(),
        createdAt: new Date("2026-10-11T12:34:56.000Z"),
      });
    }
  });
});

describe("parseDatabaseName", () => {
  test.each([
    "egon_dev",
    "egon-orm",
    "postgres",
    "egon_t_1234",
    "other_t_r1_t3k9zq_9f2c61d0",
    "egon_t_R1_t3k9zq_9f2c61d0",
  ])("does not recognise %j as a test database", (name) => {
    expect(parseDatabaseName(name)).toBeUndefined();
  });
});

describe("currentRunId", () => {
  const withEnv = (value: string | undefined, fn: () => void): void => {
    const before = process.env[RUN_ID_ENV];
    if (value === undefined) delete process.env[RUN_ID_ENV];
    else process.env[RUN_ID_ENV] = value;
    try {
      fn();
    } finally {
      if (before === undefined) delete process.env[RUN_ID_ENV];
      else process.env[RUN_ID_ENV] = before;
    }
  };

  test("uses the run id from the environment", () => {
    withEnv("r0123abcd", () => expect(currentRunId()).toBe("r0123abcd"));
  });

  test("falls back to the process id when the variable is missing or unusable", () => {
    withEnv(undefined, () => expect(currentRunId()).toBe(`p${process.pid}`));
    withEnv("Not_Usable", () => expect(currentRunId()).toBe(`p${process.pid}`));
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
