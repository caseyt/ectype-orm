import { defineConfig } from "tsup";

// Build config is identical across packages on purpose; keep them in sync. The one
// difference here is the second entry: `dist/internal.js` is NOT part of the package's
// `exports` (nothing can import it by name). It exists so that benchmarks can measure the
// built internal utilities (benchmarks/micro/internal.bench.ts) instead of the sources.
export default defineConfig({
  entry: { index: "src/index.ts", internal: "src/internal/index.ts" },
  format: ["esm", "cjs"],
  target: "node22",
  platform: "node",
  tsconfig: "tsconfig.build.json",
  // tsup 8 injects the deprecated `baseUrl` option into its declaration build, which
  // TypeScript 6 reports as TS5101 unless deprecations are silenced. Build-only; the
  // type-check configs do not carry this.
  dts: { compilerOptions: { ignoreDeprecations: "6.0" } },
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
});
