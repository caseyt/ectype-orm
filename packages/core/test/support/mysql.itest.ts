import { randomBytes } from "node:crypto";
import { createConnection } from "mysql2/promise";
import { describe, expect, test } from "vitest";
import { currentRunId, withDatabase } from "./db.js";
import { connectionSettings, tier2Enabled } from "./env.js";
import { sweepTestDatabases } from "./sweep.js";
import { truncateAll } from "./truncate.js";

// Tier 2: runs only with ECTYPE_TEST_TIER2=1 and `pnpm db:up:tier2`.
describe.skipIf(!tier2Enabled())("withDatabase and truncateAll (mysql)", () => {
  test("creates a uniquely named database and drops it afterwards", async () => {
    let inner = "";
    await withDatabase("mysql", { label: "lifecycle" }, async (db) => {
      inner = db.name;
      expect(await db.query("SELECT DATABASE() AS name")).toEqual([{ name: db.name }]);
    });
    await withDatabase("mysql", async (other) => {
      const rows = await other.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = ?", [
        inner,
      ]);
      expect(rows).toEqual([]);
    });
  });

  const TIMEOUT_MS = 500;
  const observed: { database?: string; settledAfterMs?: number } = {};

  // `fails` accepts any failure, so the next test checks that it really was the timeout.
  test.fails("a test times out while it holds a database", { timeout: TIMEOUT_MS }, () => {
    const startedAt = Date.now();
    return withDatabase("mysql", { label: "leak_timeout" }, async (db) => {
      observed.database = db.name;
      try {
        await db.query("SELECT SLEEP(30)");
      } finally {
        observed.settledAfterMs = Date.now() - startedAt;
      }
    });
  });

  test("the database of the timed-out test was created, outlived the timeout, and is gone", async () => {
    expect(observed.database).toMatch(new RegExp(`^ectype_leak_timeout_${currentRunId()}_`));
    // (`undefined`: the driver never settled the abandoned query, which is fine too.)
    // The margin absorbs scheduling jitter: this clock starts a moment after Vitest's timer.
    expect(observed.settledAfterMs ?? TIMEOUT_MS).toBeGreaterThanOrEqual(TIMEOUT_MS * 0.8);
    expect(observed.settledAfterMs ?? 0).toBeLessThan(30_000);

    await withDatabase("mysql", async (other) => {
      const leaked = await other.query(
        "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE ?",
        [`ectype\\_leak\\_timeout\\_${currentRunId()}\\_%`],
      );
      expect(leaked).toEqual([]);
    });
  });

  test("the sweep drops stale and own databases and nothing else", async () => {
    const settings = connectionSettings("mysql");
    await withDatabase("mysql", async (db) => {
      // Made-up run ids, so this cannot collide with another run sharing the server.
      const [staleRun, freshRun] = [
        `x${randomBytes(5).toString("hex")}`,
        `x${randomBytes(5).toString("hex")}`,
      ];
      const stale = `ectype_sweep_${staleRun}_1a2b3c_00000001`;
      const fresh = `ectype_sweep_${freshRun}_${Math.floor(Date.now() / 1000).toString(36)}_00000002`;
      const other = `ectype_notatest_${randomBytes(4).toString("hex")}`;
      const only = new RegExp(`^ectype_(sweep_(${staleRun}|${freshRun})|notatest)_`);
      await db.exec(`CREATE DATABASE ${stale}; CREATE DATABASE ${fresh}; CREATE DATABASE ${other};`);
      try {
        // Another run's database with an ancient name, but somebody is connected to it.
        const user = await createConnection({ ...settings, database: stale });
        try {
          const onlyStale = new RegExp(`^${stale}$`);
          expect(await sweepTestDatabases("mysql", { olderThanMs: 0, settings, only: onlyStale })).toEqual(
            [],
          );
        } finally {
          await user.end();
        }
        expect(await sweepTestDatabases("mysql", { olderThanMs: 60_000, settings, only })).toEqual([stale]);
        expect(await sweepTestDatabases("mysql", { runId: freshRun, settings, only })).toEqual([fresh]);
        const rows = await db.query(
          "SELECT schema_name AS name FROM information_schema.schemata WHERE schema_name = ?",
          [other],
        );
        expect(rows).toEqual([{ name: other }]);
      } finally {
        await db.exec(
          `DROP DATABASE IF EXISTS ${stale}; DROP DATABASE IF EXISTS ${fresh}; DROP DATABASE IF EXISTS ${other};`,
        );
      }
    });
  });

  test("truncates every table despite foreign keys and resets auto-increment", () =>
    withDatabase("mysql", async (db) => {
      expect(await truncateAll(db)).toEqual([]);
      await db.exec(`
        CREATE TABLE parents (id bigint PRIMARY KEY AUTO_INCREMENT, name text);
        CREATE TABLE children (id bigint PRIMARY KEY AUTO_INCREMENT, parent_id bigint NOT NULL,
          FOREIGN KEY (parent_id) REFERENCES parents (id));
        CREATE TABLE keep (id int);
        INSERT INTO parents (name) VALUES ('p');
        INSERT INTO children (parent_id) VALUES (1);
        INSERT INTO keep VALUES (1);
      `);
      expect(await truncateAll(db, { except: ["keep"] })).toEqual(["children", "parents"]);
      expect(await db.query("SELECT * FROM parents")).toEqual([]);
      expect(await db.query("SELECT * FROM children")).toEqual([]);
      expect(await db.query("SELECT id FROM keep")).toEqual([{ id: 1 }]);
      await db.query("INSERT INTO parents (name) VALUES (?)", ["again"]);
      expect(await db.query("SELECT id FROM parents")).toEqual([{ id: 1 }]);
    }));
});
