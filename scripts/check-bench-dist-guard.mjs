// Proves that the benchmark runner refuses to run when the packages are not built.
// Benchmarks must measure dist/ (what users install), never the TypeScript sources.
//
// Must run on a tree without packages/core/dist (a fresh checkout, or after `pnpm clean`);
// CI runs it before `pnpm build`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

if (existsSync(new URL("../packages/core/dist", import.meta.url))) {
  console.error("packages/core/dist exists; run `pnpm clean` first. This check needs an unbuilt tree.");
  process.exit(2);
}

const { status, stdout, stderr } = spawnSync("pnpm", ["--filter", "@egon-orm/benchmarks", "run", "bench"], {
  cwd: root,
  encoding: "utf8",
  shell: process.platform === "win32",
});
const output = `${stdout}${stderr}`;

if (status === 0) {
  console.error(`The benchmarks ran without a build. They are not measuring dist/:\n${output}`);
  process.exit(1);
}
if (!output.includes("dist/") || !output.includes("pnpm build") || output.includes("Wrote ")) {
  console.error(`The benchmarks failed without a build, but not with the expected message:\n${output}`);
  process.exit(1);
}
console.log("ok: the benchmark runner refuses to run without the built dist/ output");
