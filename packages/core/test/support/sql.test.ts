import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { expectSql, normalizeSql } from "./sql.js";

describe("normalizeSql", () => {
  test("collapses whitespace runs and trims", () => {
    expect(normalizeSql("  select *\n\tfrom   users\r\n where id = $1  ")).toBe(
      "select * from users where id = $1",
    );
  });

  test("drops padding inside parentheses and before commas", () => {
    expect(normalizeSql("select count( * ) , max( id )\nfrom t where id in (\n  $1 ,\n  $2\n)")).toBe(
      "select count(*), max(id) from t where id in ($1, $2)",
    );
  });

  test("leaves quoted text untouched", () => {
    expect(normalizeSql(`select  'a   b' ,  "my   col" ,  \`x  y\`  from t`)).toBe(
      `select 'a   b', "my   col", \`x  y\` from t`,
    );
  });

  test("treats a doubled quote as an escaped quote", () => {
    expect(normalizeSql(`select 'it''s   here'   as  x`)).toBe(`select 'it''s   here' as x`);
    expect(normalizeSql(`select "a""  b"   from  t`)).toBe(`select "a""  b" from t`);
  });

  test("copies an unterminated quote to the end", () => {
    expect(normalizeSql("select 'oops   ")).toBe("select 'oops   ");
  });

  test("is idempotent", () => {
    fc.assert(
      fc.property(fc.string(), (sql) => {
        const once = normalizeSql(sql);
        expect(normalizeSql(once)).toBe(once);
      }),
    );
  });

  test("never changes anything but whitespace", () => {
    const strip = (s: string): string => s.replace(/\s+/g, "");
    fc.assert(
      fc.property(fc.string(), (sql) => {
        expect(strip(normalizeSql(sql))).toBe(strip(sql));
      }),
    );
  });
});

describe("expectSql", () => {
  test("snapshots normalised sql with its params", () => {
    expectSql({ sql: 'select *\n  from "users"\n  where "age" >= $1', params: [18] }).toMatchInlineSnapshot(`
      {
        "params": [
          18,
        ],
        "sql": "select * from "users" where "age" >= $1",
      }
    `);
  });

  test("accepts a bare string and an object without params", () => {
    expectSql("select  1").toEqual({ sql: "select 1", params: [] });
    expectSql({ sql: "select  1" }).toEqual({ sql: "select 1", params: [] });
  });
});
