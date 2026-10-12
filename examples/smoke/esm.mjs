// ESM consumer of the built packages. Run `pnpm build` first, then `pnpm smoke`.
import assert from "node:assert/strict";
import { VERSION as postgresVersion } from "@ectype/postgres";
import { VERSION as zodVersion } from "@ectype/zod";
import { VERSION } from "ectype";

assert.match(VERSION, /^\d+\.\d+\.\d+/);
assert.equal(postgresVersion, VERSION);
assert.equal(zodVersion, VERSION);

console.log(`esm: ectype ${VERSION} (resolved to ${import.meta.resolve("ectype")})`);
