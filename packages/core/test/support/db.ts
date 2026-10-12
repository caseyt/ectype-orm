import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { type Connection, createConnection } from "mysql2/promise";
import pg from "pg";
import { type ConnectionSettings, connectionSettings, connectionUrl, type Dialect } from "./env.js";

/** One row as the driver returns it. */
export type Row = Record<string, unknown>;

/** A throwaway database owned by one test file. */
export interface TestDatabase {
  readonly dialect: Dialect;
  /** The unique database name, e.g. `ectype_t_users_48213_9f2c61d0a4b7`. */
  readonly name: string;
  /** Settings for connecting to this database; hand these to the adapter under test. */
  readonly settings: ConnectionSettings;
  /** The same settings as a connection URL. */
  readonly url: string;
  /**
   * Runs one statement on the helper's own connection and returns its rows.
   * Placeholders are the driver's: `$1` for Postgres, `?` for MySQL.
   */
  query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  /** Runs a script of one or more `;`-separated statements without parameters. */
  exec(sql: string): Promise<void>;
}

/** A `TestDatabase` plus the function that closes its connection and drops it. */
export interface TestDatabaseHandle {
  readonly db: TestDatabase;
  /** Idempotent. */
  drop(): Promise<void>;
}

/** Options for {@link createTestDatabase} and {@link withDatabase}. */
export interface TestDatabaseOptions {
  /** Included in the database name to make leftovers easy to attribute. Default `"t"`. */
  readonly label?: string;
  /** Fixtures (file names without `.sql` under `fixtures/`) to load after creation. */
  readonly fixtures?: readonly string[];
  /** Connection settings for the server. Default: {@link connectionSettings} for the dialect. */
  readonly settings?: ConnectionSettings;
}

/** Longest identifier both Postgres (63 bytes) and MySQL (64 characters) accept. */
const MAX_NAME_LENGTH = 63;

/**
 * Builds a database name that is unique across processes and calls:
 * `ectype_<label>_<pid>_<12 random hex digits>`, lowercase `[a-z0-9_]` only, so it never
 * needs quoting or escaping.
 */
export function uniqueDatabaseName(label = "t"): string {
  const suffix = `_${process.pid}_${randomBytes(6).toString("hex")}`;
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const prefix = `ectype_${slug === "" ? "t" : slug}`;
  return prefix.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
}

/** Reads `fixtures/<name>.sql`. */
export function readFixture(name: string): Promise<string> {
  if (!/^[\w-]+$/.test(name)) throw new Error(`invalid fixture name ${JSON.stringify(name)}`);
  return readFile(new URL(`./fixtures/${name}.sql`, import.meta.url), "utf8");
}

/** Loads `fixtures/<name>.sql` into `db`. */
export async function loadFixture(db: TestDatabase, name: string): Promise<void> {
  await db.exec(await readFixture(name));
}

function unreachable(dialect: Dialect, settings: ConnectionSettings, cause: unknown): Error {
  const hint = dialect === "postgres" ? "pnpm db:up" : "pnpm db:up:tier2";
  return new Error(
    `Cannot reach the ${dialect} test server at ${settings.host}:${settings.port}. Start it with \`${hint}\`.`,
    { cause },
  );
}

async function createPostgres(name: string, server: ConnectionSettings): Promise<TestDatabaseHandle> {
  const admin = new pg.Client(server);
  try {
    await admin.connect();
  } catch (cause) {
    throw unreachable("postgres", server, cause);
  }
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const settings = { ...server, database: name };
  const dropDatabase = async (): Promise<void> => {
    const client = new pg.Client(server);
    await client.connect();
    try {
      // FORCE disconnects anything a failed test left behind.
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await client.end();
    }
  };

  const client = new pg.Client(settings);
  try {
    await client.connect();
  } catch (error) {
    await dropDatabase();
    throw error;
  }

  let dropped = false;
  return {
    db: {
      dialect: "postgres",
      name,
      settings,
      url: connectionUrl("postgres", settings),
      async query<T extends Row>(sql: string, params: readonly unknown[] = []) {
        const result = await client.query<T>(sql, [...params]);
        return result.rows;
      },
      async exec(sql) {
        // Without parameters pg uses the simple query protocol, which accepts multiple statements.
        await client.query(sql);
      },
    },
    async drop() {
      if (dropped) return;
      dropped = true;
      try {
        await client.end();
      } finally {
        await dropDatabase();
      }
    },
  };
}

async function createMysql(name: string, server: ConnectionSettings): Promise<TestDatabaseHandle> {
  let connection: Connection;
  try {
    connection = await createConnection({ ...server, multipleStatements: true });
  } catch (cause) {
    throw unreachable("mysql", server, cause);
  }
  try {
    await connection.query(`CREATE DATABASE ${name}`);
    await connection.changeUser({ database: name });
  } catch (error) {
    await connection.end();
    throw error;
  }

  const settings = { ...server, database: name };
  let dropped = false;
  return {
    db: {
      dialect: "mysql",
      name,
      settings,
      url: connectionUrl("mysql", settings),
      async query<T extends Row>(sql: string, params: readonly unknown[] = []) {
        const [rows] = await connection.query(sql, [...params]);
        return (Array.isArray(rows) ? rows : []) as T[];
      },
      async exec(sql) {
        await connection.query(sql);
      },
    },
    async drop() {
      if (dropped) return;
      dropped = true;
      try {
        await connection.query(`DROP DATABASE IF EXISTS ${name}`);
      } finally {
        await connection.end();
      }
    },
  };
}

/**
 * Creates a uniquely named database on the `dialect` test server and connects to it.
 * The caller must call `drop()`; prefer {@link withDatabase}, or pair this with
 * `beforeAll`/`afterAll` when one database should serve a whole file:
 *
 * @example
 * ```ts
 * let handle: TestDatabaseHandle;
 * beforeAll(async () => {
 *   handle = await createTestDatabase("postgres", { label: "users", fixtures: ["blog"] });
 * });
 * afterAll(() => handle.drop());
 * afterEach(() => truncateAll(handle.db));
 * ```
 */
export async function createTestDatabase(
  dialect: Dialect,
  options: TestDatabaseOptions = {},
): Promise<TestDatabaseHandle> {
  const server = options.settings ?? connectionSettings(dialect);
  const name = uniqueDatabaseName(options.label);
  const handle =
    dialect === "postgres" ? await createPostgres(name, server) : await createMysql(name, server);
  try {
    for (const fixture of options.fixtures ?? []) await loadFixture(handle.db, fixture);
  } catch (error) {
    await handle.drop();
    throw error;
  }
  return handle;
}

/**
 * Runs `fn` against a freshly created, uniquely named database and drops it afterwards,
 * whether `fn` resolves or rejects. Because nothing is shared between calls, integration
 * test files can run in parallel.
 *
 * @example
 * ```ts
 * test("emails are unique", () =>
 *   withDatabase("postgres", { fixtures: ["blog"] }, async (db) => {
 *     await db.query("insert into users (email) values ($1)", ["a@example.com"]);
 *     await expect(db.query("insert into users (email) values ($1)", ["a@example.com"])).rejects.toThrow();
 *   }));
 * ```
 */
export function withDatabase<T>(dialect: Dialect, fn: (db: TestDatabase) => Promise<T>): Promise<T>;
export function withDatabase<T>(
  dialect: Dialect,
  options: TestDatabaseOptions,
  fn: (db: TestDatabase) => Promise<T>,
): Promise<T>;
export async function withDatabase<T>(
  dialect: Dialect,
  optionsOrFn: TestDatabaseOptions | ((db: TestDatabase) => Promise<T>),
  maybeFn?: (db: TestDatabase) => Promise<T>,
): Promise<T> {
  const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
  if (fn === undefined) throw new TypeError("withDatabase requires a callback");
  const handle = await createTestDatabase(dialect, options);
  try {
    return await fn(handle.db);
  } finally {
    await handle.drop();
  }
}
