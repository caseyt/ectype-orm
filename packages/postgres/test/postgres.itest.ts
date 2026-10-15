// Postgres-specific behaviour of the adapter that the dialect-independent conformance
// suite does not cover: the options of `postgres(...)`, a pool you bring yourself,
// server-side timeouts, and that the adapter leaves the global `pg` settings alone.

import { createTestDatabase, type TestDatabase, type TestDatabaseHandle } from "@egon-orm/test-support";
import type { DatabaseAdapter } from "egon-orm";
import { DatabaseError } from "egon-orm";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { bigintType, resolveCodec, timestampType } from "../../core/src/types/index.js";
import { checkedOut } from "../../core/test/conformance/adapter/index.js";
import { type PostgresOptions, postgres } from "../src/index.js";

let handle: TestDatabaseHandle;
let db: TestDatabase;
const made: DatabaseAdapter[] = [];

function connection(): PostgresOptions {
  return {
    host: db.settings.host,
    port: db.settings.port,
    user: db.settings.user,
    password: db.settings.password,
    database: db.name,
  };
}

function adapter(options: PostgresOptions = {}): DatabaseAdapter {
  const created = postgres({ ...connection(), ...options });
  made.push(created);
  return created;
}

beforeAll(async () => {
  handle = await createTestDatabase("postgres", { label: "pgadapter" });
  db = handle.db;
});

afterEach(async () => {
  for (const each of made.splice(0)) {
    expect(checkedOut(each.poolStats())).toBe(0);
    await each.close();
  }
});

afterAll(async () => {
  await handle?.drop();
});

describe("values", () => {
  test("date, int8 and numeric arrive as text; the global pg parsers are not changed", async () => {
    const dateParser = pg.types.getTypeParser(1082);
    const int8Parser = pg.types.getTypeParser(20);
    const a = adapter();
    const { rows } = await a.execute(
      "select '2026-03-29'::date as d, 9007199254740993::int8 as i, 1.50::numeric as n",
      [],
    );
    expect(rows[0]).toEqual({ d: "2026-03-29", i: "9007199254740993", n: "1.50" });
    expect(pg.types.getTypeParser(1082)).toBe(dateParser);
    expect(pg.types.getTypeParser(20)).toBe(int8Parser);

    // Another pg client in the same process still parses dates the default way.
    const raw = new pg.Client({ ...db.settings, database: db.name });
    await raw.connect();
    try {
      const plain = await raw.query("select '2026-03-29'::date as d");
      expect(plain.rows[0]?.d).toBeInstanceOf(Date);
    } finally {
      await raw.end();
    }
  });

  test("the bigint type reads the numeric that sum() of a bigint column returns", async () => {
    const a = adapter();
    const { rows } = await a.execute(
      "select sum(x) as total from (values (9007199254740993::int8), (1::int8)) as v (x)",
      [],
    );
    const codec = resolveCodec(bigintType(), a);
    expect(codec.fromDb(rows[0]?.total)).toBe(9_007_199_254_740_994n);
  });

  test("timestamptz is exact whatever the session time zone of a pool you bring", async () => {
    const pool = new pg.Pool({
      ...db.settings,
      database: db.name,
      options: "-c TimeZone=Asia/Kathmandu",
      max: 2,
    });
    try {
      const a = postgres({ pool });
      const codec = resolveCodec(timestampType(), a);
      const instant = new Date("0001-06-15T12:34:56.789Z");
      const sent = codec.toDb(instant);
      const { rows } = await a.execute("select $1::timestamptz as t, $1::timestamptz::text as text", [sent]);
      expect(rows[0]?.text).toMatch(/\+05:/);
      expect(codec.fromDb(rows[0]?.t)).toEqual(instant);
      await a.close();
    } finally {
      await pool.end();
    }
  });
});

describe("options", () => {
  test("applicationName is what pg_stat_activity shows", async () => {
    const a = adapter({ applicationName: "egon-adapter-test" });
    const { rows } = await a.execute(
      "select application_name as name from pg_stat_activity where pid = pg_backend_pid()",
      [],
    );
    expect(rows[0]?.name).toBe("egon-adapter-test");
  });

  test("statementTimeoutMs stops a long statement on the server", async () => {
    const a = adapter({ statementTimeoutMs: 100 });
    await expect(a.execute("select pg_sleep(5)", [])).rejects.toMatchObject({ code: "timeout" });
    expect((await a.execute("select 1 as one", [])).rows).toEqual([{ one: 1 }]);
  });

  test("connectionTimeoutMs bounds the wait for a connection from a busy pool", async () => {
    const a = adapter({ pool: { max: 1, connectionTimeoutMs: 100 } });
    const held = await a.acquire();
    try {
      const error = await a.execute("select 1", []).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DatabaseError);
      expect(error).toMatchObject({ code: "connection" });
    } finally {
      await held.release();
    }
  });

  test("an unreachable server is a connection error", async () => {
    const a = postgres({
      host: "127.0.0.1",
      port: 1,
      user: "nobody",
      database: "none",
      pool: { connectionTimeoutMs: 2_000 },
    });
    await expect(a.ping()).rejects.toMatchObject({ code: "connection" });
    await a.close();
  });

  test("wrong credentials are a connection error", async () => {
    const a = adapter({ password: "not-the-password" });
    await expect(a.ping()).rejects.toMatchObject({ code: "connection" });
  });
});

describe("a pool you bring", () => {
  test("is used as it is, and left open by close()", async () => {
    const pool = new pg.Pool({ ...db.settings, database: db.name, max: 1 });
    try {
      const a = postgres({ pool });
      expect((await a.execute("select 1 as one", [])).rows).toEqual([{ one: 1 }]);
      expect(a.poolStats()).toEqual({ size: 1, idle: 1, waiting: 0 });
      await a.close();
      expect((await pool.query("select 2 as two")).rows).toEqual([{ two: 2 }]);
    } finally {
      await pool.end();
    }
  });

  test("cancels a statement through the pool's own settings", async () => {
    const pool = new pg.Pool({ ...db.settings, database: db.name, max: 1 });
    try {
      const a = postgres({ pool });
      await expect(a.execute("select pg_sleep(5)", [], { timeoutMs: 100 })).rejects.toMatchObject({
        code: "timeout",
      });
      await a.close();
    } finally {
      await pool.end();
    }
  });
});

describe("statements", () => {
  test("a named statement is prepared once on a connection and reused", async () => {
    const a = adapter({ pool: { max: 1 } });
    const c = await a.acquire();
    try {
      for (const value of [1, 2]) {
        const { rows } = await c.execute("select $1::int + 1 as next", [value], {
          statementName: "egon_next",
        });
        expect(rows).toEqual([{ next: value + 1 }]);
      }
      const { rows } = await c.execute(
        "select count(*)::int as n from pg_prepared_statements where name = 'egon_next'",
        [],
      );
      expect(rows).toEqual([{ n: 1 }]);
    } finally {
      await c.release();
    }
  });

  test("a list of statements without parameters returns the last statement's result", async () => {
    const a = adapter();
    const result = await a.execute("select 1 as a; select 2 as b, 3 as c", []);
    expect(result.rows).toEqual([{ b: 2, c: 3 }]);
  });

  test("begin outside a transaction through execute never leaks an open transaction to the next caller", async () => {
    const a = adapter({ pool: { max: 1 } });
    await a.execute("begin", []);
    const { rows } = await a.execute("select now() = statement_timestamp() as fresh", []);
    expect(rows[0]?.fresh).toBe(true);
  });
});
