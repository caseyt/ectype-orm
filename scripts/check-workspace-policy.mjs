// Fails when pnpm-workspace.yaml weakens pnpm's supply-chain policy.
//
// pnpm 12 refuses releases younger than its minimum release age. Without
// `minimumReleaseAgeStrict: true`, adding a too-new exact version makes pnpm append the
// package to `minimumReleaseAgeExclude` by itself, with one log line as the only notice.
// That happened once in this repository. So: strict mode must stay on, and no exclusion
// may be committed. If a dependency is too new, pin the newest release that passes.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// No YAML parser is resolvable from the workspace root, and adding one for this check is
// not worth a dependency. The scan below reads `key: value` lines, with the key bare,
// single-quoted or double-quoted and at any indentation, and errs on the strict side.
// It records the indentation, because pnpm reads its settings at the top level only.
const KEY_LINE = /^(\s*)(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_.-]+))\s*:\s*(.*)$/;

/**
 * Returns the `key: value` pairs of a YAML document, one per line that has a key, with
 * `topLevel` true when the key starts in column 0. Comments are dropped, so the settings
 * can be discussed in the file itself.
 */
export function readEntries(yaml) {
  const entries = [];
  for (const raw of yaml.split(/\r?\n/)) {
    const match = KEY_LINE.exec(raw.replace(/\s+#.*$|^#.*$/, ""));
    if (match === null) continue;
    entries.push({
      key: match[2] ?? match[3] ?? match[4],
      value: match[5].trim(),
      topLevel: match[1] === "",
    });
  }
  return entries;
}

/** Returns one message per way `yaml` (the text of pnpm-workspace.yaml) weakens the policy. */
export function findPolicyProblems(yaml) {
  const entries = readEntries(yaml);
  const problems = [];
  if (entries.some(({ key }) => key === "minimumReleaseAgeExclude")) {
    problems.push(
      "minimumReleaseAgeExclude is present: no package may be exempt from the release-age policy.",
    );
  }
  const strict = entries.filter(({ key }) => key === "minimumReleaseAgeStrict");
  // A key nested under another one (indented) is not a pnpm setting: pnpm ignores it and
  // strict mode stays off. So the one occurrence must start in column 0.
  if (strict.length !== 1 || strict[0].value !== "true" || !strict[0].topLevel) {
    problems.push(
      "minimumReleaseAgeStrict must be set exactly once, at the top level (column 0), to an unquoted `true`: without it pnpm adds exclusions by itself.",
    );
  }
  for (const { key, value } of entries) {
    if (key === "minimumReleaseAge") {
      problems.push(`minimumReleaseAge is overridden (${value}): keep pnpm's default.`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = findPolicyProblems(
    readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8"),
  );
  if (problems.length > 0) {
    console.error(`pnpm-workspace.yaml:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    process.exit(1);
  }
  console.log("ok: pnpm-workspace.yaml keeps the release-age policy strict, with no exclusions");
}
