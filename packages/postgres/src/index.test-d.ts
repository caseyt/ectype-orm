import type { DatabaseAdapter } from "egon-orm";
import pg from "pg";
import { describe, expectTypeOf, test } from "vitest";
import { type PostgresOptions, postgres, VERSION } from "./index.js";

test("VERSION is a string, not any", () => {
  expectTypeOf(VERSION).toBeString();
  expectTypeOf(VERSION).not.toBeAny();
});

describe("postgres", () => {
  test("returns a DatabaseAdapter", () => {
    const adapter = postgres({ connectionString: "postgres://localhost/app" });
    expectTypeOf(adapter).toEqualTypeOf<DatabaseAdapter>();
    expectTypeOf(adapter).not.toBeAny();
    expectTypeOf(postgres()).toEqualTypeOf<DatabaseAdapter>();
  });

  test("takes connection settings, pool settings or a pool, and the adapter options", () => {
    postgres({
      host: "db",
      port: 5432,
      user: "app",
      password: async () => "rotated",
      database: "main",
      ssl: { rejectUnauthorized: true },
      pool: { max: 10, idleTimeoutMs: 30_000, connectionTimeoutMs: 5_000 },
      planCacheSize: 1000,
      statementTimeoutMs: 10_000,
      applicationName: "my-app",
    });
    postgres({ pool: new pg.Pool() });
    // An environment variable may be missing: undefined is the same as leaving the option out.
    postgres({ connectionString: process.env.DATABASE_URL, pool: { max: undefined } });
    expectTypeOf<PostgresOptions["pool"]>().toEqualTypeOf<
      import("./options.js").PostgresPoolOptions | pg.Pool | undefined
    >();
  });

  test("refuses what it does not have", () => {
    // @ts-expect-error there is no types option: the schema field decides the runtime type
    postgres({ types: {} });
    // @ts-expect-error pool settings use the Ms names
    postgres({ pool: { idleTimeoutMillis: 1 } });
    // @ts-expect-error a port is a number
    postgres({ port: "5432" });
    // @ts-expect-error logging belongs to the repo
    postgres({ log: true });
  });
});
