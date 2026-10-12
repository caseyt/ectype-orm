/**
 * The version of the `ectype` package.
 *
 * Placeholder export from step 01 (foundation); the public API arrives in later steps.
 *
 * @example
 * ```ts
 * import { VERSION } from "ectype";
 *
 * console.log(VERSION); // "0.0.0"
 * ```
 */
export const VERSION: string = "0.0.0";

// Step 02: the two parts of the contracts that are public API by themselves. The contract
// types (Row, Loaded, EctoType, Adapter, ...) are exported by the step that implements them.
export type { Err, Ok, Result } from "./contracts/result.js";
export { err, ok } from "./contracts/result.js";
export type { AdapterErrorCode, ConstraintViolationType, ErrorCode } from "./errors.js";
export {
  AdapterError,
  CastError,
  ConstraintError,
  EctypeError,
  InvalidChangesetError,
  isEctypeError,
  MigrationError,
  MultipleResultsError,
  NoResultsError,
  NotLoadedError,
  QueryError,
  SchemaDefinitionError,
  StaleEntryError,
} from "./errors.js";
