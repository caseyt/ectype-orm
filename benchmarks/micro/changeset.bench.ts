// Micro-benchmarks for packages/core/src/changeset (step 05). README §7 budget: cast + 5
// built-in validations on a 10-field changeset < 3 µs.
import { cast, change, meta, Schema, t } from "egon-orm";
import { bench, doNotOptimize, group, runBenchmarks } from "../src/harness.js";

class Account extends Schema("accounts", {
  id: t.integer().primaryKey().dbGenerated(),
  email: t.string(),
  name: t.string().nullable(),
  age: t.integer().nullable(),
  role: t.enum(["admin", "member"]).default("member"),
  bio: t.string().nullable(),
  website: t.string().nullable(),
  score: t.float().default(0),
  active: t.boolean().default(true),
  joinedAt: t.timestamp(),
}) {}

const permitted = [
  "email",
  "name",
  "age",
  "role",
  "bio",
  "website",
  "score",
  "active",
  "joinedAt",
  "id",
] as const;

// Form-style input: strings, as a request body carries them. Rotated so that the JIT
// sees a realistic mix (including one invalid age in eight).
const MASK = 63;
let turn = 0;
const inputs = Array.from({ length: MASK + 1 }, (_, i) => ({
  email: `user${i}@example.com`,
  name: `User ${i}`,
  age: i % 8 === 0 ? "old" : String(18 + (i % 50)),
  role: i % 2 === 0 ? "admin" : "member",
  bio: i % 3 === 0 ? "" : "Writes software.",
  website: `https://example.com/${i}`,
  score: String(i / 4),
  active: i % 5 === 0 ? "false" : "true",
  joinedAt: "2026-10-14T09:00:00.000Z",
  id: String(i + 1),
  ignored: "not permitted",
}));
const nextInput = () => inputs[turn++ & MASK];

const info = meta(Account);
const row = info.create(
  [1, "ada@example.com", "Ada", 36, "admin", null, null, 1.5, true, new Date("2026-01-01T00:00:00Z")],
  info.rowMeta("loaded", undefined),
) as Account;

const EMAIL = /^[^@\s]+@[^@\s]+$/;
const cs10 = cast(Account, inputs[1], permitted);

group("changeset: cast", () => {
  bench("cast 10 fields (new record)", () => doNotOptimize(cast(Account, nextInput(), permitted)));
  bench("cast 10 fields (loaded row)", () => doNotOptimize(cast(row, nextInput(), permitted)));
  bench("change 3 values (loaded row)", () =>
    doNotOptimize(change(row, { name: "Grace", age: 40, active: false })),
  );
});

group("changeset: validate", () => {
  bench("cast 10 fields + 5 validations (budget < 3 µs)", () =>
    doNotOptimize(
      cast(Account, nextInput(), permitted)
        .validateRequired(["email", "joinedAt"])
        .validateFormat("email", EMAIL)
        .validateLength("name", { min: 2, max: 80 })
        .validateNumber("age", { greaterThanOrEqualTo: 13 })
        .validateInclusion("role", ["admin", "member"]),
    ),
  );
  bench("one passing validation (validateLength)", () =>
    doNotOptimize(cs10.validateLength("name", { min: 2, max: 80 })),
  );
  bench("one passing validation (validateRequired, 2 fields)", () =>
    doNotOptimize(cs10.validateRequired(["email", "joinedAt"])),
  );
  bench("errorMessages of a changeset with one error", () =>
    doNotOptimize(cast(Account, inputs[0], permitted).errorMessages()),
  );
});

await runBenchmarks();
