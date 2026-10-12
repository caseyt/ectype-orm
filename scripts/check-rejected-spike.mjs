// Asserts that docs/plan/spikes/rejected-const-thunks.ts still FAILS to compile, with the
// diagnostics that justify decision D1 (docs/adr/0001-schema-classes.md). If a future
// TypeScript release accepts those designs, this check fails and D1 should be revisited.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const spike = "docs/plan/spikes/rejected-const-thunks.ts";
/** Candidate A (const + thunks) must fail with TS7022; candidate C (thunks in `extends`) with TS2506. */
const expected = ["TS7022", "TS2506"];

const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");

const { status, stdout, stderr } = spawnSync(
  process.execPath,
  [tsc, "--noEmit", "--strict", "--ignoreConfig", "--pretty", "false", spike],
  { cwd: root, encoding: "utf8" },
);
const output = `${stdout}${stderr}`;

if (status === 0) {
  console.error(`${spike} compiled without errors. Decision D1 rests on it failing; revisit the ADR.`);
  process.exit(1);
}
const missing = expected.filter((code) => !output.includes(`error ${code}:`));
if (missing.length > 0) {
  console.error(`${spike} failed, but without the expected diagnostic(s) ${missing.join(", ")}:\n${output}`);
  process.exit(1);
}
console.log(`ok: ${spike} is still rejected (${expected.join(", ")})`);
