// Micro-benchmarks for packages/core/src/changeset/validators (step 06). Targets:
// `validate` with a 10-field Zod object < 20% over calling Zod directly; the function
// validator path < 300 ns of overhead.
import { cast, meta, Schema, t } from "egon-orm";
import { z } from "zod";
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

const info = meta(Account);
const joinedAt = new Date("2026-01-01T00:00:00Z");
const row = info.create(
  [1, "ada@example.com", "Ada", 36, "admin", null, "https://example.com/ada", 1.5, true, joinedAt],
  info.rowMeta("loaded", undefined),
) as Account;

const AccountInput = z.object({
  id: z.number().int(),
  email: z.string().email(),
  name: z.string().min(2).nullable(),
  age: z.number().int().min(13).nullable(),
  role: z.enum(["admin", "member"]),
  bio: z.string().max(500).nullable(),
  website: z.string().url().nullable(),
  score: z.number(),
  active: z.boolean(),
  joinedAt: z.date(),
});
const standard = AccountInput["~standard"];

// A changeset of the loaded row with three changes, and the object the validator sees.
const cs = cast(row, { name: "Ada Lovelace", age: "37", bio: "Wrote the first program." }, [
  "name",
  "age",
  "bio",
]);
const values = {
  id: 1,
  email: "ada@example.com",
  name: "Ada Lovelace",
  age: 37,
  role: "admin",
  bio: "Wrote the first program.",
  website: "https://example.com/ada",
  score: 1.5,
  active: true,
  joinedAt,
};
const invalid = cast(row, { email: "not an address", age: "9" }, ["email", "age"]);
const invalidValues = { ...values, email: "not an address", age: 9 };
const renamed = cast(row, { email: "ada.lovelace@example.com" }, ["email"]);
const fresh = cast(Account, { email: "grace@example.com", name: "Grace", joinedAt: joinedAt.toISOString() }, [
  "email",
  "name",
  "joinedAt",
]);

const noIssues = () => undefined;
const emptyIssues = () => [];
const EMAIL = z.string().email();

group("validators: Zod, 10 fields (target < 20% over Zod)", () => {
  bench("Zod directly: ~standard.validate (passing)", () => doNotOptimize(standard.validate(values)));
  bench("cs.validate(zodObject) (passing)", () => doNotOptimize(cs.validate(AccountInput)));
  bench("Zod directly: ~standard.validate (2 issues)", () => doNotOptimize(standard.validate(invalidValues)));
  bench("cs.validate(zodObject) (2 issues)", () => doNotOptimize(invalid.validate(AccountInput)));
});

group("validators: function (target < 300 ns overhead)", () => {
  bench("cs.validate(fn) returning nothing", () => doNotOptimize(cs.validate(noIssues)));
  bench("cs.validate(fn) returning []", () => doNotOptimize(cs.validate(emptyIssues)));
  bench("cs.validate(fn) with one issue", () =>
    doNotOptimize(cs.validate(() => [{ path: "name", message: "is taken" }])),
  );
  bench("cs.validate(fn) returning nothing (new record: defaults built)", () =>
    doNotOptimize(fresh.validate(noIssues)),
  );
});

group("validators: one field", () => {
  bench("Zod directly: z.string().email() ~standard.validate (passing)", () =>
    doNotOptimize(EMAIL["~standard"].validate("ada.lovelace@example.com")),
  );
  bench("cs.validateField('email', z.string().email()) (changed, passing)", () =>
    doNotOptimize(renamed.validateField("email", EMAIL)),
  );
  bench("Zod directly: z.string().email() ~standard.validate (1 issue)", () =>
    doNotOptimize(EMAIL["~standard"].validate("not an address")),
  );
  bench("cs.validateField('email', z.string().email()) (changed, 1 issue)", () =>
    doNotOptimize(invalid.validateField("email", EMAIL)),
  );
  bench("cs.validateField('email', …) (unchanged: skipped)", () =>
    doNotOptimize(cs.validateField("email", EMAIL)),
  );
});

await runBenchmarks();
