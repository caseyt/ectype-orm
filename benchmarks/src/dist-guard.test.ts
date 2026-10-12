// Tests of the benchmark harness itself, on Node's built-in runner (`pnpm test:unit` runs
// them after the Vitest projects). Kept out of Vitest so that harness files do not show
// up in the packages' coverage report.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isInsideOwnDist } from "./dist-guard.js";

describe("isInsideOwnDist", () => {
  const root = "/repo/packages/core";

  test("accepts files in the package's own dist directory", () => {
    assert.equal(isInsideOwnDist("/repo/packages/core/dist/index.js", root), true);
    assert.equal(isInsideOwnDist("/repo/packages/core/dist/chunks/a.cjs", root), true);
  });

  test("rejects the package sources", () => {
    assert.equal(isInsideOwnDist("/repo/packages/core/src/index.ts", root), false);
  });

  test("rejects sources even when another path component is called dist", () => {
    const nested = "/builds/dist/repo/packages/core";
    assert.equal(isInsideOwnDist(`${nested}/src/index.ts`, nested), false);
    assert.equal(isInsideOwnDist(`${nested}/dist/index.js`, nested), true);
    assert.equal(isInsideOwnDist("/repo/packages/core/src/dist/index.ts", root), false);
  });

  test("rejects another package's dist, a sibling with a similar name, and the directory itself", () => {
    assert.equal(isInsideOwnDist("/repo/packages/postgres/dist/index.js", root), false);
    assert.equal(isInsideOwnDist("/repo/packages/core/dist-old/index.js", root), false);
    assert.equal(isInsideOwnDist("/repo/packages/core/dist", root), false);
  });
});
