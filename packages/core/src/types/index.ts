/**
 * The type system: every built-in type, and the two functions that make new ones.
 *
 * This barrel is internal. The built-in types reach developers through the field builder
 * `t` (`t.integer()` wraps `integerType()`); `src/index.ts` makes public only
 * `defineType`, `parameterized` and the contract types.
 *
 * @module
 */
export { resolveCodec } from "./codec.js";
export type { EnumMapping } from "./composite.js";
export { arrayType, elementTypeOf, enumType, jsonType, mapElements } from "./composite.js";
export type { TypeDefinition } from "./define.js";
export { defineType, parameterized } from "./define.js";
export type { BigintOptions, DecimalOptions } from "./scalars.js";
export {
  bigintType,
  binaryType,
  booleanType,
  decimalType,
  floatType,
  INVALID,
  integerType,
  stringType,
  uuidType,
} from "./scalars.js";
export type { DateOptions, TimestampOptions, TimestampPrecision } from "./temporal.js";
export { dateType, localTimestampType, timestampType, timeType } from "./temporal.js";
