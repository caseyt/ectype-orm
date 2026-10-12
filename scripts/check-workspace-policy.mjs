// Fails when pnpm-workspace.yaml weakens pnpm's supply-chain policy.
//
// pnpm 12 refuses releases younger than its minimum release age. Without
// `minimumReleaseAgeStrict: true`, adding a too-new exact version makes pnpm append the
// package to `minimumReleaseAgeExclude` by itself, with one log line as the only notice.
// That happened once in this repository. So: strict mode must stay on, and no exclusion
// may be committed. If a dependency is too new, pin the newest release that passes.
import { readFileSync } from "node:fs";

const file = new URL("../pnpm-workspace.yaml", import.meta.url);
// Comments are ignored, so the settings can be discussed in the file itself.
const lines = readFileSync(file, "utf8")
  .split("\n")
  .map((line) => line.replace(/#.*$/, "").trimEnd());

const problems = [];
if (lines.some((line) => /^\s*minimumReleaseAgeExclude\s*:/.test(line))) {
  problems.push("minimumReleaseAgeExclude is present: no package may be exempt from the release-age policy.");
}
if (!lines.some((line) => /^minimumReleaseAgeStrict:\s*true$/.test(line))) {
  problems.push("minimumReleaseAgeStrict: true is missing: without it pnpm adds exclusions by itself.");
}
for (const line of lines) {
  const match = /^minimumReleaseAge:\s*(\S+)$/.exec(line);
  if (match !== null) problems.push(`minimumReleaseAge is overridden (${match[1]}): keep pnpm's default.`);
}

if (problems.length > 0) {
  console.error(`pnpm-workspace.yaml:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
  process.exit(1);
}
console.log("ok: pnpm-workspace.yaml keeps the release-age policy strict, with no exclusions");
