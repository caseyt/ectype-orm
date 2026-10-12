// Question 2 — Parameter slots.
//
// Compiled SQL is cached and re-executed with different values, so two things must hold:
//
//  (a) Slot recovery. The order of the placeholders in the SQL text is recoverable.
//      Technique: every value node carries a slot object instead of a value; Kysely's
//      compiler copies node values into `parameters` in placeholder order; so
//      `parameters` is the slot list (see compileNode in bridge.ts).
//  (b) Canonical numbering. A slot's index is a position in `collectParams(ast)`: the
//      contract's canonical parameter order (packages/core/src/contracts/query.ts), which
//      is NOT placeholder order and is the same for every AST of one shape. The lowering
//      numbers parameter nodes with a counter while visiting in that order; `collectParams`
//      in ast.ts is an independent walk. They must agree, or a re-bound plan sends values
//      to the wrong placeholders.
//
// The statement used (queries.ts, `slots`) has a CTE with WHERE and HAVING parameters, a
// join on a subquery containing EXISTS with `= ANY(list)`, a second list inside another
// EXISTS, a parameter in the select list, a named parameter used in two places, UNION ALL,
// LIMIT and OFFSET. Its placeholder order is 0, 1, 5, 2, 3, minAge, 4, 8, minAge, 6, 7.
//
// What is checked:
//   - the slots, against the order worked out by hand from the SQL text;
//   - ONE plan, compiled from an AST holding dummy values, executed against Postgres with
//     60 sets of random values taken from OTHER ASTs via collectParams, each compared
//     with a hand-written statement run through `pg` with hand-ordered parameters;
//   - the same for MySQL and SQLite placeholders (`?`, lists expanded), where the bound
//     array is compared with one assembled by hand (compile only: no MySQL or SQLite
//     database is involved);
//   - that a value which is not a slot cannot get through unnoticed.
import assert from "node:assert/strict";
import { AliasNode, IdentifierNode, SelectionNode, SelectQueryNode, ValueNode } from "kysely";
import pg from "pg";
import { collectParams } from "./ast.js";
import { bindParams, compile, compileNode, type ParamSlot } from "./bridge.js";
import { Bridge, check, main } from "./db.js";
import {
  reference,
  SLOTS_HAND_WRITTEN,
  type SlotValues,
  slots,
  slotsHandWrittenParams,
  update,
} from "./queries.js";

const DUMMY: SlotValues = {
  minViews: 0,
  minPosts: 0,
  commentIds: [],
  maxAge: 0,
  tagIds: [],
  bonus: 0,
  limit: 0,
  offset: 0,
  unionMinPosts: 0,
  minAge: 0,
};

// Deterministic pseudo-random values (mulberry32).
let seed = 0x9e3779b9;
const random = (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1));
const ints = (count: number, min: number, max: number): number[] =>
  Array.from({ length: count }, () => int(min, max));

function randomValues(listLengths?: { commentIds: number; tagIds: number }): SlotValues {
  return {
    minViews: int(0, 12),
    minPosts: int(1, 3),
    commentIds: ints(listLengths?.commentIds ?? int(0, 40), 1, 480),
    maxAge: int(30, 64),
    tagIds: ints(listLengths?.tagIds ?? int(1, 4), 1, 5),
    bonus: int(0, 1000),
    limit: int(1, 30),
    offset: int(0, 3),
    unionMinPosts: int(1, 4),
    minAge: int(15, 40),
  };
}

await main("Question 2: parameter slots", { users: 60, postsPerUser: 4 }, async (db) => {
  const bridge = await Bridge.open(db.config);
  const direct = new pg.Pool(db.config);
  try {
    console.log("Postgres: slots are in placeholder order and index the canonical parameter order");
    const plan = compile(slots(DUMMY), "postgres");
    check(
      "sql",
      plan.sql,
      'with "busy" as (select "p"."author_id" as "c0", count("p"."id") as "c1" from "posts" as "p" where "p"."views" >= $1 group by "p"."author_id" having count("p"."id") >= $2) select "u"."id" as "c0", "b"."c1" + $3 as "c1", "cp"."c1" as "c2" from "users" as "u" inner join "busy" as "b" on "b"."c0" = "u"."id" left join (select "p2"."author_id" as "c0", count("p2"."id") as "c1" from "posts" as "p2" where exists (select "c"."id" as "c0" from "comments" as "c" where "c"."post_id" = "p2"."id" and "c"."id" = any($4)) group by "p2"."author_id") as "cp" on "cp"."c0" = "u"."id" where "u"."age" <= $5 and "u"."age" >= $6 and exists (select "p3"."id" as "c0" from "posts" as "p3" inner join "posts_tags" as "pt" on "pt"."post_id" = "p3"."id" where "p3"."author_id" = "u"."id" and "pt"."tag_id" = any($7)) union all select "u"."id" as "c0", "b"."c1" as "c1", null::bigint as "c2" from "users" as "u" inner join "busy" as "b" on "b"."c0" = "u"."id" where "b"."c1" >= $8 and "u"."age" < $9 order by c0 asc, c1 asc limit $10 offset $11',
    );
    // Worked out by hand from the SQL text above and the table in queries.ts.
    const expectedSlots: ParamSlot[] = [
      { kind: "inline", index: 0 }, // $1  CTE where
      { kind: "inline", index: 1 }, // $2  CTE having
      { kind: "inline", index: 5 }, // $3  select list: numbered after the joins and wheres
      { kind: "list", index: 2 }, // $4  join subquery
      { kind: "inline", index: 3 }, // $5  where
      { kind: "named", name: "minAge" }, // $6
      { kind: "list", index: 4 }, // $7  exists subquery
      { kind: "inline", index: 8 }, // $8  union branch: numbered after limit and offset
      { kind: "named", name: "minAge" }, // $9  the named parameter again
      { kind: "inline", index: 6 }, // $10 limit
      { kind: "inline", index: 7 }, // $11 offset
    ];
    check("slots", plan.slots, expectedSlots);
    const sample = randomValues();
    check("collectParams gives the canonical order", collectParams(slots(sample)), [
      sample.minViews,
      sample.minPosts,
      sample.commentIds,
      sample.maxAge,
      sample.tagIds,
      sample.bonus,
      sample.limit,
      sample.offset,
      sample.unionMinPosts,
    ]);
    assert.throws(
      () => bindParams(plan.slots, collectParams(slots(sample)), {}),
      /missing named parameter "minAge"/,
    );
    console.log("  ok  a missing named parameter is an error, not undefined");

    console.log("\none plan (compiled from dummy values), 60 other ASTs, executed against Postgres");
    let nonEmpty = 0;
    let multiRow = 0;
    let both = 0;
    for (let round = 0; round < 60; round++) {
      const values = randomValues();
      const other = slots(values);
      // The plan is shared because the shape is the same: a cold compile gives the same SQL.
      assert.equal(compile(other, "postgres").sql, plan.sql);
      const viaBridge = await bridge.execute<{ c2: unknown }>(plan, collectParams(other), {
        minAge: values.minAge,
      });
      const viaPg = await direct.query(SLOTS_HAND_WRITTEN, slotsHandWrittenParams(values));
      assert.deepStrictEqual(viaBridge.rows, viaPg.rows, `round ${round}: ${JSON.stringify(values)}`);
      if (viaPg.rows.length > 0) nonEmpty += 1;
      if (viaPg.rows.length > 1) multiRow += 1;
      if (viaPg.rows.some((row) => row.c2 === null) && viaPg.rows.some((row) => row.c2 !== null)) both += 1;
    }
    console.log(
      `  ok  60 rounds equal the hand-written statement (${nonEmpty} with rows, ${multiRow} with more than one row, ${both} with rows from both UNION branches)`,
    );
    assert.ok(multiRow >= 30, "most comparisons must return several rows, or they prove little");
    assert.ok(both >= 10, "both branches of the UNION must be exercised");

    console.log("\na wrong numbering is caught by this check (it is not a tautology)");
    // Swap two indexes in the slots, as a lowering that numbered the select list before the
    // joins would, and confirm the comparison above would have failed.
    const swapped = plan.slots.map((slot) =>
      slot.kind === "inline" && slot.index === 5
        ? { ...slot, index: 3 }
        : slot.kind === "inline" && slot.index === 3
          ? { ...slot, index: 5 }
          : slot,
    );
    let caught = 0;
    let comparable = 0;
    for (let round = 0; round < 20; round++) {
      const values = randomValues();
      const wrong = await bridge
        .execute({ ...plan, slots: swapped }, collectParams(slots(values)), { minAge: values.minAge })
        .then((result) => result.rows);
      const right = await direct.query(SLOTS_HAND_WRITTEN, slotsHandWrittenParams(values));
      // A round whose correct result is empty cannot show a difference in c1.
      if (right.rows.length === 0 && wrong.length === 0) continue;
      comparable += 1;
      try {
        assert.deepStrictEqual(wrong, right.rows);
      } catch {
        caught += 1;
      }
    }
    // The rounds it does not change are those whose rows all come from the UNION branch,
    // which uses neither of the two swapped parameters.
    assert.ok(
      caught >= 8,
      `a swapped numbering must change the results (changed ${caught} of ${comparable})`,
    );
    console.log(
      `  ok  swapping two indexes changed the result in ${caught} of ${comparable} rounds that return rows`,
    );

    console.log("\nlist length does not change the Postgres SQL (one plan for every length)");
    for (const length of [0, 1, 7, 500]) {
      const values = randomValues({ commentIds: length, tagIds: length });
      assert.equal(compile(slots(values), "postgres").sql, plan.sql);
    }
    console.log("  ok  lengths 0, 1, 7 and 500 compile to identical SQL");

    console.log("\nsimpler statements: slots follow the canonical order too");
    check(
      "reference SELECT",
      compile(reference(0, 0)).slots,
      [0, 1].map((index) => ({ kind: "inline", index })),
    );
    check(
      "UPDATE (SET values, then WHERE values)",
      compile(update("", 0, 0, 0)).slots,
      [0, 1, 2, 3].map((index) => ({ kind: "inline", index })),
    );

    console.log("\nMySQL and SQLite: `?` placeholders, lists expanded (compile only, no database)");
    for (const dialect of ["mysql", "sqlite"] as const) {
      const lengths = { commentIds: 3, tagIds: 2 };
      const cached = compile(slots(randomValues(lengths)), dialect);
      check(`${dialect}: one slot per ?`, cached.sql.split("?").length - 1, cached.slots.length);
      check(`${dialect}: slots`, cached.slots, [
        { kind: "inline", index: 0 },
        { kind: "inline", index: 1 },
        { kind: "inline", index: 5 },
        { kind: "element", index: 2, element: 0 },
        { kind: "element", index: 2, element: 1 },
        { kind: "element", index: 2, element: 2 },
        { kind: "inline", index: 3 },
        { kind: "named", name: "minAge" },
        { kind: "element", index: 4, element: 0 },
        { kind: "element", index: 4, element: 1 },
        { kind: "inline", index: 8 },
        { kind: "named", name: "minAge" },
        { kind: "inline", index: 6 },
        { kind: "inline", index: 7 },
      ]);
      assert.match(cached.sql, /in \(\?, \?, \?\)/);
      assert.match(cached.sql, /in \(\?, \?\)/);
      for (let round = 0; round < 200; round++) {
        const v = randomValues(lengths);
        // The array a driver must receive, assembled by hand in the order of the `?`s.
        const expected = [
          v.minViews,
          v.minPosts,
          v.bonus,
          ...v.commentIds,
          v.maxAge,
          v.minAge,
          ...v.tagIds,
          v.unionMinPosts,
          v.minAge,
          v.limit,
          v.offset,
        ];
        assert.deepStrictEqual(
          bindParams(cached.slots, collectParams(slots(v)), { minAge: v.minAge }),
          expected,
        );
      }
      console.log(
        `  ok  ${dialect}: a cached plan bound with 200 other value sets equals the hand-assembled array`,
      );
      const longer = compile(slots(randomValues({ commentIds: 4, tagIds: 2 })), dialect);
      assert.notEqual(longer.sql, cached.sql);
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
  console.log(
    "\nQuestion 2: parameter order is recovered exactly and numbered canonically, for $n and for ?, including arrays.",
  );
});
