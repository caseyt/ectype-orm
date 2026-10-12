import { existsSync, writeFileSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "mitata";

export { bench, do_not_optimize as doNotOptimize, group, summary } from "mitata";

/** Environment variable through which the runner tells a benchmark file where to write its results. */
export const RESULT_PATH_ENV = "ECTYPE_BENCH_RESULT_PATH";

/**
 * Resolves `ectype` the way the current process imports it and returns the file path,
 * throwing unless that file exists inside a `dist/` directory.
 *
 * Benchmarks must measure the built packages, which is what users run. If this throws,
 * run `pnpm build` (the root `pnpm bench` does) and make sure the process was started
 * with `benchmarks/tsconfig.run.json`, which has no source `paths`.
 */
export function resolveBuiltEctype(): string {
  let path: string;
  try {
    path = fileURLToPath(import.meta.resolve("ectype"));
  } catch (cause) {
    throw new Error('Cannot resolve "ectype" to its built dist/ output. Run `pnpm build` first.', { cause });
  }
  if (!path.split(sep).includes("dist")) {
    throw new Error(
      `Benchmarks must run against the built dist/ output, but "ectype" resolved to ${path}. ` +
        "Start benchmark processes with benchmarks/tsconfig.run.json (see src/run.ts).",
    );
  }
  if (!existsSync(path)) {
    throw new Error(`"ectype" resolves to ${path}, which does not exist. Run \`pnpm build\` first.`);
  }
  return path;
}

/** Timing statistics for one benchmark, in nanoseconds per iteration. */
export interface BenchmarkStats {
  readonly samples: number;
  readonly min: number;
  readonly max: number;
  readonly avg: number;
  readonly p50: number;
  readonly p75: number;
  readonly p99: number;
}

/** One benchmark as recorded in a results file. */
export interface BenchmarkResult {
  /** Benchmark file, relative to `benchmarks/`. */
  readonly file: string;
  readonly name: string;
  readonly stats: BenchmarkStats;
}

/**
 * Runs every benchmark registered in the current file, prints the mitata table, and hands
 * the statistics to the runner (`src/run.ts`) when it asked for them.
 *
 * Call it once, at the end of each `*.bench.ts` file.
 */
export async function runBenchmarks(): Promise<void> {
  resolveBuiltEctype();
  const { benchmarks } = await run();
  const resultPath = process.env[RESULT_PATH_ENV];
  if (resultPath === undefined) return;

  const results: Omit<BenchmarkResult, "file">[] = [];
  for (const trial of benchmarks) {
    for (const { name, stats, error } of trial.runs) {
      if (error !== undefined) throw new Error(`benchmark "${name}" threw`, { cause: error });
      if (stats === undefined) continue;
      results.push({
        name,
        stats: {
          samples: stats.samples.length,
          min: stats.min,
          max: stats.max,
          avg: stats.avg,
          p50: stats.p50,
          p75: stats.p75,
          p99: stats.p99,
        },
      });
    }
  }
  writeFileSync(resultPath, JSON.stringify(results));
}
