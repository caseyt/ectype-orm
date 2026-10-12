import { type Assertion, expect } from "vitest";

/** Anything that carries compiled SQL: a bare string, or an object with `sql` and optional `params`. */
export type CompiledSql = string | { readonly sql: string; readonly params?: readonly unknown[] };

/** What `expectSql` snapshots. */
export interface NormalizedSql {
  readonly sql: string;
  readonly params: readonly unknown[];
}

const QUOTES = new Set(["'", '"', "`"]);
const WHITESPACE = /\s/;

/**
 * Collapses every run of whitespace outside quotes to one space, trims the ends, and drops
 * the padding just inside parentheses and before commas. Text inside single quotes, double
 * quotes and backticks is left exactly as written (a doubled quote is an escaped quote).
 */
export function normalizeSql(sql: string): string {
  let out = "";
  let pendingSpace = false;
  let i = 0;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    if (WHITESPACE.test(ch)) {
      pendingSpace = true;
      i += 1;
      continue;
    }
    if (pendingSpace) {
      const tight = out === "" || out.endsWith("(") || ch === ")" || ch === ",";
      if (!tight) out += " ";
      pendingSpace = false;
    }
    if (!QUOTES.has(ch)) {
      out += ch;
      i += 1;
      continue;
    }
    // Copy the quoted run verbatim, including an unterminated one.
    let end = i + 1;
    while (end < sql.length) {
      if (sql.charAt(end) !== ch) end += 1;
      else if (sql.charAt(end + 1) === ch) end += 2;
      else break;
    }
    out += sql.slice(i, end + 1);
    i = end + 1;
  }
  return out;
}

/**
 * Starts an assertion on compiled SQL with insignificant whitespace normalised, so that
 * snapshots do not churn when formatting changes.
 *
 * @example
 * ```ts
 * expectSql(compile(query)).toMatchInlineSnapshot(`
 *   {
 *     "params": [18],
 *     "sql": "select * from "users" where "age" >= $1",
 *   }
 * `);
 * ```
 */
export function expectSql(compiled: CompiledSql): Assertion<NormalizedSql> {
  const sql = typeof compiled === "string" ? compiled : compiled.sql;
  const params = typeof compiled === "string" ? [] : (compiled.params ?? []);
  return expect<NormalizedSql>({ sql: normalizeSql(sql), params });
}
