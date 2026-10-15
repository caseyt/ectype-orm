import pg from "pg";
import { describe, expect, test } from "vitest";
import { type PostgresOptions, resolveOptions } from "./options.js";

describe("resolveOptions", () => {
  test("with no options, the pool has ten connections and pg reads the PG* variables", () => {
    expect(resolveOptions(undefined)).toEqual({ owned: true, config: { max: 10 } });
    expect(resolveOptions({})).toEqual({ owned: true, config: { max: 10 } });
  });

  test("maps every option to pg's names", () => {
    const password = (): string => "secret";
    const ssl = { rejectUnauthorized: false };
    expect(
      resolveOptions({
        connectionString: "postgres://u@h/d",
        host: "db",
        port: 5433,
        user: "app",
        password,
        database: "main",
        ssl,
        pool: { max: 3, idleTimeoutMs: 1_000, connectionTimeoutMs: 2_000 },
        planCacheSize: 50,
        statementTimeoutMs: 0,
        applicationName: "app",
      }),
    ).toEqual({
      owned: true,
      config: {
        connectionString: "postgres://u@h/d",
        host: "db",
        port: 5433,
        user: "app",
        password,
        database: "main",
        ssl,
        max: 3,
        idleTimeoutMillis: 1_000,
        connectionTimeoutMillis: 2_000,
        statement_timeout: 0,
        application_name: "app",
      },
    });
  });

  test("takes a password string and ssl true, and pool settings one at a time", () => {
    expect(resolveOptions({ password: "pw", ssl: true, pool: {} })).toEqual({
      owned: true,
      config: { max: 10, password: "pw", ssl: true },
    });
  });

  test("an option given as undefined is the same as one left out", () => {
    expect(
      resolveOptions({
        connectionString: undefined,
        pool: { max: undefined },
        statementTimeoutMs: undefined,
      }),
    ).toEqual({ owned: true, config: { max: 10 } });
    const pool = new pg.Pool();
    expect(resolveOptions({ pool, host: undefined })).toEqual({ owned: false, pool });
  });

  test("uses a pool you bring as it is", () => {
    const pool = new pg.Pool();
    expect(resolveOptions({ pool, planCacheSize: 10 })).toEqual({ owned: false, pool });
  });

  test.each([
    ["connectionString", { connectionString: "postgres://x" }],
    ["host", { host: "x" }],
    ["statementTimeoutMs", { statementTimeoutMs: 5 }],
    ["applicationName", { applicationName: "x" }],
    ["password", { password: "x" }],
  ])("refuses %s together with a pool you bring", (name, extra) => {
    const pool = new pg.Pool();
    expect(() => resolveOptions({ pool, ...extra } as PostgresOptions)).toThrow(
      new RegExp(`${name} cannot be combined with an existing pool`),
    );
  });

  test.each([
    ["options that are not an object", "postgres://x", /options must be a plain object/],
    [
      "an unknown option",
      { connectionstring: "x" },
      /unknown option "connectionstring"\. The options are: connectionString/,
    ],
    ["an unknown pool option", { pool: { size: 1 } }, /unknown option "size" in pool/],
    ["a pool that is neither settings nor a pool", { pool: 5 }, /pool must be pool settings/],
    ["a host that is not a string", { host: 5 }, /host must be a string/],
    ["a port out of range", { port: 70_000 }, /port must be a whole number from 1 to 65535/],
    ["a fractional port", { port: 1.5 }, /port must be a whole number/],
    ["a password of the wrong type", { password: 5 }, /password must be a string or a function/],
    ["ssl of the wrong type", { ssl: "yes" }, /ssl must be a boolean or an object/],
    ["ssl null", { ssl: null }, /ssl must be a boolean or an object/],
    ["pool.max zero", { pool: { max: 0 } }, /pool\.max must be a whole number from 1/],
    ["a negative idle timeout", { pool: { idleTimeoutMs: -1 } }, /pool\.idleTimeoutMs/],
    [
      "a connection timeout that is not a number",
      { pool: { connectionTimeoutMs: "5" } },
      /pool\.connectionTimeoutMs/,
    ],
    ["a negative statement timeout", { statementTimeoutMs: -5 }, /statementTimeoutMs must be a whole number/],
    ["an application name that is not a string", { applicationName: 1 }, /applicationName must be a string/],
    ["a database that is not a string", { database: 1 }, /database must be a string/],
    ["a user that is not a string", { user: 1 }, /user must be a string/],
    [
      "a connection string that is not a string",
      { connectionString: 1 },
      /connectionString must be a string/,
    ],
  ])("refuses %s with a TypeError", (_label, options, message) => {
    expect(() => resolveOptions(options as PostgresOptions)).toThrow(TypeError);
    expect(() => resolveOptions(options as PostgresOptions)).toThrow(message);
  });

  test("accepts options made without a prototype", () => {
    const options = Object.assign(Object.create(null) as object, { host: "db" });
    expect(resolveOptions(options as PostgresOptions)).toEqual({
      owned: true,
      config: { max: 10, host: "db" },
    });
  });
});
