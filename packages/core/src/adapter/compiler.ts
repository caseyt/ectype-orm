/**
 * Where the adapter gets its statement compiler from. The compiler and its plan cache
 * belong to `../compiler/`; the adapter owns one compiler per instance, so that the plan
 * cache lives in the adapter and `planCacheSize` is an adapter option.
 *
 * This module is the one seam between the two: `createAdapter` calls
 * {@link createStatementCompiler} once, and the six `compile*` methods of the adapter
 * delegate to what it returns.
 *
 * @module
 */
import type { Adapter, Capabilities, Dialect } from "../contracts/adapter.js";
import { QueryError } from "../errors.js";

/** The part of the {@link Adapter} contract that compiles statements. */
export type StatementCompiler = Pick<
  Adapter,
  "compile" | "compileExplain" | "compileFragment" | "compileInsert" | "compileUpdate" | "compileDelete"
>;

/** What a compiler is created from: one per adapter instance. */
export interface StatementCompilerOptions {
  readonly dialect: Dialect;
  readonly capabilities: Capabilities;
  /** Quotes an identifier for the dialect, doubling the quote character. */
  readonly quoteIdentifier: (name: string) => string;
  /** The size of the shape-keyed plan cache. */
  readonly planCacheSize: number;
}

function unavailable(method: string, dialect: Dialect): never {
  throw new QueryError(
    `adapter.${method}() cannot compile for ${dialect}: this build of egon-orm has no SQL compiler yet. Run SQL text with adapter.execute() instead.`,
  );
}

/**
 * Creates the statement compiler of one adapter.
 *
 * The SQL compiler is not part of this build yet. Until it is, every `compile*` method
 * throws `QueryError`; the adapter's execution methods (`execute`, `stream`,
 * connections, transactions) do not depend on it.
 */
export function createStatementCompiler(options: StatementCompilerOptions): StatementCompiler {
  const { dialect } = options;
  return {
    compile: () => unavailable("compile", dialect),
    compileExplain: () => unavailable("compileExplain", dialect),
    compileFragment: () => unavailable("compileFragment", dialect),
    compileInsert: () => unavailable("compileInsert", dialect),
    compileUpdate: () => unavailable("compileUpdate", dialect),
    compileDelete: () => unavailable("compileDelete", dialect),
  };
}
