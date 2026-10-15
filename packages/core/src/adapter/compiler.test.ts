import { expect, test } from "vitest";
import type { Capabilities } from "../contracts/adapter.js";
import type { FragmentNode, QueryAst } from "../contracts/query.js";
import type { SchemaMeta } from "../contracts/schema.js";
import { QueryError } from "../errors.js";
import { createStatementCompiler } from "./compiler.js";

const compiler = createStatementCompiler({
  dialect: "postgres",
  capabilities: {} as Capabilities,
  quoteIdentifier: (name) => `"${name}"`,
  planCacheSize: 10,
});

const ast = {} as QueryAst;
const meta = {} as SchemaMeta;

test.each([
  ["compile", () => compiler.compile(ast, "all", undefined)],
  ["compileExplain", () => compiler.compileExplain(ast, "all", undefined, {})],
  ["compileFragment", () => compiler.compileFragment({} as FragmentNode)],
  [
    "compileInsert",
    () =>
      compiler.compileInsert(
        meta,
        [],
        { source: { kind: "values", rows: 1 }, returning: [], onConflict: undefined },
        undefined,
      ),
  ],
  ["compileUpdate", () => compiler.compileUpdate(meta, [], [], [], undefined)],
  ["compileDelete", () => compiler.compileDelete(meta, [], [], undefined)],
])("%s throws QueryError while this build has no SQL compiler", (method, call) => {
  expect(call).toThrow(QueryError);
  expect(call).toThrow(`adapter.${method}() cannot compile for postgres`);
});
