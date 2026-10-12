// Removes build output and caches (not node_modules).
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const projects = [
  ".",
  "benchmarks",
  "docs/site",
  ...readdirSync(join(root, "packages")).map((name) => join("packages", name)),
];
const targets = ["dist", ".tsbuild", "coverage", ".vitepress/dist", ".vitepress/cache"];

for (const project of projects) {
  for (const target of targets) rmSync(join(root, project, target), { recursive: true, force: true });
}
