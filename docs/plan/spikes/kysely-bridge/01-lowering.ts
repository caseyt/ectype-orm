// Question 1 — Lowering.
//
// Can a hand-built AST be turned into Kysely OperationNodes directly (no fluent builder)
// and compiled by PostgresQueryCompiler? Checked for the reference SELECT, an
// INSERT ... ON CONFLICT ... RETURNING, an UPDATE ... RETURNING, a CTE, a window function
// and a raw fragment. Each statement is compared with the expected SQL text and then
// executed against Postgres, and its rows are compared with the rows of an independently
// hand-written statement run through `pg` alone.
import pg from "pg";
import { compile, type Plan } from "./bridge.js";
import { Bridge, check, main } from "./db.js";
import * as q from "./queries.js";

await main("Question 1: lowering", { users: 40, postsPerUser: 6 }, async (db) => {
  const bridge = await Bridge.open(db.config);
  const direct = new pg.Pool(db.config);
  try {
    /** Runs `plan` through the bridge and `sql` through pg, and compares the rows. */
    async function same(label: string, plan: Plan, params: unknown[], sql: string, sqlParams: unknown[]) {
      const viaBridge = await bridge.execute<Record<string, unknown>>(plan, params);
      const viaPg = await direct.query(sql, sqlParams);
      check(
        `${label}: rows equal the hand-written statement's (${viaPg.rows.length} rows)`,
        viaBridge.rows,
        viaPg.rows,
      );
      if (viaPg.rows.length === 0) throw new Error(`${label}: the comparison is empty, so it proves nothing`);
    }

    // Every plan below is compiled from an AST built with placeholder values (0, "") and
    // then executed with other values: a plan holds slots, never values.
    console.log("reference SELECT (join, where, group by, order by, limit)");
    const reference = compile(q.reference(0, 0));
    check("sql", reference.sql, q.REFERENCE_SQL);
    check("slots", reference.slots, [
      { kind: "inline", index: 0 },
      { kind: "inline", index: 1 },
    ]);
    await same(
      "executes",
      reference,
      [30, 5],
      `SELECT u.id AS c0, count(p.id) AS c1 FROM users u JOIN posts p ON p.author_id = u.id
       WHERE u.age >= $1 AND p.published GROUP BY u.id ORDER BY u.inserted_at DESC LIMIT $2`,
      [30, 5],
    );

    console.log("\nCTE (WITH ... AS MATERIALIZED)");
    const cte = compile(q.cte(0, 0));
    check("sql", cte.sql, q.CTE_SQL);
    await same(
      "executes",
      cte,
      [9, 7],
      `WITH busy AS MATERIALIZED (SELECT p.author_id AS c0, count(p.id) AS c1 FROM posts p WHERE p.views >= $1 GROUP BY p.author_id)
       SELECT u.id AS c0, b.c1 AS c1 FROM users u JOIN busy b ON b.c0 = u.id ORDER BY u.id LIMIT $2`,
      [9, 7],
    );

    console.log("\nwindow function");
    const window = compile(q.windowed(0));
    check("sql", window.sql, q.WINDOW_SQL);
    await same(
      "executes",
      window,
      [3],
      `SELECT p.id AS c0, row_number() OVER (PARTITION BY p.author_id ORDER BY p.views DESC) AS c1
       FROM posts p WHERE p.author_id = $1 ORDER BY p.id`,
      [3],
    );

    console.log("\nraw fragment");
    const fragment = compile(q.fragmented(""));
    check("sql", fragment.sql, q.FRAGMENT_SQL);
    await same(
      "executes",
      fragment,
      ["user1"],
      `SELECT u.id AS c0, upper(u.name) AS c1 FROM users u WHERE starts_with(lower(u.email), $1) ORDER BY u.id`,
      ["user1"],
    );

    console.log("\nprecedence: (a OR b) AND c");
    const precedence = compile(q.precedence(0, 0, ""));
    check("sql", precedence.sql, q.PRECEDENCE_SQL);
    await same(
      "executes",
      precedence,
      [20, 21, "member"],
      `SELECT u.id AS c0 FROM users u WHERE (u.age = $1 OR u.age = $2) AND u.role = $3 ORDER BY u.id`,
      [20, 21, "member"],
    );

    console.log("\nINSERT ... ON CONFLICT ... RETURNING");
    const upsert = compile(q.upsert("", "", 0, 0));
    check("sql", upsert.sql, q.UPSERT_SQL);
    check(
      "slots",
      upsert.slots,
      [0, 1, 2, 3].map((index) => ({ kind: "inline", index })),
    );
    const inserted = await bridge.execute<Record<string, unknown>>(upsert, [
      "new@example.com",
      "First",
      33,
      1,
    ]);
    check(
      "insert returns the new row",
      { ...inserted.rows[0], c0: "?" },
      { c0: "?", c1: "new@example.com", c2: "First", c3: 1 },
    );
    check("numAffectedRows", inserted.numAffectedRows, 1n);
    const conflicted = await bridge.execute<Record<string, unknown>>(upsert, [
      "new@example.com",
      "Second",
      33,
      1,
    ]);
    check("conflict updates the same row", conflicted.rows[0], {
      c0: inserted.rows[0]?.c0,
      c1: "new@example.com",
      c2: "Second",
      c3: 2,
    });
    const stored = await direct.query("SELECT name, lock_version FROM users WHERE email = $1", [
      "new@example.com",
    ]);
    check("the database holds the updated row, once", stored.rows, [{ name: "Second", lock_version: 2 }]);

    console.log("\nUPDATE ... RETURNING");
    const update = compile(q.update("", 0, 0, 0));
    check("sql", update.sql, q.UPDATE_SQL);
    check(
      "slots",
      update.slots,
      [0, 1, 2, 3].map((index) => ({ kind: "inline", index })),
    );
    const id = inserted.rows[0]?.c0;
    const updated = await bridge.execute<Record<string, unknown>>(update, ["Third", 1, id, 2]);
    check("update returns the row", updated.rows, [{ c0: id, c1: "Third", c2: 3 }]);
    const stale = await bridge.execute<Record<string, unknown>>(update, ["Fourth", 1, id, 2]);
    check("a stale lock_version updates nothing", [stale.rows, stale.numAffectedRows], [[], 0n]);
  } finally {
    await bridge.close();
    await direct.end();
  }
  console.log("\nQuestion 1: every statement lowered, compiled to the expected SQL, and ran.");
});
