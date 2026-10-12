import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when `entry` is a file inside `<packageRoot>/dist/`.
 *
 * Only the package's own `dist` directory counts: a `dist` component elsewhere in the
 * path (for example a checkout under `/builds/dist/…`) does not.
 */
export function isInsideOwnDist(entry: string, packageRoot: string): boolean {
  const fromDist = relative(join(packageRoot, "dist"), entry);
  return (
    fromDist !== "" && !fromDist.startsWith("..") && !fromDist.startsWith(sep) && !/^[A-Za-z]:/.test(fromDist)
  );
}

/**
 * Resolves `ectype` the way the current process imports it and returns the file path,
 * throwing unless that file exists inside the package's own `dist/` directory.
 *
 * Benchmarks must measure the built packages, which is what users run. If this throws,
 * run `pnpm build` (the root `pnpm bench` does) and make sure the process was started
 * with `benchmarks/tsconfig.run.json`, which has no source `paths`.
 */
export function resolveBuiltEctype(): string {
  let entry: string;
  let packageRoot: string;
  try {
    entry = fileURLToPath(import.meta.resolve("ectype"));
    packageRoot = dirname(realpathSync(createRequire(import.meta.url).resolve("ectype/package.json")));
  } catch (cause) {
    throw new Error('Cannot resolve "ectype" to its built dist/ output. Run `pnpm build` first.', { cause });
  }
  if (!existsSync(entry)) {
    throw new Error(`"ectype" resolves to ${entry}, which does not exist. Run \`pnpm build\` first.`);
  }
  entry = realpathSync(entry);
  if (!isInsideOwnDist(entry, packageRoot)) {
    throw new Error(
      `Benchmarks must run against the built dist/ output in ${join(packageRoot, "dist")}, but "ectype" ` +
        `resolved to ${entry}. Start benchmark processes with benchmarks/tsconfig.run.json (see src/run.ts).`,
    );
  }
  return entry;
}
