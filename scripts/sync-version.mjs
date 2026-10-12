// Rewrites `export const VERSION` in each package's src/index.ts to match its package.json.
// Run by `pnpm version-packages` after `changeset version`; the unit test beside each
// index.ts fails if the two ever disagree.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packagesDir = fileURLToPath(new URL("../packages", import.meta.url));
const pattern = /^export const VERSION: string = "[^"]*";$/m;

const packages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

for (const name of packages) {
  const { version } = JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8"));
  const indexPath = join(packagesDir, name, "src", "index.ts");
  const source = readFileSync(indexPath, "utf8");
  if (!pattern.test(source)) {
    console.error(`${indexPath}: no \`export const VERSION: string = "…";\` line to update`);
    process.exitCode = 1;
    continue;
  }
  const updated = source.replace(pattern, `export const VERSION: string = "${version}";`);
  if (updated !== source) {
    writeFileSync(indexPath, updated);
    console.log(`packages/${name}: VERSION = ${version}`);
  }
}
