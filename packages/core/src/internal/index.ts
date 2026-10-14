/**
 * Small utilities shared by the rest of the package. Internal: nothing here is part of
 * the public API, and `src/index.ts` does not re-export it.
 *
 * @module
 */

// Not a utility: the built-in types (step 03), re-exported here only so that
// `dist/internal.js` carries them and benchmarks/micro/types.bench.ts can measure built
// code. Nothing inside the package imports the types through this barrel.
export * as types from "../types/index.js";
export { deepEqual } from "./deep-equal.js";
export { HASH_SEED, hashInt, hashString } from "./hash.js";
export { formatStruct, formatValue, omitRedacted, REDACTED, redactFields } from "./inspect.js";
export { LruCache } from "./lru.js";
export { camelToSnake, snakeToCamel } from "./naming.js";
export { isPlainObject } from "./plain-object.js";
