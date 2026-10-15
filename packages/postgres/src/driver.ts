/**
 * The driver wrapper over `pg`: a `pg.Pool`, cursors from `pg-cursor`, and cancel
 * requests. Everything else (transactions, timeouts, telemetry, errors) is the shared
 * adapter's.
 *
 * @module
 */
import type { createAdapter, PoolEvent, RawResult } from "egon-orm";
import { QueryError } from "egon-orm";
import pg from "pg";
import type Cursor from "pg-cursor";
import type { PoolSource } from "./options.js";
import { PG_TYPES } from "./values.js";

/** The driver interface of the shared adapter (not exported by name from `egon-orm`). */
type Definition = Parameters<typeof createAdapter>[0];
type DriverWrapper = ReturnType<Definition["driver"]>;
type DriverHooks = Parameters<Definition["driver"]>[0];
type DriverConnection = Awaited<ReturnType<DriverWrapper["acquire"]>>;
type DriverCursor = Awaited<ReturnType<DriverConnection["cursor"]>>;

/** The `pg-cursor` class. */
export type CursorClass = typeof Cursor;

/**
 * What the wrapper creates its objects with. Replaced in unit tests, which have no
 * database.
 */
export interface PgRuntime {
  /** Creates the pool the adapter owns. */
  readonly createPool: (config: pg.PoolConfig) => pg.Pool;
  /** Creates the short-lived client that sends a cancel request. */
  readonly createClient: (config: pg.ClientConfig) => pg.Client;
  /** Loads `pg-cursor`, an optional peer dependency, the first time a stream starts. */
  readonly loadCursor: () => Promise<CursorClass>;
}

/** The real runtime. */
export const PG_RUNTIME: PgRuntime = {
  createPool: (config) => new pg.Pool(config),
  createClient: (config) => new pg.Client(config),
  loadCursor: async () => {
    try {
      const module = (await import("pg-cursor")) as { default: CursorClass };
      return module.default;
    } catch (error) {
      throw new QueryError(
        'Streaming rows from Postgres needs the "pg-cursor" package, which is not installed. Add it with: pnpm add pg-cursor',
        error,
      );
    }
  },
};

/** Ignores the error an idle client reports: pg-pool has already removed that client. */
const ignore = (): void => undefined;

/** One checked-out `pg` client. */
class PgConnection implements DriverConnection {
  constructor(
    readonly client: pg.PoolClient,
    private readonly driver: PgDriver,
  ) {}

  async query(
    sql: string,
    params: readonly unknown[],
    statementName: string | undefined,
  ): Promise<RawResult> {
    const config: pg.QueryConfig =
      statementName === undefined
        ? { text: sql, values: params as unknown[], types: PG_TYPES }
        : { text: sql, values: params as unknown[], types: PG_TYPES, name: statementName };
    const outcome: pg.QueryResult | pg.QueryResult[] = await this.client.query(config);
    // A statement list without parameters runs in one round trip and reports one result per
    // statement; the last one is the answer.
    const result = Array.isArray(outcome) ? (outcome[outcome.length - 1] as pg.QueryResult) : outcome;
    return { rows: result.rows, rowCount: result.rowCount ?? 0, insertId: undefined };
  }

  async cursor(sql: string, params: readonly unknown[]): Promise<DriverCursor> {
    const CursorConstructor = await this.driver.cursorClass();
    const cursor = this.client.query(new CursorConstructor(sql, params as unknown[], { types: PG_TYPES }));
    return {
      read: (count) => cursor.read(count) as Promise<Record<string, unknown>[]>,
      close: () => cursor.close(),
    };
  }

  cancel(): Promise<void> {
    return this.driver.cancel(this.client);
  }

  inTransaction(): boolean {
    const status = this.client.getTransactionStatus();
    return status === "T" || status === "E";
  }
}

/** The `pg` driver wrapper. */
export class PgDriver implements DriverWrapper {
  private pool: pg.Pool | undefined = undefined;
  private max = 10;
  private cursorLoading: Promise<CursorClass> | undefined = undefined;
  private readonly onConnect: () => void;
  private readonly onRemove: () => void;

  constructor(
    private readonly source: PoolSource,
    hooks: DriverHooks,
    private readonly runtime: PgRuntime = PG_RUNTIME,
  ) {
    this.onConnect = () => hooks.connected();
    this.onRemove = () => hooks.disconnected();
  }

  init(): void {
    const source = this.source;
    const pool = source.owned ? this.runtime.createPool(source.config) : source.pool;
    // An owned pool must have an error listener: pg-pool emits "error" for an idle
    // connection that fails, and an unhandled "error" would end the process. The failed
    // connection is already removed by then (a "remove", reported as `disconnect`).
    if (source.owned) pool.on("error", ignore);
    pool.on("connect", this.onConnect);
    pool.on("remove", this.onRemove);
    const max: unknown = pool.options?.max;
    this.max = typeof max === "number" && max > 0 ? max : 10;
    this.pool = pool;
  }

  async acquire(): Promise<DriverConnection> {
    const client = await this.started().connect();
    return new PgConnection(client, this);
  }

  async release(connection: DriverConnection, destroy: boolean): Promise<void> {
    (connection as PgConnection).client.release(destroy);
  }

  async destroy(): Promise<void> {
    const pool = this.pool;
    if (pool === undefined) return;
    pool.off("connect", this.onConnect);
    pool.off("remove", this.onRemove);
    if (this.source.owned) {
      await pool.end();
      pool.off("error", ignore);
    }
  }

  stats(): PoolEvent {
    const pool = this.started();
    return { size: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
  }

  saturated(): boolean {
    const pool = this.started();
    return pool.idleCount === 0 && pool.totalCount >= this.max;
  }

  /** `pg-cursor`, loaded once. A failed load is not remembered, so installing it later works. */
  cursorClass(): Promise<CursorClass> {
    if (this.cursorLoading === undefined) {
      const loading = this.runtime.loadCursor();
      this.cursorLoading = loading;
      // Only one load is ever in flight, so a failure always belongs to the current one.
      loading.catch(() => {
        this.cursorLoading = undefined;
      });
    }
    return this.cursorLoading;
  }

  /**
   * Cancels what `client` is running: a separate connection asks the server to cancel the
   * statement of the backend process behind `client` (`pg_cancel_backend`). A backend
   * that is idle by then ignores the request.
   */
  async cancel(client: pg.PoolClient): Promise<void> {
    const pid: unknown = (client as { processID?: unknown }).processID;
    if (typeof pid !== "number") return;
    const canceller = this.runtime.createClient(this.connectionConfig());
    try {
      await canceller.connect();
      await canceller.query("select pg_cancel_backend($1)", [pid]);
    } finally {
      await canceller.end().catch(ignore);
    }
  }

  private connectionConfig(): pg.ClientConfig {
    const source = this.source;
    return source.owned ? source.config : (source.pool.options as pg.ClientConfig);
  }

  private started(): pg.Pool {
    const pool = this.pool;
    if (pool === undefined) throw new Error("The pg driver wrapper was used before init().");
    return pool;
  }
}
