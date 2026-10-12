// Question 3 — Execution.
//
// Run a cached { sql, slots } through Kysely's driver/connection API without constructing
// a Kysely query builder (or a `Kysely` instance at all) per call, and drive transactions
// and savepoints through the same connection.
//
// The only Kysely objects involved are one PostgresDriver and its DatabaseConnections
// (see Bridge in db.ts). Per execution the bridge allocates the parameter array, one
// CompiledQuery-shaped object literal and one lazy query id.
import assert from "node:assert/strict";
import pg from "pg";
import { compile } from "./bridge.js";
import { Bridge, check, main } from "./db.js";
import { REFERENCE, UPSERT } from "./queries.js";

await main("Question 3: execution", { users: 40, postsPerUser: 6 }, async (db) => {
  const bridge = await Bridge.open({ ...db.config, max: 4 });
  const observer = new pg.Pool({ ...db.config, max: 2 });
  const names = async (prefix: string) =>
    (
      await observer.query("SELECT name FROM users WHERE email LIKE $1 ORDER BY name", [`${prefix}%`])
    ).rows.map((row: { name: string }) => row.name);
  try {
    const select = compile(REFERENCE);
    const upsert = compile(UPSERT);

    console.log("cached plan, many executions, pooled connections");
    const expected = await observer.query(
      `SELECT u.id AS c0, count(p.id) AS c1 FROM users u JOIN posts p ON p.author_id = u.id
       WHERE u.age >= $1 AND p.published GROUP BY u.id ORDER BY u.inserted_at DESC LIMIT $2`,
      [20, 10],
    );
    const results = await Promise.all(Array.from({ length: 25 }, () => bridge.execute(select, [20, 10])));
    for (const result of results) assert.deepStrictEqual(result.rows, expected.rows);
    console.log(
      `  ok  25 concurrent executions on a pool of 4 returned the expected ${expected.rows.length} rows each`,
    );
    check("the pool never grew past its limit", bridge.pool.totalCount <= 4, true);

    console.log("\ntransaction: commit");
    let connection = await bridge.acquire();
    try {
      await bridge.begin(connection);
      const pid1 = await bridge.raw<{ pid: number; tx: string }>(
        connection,
        "SELECT pg_backend_pid() AS pid, txid_current()::text AS tx",
      );
      await bridge.run(connection, upsert, ["tx-commit@example.com", "committed", 30, 1]);
      check("not visible to another connection before commit", await names("tx-commit"), []);
      const pid2 = await bridge.raw<{ pid: number; tx: string }>(
        connection,
        "SELECT pg_backend_pid() AS pid, txid_current()::text AS tx",
      );
      check("same backend and same transaction id throughout", pid2.rows, pid1.rows);
      await bridge.commit(connection);
    } finally {
      await bridge.release(connection);
    }
    check("visible after commit", await names("tx-commit"), ["committed"]);

    console.log("\ntransaction: rollback");
    connection = await bridge.acquire();
    try {
      await bridge.begin(connection);
      await bridge.run(connection, upsert, ["tx-rollback@example.com", "rolled back", 30, 1]);
      const inside = await bridge.raw<{ n: number }>(
        connection,
        "SELECT count(*)::int AS n FROM users WHERE email = $1",
        ["tx-rollback@example.com"],
      );
      check("visible inside the transaction", inside.rows, [{ n: 1 }]);
      await bridge.rollback(connection);
    } finally {
      await bridge.release(connection);
    }
    check("gone after rollback", await names("tx-rollback"), []);

    console.log("\nsavepoints on the same connection");
    connection = await bridge.acquire();
    try {
      await bridge.begin(connection);
      await bridge.run(connection, upsert, ["sp-a@example.com", "A", 30, 1]);
      await bridge.savepoint(connection, "sp1");
      await bridge.run(connection, upsert, ["sp-b@example.com", "B", 30, 1]);
      await bridge.rollbackTo(connection, "sp1");
      await bridge.run(connection, upsert, ["sp-c@example.com", "C", 30, 1]);
      await bridge.releaseSavepoint(connection, "sp1");
      // A savepoint name that needs quoting: Kysely emits it as a quoted identifier.
      await bridge.savepoint(connection, 'odd "name"; drop table users');
      await bridge.run(connection, upsert, ["sp-d@example.com", "D", 30, 1]);
      await bridge.rollbackTo(connection, 'odd "name"; drop table users');
      await bridge.commit(connection);
    } finally {
      await bridge.release(connection);
    }
    check("A and C committed, B and D rolled back to their savepoints", await names("sp-"), ["A", "C"]);

    console.log("\nan error inside a transaction keeps the driver error, and the connection survives");
    connection = await bridge.acquire();
    try {
      await bridge.begin(connection);
      // UPSERT only handles conflicts on email; a NULL email violates NOT NULL instead.
      const failure = await bridge.run(connection, upsert, [null, "x", 30, 1]).then(
        () => undefined,
        (error: unknown) => error,
      );
      assert.ok(failure instanceof Error);
      check(
        "the pg error code is intact (23502 not_null_violation)",
        (failure as { code?: string }).code,
        "23502",
      );
      check(
        "and so are column and table",
        [(failure as { table?: string }).table, (failure as { column?: string }).column],
        ["users", "email"],
      );
      await bridge.rollback(connection);
      const after = await bridge.run(connection, select, [20, 10]);
      check("the same connection runs the cached plan after rollback", after.rows, expected.rows);
    } finally {
      await bridge.release(connection);
    }

    console.log("\nno connection leaked");
    check(
      "every pooled connection is idle",
      [bridge.pool.idleCount === bridge.pool.totalCount, bridge.pool.waitingCount],
      [true, 0],
    );
  } finally {
    await bridge.close();
    await observer.end();
  }
  console.log(
    "\nQuestion 3: cached plans, transactions and savepoints all run through the driver API alone.",
  );
});
