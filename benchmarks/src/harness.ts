import { writeFileSync } from "node:fs";
import { run } from "mitata";

export { bench, do_not_optimize as doNotOptimize, group, summary } from "mitata";

/** Environment variable through which the runner tells a benchmark file where to write its results. */
export const RESULT_PATH_ENV = "ECTYPE_BENCH_RESULT_PATH";

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
