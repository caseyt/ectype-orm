// The reference schemas in test/support/blog.ts against the DDL they describe,
// test/support/fixtures/blog.sql: every table and column, and every association resolved.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { Comment, Membership, Org, Post, Profile, Tag, User, UserSettings } from "../../test/support/blog.js";
import type { AnySchema } from "../contracts/schema.js";
import { meta, primaryKeyOf } from "./index.js";

const SCHEMAS: readonly AnySchema[] = [User, Profile, Post, Comment, Tag, Org, Membership];

/** Table name to its column names, in order, read from the fixture's CREATE TABLE statements. */
function tablesInFixture(): Map<string, string[]> {
  const sql = readFileSync(new URL("../../test/support/fixtures/blog.sql", import.meta.url), "utf8");
  const tables = new Map<string, string[]>();
  for (const [, name, body] of sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
    const columns = (body as string)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("PRIMARY KEY"))
      .map((line) => line.split(/\s+/)[0] as string);
    tables.set(name as string, columns);
  }
  return tables;
}

describe("the blog schemas", () => {
  test("cover every table of the fixture except the join table, column for column", () => {
    const tables = tablesInFixture();
    expect([...tables.keys()].sort()).toEqual(
      [...SCHEMAS.map((schema) => meta(schema).source as string), "posts_tags"].sort(),
    );
    for (const schema of SCHEMAS) {
      const m = meta(schema);
      expect(
        m.persisted.map((field) => field.column),
        m.name,
      ).toEqual(tables.get(m.source as string));
    }
  });

  test("every association resolves", () => {
    const kinds = new Set<string>();
    for (const schema of SCHEMAS) {
      for (const assoc of meta(schema).assocs().values()) {
        kinds.add(assoc.through === undefined ? assoc.kind : `${assoc.kind} through`);
        expect(meta(assoc.target()).source).not.toBeNull();
      }
    }
    expect([...kinds].sort()).toEqual(["belongsTo", "hasMany", "hasMany through", "hasOne", "manyToMany"]);
  });

  test("cover a composite key, a uuid key, an enum, a virtual and a redacted field, an array and an embed", () => {
    expect(meta(Membership).primaryKey.map((field) => field.name)).toEqual(["orgId", "userId"]);
    expect(meta(Org).primaryKey[0]?.type.name).toBe("uuid");
    expect(meta(Org).primaryKey[0]?.autogenerate).toBeDefined();
    expect(meta(User).fieldsByName.get("role")?.type.name).toBe("enum");
    expect(meta(User).fieldsByName.get("password")?.virtual).toBe(true);
    expect(meta(User).fieldsByName.get("passwordHash")?.redact).toBe(true);
    expect(meta(Post).fieldsByName.get("tagList")).toMatchObject({ column: "tags" });
    expect(meta(Post).fieldsByName.get("tagList")?.type.name).toBe("array(string)");
    expect(meta(User).embeds[0]?.schema()).toBe(UserSettings);
  });

  test("keys are database-generated except the composite key and the client-generated uuid", () => {
    for (const schema of [User, Profile, Post, Comment, Tag]) {
      expect(meta(schema).primaryKey[0]?.dbGenerated).toBe(true);
    }
    expect(meta(Org).primaryKey[0]?.dbGenerated).toBe(false);
    expect(meta(Membership).primaryKey.map((field) => field.dbGenerated)).toEqual([false, false]);
  });

  test("the user to org many-to-many goes through the Membership schema", () => {
    const orgs = meta(User).assocs().get("orgs");
    expect(orgs?.joinThrough?.source).toBe("memberships");
    expect(orgs?.joinKeys).toEqual([
      { column: "user_id", field: "id" },
      { column: "org_id", field: "id" },
    ]);
    expect(meta(Org).assocs().get("users")?.joinKeys).toEqual([
      { column: "org_id", field: "id" },
      { column: "user_id", field: "id" },
    ]);
  });

  test("rows of the blog schemas carry their getters", () => {
    const m = meta(User);
    const user = m.create(
      [7, "ada@example.com", null, null, "member", null, null, 1, new Date(0), new Date(0)],
      m.rowMeta("loaded", undefined),
    ) as User;
    expect(user.displayName).toBe("ada@example.com");
    expect(primaryKeyOf(user, User)).toBe(7);
  });
});
