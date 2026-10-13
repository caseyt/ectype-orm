// Example micro-benchmark. Feature steps add `benchmarks/micro/<area>.bench.ts` files in
// this shape: register benchmarks with `bench`, then call `runBenchmarks()` once.
import { VERSION } from "egon-orm";
import { bench, doNotOptimize, group, runBenchmarks } from "../src/harness.js";

const row = { id: 1, email: "ada@example.com", name: "Ada", age: 36, role: "member" };

group("example", () => {
  bench("read VERSION", () => doNotOptimize(VERSION.length));

  bench("copy a 5-field row, fixed key order", () =>
    doNotOptimize({ id: row.id, email: row.email, name: row.name, age: row.age, role: row.role }),
  );
});

await runBenchmarks();
