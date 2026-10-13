import { describe, expect, test } from "vitest";
import { uniqueDatabaseName } from "./db.js";
import { shouldSweep } from "./sweep.js";

describe("shouldSweep", () => {
  const now = new Date("2026-10-11T12:00:00Z");
  const tenMinutesAgo = Math.floor(now.getTime() / 1000 - 600).toString(36);
  const name = `egon_users_rabc12345_${tenMinutesAgo}_0a1b2c3d`;

  test("matches the owning run regardless of age", () => {
    expect(shouldSweep(name, { runId: "rabc12345", now })).toBe(true);
    expect(shouldSweep(name, { runId: "rother000", now })).toBe(false);
  });

  test("matches any run's database once it is older than the limit", () => {
    expect(shouldSweep(name, { olderThanMs: 5 * 60_000, now })).toBe(true);
    expect(shouldSweep(name, { olderThanMs: 10 * 60_000, now })).toBe(false);
    expect(shouldSweep(name, { olderThanMs: 15 * 60_000, now })).toBe(false);
  });

  test("is restricted by `only`", () => {
    expect(shouldSweep(name, { runId: "rabc12345", only: /^egon_users_/, now })).toBe(true);
    expect(shouldSweep(name, { runId: "rabc12345", only: /^egon_posts_/, now })).toBe(false);
  });

  test("matches nothing without a rule", () => {
    expect(shouldSweep(name, { now })).toBe(false);
    expect(shouldSweep(uniqueDatabaseName(), {})).toBe(false);
  });

  test("never matches a name that uniqueDatabaseName did not produce", () => {
    for (const other of ["egon_dev", "postgres", "mysql", "egon_production", "app_r1_t3k9zq_9f2c61d0"]) {
      expect(shouldSweep(other, { olderThanMs: 0, runId: "r1", now })).toBe(false);
    }
  });
});
