import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { PARALLEL_TOKEN_ENV } from "./parallel.js";

// Step 01 acceptance: "two integration test files run in parallel without interfering".
//
// The two files are parallel-a.pair.ts and parallel-b.pair.ts (Vitest project
// `core:parallel-pair`). Each refuses to pass unless it sees the other one's live database
// connection, so they pass only when they truly overlap in time. That needs two Vitest
// workers, which the surrounding run may not have (`--maxWorkers=1`, a single-CPU
// container), so this test starts its own Vitest run for the pair with exactly two workers
// and asserts on the result. The proof is the pair's; this file only guarantees the
// conditions it needs.

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const require = createRequire(import.meta.url);
const vitestCli = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");

interface JsonReport {
  readonly success: boolean;
  readonly numTotalTestSuites: number;
  readonly numPassedTests: number;
  readonly numTotalTests: number;
  readonly testResults: readonly { readonly name: string; readonly status: string }[];
}

function runPair(reportPath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        vitestCli,
        "run",
        "--project",
        "core:parallel-pair",
        "--maxWorkers=2",
        "--reporter=json",
        `--outputFile=${reportPath}`,
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, [PARALLEL_TOKEN_ENV]: randomBytes(6).toString("hex") },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("two integration test files run in parallel without interfering", { timeout: 90_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ectype-parallel-"));
  let report: JsonReport;
  try {
    const reportPath = join(scratch, "report.json");
    const { code, stdout, stderr } = await runPair(reportPath);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    report = JSON.parse(readFileSync(reportPath, "utf8")) as JsonReport;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  expect(report.success).toBe(true);
  expect(report.testResults.map((file) => [file.name.split("/").at(-1), file.status]).sort()).toEqual([
    ["parallel-a.pair.ts", "passed"],
    ["parallel-b.pair.ts", "passed"],
  ]);
  expect(report.numTotalTests).toBe(2);
  expect(report.numPassedTests).toBe(2);
});
