// The Postgres adapter compiles with the SQL compiler of egon-orm (step 10): queries
// built with from(...) and row-level writes, compiled through the adapter, bound and
// executed on a real database.

import { createTestDatabase, type TestDatabase, type TestDatabaseHandle, User } from "@egon-orm/test-support";
import type { DatabaseAdapter, FieldMeta } from "egon-orm";
import { from, meta, param, t } from "egon-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { bindParams } from "../../core/src/compiler/index.js";
import { postgres } from "../src/index.js";

let handle: TestDatabaseHandle;
let db: TestDatabase;
let adapter: DatabaseAdapter;

beforeAll(async () => {
  handle = await createTestDatabase("postgres", { label: "pgcompile", fixtures: ["blog"] });
  db = handle.db;
  adapter = postgres({
    host: db.settings.host,
    port: db.settings.port,
    user: db.settings.user,
    password: db.settings.password,
    database: db.name,
    planCacheSize: 50,
  });
});

afterAll(async () => {
  await adapter?.close();
  await handle?.drop();
});

test("a query built with from() compiles through the adapter and runs", async () => {
  const users = meta(User);
  const email = users.fieldsByName.get("email") as FieldMeta;
  const age = users.fieldsByName.get("age") as FieldMeta;
  const id = users.fieldsByName.get("id") as FieldMeta;
  const insert = adapter.compileInsert(
    users,
    [email, age],
    { source: { kind: "values", rows: 2 }, returning: [id], onConflict: undefined },
    undefined,
  );
  const inserted = await adapter.execute(
    insert.sql,
    bindParams(insert.slots, ["ann@example.com", 34, "bo@example.com", 15]),
    { slots: insert.slots },
  );
  expect(inserted.rowCount).toBe(2);

  const q = from(User, "u")
    .where(({ u }) => u.age.gte(param("minAge", t.integer())))
    .where(({ u }) => u.email.in(["ann@example.com", "bo@example.com"]))
    .orderBy(({ u }) => u.email)
    .select(({ u }) => ({ email: u.email, age: u.age }));
  const plan = adapter.compile(q.ast, "all", undefined);
  // The plan is cached in the adapter: compiling the same query again finds it.
  expect(adapter.compile(q.ast, "all", undefined)).toBe(plan);
  const result = await adapter.execute(plan.sql, bindParams(plan.slots, q.ast.params, { minAge: 18 }), {
    slots: plan.slots,
  });
  expect(result.rows).toEqual([{ c0: "ann@example.com", c1: 34 }]);
});
