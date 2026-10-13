// Database plumbing for the spike scripts. Everything runs against the Postgres started
// by `pnpm db:up` (docker-compose.yml at the repository root). There is no fallback: if
// the server is not reachable the script fails.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CompiledQuery,
  createQueryId,
  type DatabaseConnection,
  type Driver,
  PostgresDriver,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";
import pg from "pg";
import { bindParams, type Plan } from "./bridge.js";

// Same variables and defaults as packages/core/test/support/env.ts.
const env = process.env;
export const SERVER = {
  host: env.EGON_PG_HOST || "127.0.0.1",
  port: Number(env.EGON_PG_PORT || 54_329),
  user: env.EGON_PG_USER || "egon",
  password: env.EGON_PG_PASSWORD || "egon",
  database: env.EGON_PG_DATABASE || "egon_dev",
};

const BLOG_FIXTURE = new URL("../../../../packages/core/test/support/fixtures/blog.sql", import.meta.url);

export interface SpikeDatabase {
  readonly name: string;
  /** Settings for a `pg.Pool` on the throwaway database. */
  readonly config: pg.PoolConfig;
  /** PostgreSQL's own version string, printed by every script as proof of what it ran against. */
  readonly serverVersion: string;
  drop(): Promise<void>;
}

/**
 * Creates a throwaway database loaded with the blog fixture and seeds it.
 *
 * The name follows the test-support convention (`egon_<label>_<run>_<time>_<random>`),
 * so a database leaked by a crashed script is removed by the next integration run's sweep.
 */
export async function createSpikeDatabase(seed: {
  users: number;
  postsPerUser: number;
}): Promise<SpikeDatabase> {
  const seconds = Math.floor(Date.now() / 1000).toString(36);
  const name = `egon_spike_p${process.pid}_${seconds}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client(SERVER);
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const config: pg.PoolConfig = { ...SERVER, database: name };

  const client = new pg.Client(config);
  await client.connect();
  let serverVersion: string;
  try {
    await client.query(readFileSync(BLOG_FIXTURE, "utf8"));
    await client.query(
      `INSERT INTO users (email, name, age, created_at)
       SELECT 'user' || i || '@example.com', 'User ' || i, 15 + (i % 50), now() - make_interval(mins => i)
       FROM generate_series(1, $1::int) AS i`,
      [seed.users],
    );
    await client.query(
      `INSERT INTO posts (author_id, title, body, published, views, tags)
       SELECT u.id, 'Post ' || n || ' of ' || u.id, repeat('lorem ipsum ', 8), (n % 2 = 0), n * 3,
              ARRAY['t' || (n % 3), 'all']
       FROM users u CROSS JOIN generate_series(1, $1::int) AS n`,
      [seed.postsPerUser],
    );
    // Comments, tags and post tags, for the statements of 02-param-slots.ts.
    await client.query(
      `INSERT INTO comments (post_id, author_id, body)
       SELECT p.id, p.author_id, 'comment ' || n FROM posts p CROSS JOIN generate_series(1, 2) AS n`,
    );
    await client.query(`INSERT INTO tags (name) SELECT 'tag' || n FROM generate_series(1, 5) AS n`);
    await client.query(
      `INSERT INTO posts_tags (post_id, tag_id)
       SELECT p.id, t.id FROM posts p JOIN tags t ON (p.id + t.id) % 3 = 0`,
    );
    const version = await client.query<{ version: string }>("SELECT version()");
    serverVersion = version.rows[0]?.version ?? "unknown";
  } finally {
    await client.end();
  }

  return {
    name,
    config,
    serverVersion,
    async drop() {
      // Let the backends of the pools that were just closed exit by themselves. Dropping
      // WITH (FORCE) while a client is still saying goodbye makes the server terminate it,
      // which surfaces in this process as an unhandled 'error' event on that client.
      for (let attempt = 0; attempt < 100; attempt++) {
        const open = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1", [
          name,
        ]);
        if (open.rows[0]?.n === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/**
 * The execution half of the bridge: a Kysely `PostgresDriver` used directly, with no
 * `Kysely` instance, no query builder and no executor/plugin layer.
 */
export class Bridge {
  /** Typed as Kysely's dialect-independent `Driver`: nothing below is Postgres-specific. */
  readonly driver: Driver;
  readonly #compiler = new PostgresQueryCompiler();
  readonly #compileQuery = this.#compiler.compileQuery.bind(this.#compiler);

  private constructor(readonly pool: pg.Pool) {
    this.driver = new PostgresDriver({ pool });
  }

  static async open(config: pg.PoolConfig): Promise<Bridge> {
    const bridge = new Bridge(new pg.Pool(config));
    await bridge.driver.init();
    return bridge;
  }

  acquire(): Promise<DatabaseConnection> {
    return this.driver.acquireConnection();
  }

  release(connection: DatabaseConnection): Promise<void> {
    return this.driver.releaseConnection(connection);
  }

  /**
   * Runs a cached plan on a connection. Per call: the parameter array, one CompiledQuery
   * object literal and one (lazy) query id. `plan.node` is the tree from compile time.
   */
  run<R>(
    connection: DatabaseConnection,
    plan: Plan,
    params: readonly unknown[],
    named?: Readonly<Record<string, unknown>>,
  ): Promise<QueryResult<R>> {
    return connection.executeQuery<R>({
      sql: plan.sql,
      parameters: bindParams(plan.slots, params, named),
      query: plan.node,
      queryId: createQueryId(),
    });
  }

  /** Checks a connection out of the pool, runs the plan, and returns the connection. */
  async execute<R>(
    plan: Plan,
    params: readonly unknown[],
    named?: Readonly<Record<string, unknown>>,
  ): Promise<QueryResult<R>> {
    const connection = await this.driver.acquireConnection();
    try {
      return await this.run<R>(connection, plan, params, named);
    } finally {
      await this.driver.releaseConnection(connection);
    }
  }

  begin(connection: DatabaseConnection): Promise<void> {
    return this.driver.beginTransaction(connection, {});
  }

  commit(connection: DatabaseConnection): Promise<void> {
    return this.driver.commitTransaction(connection);
  }

  rollback(connection: DatabaseConnection): Promise<void> {
    return this.driver.rollbackTransaction(connection);
  }

  // The savepoint methods are optional on Kysely's Driver interface (a dialect may lack them).
  async savepoint(connection: DatabaseConnection, name: string): Promise<void> {
    if (this.driver.savepoint === undefined) throw new Error("driver has no savepoint support");
    await this.driver.savepoint(connection, name, this.#compileQuery);
  }

  async rollbackTo(connection: DatabaseConnection, name: string): Promise<void> {
    if (this.driver.rollbackToSavepoint === undefined) throw new Error("driver has no savepoint support");
    await this.driver.rollbackToSavepoint(connection, name, this.#compileQuery);
  }

  async releaseSavepoint(connection: DatabaseConnection, name: string): Promise<void> {
    if (this.driver.releaseSavepoint === undefined) throw new Error("driver has no savepoint support");
    await this.driver.releaseSavepoint(connection, name, this.#compileQuery);
  }

  /** For statements the spike does not lower (assertions about database state). */
  raw<R>(
    connection: DatabaseConnection,
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    return connection.executeQuery<R>(CompiledQuery.raw(sql, [...params]));
  }

  close(): Promise<void> {
    return this.driver.destroy();
  }
}

/** Runs one spike script: fresh database, banner, cleanup, non-zero exit on any failure. */
export async function main(
  title: string,
  seed: { users: number; postsPerUser: number },
  body: (db: SpikeDatabase) => Promise<void>,
): Promise<void> {
  const db = await createSpikeDatabase(seed);
  console.log(`# ${title}`);
  console.log(`database: ${db.name} on ${SERVER.host}:${SERVER.port}`);
  console.log(`server:   ${db.serverVersion}`);
  console.log(`node:     ${process.version}\n`);
  try {
    await body(db);
  } finally {
    await db.drop();
  }
}

/** Prints a check and fails the script when it does not hold. */
export function check(label: string, actual: unknown, expected: unknown): void {
  assert.deepStrictEqual(actual, expected, label);
  console.log(`  ok  ${label}`);
}
