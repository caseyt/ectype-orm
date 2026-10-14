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

// Step 05: changesets. The contract types a developer names when reading a changeset
// (its errors, its constraints, its action) are public with it.
export type {
  AppliedData,
  AssocName,
  CastOptions,
  Changes,
  ChangesetData,
  ChangesetModel,
  ChangesetSource,
  ChangeValidatorError,
  ChangeValidatorResult,
  CheckConstraintOptions,
  ConfirmationOptions,
  ConstraintOptions,
  ErrorFormatter,
  ErrorTree,
  FieldName,
  FieldOfType,
  FieldValues,
  LengthOptions,
  MessageOption,
  MessageOptions,
  NumberOptions,
  PrepareFunction,
  RequiredOptions,
  RowSchema,
  SchemalessTarget,
  UniqueAsyncOptions,
  ValidationEntry,
} from "./changeset/index.js";
export { applyAction, Changeset, cast, change, traverseErrors } from "./changeset/index.js";
export type {
  Action,
  ChangesetError,
  ChangesetLike,
  Constraint,
  ConstraintType,
} from "./contracts/changeset.js";
// Step 02: the two parts of the contracts that are public API by themselves. The contract
// types (Row, Loaded, FieldType, Adapter, ...) are exported by the step that implements them.
export type { Failure, Result, Success } from "./contracts/result.js";
export { failure, success } from "./contracts/result.js";
// Step 04: schemas. The contract types a developer names (`Row`, `InsertShape`, `Loaded`,
// the metadata that `meta()` returns) are public together with the functions.
export type {
  AnySchema,
  Assoc,
  AssocKeys,
  AssocKind,
  AssocMeta,
  AssocOrderMeta,
  EmbedMeta,
  FieldBuilder,
  FieldMeta,
  FieldNames,
  FieldsShape,
  InsertShape,
  JoinKeyMeta,
  JoinThroughMeta,
  Loaded,
  OnReplace,
  PreloadSpec,
  PrimaryKeyOf,
  Row,
  RowMeta,
  RowState,
  SchemaClass,
  SchemaMeta,
  Writable,
} from "./contracts/schema.js";
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
// Step 07: query expressions. The classes are public as types only: expressions come from
// columns, operators and these functions.
export type { Col, Expr, NoParams, Operand, OrderExpr, SomeParams } from "./query/expr.js";
export type { Aggregate, Case, FragmentFunction, WindowSpec } from "./query/functions.js";
export {
  and,
  arrayAgg,
  avg,
  caseWhen,
  coalesce,
  count,
  countDistinct,
  exists,
  fragment,
  jsonAgg,
  lit,
  max,
  min,
  not,
  now,
  or,
  param,
  stringAgg,
  sum,
  val,
} from "./query/functions.js";
export type {
  AssocOrderBy,
  AssocWhere,
  BelongsToOptions,
  EmbeddedSchemaOptions,
  EmbedOnReplace,
  EmbedOptions,
  FieldTypes,
  HasManyOptions,
  HasOneOptions,
  JoinKeys,
  KeyFields,
  ManyToManySchemaOptions,
  ManyToManyTableOptions,
  Naming,
  SchemaOptions,
  ThroughOptions,
  TimestampFields,
  TimestampsOptions,
} from "./schema/index.js";
export {
  belongsTo,
  EmbeddedSchema,
  fieldNames,
  hasMany,
  hasOne,
  isRow,
  isSchema,
  manyToMany,
  meta,
  primaryKeyOf,
  Schema,
  stateOf,
  t,
  timestamps,
} from "./schema/index.js";
export type { TypeDefinition } from "./types/define.js";
export { defineType, parameterized } from "./types/define.js";
