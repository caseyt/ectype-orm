// CommonJS consumer of the built packages. Run `pnpm build` first, then `pnpm smoke`.
//
// The packages are ESM only (decision D14): there is no CommonJS build. A CommonJS project
// still loads them with a plain `require()`, because Node loads ES modules that way from
// 22.12 on (checked: 22.11.0 fails with ERR_REQUIRE_ESM, 22.12.0 works with an
// ExperimentalWarning, 22.23.1 and 24.14.1 work silently). `engines.node` is `>=22.12`
// for that reason. This script proves it on the Node that runs it.
const assert = require("node:assert/strict");
const { VERSION: postgresVersion } = require("@ectype/postgres");
const { VERSION: zodVersion } = require("@ectype/zod");
const { VERSION, QueryError, isEctypeError, ok } = require("ectype");

assert.match(VERSION, /^\d+\.\d+\.\d+/);
assert.equal(postgresVersion, VERSION);
assert.equal(zodVersion, VERSION);

// What was loaded is the one ES module build, not a CommonJS copy of it.
const resolved = require.resolve("ectype");
assert.ok(resolved.endsWith("/dist/index.js"), resolved);

// The same module instance as an `import` gets, so classes and symbols are shared.
import("ectype").then((esm) => {
  assert.equal(esm.QueryError, QueryError);
  const error = new QueryError("x");
  assert.ok(error instanceof esm.EctypeError);
  assert.ok(isEctypeError(error, "query"));
  assert.deepEqual(ok(1), { ok: true, value: 1 });
  console.log(
    `cjs: require("ectype") loaded the ES module ${VERSION} on Node ${process.version} (${resolved})`,
  );
});
