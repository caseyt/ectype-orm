// The checked sources of the Postgres code blocks in guide/adapters.md. Each `#region` is
// included in the page by name; everything outside a region is the scaffolding that makes
// the regions compile.

import { postgres } from "@egon-orm/postgres";
import { ConstraintError, DatabaseError, isEgonError } from "egon-orm";
import pg from "pg";

export function connect() {
  // #region connect
  const adapter = postgres({
    connectionString: process.env.DATABASE_URL,
    pool: { max: 10, idleTimeoutMs: 30_000, connectionTimeoutMs: 5_000 },
  });
  // #endregion connect
  return adapter;
}

export function settings() {
  // #region settings
  const adapter = postgres({
    host: "db.internal",
    port: 5432,
    user: "app",
    password: async () => fetchToken(), // a function, for credentials that rotate
    database: "main",
    ssl: { rejectUnauthorized: true },
    statementTimeoutMs: 10_000,
    applicationName: "billing-api",
  });
  // #endregion settings
  return adapter;
}

declare function fetchToken(): Promise<string>;

export async function ownPool() {
  // #region own-pool
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
  const adapter = postgres({ pool });

  // ...

  await adapter.close(); // waits for the adapter's connections to come back
  await pool.end(); // the pool is yours to end
  // #endregion own-pool
}

export async function health() {
  const adapter = connect();
  // #region health
  await adapter.ping(); // throws DatabaseError (code "connection") when unreachable
  adapter.poolStats(); // { size: 3, idle: 2, waiting: 0 }
  // #endregion health
}

declare function insertUser(email: string): Promise<void>;
declare function retry(): Promise<void>;

export async function errors(email: string) {
  // #region errors
  try {
    await insertUser(email);
  } catch (error) {
    if (error instanceof ConstraintError && error.constraint === "users_email_key") {
      // error.type === "unique", error.table === "users", error.sql is the statement
    } else if (isEgonError(error, "serializationFailure") || isEgonError(error, "deadlock")) {
      await retry(); // (error as DatabaseError).retryable === true
    } else if (error instanceof DatabaseError && error.code === "connection") {
      // the database is unreachable, or the connection was lost
    } else {
      throw error;
    }
  }
  // #endregion errors
}
