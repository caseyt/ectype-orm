// Runs the five spike scripts in order and stops at the first failure.
//
//   pnpm db:up
//   pnpm --filter @ectype/spike-kysely-bridge run spike
//
// Set SPIKE_COST_QUICK=1 to shorten the benchmark of question 4 (for a smoke run only: the
// numbers in ADR 0002 come from the full run).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const SCRIPTS: [file: string, nodeFlags: string[]][] = [
  ["01-lowering.ts", []],
  ["02-param-slots.ts", []],
  ["03-execution.ts", []],
  ["04-cost.ts", ["--expose-gc"]],
  ["05-gaps.ts", []],
];

for (const [file, flags] of SCRIPTS) {
  const child = spawnSync(process.execPath, [...flags, "--import", "tsx", file], {
    cwd: here,
    stdio: "inherit",
  });
  if (child.status !== 0) {
    console.error(`\n${file} failed (exit ${child.status ?? child.signal}).`);
    process.exit(1);
  }
  console.log("");
}
console.log("All five spike scripts passed.");
