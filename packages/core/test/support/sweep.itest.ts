import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe, expect, test } from "vitest";
import { currentRunId, withDatabase } from "./db.js";
import { connectionSettings } from "./env.js";
import { sweepTestDatabases } from "./sweep.js";

const settings = connectionSettings("postgres");
const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
const seconds = (date: Date): string => Math.floor(date.getTime() / 1000).toString(36);

/**
 * A run id nobody else uses, so that these tests can run while another integration run
 * (or another copy of this file) shares the server.
 */
const fakeRunId = (): string => `x${hex(5)}`;
/** A database name as `uniqueDatabaseName` would build it for `runId` at `createdAt`. */
const fakeName = (runId: string, createdAt: Date): string =>
  `egon_sweep_${runId}_${seconds(createdAt)}_${hex(4)}`;
/** Restricts a sweep to the databases of the given made-up runs. */
const onlyRuns = (...runIds: string[]): RegExp => new RegExp(`^egon_sweep_(${runIds.join("|")})_`);

async function exists(name: string): Promise<boolean> {
  return withDatabase("postgres", async (db) => {
    const rows = await db.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    return rows.length === 1;
  });
}

describe("sweepTestDatabases (postgres)", () => {
  test("drops databases older than the limit and leaves younger ones of other runs alone", () =>
    withDatabase("postgres", async (db) => {
      const [staleRun, freshRun] = [fakeRunId(), fakeRunId()];
      const stale = fakeName(staleRun, new Date(Date.now() - 3_600_000));
      const fresh = fakeName(freshRun, new Date());
      await db.query(`CREATE DATABASE ${stale}`);
      await db.query(`CREATE DATABASE ${fresh}`);
      try {
        const only = onlyRuns(staleRun, freshRun);
        expect(await sweepTestDatabases("postgres", { olderThanMs: 30 * 60_000, settings, only })).toEqual([
          stale,
        ]);
        expect(await exists(stale)).toBe(false);
        expect(await exists(fresh)).toBe(true);
      } finally {
        await db.query(`DROP DATABASE IF EXISTS ${stale}`);
        await db.query(`DROP DATABASE IF EXISTS ${fresh}`);
      }
    }));

  test("never treats a database with open connections as stale", () =>
    withDatabase("postgres", async (db) => {
      // Another run's database with an ancient name, but somebody is connected to it.
      const run = fakeRunId();
      const name = fakeName(run, new Date("2020-01-01T00:00:00Z"));
      await db.query(`CREATE DATABASE ${name}`);
      const user = new pg.Client({ ...settings, database: name });
      await user.connect();
      try {
        expect(
          await sweepTestDatabases("postgres", { olderThanMs: 0, settings, only: onlyRuns(run) }),
        ).toEqual([]);
        expect(await exists(name)).toBe(true);
        await user.end();
        expect(
          await sweepTestDatabases("postgres", { olderThanMs: 0, settings, only: onlyRuns(run) }),
        ).toEqual([name]);
      } finally {
        await user.end().catch(() => undefined);
        await db.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }
    }));

  test("drops every database of the given run, even one in use, and no other run's", () =>
    withDatabase("postgres", async (db) => {
      const [myRun, theirRun] = [fakeRunId(), fakeRunId()];
      const mine = fakeName(myRun, new Date());
      const theirs = fakeName(theirRun, new Date());
      await db.query(`CREATE DATABASE ${mine}`);
      await db.query(`CREATE DATABASE ${theirs}`);
      const user = new pg.Client({ ...settings, database: mine });
      user.on("error", () => undefined); // the sweep terminates this connection
      await user.connect();
      try {
        const only = onlyRuns(myRun, theirRun);
        expect(await sweepTestDatabases("postgres", { runId: myRun, settings, only })).toEqual([mine]);
        expect(await exists(mine)).toBe(false);
        expect(await exists(theirs)).toBe(true);
        expect(await exists(db.name)).toBe(true);
      } finally {
        await user.end().catch(() => undefined);
        await db.query(`DROP DATABASE IF EXISTS ${mine} WITH (FORCE)`);
        await db.query(`DROP DATABASE IF EXISTS ${theirs}`);
      }
    }));

  test("ignores databases that uniqueDatabaseName did not create", () =>
    withDatabase("postgres", async (db) => {
      const name = `egon_notatest_${hex(4)}`;
      await db.query(`CREATE DATABASE ${name}`);
      try {
        const only = /^egon_(notatest_|dev$)/;
        expect(
          await sweepTestDatabases("postgres", { olderThanMs: 0, runId: "notatest", settings, only }),
        ).toEqual([]);
        expect(await exists(name)).toBe(true);
        expect(await exists(settings.database)).toBe(true);
      } finally {
        await db.query(`DROP DATABASE IF EXISTS ${name}`);
      }
    }));

  test("reports an unreachable server with the command that starts it", async () => {
    await expect(
      sweepTestDatabases("postgres", {
        runId: currentRunId(),
        only: /^$/,
        settings: { ...settings, port: 1 },
      }),
    ).rejects.toThrow(/Cannot reach the postgres test server/);
  });
});
