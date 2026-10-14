// Micro-benchmarks for packages/core/src/schema (step 04): what building a row costs
// (README §7 budget: hydrate a 10-column row < 150 ns, of which the row factory is the
// part this step owns), and what looking up a schema's metadata costs per query.
import { belongsTo, hasMany, meta, Schema, t, timestamps } from "egon-orm";
import { bench, doNotOptimize, group, runBenchmarks } from "../src/harness.js";

const fields = {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  age: t.integer().nullable(),
  role: t.enum(["admin", "member"]).default("member"),
  passwordHash: t.string().redact(),
  settings: t.json<{ theme: string }>().nullable(),
  lockVersion: t.integer().default(1),
  ...timestamps(),
};

class User extends Schema("users", fields) {
  static posts = hasMany(() => User, { foreignKey: "id" });
  static manager = belongsTo(() => User, { foreignKey: "id" });

  get displayName(): string {
    return this.name ?? this.email;
  }
}

class UserWithoutCodegen extends Schema("users", fields, { codegen: false }) {}

// Ten columns per row, as a driver returns them; rotated so that the JIT sees the mix of
// values (and nulls) a real result has.
const MASK = 63;
let turn = 0;
const created = new Date("2026-10-13T00:00:00Z");
const rows = Array.from({ length: MASK + 1 }, (_, i) => [
  i,
  `user${i}@example.com`,
  i % 2 === 0 ? null : `User ${i}`,
  i % 3 === 0 ? null : 20 + i,
  i % 2 === 0 ? "admin" : "member",
  "$2b$10$abcdefghijklmnopqrstuv",
  i % 4 === 0 ? null : { theme: "dark" },
  1,
  created,
  created,
]);
const nextRow = (): unknown[] => rows[turn++ & MASK] as unknown[];

const userMeta = meta(User);
const loaded = userMeta.rowMeta("loaded", undefined);
const plainMeta = meta(UserWithoutCodegen);
const plainLoaded = plainMeta.rowMeta("loaded", undefined);
const withPosts = userMeta.createWith(["posts"]);
const noPosts: unknown[] = [];

group("schema: build a row", () => {
  bench("create a 10-field row (generated factory)", () => doNotOptimize(userMeta.create(nextRow(), loaded)));
  bench("create a 10-field row (loop, no codegen)", () =>
    doNotOptimize(plainMeta.create(nextRow(), plainLoaded)),
  );
  bench("create a 10-field row with one loaded association", () =>
    doNotOptimize(withPosts(nextRow(), [noPosts], loaded)),
  );
  bench("baseline: object literal with the same 10 fields", () => {
    const v = nextRow();
    doNotOptimize({
      id: v[0],
      email: v[1],
      name: v[2],
      age: v[3],
      role: v[4],
      passwordHash: v[5],
      settings: v[6],
      lockVersion: v[7],
      createdAt: v[8],
      updatedAt: v[9],
    });
  });
});

group("schema: metadata", () => {
  bench("meta(User)", () => doNotOptimize(meta(User)));
  bench("meta(User).rowMeta(loaded, undefined)", () =>
    doNotOptimize(meta(User).rowMeta("loaded", undefined)),
  );
  bench("meta(User).rowMeta(loaded, tenant)", () => doNotOptimize(meta(User).rowMeta("loaded", "tenant_1")));
  bench("meta(User).assocs().get(posts)", () => doNotOptimize(meta(User).assocs().get("posts")));
  bench("meta(User).createWith([posts]), cached", () => doNotOptimize(meta(User).createWith(["posts"])));
});

await runBenchmarks();
