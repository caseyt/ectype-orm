import { describe, expect, test } from "vitest";
import { createTestDatabase, currentRunId, type TestDatabase, withDatabase } from "./db.js";
import { connectionSettings } from "./env.js";
import { truncateAll } from "./truncate.js";

const BLOG_TABLES = ["comments", "memberships", "orgs", "posts", "posts_tags", "profiles", "tags", "users"];

async function databaseExists(db: TestDatabase, name: string): Promise<boolean> {
  const rows = await db.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  return rows.length === 1;
}

describe("withDatabase (postgres)", () => {
  test("creates a uniquely named database and drops it afterwards", async () => {
    let inner = "";
    const result = await withDatabase("postgres", { label: "lifecycle" }, async (db) => {
      inner = db.name;
      expect(db.dialect).toBe("postgres");
      expect(db.settings.database).toBe(db.name);
      expect(db.url).toContain(`/${db.name}`);
      expect(await db.query("SELECT current_database() AS name")).toEqual([{ name: db.name }]);
      return "returned";
    });
    expect(result).toBe("returned");
    expect(inner).toMatch(/^egon_lifecycle_/);

    await withDatabase("postgres", async (other) => {
      expect(other.name).not.toBe(inner);
      expect(await databaseExists(other, inner)).toBe(false);
      expect(await databaseExists(other, other.name)).toBe(true);
    });
  });

  test("drops the database when the callback throws", async () => {
    let inner = "";
    await expect(
      withDatabase("postgres", async (db) => {
        inner = db.name;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await withDatabase("postgres", async (other) => {
      expect(await databaseExists(other, inner)).toBe(false);
    });
  });

  test("drops the database when a fixture fails to load, and drop is idempotent", async () => {
    await expect(
      createTestDatabase("postgres", { label: "dropcheck", fixtures: ["blog", "blog"] }),
    ).rejects.toThrow(/already exists/);

    const handle = await createTestDatabase("postgres", { label: "dropcheck" });
    const { name } = handle.db;
    await handle.drop();
    await handle.drop();
    await withDatabase("postgres", async (other) => {
      expect(await databaseExists(other, name)).toBe(false);
      const leftovers = await other.query(
        "SELECT datname FROM pg_database WHERE datname LIKE $1 AND datname <> $2",
        [`egon\\_dropcheck\\_${currentRunId()}\\_%`, other.name],
      );
      expect(leftovers).toEqual([]);
    });
  });

  test("reports an unreachable server with the command that starts it", async () => {
    const settings = { ...connectionSettings("postgres"), port: 1 };
    await expect(withDatabase("postgres", { settings }, async () => undefined)).rejects.toThrow(
      /Cannot reach the postgres test server at .*:1\. Start it with `pnpm db:up`/,
    );
  });
});

describe("cleanup when a test times out (postgres)", () => {
  const TIMEOUT_MS = 500;
  // What the timed-out test got up to, for the test after it.
  const observed: { database?: string; settledAfterMs?: number } = {};

  // `fails`: this test is expected to time out. Vitest abandons the callback, so the
  // `finally` in withDatabase cannot run in time; the onTestFinished hook must drop it.
  // `fails` accepts any failure, so the next test checks that it really was this one.
  test.fails("a test times out while it holds a database", { timeout: TIMEOUT_MS }, () => {
    const startedAt = Date.now();
    return withDatabase("postgres", { label: "leak_timeout" }, async (db) => {
      observed.database = db.name;
      try {
        await db.query("SELECT pg_sleep(30)");
      } finally {
        observed.settledAfterMs = Date.now() - startedAt;
      }
    });
  });

  test("the database of the timed-out test was created, outlived the timeout, and is gone", async () => {
    // The previous test got as far as holding a database (not, say, a refused connection)...
    expect(observed.database).toMatch(new RegExp(`^egon_leak_timeout_${currentRunId()}_`));
    // ...and its query did not end by itself before the timeout: it was cut off by the drop.
    // (`undefined`: the driver never settled the abandoned query, which is fine too.)
    // The margin absorbs scheduling jitter: this clock starts a moment after Vitest's timer.
    expect(observed.settledAfterMs ?? TIMEOUT_MS).toBeGreaterThanOrEqual(TIMEOUT_MS * 0.8);
    expect(observed.settledAfterMs ?? 0).toBeLessThan(30_000);

    await withDatabase("postgres", async (other) => {
      expect(await databaseExists(other, observed.database ?? "")).toBe(false);
      const leaked = await other.query("SELECT datname FROM pg_database WHERE datname LIKE $1", [
        `egon\\_leak\\_timeout\\_${currentRunId()}\\_%`,
      ]);
      expect(leaked).toEqual([]);
    });
  });
});

describe("blog fixture (postgres)", () => {
  test("creates the reference schema", () =>
    withDatabase("postgres", { fixtures: ["blog"] }, async (db) => {
      const tables = await db.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      );
      expect(tables.map((row) => row.tablename)).toEqual(BLOG_TABLES);

      const [user] = await db.query<{ id: string; role: string; lock_version: number; created_at: Date }>(
        "INSERT INTO users (email) VALUES ($1) RETURNING id, role, lock_version, created_at",
        ["ada@example.com"],
      );
      expect(user).toMatchObject({ id: "1", role: "member", lock_version: 1 });
      expect(user?.created_at).toBeInstanceOf(Date);
      await expect(db.query("INSERT INTO users (email) VALUES ($1)", ["ada@example.com"])).rejects.toThrow(
        /users_email_key/,
      );

      const [post] = await db.query<{ id: string; published: boolean; views: number; tags: string[] }>(
        "INSERT INTO posts (author_id, title, tags) VALUES ($1, $2, $3) RETURNING id, published, views, tags",
        [user?.id, "Hello", ["a", "b"]],
      );
      expect(post).toEqual({ id: "1", published: false, views: 0, tags: ["a", "b"] });

      await db.query("INSERT INTO comments (post_id, author_id, body) VALUES ($1, $2, $3)", [
        post?.id,
        user?.id,
        "hi",
      ]);
      await db.query("DELETE FROM posts WHERE id = $1", [post?.id]);
      expect(await db.query("SELECT * FROM comments")).toEqual([]);

      const [org] = await db.query<{ id: string }>("INSERT INTO orgs (name) VALUES ($1) RETURNING id", [
        "Acme",
      ]);
      expect(org?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      await db.query("INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')", [
        org?.id,
        user?.id,
      ]);
      await expect(
        db.query("INSERT INTO memberships (org_id, user_id) VALUES ($1, $2)", [org?.id, user?.id]),
      ).rejects.toThrow(/memberships_pkey/);
    }));
});

describe("truncateAll (postgres)", () => {
  test("empties every table and restarts identities", () =>
    withDatabase("postgres", { fixtures: ["blog"] }, async (db) => {
      const seed = async (): Promise<string | undefined> => {
        const [user] = await db.query<{ id: string }>(
          "INSERT INTO users (email) VALUES ('a@example.com') RETURNING id",
        );
        await db.query("INSERT INTO posts (author_id, title) VALUES ($1, 'p')", [user?.id]);
        await db.query("INSERT INTO tags (name) VALUES ('t')");
        return user?.id;
      };
      expect(await seed()).toBe("1");

      expect(await truncateAll(db)).toEqual(BLOG_TABLES);
      for (const table of BLOG_TABLES) {
        expect(await db.query(`SELECT 1 FROM ${table}`), table).toEqual([]);
      }
      expect(await seed()).toBe("1");
    }));

  test("leaves excepted tables alone and tolerates an empty database", () =>
    withDatabase("postgres", async (db) => {
      expect(await truncateAll(db)).toEqual([]);
      await db.exec('CREATE TABLE keep (id int); CREATE TABLE "Odd ""name" (id int);');
      await db.exec('INSERT INTO keep VALUES (1); INSERT INTO "Odd ""name" VALUES (1);');
      expect(await truncateAll(db, { except: ["keep"] })).toEqual(['Odd "name']);
      expect(await db.query("SELECT id FROM keep")).toEqual([{ id: 1 }]);
      expect(await db.query('SELECT id FROM "Odd ""name"')).toEqual([]);
    }));
});
