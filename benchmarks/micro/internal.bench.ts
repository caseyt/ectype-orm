// Micro-benchmarks for packages/core/src/internal (step 02): the shape hash, the LRU that
// backs the plan cache, name conversion and inspect formatting.
//
// These utilities are not public API, so they cannot be imported from "ectype". They are
// loaded from the package's built `dist/internal.js` (an extra build entry that is not in
// the package's `exports`), so that this file measures built code like every other
// benchmark; only the types come from the sources.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { bench, doNotOptimize, group, resolveBuiltEctype, runBenchmarks } from "../src/harness.js";

type Internal = typeof import("../../packages/core/src/internal/index.js");

const builtInternal = join(dirname(resolveBuiltEctype()), "internal.js");
if (!existsSync(builtInternal)) {
  throw new Error(`${builtInternal} does not exist. Run \`pnpm build\` first.`);
}
const {
  HASH_SEED,
  hashInt,
  hashString,
  LruCache,
  camelToSnake,
  snakeToCamel,
  formatValue,
  formatStruct,
  redactFields,
} = (await import(pathToFileURL(builtInternal).href)) as Internal;

// --- hash: what the shape of the reference 3-clause query costs to compute ---
const KINDS = ["query", "table", "bool", "binary", "column", "param", "order", "column", "param"];
const IDENTIFIERS = ["users", "u", "age", "inserted_at"];

group("internal/hash", () => {
  bench("hashInt", () => doNotOptimize(hashInt(HASH_SEED, 12345)));
  bench('hashString, 11 characters ("inserted_at")', () =>
    doNotOptimize(hashString(HASH_SEED, "inserted_at")),
  );
  bench("shape of a 3-clause query: 9 kinds, 4 identifiers, 3 ints", () => {
    let hash = HASH_SEED;
    for (let i = 0; i < KINDS.length; i++) hash = hashString(hash, KINDS[i] as string);
    for (let i = 0; i < IDENTIFIERS.length; i++) hash = hashString(hash, IDENTIFIERS[i] as string);
    hash = hashInt(hash, 1);
    hash = hashInt(hash, 2);
    hash = hashInt(hash, 3);
    return doNotOptimize(hash);
  });
});

// --- lru: the plan cache's second level holds 1,000 plans keyed by shape hash ---
const full = new LruCache<number, object>(1000);
for (let i = 0; i < 1000; i++) full.set(hashInt(HASH_SEED, i), { i });
const hitKey = hashInt(HASH_SEED, 500);
const missKey = hashInt(HASH_SEED, 5000);
const plan = { sql: "select 1" };
let next = 1000;

group("internal/lru (1,000 entries, full)", () => {
  bench("get, hit", () => doNotOptimize(full.get(hitKey)));
  bench("get, miss", () => doNotOptimize(full.get(missKey)));
  bench("has", () => doNotOptimize(full.has(hitKey)));
  bench("set, existing key", () => full.set(hitKey, plan));
  bench("set, new key (evicts the oldest)", () => full.set(hashInt(HASH_SEED, next++), plan));
});

// --- naming: memoised, so the steady state is one Map lookup ---
let fresh = 0;

group("internal/naming", () => {
  bench('camelToSnake("insertedAt"), memo hit', () => doNotOptimize(camelToSnake("insertedAt")));
  bench('snakeToCamel("inserted_at"), memo hit', () => doNotOptimize(snakeToCamel("inserted_at")));
  bench("camelToSnake, memo miss (a new 16-character name each call)", () =>
    doNotOptimize(camelToSnake(`fieldName${fresh++}Value`)),
  );
});

// --- inspect: error messages and logs, never per row ---
const row = {
  id: 1,
  email: "ada@example.com",
  name: "Ada",
  age: 36,
  role: "member",
  passwordHash: "$2b$12$abcdefghijklmnopqrstuv",
  settings: { theme: "dark", tags: ["a", "b"] },
  lockVersion: 1,
  insertedAt: new Date(0),
  updatedAt: new Date(0),
};
const redacted = new Set(["passwordHash"]);

group("internal/inspect (a 10-field row)", () => {
  bench("redactFields", () => doNotOptimize(redactFields(row, redacted)));
  bench("formatValue", () => doNotOptimize(formatValue(row)));
  bench("formatStruct", () => doNotOptimize(formatStruct("User", row, redacted)));
});

await runBenchmarks();
