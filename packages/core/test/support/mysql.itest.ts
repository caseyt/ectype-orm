import { describe, expect, test } from "vitest";
import { withDatabase } from "./db.js";
import { tier2Enabled } from "./env.js";
import { truncateAll } from "./truncate.js";

// Tier 2: runs only with ECTYPE_TEST_TIER2=1 and `pnpm db:up:tier2`.
describe.skipIf(!tier2Enabled())("withDatabase and truncateAll (mysql)", () => {
  test("creates a uniquely named database and drops it afterwards", async () => {
    let inner = "";
    await withDatabase("mysql", { label: "lifecycle" }, async (db) => {
      inner = db.name;
      expect(await db.query("SELECT DATABASE() AS name")).toEqual([{ name: db.name }]);
    });
    await withDatabase("mysql", async (other) => {
      const rows = await other.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = ?", [
        inner,
      ]);
      expect(rows).toEqual([]);
    });
  });

  test("truncates every table despite foreign keys and resets auto-increment", () =>
    withDatabase("mysql", async (db) => {
      expect(await truncateAll(db)).toEqual([]);
      await db.exec(`
        CREATE TABLE parents (id bigint PRIMARY KEY AUTO_INCREMENT, name text);
        CREATE TABLE children (id bigint PRIMARY KEY AUTO_INCREMENT, parent_id bigint NOT NULL,
          FOREIGN KEY (parent_id) REFERENCES parents (id));
        CREATE TABLE keep (id int);
        INSERT INTO parents (name) VALUES ('p');
        INSERT INTO children (parent_id) VALUES (1);
        INSERT INTO keep VALUES (1);
      `);
      expect(await truncateAll(db, { except: ["keep"] })).toEqual(["children", "parents"]);
      expect(await db.query("SELECT * FROM parents")).toEqual([]);
      expect(await db.query("SELECT * FROM children")).toEqual([]);
      expect(await db.query("SELECT id FROM keep")).toEqual([{ id: 1 }]);
      await db.query("INSERT INTO parents (name) VALUES (?)", ["again"]);
      expect(await db.query("SELECT id FROM parents")).toEqual([{ id: 1 }]);
    }));
});
