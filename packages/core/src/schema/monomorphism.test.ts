// Rows must share one hidden class (README §7): every field assigned in the same order,
// nothing added or deleted afterwards. V8's %HaveSameMap says whether two objects share
// one. Natives syntax is switched on for this file only, before the probe is compiled.
import { setFlagsFromString } from "node:v8";
import { describe, expect, test } from "vitest";
import type { AnySchema } from "../contracts/schema.js";
import { belongsTo, hasMany, meta, Schema, t, timestamps } from "./index.js";

setFlagsFromString("--allow-natives-syntax");
const haveSameMap = new Function("a", "b", "return %HaveSameMap(a, b)") as (a: object, b: object) => boolean;

const fields = {
  id: t.integer().primaryKey(),
  email: t.string(),
  name: t.string().nullable(),
  age: t.integer().nullable(),
  role: t.enum(["admin", "member"]),
  password: t.string().virtual(),
  settings: t.json<{ theme: string }>().nullable(),
  score: t.float(),
  active: t.boolean(),
  ...timestamps(),
};

const variants = (i: number): unknown[] => [
  i,
  `user${i}@example.com`,
  i % 2 === 0 ? null : `User ${i}`,
  i % 3 === 0 ? null : i * 3,
  i % 2 === 0 ? "admin" : "member",
  i % 4 === 0 ? null : { theme: "dark" },
  i + 0.5,
  i % 2 === 0,
  new Date(i),
  new Date(i),
];

function check(schema: AnySchema): void {
  const m = meta(schema);
  const rowMeta = m.rowMeta("loaded", undefined);
  // The first rows settle the representation of each field (a null next to a string).
  for (let i = 0; i < 50; i++) m.create(variants(i), rowMeta);
  const rows = Array.from({ length: 200 }, (_, i) => m.create(variants(i), rowMeta));
  const first = rows[0] as object;
  for (const row of rows) expect(haveSameMap(first, row)).toBe(true);

  const withPosts = m.createWith(["posts"]);
  const withAuthor = m.createWith(["author"]);
  for (let i = 0; i < 50; i++) withPosts(variants(i), [[]], rowMeta);
  const loaded = Array.from({ length: 200 }, (_, i) =>
    withPosts(variants(i), [i % 2 === 0 ? [] : [first]], rowMeta),
  );
  for (const row of loaded) expect(haveSameMap(loaded[0] as object, row)).toBe(true);
  // The probe can tell shapes apart: other associations, or none, are another shape.
  expect(haveSameMap(loaded[0] as object, first)).toBe(false);
  expect(haveSameMap(loaded[0] as object, withAuthor(variants(1), [null], rowMeta))).toBe(false);
}

describe("every row of a schema has the same hidden class", () => {
  test("with the generated factory", () => {
    class User extends Schema("users", fields) {
      static posts = hasMany(() => User, { foreignKey: "id" });
      static author = belongsTo(() => User, { foreignKey: "id" });
    }
    check(User);
  });

  test("with the loop that replaces it where code cannot be generated", () => {
    class User extends Schema("users", fields, { codegen: false }) {
      static posts = hasMany(() => User, { foreignKey: "id" });
      static author = belongsTo(() => User, { foreignKey: "id" });
    }
    check(User);
  });
});
