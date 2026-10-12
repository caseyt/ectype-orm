// CommonJS consumer of the built packages. Run `pnpm build` first, then `pnpm smoke`.
const assert = require("node:assert/strict");
const { VERSION: postgresVersion } = require("@ectype/postgres");
const { VERSION: zodVersion } = require("@ectype/zod");
const { VERSION } = require("ectype");

assert.match(VERSION, /^\d+\.\d+\.\d+/);
assert.equal(postgresVersion, VERSION);
assert.equal(zodVersion, VERSION);

console.log(`cjs: ectype ${VERSION} (resolved to ${require.resolve("ectype")})`);
