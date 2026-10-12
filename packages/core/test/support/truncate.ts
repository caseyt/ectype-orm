import type { TestDatabase } from "./db.js";

/** Options for {@link truncateAll}. */
export interface TruncateOptions {
  /** Table names to leave untouched (for example a migrations bookkeeping table). */
  readonly except?: readonly string[];
}

const quotePostgres = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const quoteMysql = (name: string): string => `\`${name.replaceAll("`", "``")}\``;

/**
 * Empties every table in the test database and resets its sequences / auto-increment
 * counters. Returns the names of the tables it truncated.
 *
 * This is the isolation mechanism for integration tests until the transactional sandbox
 * arrives in step 16: call it in `afterEach` (or `beforeEach`).
 */
export async function truncateAll(db: TestDatabase, options: TruncateOptions = {}): Promise<string[]> {
  const except = new Set(options.except ?? []);

  if (db.dialect === "postgres") {
    const rows = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename",
    );
    const tables = rows.map((row) => row.tablename).filter((name) => !except.has(name));
    if (tables.length > 0) {
      // One statement, so foreign keys between the listed tables are not an issue.
      await db.exec(`TRUNCATE TABLE ${tables.map(quotePostgres).join(", ")} RESTART IDENTITY CASCADE`);
    }
    return tables;
  }

  const rows = await db.query<{ name: string }>(
    "SELECT table_name AS name FROM information_schema.tables " +
      "WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  const tables = rows.map((row) => row.name).filter((name) => !except.has(name));
  if (tables.length > 0) {
    const statements = tables.map((name) => `TRUNCATE TABLE ${quoteMysql(name)};`).join(" ");
    await db.exec(`SET FOREIGN_KEY_CHECKS = 0; ${statements} SET FOREIGN_KEY_CHECKS = 1;`);
  }
  return tables;
}
