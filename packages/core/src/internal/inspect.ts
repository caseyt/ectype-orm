/**
 * Redaction-aware formatting for inspect output, logs and error messages.
 *
 * Nothing here depends on `node:util`, so it behaves the same in every runtime.
 *
 * @module
 */

/**
 * What stands in for the value of a redacted field.
 *
 * Ecto equivalent: the `**redacted**` shown by `inspect/2` for `redact: true` fields.
 *
 * @example
 * ```ts
 * redactFields({ email: "a@b.c", passwordHash: "x" }, new Set(["passwordHash"]));
 * // { email: "a@b.c", passwordHash: REDACTED }
 * ```
 */
export const REDACTED = "**redacted**";

/**
 * Copies the own enumerable string-keyed properties of `values`, replacing the value of
 * every key in `redacted` with {@link REDACTED}. Key order is kept.
 *
 * @example
 * ```ts
 * redactFields({ email: "a@b.c", passwordHash: "$2b$…" }, new Set(["passwordHash"]));
 * // { email: "a@b.c", passwordHash: "**redacted**" }
 * ```
 */
export function redactFields(values: object, redacted: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(values)) {
    out[key] = redacted.has(key) ? REDACTED : (values as Record<string, unknown>)[key];
  }
  return out;
}

/**
 * Copies the own enumerable string-keyed properties of `values`, leaving out every key in
 * `redacted`. This is what `toJSON` uses: a redacted value must not be serialised at all.
 *
 * @example
 * ```ts
 * omitRedacted({ email: "a@b.c", passwordHash: "$2b$…" }, new Set(["passwordHash"]));
 * // { email: "a@b.c" }
 * ```
 */
export function omitRedacted(values: object, redacted: ReadonlySet<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(values)) {
    if (!redacted.has(key)) out[key] = (values as Record<string, unknown>)[key];
  }
  return out;
}

/** Strings longer than this are cut in {@link formatValue}. */
const MAX_STRING = 100;
/** Arrays and objects show at most this many entries in {@link formatValue}. */
const MAX_ENTRIES = 20;
/** Nesting deeper than this is abbreviated in {@link formatValue}. */
const MAX_DEPTH = 3;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function formatPrimitive(value: string | number | bigint | boolean | symbol | undefined): string {
  switch (typeof value) {
    case "string":
      return value.length > MAX_STRING
        ? `${JSON.stringify(value.slice(0, MAX_STRING))}… (${value.length} characters)`
        : JSON.stringify(value);
    case "number":
      return Object.is(value, -0) ? "-0" : String(value);
    case "bigint":
      return `${value}n`;
    case "symbol":
      return value.toString();
    default:
      return String(value);
  }
}

function format(value: unknown, depth: number, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "function") return value.name === "" ? "[Function]" : `[Function: ${value.name}]`;
  if (typeof value !== "object") {
    return formatPrimitive(value as string | number | bigint | boolean | symbol | undefined);
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value instanceof Uint8Array) return `<${value.constructor.name} ${value.byteLength} bytes>`;
  if (seen.has(value)) return "[Circular]";
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return "[Array]";
    seen.add(value);
    const parts: string[] = [];
    for (let i = 0; i < value.length && i < MAX_ENTRIES; i++) parts.push(format(value[i], depth + 1, seen));
    if (value.length > MAX_ENTRIES) parts.push(`… ${value.length - MAX_ENTRIES} more`);
    seen.delete(value);
    return `[${parts.join(", ")}]`;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  const name =
    proto === null || proto === Object.prototype
      ? ""
      : `${(proto as { constructor?: { name?: string } }).constructor?.name ?? "Object"} `;
  if (depth >= MAX_DEPTH) return name === "" ? "[Object]" : `[${name.trimEnd()}]`;
  seen.add(value);
  const keys = Object.keys(value);
  const parts: string[] = [];
  for (let i = 0; i < keys.length && i < MAX_ENTRIES; i++) {
    const key = keys[i] as string;
    const label = IDENTIFIER.test(key) ? key : JSON.stringify(key);
    parts.push(`${label}: ${format((value as Record<string, unknown>)[key], depth + 1, seen)}`);
  }
  if (keys.length > MAX_ENTRIES) parts.push(`… ${keys.length - MAX_ENTRIES} more`);
  seen.delete(value);
  return parts.length === 0 ? `${name}{}` : `${name}{ ${parts.join(", ")} }`;
}

/**
 * Renders any value as one line of text for an error message or a log line: strings are
 * quoted and cut at 100 characters, dates are ISO strings, binary data is summarised,
 * arrays and objects show at most 20 entries and 3 levels, and cycles are marked.
 * It never throws (a value whose getters throw renders as `[unprintable]`) and never
 * calls a `toString`, `toJSON` or inspect method that the value defines.
 *
 * It does not redact. Redact first ({@link redactFields}), or use {@link formatStruct}.
 *
 * @example
 * ```ts
 * formatValue("ada"); // '"ada"'
 * formatValue(10n); // "10n"
 * formatValue(new Date(0)); // "1970-01-01T00:00:00.000Z"
 * formatValue({ id: 1, tags: ["a", "b"] }); // '{ id: 1, tags: ["a", "b"] }'
 * ```
 */
export function formatValue(value: unknown): string {
  try {
    return format(value, 0, new Set());
  } catch {
    // A getter or a Proxy trap of the value threw. An error message must still be produced.
    return "[unprintable]";
  }
}

/**
 * Renders a named record of fields, such as a row or a changeset, with the values of the
 * redacted keys replaced by `**redacted**`.
 *
 * Ecto equivalent: `inspect/2` on a schema struct, which honours `redact: true`.
 *
 * @example
 * ```ts
 * formatStruct("User", { id: 1, email: "a@b.c", passwordHash: "$2b$…" }, new Set(["passwordHash"]));
 * // 'User { id: 1, email: "a@b.c", passwordHash: **redacted** }'
 * ```
 */
export function formatStruct(name: string, values: object, redacted: ReadonlySet<string>): string {
  const parts: string[] = [];
  const seen = new Set<object>([values]);
  for (const key of Object.keys(values)) {
    const label = IDENTIFIER.test(key) ? key : JSON.stringify(key);
    let text: string;
    if (redacted.has(key)) {
      // The value of a redacted field is not even read.
      text = REDACTED;
    } else {
      try {
        text = format((values as Record<string, unknown>)[key], 1, seen);
      } catch {
        text = "[unprintable]";
      }
    }
    parts.push(`${label}: ${text}`);
  }
  return parts.length === 0 ? `${name} {}` : `${name} { ${parts.join(", ")} }`;
}
