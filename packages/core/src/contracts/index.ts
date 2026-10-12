/**
 * The frozen contracts: the interfaces that the rest of `ectype` is written against.
 *
 * This barrel is internal. Other modules of the package import from it (or from the
 * individual files); what is public is decided by `src/index.ts`. See `README.md` in this
 * directory for which step implements and which steps consume each file.
 *
 * @module
 */
export type * from "./adapter.js";
export type * from "./changeset.js";
export type * from "./query.js";
export type { Err, Ok, Result } from "./result.js";
export { err, ok } from "./result.js";
export type * from "./schema.js";
export { META, ROW } from "./schema.js";
export type * from "./standard-schema.js";
export type * from "./type.js";
export { IDENTITY } from "./type.js";
