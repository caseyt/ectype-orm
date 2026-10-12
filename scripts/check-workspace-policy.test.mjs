// Run by `pnpm test:unit` (node --test).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { findPolicyProblems } from "./check-workspace-policy.mjs";

const GOOD =
  'packages:\n  - "packages/*"\n\n# minimumReleaseAgeExclude must never appear\nminimumReleaseAgeStrict: true\n\nallowBuilds:\n  esbuild: true\n';

describe("findPolicyProblems", () => {
  test("accepts the committed pnpm-workspace.yaml", () => {
    const committed = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
    assert.deepEqual(findPolicyProblems(committed), []);
  });

  test("accepts a strict file and ignores comments that mention the settings", () => {
    assert.deepEqual(findPolicyProblems(GOOD), []);
    assert.deepEqual(findPolicyProblems(`${GOOD}  # minimumReleaseAge: 0\n`), []);
  });

  for (const [name, key] of [
    ["a bare key", "minimumReleaseAgeExclude"],
    ["a double-quoted key", '"minimumReleaseAgeExclude"'],
    ["a single-quoted key", "'minimumReleaseAgeExclude'"],
    ["an indented key", "  minimumReleaseAgeExclude"],
    ["a key with a space before the colon", '"minimumReleaseAgeExclude" '],
  ]) {
    test(`rejects an exclusion written as ${name}`, () => {
      for (const value of ["\n  - zod@4.6.6\n", " [zod@4.6.6]\n", ' ["zod@4.6.6"] # approved\n']) {
        const problems = findPolicyProblems(`${GOOD}${key}:${value}`);
        assert.equal(problems.length, 1, `${key}:${value}`);
        assert.match(problems[0], /minimumReleaseAgeExclude is present/);
      }
    });
  }

  test("rejects strict mode that is missing, off, quoted, commented out or contradicted", () => {
    const without = GOOD.replace("minimumReleaseAgeStrict: true\n", "");
    for (const replacement of [
      "",
      "minimumReleaseAgeStrict: false\n",
      '"minimumReleaseAgeStrict": false\n',
      'minimumReleaseAgeStrict: "true"\n',
      "# minimumReleaseAgeStrict: true\n",
      "minimumReleaseAgeStrict: true\nminimumReleaseAgeStrict: false\n",
    ]) {
      const problems = findPolicyProblems(without + replacement);
      assert.equal(problems.length, 1, JSON.stringify(replacement));
      assert.match(problems[0], /minimumReleaseAgeStrict must be set/);
    }
  });

  test("accepts strict mode written with a quoted key", () => {
    const quoted = GOOD.replace("minimumReleaseAgeStrict: true", '"minimumReleaseAgeStrict": true');
    assert.deepEqual(findPolicyProblems(quoted), []);
  });

  test("rejects an overridden minimum age, quoted or not", () => {
    for (const line of ["minimumReleaseAge: 0\n", '"minimumReleaseAge": 0\n', "'minimumReleaseAge': 1\n"]) {
      const problems = findPolicyProblems(GOOD + line);
      assert.equal(problems.length, 1, line);
      assert.match(problems[0], /minimumReleaseAge is overridden/);
    }
  });
});
