import { fileURLToPath } from "node:url";
import { defineConfig, type TestProjectConfiguration } from "vitest/config";

/** Every workspace package gets the same three Vitest projects: unit, types, integration. */
const PACKAGES = ["core", "postgres", "zod", "cli", "sqlite", "mysql"] as const;

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/** Tests run against package sources, so no build is needed before `pnpm test:*`. */
const alias = {
  ectype: fromRoot("./packages/core/src/index.ts"),
  "@ectype/postgres": fromRoot("./packages/postgres/src/index.ts"),
  "@ectype/sqlite": fromRoot("./packages/sqlite/src/index.ts"),
  "@ectype/mysql": fromRoot("./packages/mysql/src/index.ts"),
  "@ectype/zod": fromRoot("./packages/zod/src/index.ts"),
  "@ectype/cli": fromRoot("./packages/cli/src/index.ts"),
  // Shared test helpers (not a published package): packages/core/test/support.
  "@ectype/test-support": fromRoot("./packages/core/test/support/index.ts"),
};

function projectsFor(pkg: (typeof PACKAGES)[number]): TestProjectConfiguration[] {
  const root = fromRoot(`./packages/${pkg}`);
  return [
    {
      resolve: { alias },
      test: {
        name: `${pkg}:unit`,
        root,
        environment: "node",
        include: ["src/**/*.test.ts", "test/**/*.test.ts"],
      },
    },
    {
      resolve: { alias },
      test: {
        name: `${pkg}:types`,
        root,
        environment: "node",
        include: [],
        typecheck: {
          enabled: true,
          only: true,
          checker: "tsc",
          tsconfig: "./tsconfig.json",
          include: ["src/**/*.test-d.ts", "test/**/*.test-d.ts"],
        },
      },
    },
    {
      resolve: { alias },
      test: {
        name: `${pkg}:integration`,
        root,
        environment: "node",
        include: ["src/**/*.itest.ts", "test/**/*.itest.ts"],
        // Files run in parallel (each owns a database, see test/support/db.ts);
        // tests inside one file run serially.
        fileParallelism: true,
        sequence: { concurrent: false },
        testTimeout: 30_000,
        hookTimeout: 60_000,
      },
    },
  ];
}

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: PACKAGES.flatMap(projectsFor),
    coverage: {
      provider: "v8",
      // Resolved against each project root (packages/<name>), not the repository root.
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.test-d.ts", "**/*.itest.ts", "**/*.d.ts"],
      reporter: ["text", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      thresholds: {
        // README §6: CI enforces 95% lines and branches per package.
        "packages/core/src/**": { lines: 95, branches: 95 },
        "packages/postgres/src/**": { lines: 95, branches: 95 },
      },
    },
  },
});
