import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const coreRoot = fileURLToPath(new URL("../../../", import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.ts$/.test(entry.name) && !/\.(test|test-d|itest)\.ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

const LIBRARIES =
  /from\s+["'](zod|valibot|arktype|yup|@standard-schema\/[^"']+)(\/[^"']*)?["']|import\(\s*["'](zod|valibot|arktype|yup)["']/;

test("no source file of the core package imports a validation library, not even for types", () => {
  const offenders = sources(join(coreRoot, "src")).filter((file) =>
    LIBRARIES.test(readFileSync(file, "utf8")),
  );
  expect(offenders).toEqual([]);
});

test("the core package declares no dependency on a validation library", () => {
  const pkg = JSON.parse(readFileSync(join(coreRoot, "package.json"), "utf8")) as Record<string, unknown>;
  for (const key of ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"]) {
    const deps = (pkg[key] ?? {}) as Record<string, string>;
    expect(
      Object.keys(deps).filter((name) => /^(zod|valibot|arktype|yup|@standard-schema\/)/.test(name)),
    ).toEqual([]);
  }
});
