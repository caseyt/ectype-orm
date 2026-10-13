// Benchmark runner: one Node process per `*.bench.ts` file (so one file cannot disturb
// another's JIT state), then a single JSON report at `benchmarks/results/<git-sha>.json`.
//
//   pnpm bench              # every file under micro/
//   pnpm bench example      # only files whose path contains "example"
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type BenchmarkResult, RESULT_PATH_ENV, resolveBuiltEgon } from "./harness.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SUITES = ["micro"];
/** Node flags are pinned so that runs are comparable. */
const NODE_FLAGS = ["--expose-gc", "--import", "tsx"];
/** Without workspace `paths`, so that benchmark files import the built dist/ output. */
const RUN_TSCONFIG = join(ROOT, "tsconfig.run.json");

function findBenchFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...findBenchFiles(path));
    else if (entry.name.endsWith(".bench.ts")) files.push(path);
  }
  return files.sort();
}

function git(...args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

// Refuse to measure anything but the built packages. Each benchmark process checks again.
let egonEntry: string;
try {
  egonEntry = resolveBuiltEgon();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
console.log(`egon-orm resolves to ${relative(join(ROOT, ".."), egonEntry)}`);

const filters = process.argv.slice(2);
const files = SUITES.flatMap((suite) => findBenchFiles(join(ROOT, suite)))
  .map((file) => relative(ROOT, file))
  .filter((file) => filters.length === 0 || filters.some((filter) => file.includes(filter)));

if (files.length === 0) {
  console.error(`No benchmark files matched ${JSON.stringify(filters)}.`);
  process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), "egon-bench-"));
const benchmarks: BenchmarkResult[] = [];
let failed = false;

try {
  for (const [index, file] of files.entries()) {
    console.log(`\n# ${file}`);
    const resultPath = join(scratch, `${index}.json`);
    const child = spawnSync(process.execPath, [...NODE_FLAGS, file], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, [RESULT_PATH_ENV]: resultPath, TSX_TSCONFIG_PATH: RUN_TSCONFIG },
    });
    if (child.status !== 0) {
      console.error(`${file} exited with status ${child.status ?? child.signal}`);
      failed = true;
      continue;
    }
    const results = JSON.parse(readFileSync(resultPath, "utf8")) as Omit<BenchmarkResult, "file">[];
    for (const result of results) benchmarks.push({ file, ...result });
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failed) process.exit(1);

const sha = git("rev-parse", "HEAD") || "unknown";
const report = {
  gitSha: sha,
  gitDirty: git("status", "--porcelain") !== "",
  date: new Date().toISOString(),
  node: process.version,
  nodeFlags: NODE_FLAGS,
  machine: {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    memoryBytes: totalmem(),
  },
  /** The file `egon-orm` was loaded from, relative to the repository root. Always under dist/. */
  egonEntry: relative(join(ROOT, ".."), egonEntry),
  unit: "ns/iter",
  benchmarks,
};

const resultsDir = join(ROOT, "results");
mkdirSync(resultsDir, { recursive: true });
const reportPath = join(resultsDir, `${sha}.json`);
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nWrote ${benchmarks.length} result(s) to benchmarks/${relative(ROOT, reportPath)}`);
