/**
 * The version of the `egon-orm` package.
 *
 * Placeholder export from step 01 (foundation); the public API arrives in later steps.
 *
 * @example
 * ```ts
 * import { VERSION } from "egon-orm";
 *
 * console.log(VERSION); // "0.0.0"
 * ```
 */
export const VERSION: string = "0.0.0";

// Step 02: the two parts of the contracts that are public API by themselves. The contract
// types (Row, Loaded, FieldType, Adapter, ...) are exported by the step that implements them.
export type { Failure, Result, Success } from "./contracts/result.js";
export { failure, success } from "./contracts/result.js";
// Step 03: the type system. The built-in types are reached through the field builder `t`
// (step 04); what is public here is how to write your own.
export type {
  AnyFieldType,
  AppTypeOf,
  CastResult,
  Codec,
  DbType,
  DbTypeKind,
  DbTypeOf,
  FieldType,
} from "./contracts/type.js";
export type { ConstraintViolationType, DatabaseErrorCode, ErrorCode } from "./errors.js";
export {
  CastError,
  ConstraintError,
  DatabaseError,
  EgonError,
  InvalidChangesetError,
  isEgonError,
  MultipleResultsError,
  NoResultsError,
  NotLoadedError,
  QueryError,
  SchemaDefinitionError,
  StaleEntryError,
} from "./errors.js";
export type { TypeDefinition } from "./types/define.js";
export { defineType, parameterized } from "./types/define.js";
