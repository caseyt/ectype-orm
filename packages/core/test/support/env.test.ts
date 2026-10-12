import { describe, expect, test } from "vitest";
import { connectionSettings, connectionUrl, tier2Enabled } from "./env.js";

describe("connectionSettings", () => {
  test("defaults match docker-compose.yml", () => {
    expect(connectionSettings("postgres", {})).toEqual({
      host: "127.0.0.1",
      port: 54329,
      user: "ectype",
      password: "ectype",
      database: "ectype_dev",
    });
    expect(connectionSettings("mysql", {})).toEqual({
      host: "127.0.0.1",
      port: 33069,
      user: "root",
      password: "ectype",
      database: "ectype_dev",
    });
  });

  test("environment variables override the defaults", () => {
    const settings = connectionSettings("postgres", {
      ECTYPE_PG_HOST: "db.internal",
      ECTYPE_PG_PORT: "6543",
      ECTYPE_PG_USER: "ci",
      ECTYPE_PG_PASSWORD: "secret",
      ECTYPE_PG_DATABASE: "maintenance",
    });
    expect(settings).toEqual({
      host: "db.internal",
      port: 6543,
      user: "ci",
      password: "secret",
      database: "maintenance",
    });
    expect(connectionSettings("mysql", { ECTYPE_MYSQL_PORT: "3307" }).port).toBe(3307);
  });

  test("an empty variable falls back to the default", () => {
    expect(connectionSettings("postgres", { ECTYPE_PG_HOST: "", ECTYPE_PG_PORT: "" })).toMatchObject({
      host: "127.0.0.1",
      port: 54329,
    });
  });

  test.each(["abc", "0", "65536", "5432.5", "-1"])("rejects %j as a port", (value) => {
    expect(() => connectionSettings("postgres", { ECTYPE_PG_PORT: value })).toThrow(
      /ECTYPE_PG_PORT must be a TCP port/,
    );
  });
});

describe("connectionUrl", () => {
  test("formats settings as a URL", () => {
    expect(connectionUrl("postgres", connectionSettings("postgres", {}))).toBe(
      "postgres://ectype:ectype@127.0.0.1:54329/ectype_dev",
    );
  });

  test("escapes credentials", () => {
    const url = connectionUrl("mysql", {
      host: "localhost",
      port: 3306,
      user: "a@b",
      password: "p:w/d#?",
      database: "db",
    });
    expect(url).toBe("mysql://a%40b:p%3Aw%2Fd%23%3F@localhost:3306/db");
    expect(new URL(url).password).toBe("p%3Aw%2Fd%23%3F");
  });
});

test("tier 2 databases are opt-in", () => {
  expect(tier2Enabled({})).toBe(false);
  expect(tier2Enabled({ ECTYPE_TEST_TIER2: "0" })).toBe(false);
  expect(tier2Enabled({ ECTYPE_TEST_TIER2: "1" })).toBe(true);
  expect(tier2Enabled({ ECTYPE_TEST_TIER2: "true" })).toBe(true);
});
