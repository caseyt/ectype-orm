/**
 * Connection settings for the test databases.
 *
 * Every value can be overridden through the environment; the defaults match
 * `docker-compose.yml` at the repository root, so `pnpm db:up` needs no configuration.
 */

/** The SQL dialects that have a test database. SQLite joins in step 17. */
export type Dialect = "postgres" | "mysql";

/** How to reach one database server. `database` is the maintenance database, not a per-test one. */
export interface ConnectionSettings {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

type Env = Readonly<Record<string, string | undefined>>;

function readString(env: Env, key: string, fallback: string): string {
  const value = env[key];
  return value === undefined || value === "" ? fallback : value;
}

function readPort(env: Env, key: string, fallback: number): number {
  const value = env[key];
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${key} must be a TCP port number, got ${JSON.stringify(value)}`);
  }
  return port;
}

/**
 * Reads the connection settings for `dialect` from `env` (default `process.env`).
 *
 * | Dialect  | Variables                                                                          |
 * |----------|------------------------------------------------------------------------------------|
 * | postgres | `EGON_PG_HOST`, `EGON_PG_PORT`, `EGON_PG_USER`, `EGON_PG_PASSWORD`, `EGON_PG_DATABASE` |
 * | mysql    | `EGON_MYSQL_HOST`, `EGON_MYSQL_PORT`, `EGON_MYSQL_USER`, `EGON_MYSQL_PASSWORD`, `EGON_MYSQL_DATABASE` |
 */
export function connectionSettings(dialect: Dialect, env: Env = process.env): ConnectionSettings {
  switch (dialect) {
    case "postgres":
      return {
        host: readString(env, "EGON_PG_HOST", "127.0.0.1"),
        port: readPort(env, "EGON_PG_PORT", 54_329),
        user: readString(env, "EGON_PG_USER", "egon"),
        password: readString(env, "EGON_PG_PASSWORD", "egon"),
        database: readString(env, "EGON_PG_DATABASE", "egon_dev"),
      };
    case "mysql":
      return {
        host: readString(env, "EGON_MYSQL_HOST", "127.0.0.1"),
        port: readPort(env, "EGON_MYSQL_PORT", 33_069),
        user: readString(env, "EGON_MYSQL_USER", "root"),
        password: readString(env, "EGON_MYSQL_PASSWORD", "egon"),
        database: readString(env, "EGON_MYSQL_DATABASE", "egon_dev"),
      };
  }
}

/** Formats settings as a connection URL (`postgres://…` or `mysql://…`), with credentials escaped. */
export function connectionUrl(dialect: Dialect, settings: ConnectionSettings): string {
  const { host, port, user, password, database } = settings;
  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return `${dialect}://${auth}@${host}:${port}/${encodeURIComponent(database)}`;
}

/** True when the tier 2 databases (MySQL) are expected to be running: `EGON_TEST_TIER2=1`. */
export function tier2Enabled(env: Env = process.env): boolean {
  return env.EGON_TEST_TIER2 === "1" || env.EGON_TEST_TIER2 === "true";
}
