// Every statement of the SQL snapshot matrices is executed against Postgres, to prove that
// the emitted SQL is valid and that its parameters bind (results are not asserted here;
// the snapshot tests pin the text). Each statement runs in a transaction that is rolled
// back, so writes do not affect the next one.
import { createTestDatabase, type TestDatabaseHandle } from "@egon-orm/test-support";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bindParams } from "./bind.js";
import { createCompiler } from "./compiler.js";
import { postgresDialect } from "./dialect.js";
import { ALL_CASES } from "./sql-cases.js";
import { EXTRA_DDL } from "./sql-fixtures.js";

const SEED = `
INSERT INTO users (id, email, name, age, role, settings) VALUES
  (1, 'ann@example.com', 'Ann', 34, 'admin', '{"theme": "dark", "tags": ["a", "b"]}'),
  (2, 'bo@example.com', NULL, 15, 'member', NULL),
  (3, 'cy@example.com', 'Cy', NULL, 'member', '{"theme": "light"}');
INSERT INTO profiles (user_id, bio) VALUES (1, 'hello');
INSERT INTO posts (id, author_id, title, published, views, tags, published_at) VALUES
  (1, 1, 'First', true, 120, '{ts,orm}', now()),
  (2, 1, 'Second', false, 3, '{sql}', NULL),
  (3, 2, 'Third', true, 7, NULL, NULL);
INSERT INTO comments (post_id, author_id, body) VALUES (1, 2, 'nice'), (2, NULL, 'anon');
INSERT INTO tags (id, name) VALUES (1, 'ts'), (2, 'sql');
INSERT INTO posts_tags (post_id, tag_id) VALUES (1, 1), (2, 2);
INSERT INTO orgs (name) VALUES ('Acme');
INSERT INTO memberships (org_id, user_id) SELECT id, 1 FROM orgs;
INSERT INTO events (name, payload) VALUES ('signup', '{"plan": "free"}');
SELECT setval('users_id_seq', 100), setval('posts_id_seq', 100), setval('tags_id_seq', 100);
`;

let handle: TestDatabaseHandle;

beforeAll(async () => {
  handle = await createTestDatabase("postgres", { label: "compiler", fixtures: ["blog"] });
  await handle.db.exec(EXTRA_DDL);
  await handle.db.exec(SEED);
});

afterAll(async () => {
  await handle?.drop();
});

const compiler = createCompiler(postgresDialect);

for (const [area, cases] of ALL_CASES) {
  describe(`${area} statements run on Postgres`, () => {
    for (const sqlCase of cases) {
      test(sqlCase.name, async () => {
        const plan = sqlCase.compile(compiler);
        const params = bindParams(plan.slots, sqlCase.params, sqlCase.named);
        const db = handle.db;
        await db.query("begin");
        try {
          const rows = await db.query(plan.sql, params);
          expect(Array.isArray(rows)).toBe(true);
        } finally {
          await db.query("rollback");
        }
      });
    }
  });
}

test("the plan cache shared by every statement above saw no collision", () => {
  expect(compiler.stats().collisions).toBe(0);
  expect(compiler.stats().misses).toBeGreaterThan(100);
});
