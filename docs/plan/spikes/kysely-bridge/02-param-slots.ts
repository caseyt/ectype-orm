// Question 2 — Parameter slots.
//
// Compiled SQL is cached and re-executed with different values, so the order of the
// placeholders in the SQL text must be recoverable. Technique: every value node carries a
// slot object instead of a value; Kysely's compiler copies node values into `parameters`
// in placeholder order; so `parameters` is the slot list (see compileNode in bridge.ts).
//
// Checked here: out-of-order and repeated parameters, named parameters, arrays as one
// parameter on Postgres (`= ANY($n)`), expansion to `IN (?, ?, …)` for the `?` dialects,
// re-execution of one cached plan with other values against Postgres, and that a value
// which is not a slot cannot get through unnoticed.
import assert from "node:assert/strict";
import { AliasNode, IdentifierNode, SelectionNode, SelectQueryNode, ValueNode } from "kysely";
import pg from "pg";
import { bindParams, compile, compileNode, type ParamSlot } from "./bridge.js";
import { Bridge, check, main } from "./db.js";
import { REFERENCE, SLOTS, UPDATE } from "./queries.js";

const HAND_WRITTEN = `SELECT u.id AS c0, u.age AS c1 FROM users u
  WHERE u.id = ANY($1) AND u.age >= $2 AND u.age <= $3 AND u.age <> $3 ORDER BY u.id`;

await main("Question 2: parameter slots", { users: 60, postsPerUser: 2 }, async (db) => {
  const bridge = await Bridge.open(db.config);
  const direct = new pg.Pool(db.config);
  try {
    console.log("Postgres: positional $n, out of order, repeated, named, list");
    const plan = compile(SLOTS, "postgres");
    check(
      "sql",
      plan.sql,
      'select "u"."id" as "c0", "u"."age" as "c1" from "users" as "u" where "u"."id" = any($1) and "u"."age" >= $2 and "u"."age" <= $3 and "u"."age" <> $4 order by "u"."id" asc',
    );
    // params[1] comes first, params[0] is used twice, and one value comes by name.
    const expectedSlots: ParamSlot[] = [
      { kind: "list", index: 1 },
      { kind: "named", name: "minAge" },
      { kind: "inline", index: 0 },
      { kind: "inline", index: 0 },
    ];
    check("slots are in placeholder order", plan.slots, expectedSlots);
    check("bindParams", bindParams(plan.slots, [40, [1, 2, 3]], { minAge: 18 }), [[1, 2, 3], 18, 40, 40]);
    assert.throws(() => bindParams(plan.slots, [40, [1]], {}), /missing named parameter "minAge"/);
    console.log("  ok  a missing named parameter is an error, not undefined");

    console.log("\none cached plan, executed with different values against Postgres");
    const everyId = Array.from({ length: 60 }, (_, i) => i + 1);
    const runs: [maxAge: number, ids: number[], minAge: number][] = [
      [40, everyId, 18],
      [64, [1, 2, 3], 0],
      [30, [], 0],
      [22, [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60], 16],
      [50, everyId.filter((id) => id % 2 === 1), 45],
    ];
    let nonEmpty = 0;
    for (const [maxAge, ids, minAge] of runs) {
      const viaBridge = await bridge.execute(plan, [maxAge, ids], { minAge });
      const viaPg = await direct.query(HAND_WRITTEN, [ids, minAge, maxAge]);
      check(
        `maxAge=${maxAge} minAge=${minAge} ids[${ids.length}] -> ${viaPg.rows.length} rows`,
        viaBridge.rows,
        viaPg.rows,
      );
      if (viaPg.rows.length > 0) nonEmpty += 1;
    }
    assert.ok(nonEmpty >= 3, "most comparisons must return rows, or they prove nothing");

    console.log("\nlist length does not change the Postgres SQL (one plan for every length)");
    for (const length of [0, 1, 7, 500]) {
      const ids = Array.from({ length }, (_, i) => i + 1);
      assert.equal(compile(SLOTS, "postgres", [40, ids]).sql, plan.sql);
    }
    console.log("  ok  lengths 0, 1, 7 and 500 compile to identical SQL");

    console.log("\na cached plan bound with new values equals a cold compile with those values");
    // Deterministic pseudo-random values (mulberry32), 500 rounds over three statements.
    let seed = 0x9e3779b9;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const value = () => Math.floor(random() * 1000);
    for (const dialect of ["postgres", "mysql", "sqlite"] as const) {
      for (let round = 0; round < 500; round++) {
        // Lists keep their length within a round: on the `?` dialects the length is part of the plan.
        const length = Math.floor(random() * 6);
        const a = [value(), Array.from({ length }, value), value(), value()];
        const b = [value(), Array.from({ length }, value), value(), value()];
        for (const ast of [SLOTS, REFERENCE, UPDATE]) {
          const cached = compile(ast, dialect, a);
          const cold = compile(ast, dialect, b);
          assert.equal(cached.sql, cold.sql);
          assert.deepStrictEqual(
            bindParams(cached.slots, b, { minAge: b[2] }),
            bindParams(cold.slots, b, { minAge: b[2] }),
          );
        }
      }
    }
    console.log("  ok  500 rounds x 3 statements x 3 dialects");

    console.log("\nMySQL and SQLite: `?` placeholders, lists expanded (compile only, no database)");
    for (const dialect of ["mysql", "sqlite"] as const) {
      const quote = dialect === "mysql" ? "`" : '"';
      const id = (name: string) => `${quote}${name}${quote}`;
      const expanded = compile(SLOTS, dialect, [40, [7, 8, 9]]);
      check(
        `${dialect} sql`,
        expanded.sql,
        `select ${id("u")}.${id("id")} as ${id("c0")}, ${id("u")}.${id("age")} as ${id("c1")} from ${id("users")} as ${id("u")} where ${id("u")}.${id("id")} in (?, ?, ?) and ${id("u")}.${id("age")} >= ? and ${id("u")}.${id("age")} <= ? and ${id("u")}.${id("age")} <> ? order by ${id("u")}.${id("id")} asc`,
      );
      check(`${dialect} slots`, expanded.slots, [
        { kind: "element", index: 1, element: 0 },
        { kind: "element", index: 1, element: 1 },
        { kind: "element", index: 1, element: 2 },
        { kind: "named", name: "minAge" },
        { kind: "inline", index: 0 },
        { kind: "inline", index: 0 },
      ]);
      check(`${dialect} one slot per ?`, expanded.sql.split("?").length - 1, expanded.slots.length);
      check(
        `${dialect} bindParams`,
        bindParams(expanded.slots, [40, [7, 8, 9]], { minAge: 18 }),
        [7, 8, 9, 18, 40, 40],
      );
      const longer = compile(SLOTS, dialect, [40, [7, 8, 9, 10]]);
      assert.notEqual(longer.sql, expanded.sql);
      console.log(
        `  ok  ${dialect}: a list of another length is another SQL text (length belongs in the cache key)`,
      );
    }

    console.log("\na value that is not a slot cannot reach the parameters unnoticed");
    const foreign = SelectQueryNode.cloneWithSelections(SelectQueryNode.create(), [
      SelectionNode.create(AliasNode.create(ValueNode.create("a user value"), IdentifierNode.create("c0"))),
    ]);
    assert.throws(() => compileNode(foreign, new Set(), "postgres"), /compiled parameter is not a slot/);
    console.log("  ok  compileNode rejects it");
  } finally {
    await bridge.close();
    await direct.end();
  }
  console.log("\nQuestion 2: parameter order is recovered exactly, for $n and for ?, including arrays.");
});
