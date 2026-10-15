/**
 * The driver wrapper: the small interface a dialect package implements over its database
 * driver (`pg`, `mysql2`, `better-sqlite3`). The shared adapter (`adapter.ts`) does
 * everything else: transactions, savepoints, cancellation, telemetry, error
 * normalisation, closing.
 *
 * Internal: these names are not exported from the package's entry point. A dialect
 * package reaches them through the parameter type of `createAdapter`.
 *
 * @module
 */
import type { PoolEvent, RawResult } from "../contracts/adapter.js";

/**
 * What the shared adapter gives the wrapper when it creates it: the functions that report
 * pool events. The adapter turns each call into an event with the pool's state
 * ({@link DriverWrapper.stats}) as its payload, and does nothing when no one listens.
 */
export interface DriverHooks {
  /** A new database connection was opened. */
  readonly connected: () => void;
  /** A database connection was closed and left the pool. */
  readonly disconnected: () => void;
}

/**
 * A pool of database connections, wrapped. Created lazily, on the adapter's first use.
 */
export interface DriverWrapper {
  /** Creates the pool, or attaches to the one the caller supplied. Called once, before anything else. */
  init(): void;
  /** Checks a connection out of the pool, waiting for one when every connection is in use. */
  acquire(): Promise<DriverConnection>;
  /**
   * Returns a connection to the pool, or closes it instead when `destroy` is true (it
   * failed fatally, a statement on it was interrupted mid-flight, or it was left inside a
   * transaction). Called exactly once per acquired connection.
   */
  release(connection: DriverConnection, destroy: boolean): Promise<void>;
  /**
   * Closes the pool once its connections are back, when the adapter created it. A pool
   * the caller supplied is left open (its owner closes it); only the wrapper's listeners
   * are removed from it.
   */
  destroy(): Promise<void>;
  /** The pool's current state. */
  stats(): PoolEvent;
  /** Whether a call to {@link acquire} made now would have to wait for a connection. */
  saturated(): boolean;
}

/**
 * One checked-out connection, wrapped.
 */
export interface DriverConnection {
  /**
   * Runs one statement. `statementName` makes it a named server-side prepared statement
   * where the driver supports one; otherwise it is ignored.
   */
  query(sql: string, params: readonly unknown[], statementName: string | undefined): Promise<RawResult>;
  /** Opens a server-side cursor over the statement's rows. */
  cursor(sql: string, params: readonly unknown[]): Promise<DriverCursor>;
  /**
   * Asks the server to cancel the statement this connection is running. Resolves once the
   * request has been delivered (not when the statement has stopped); a statement that has
   * already finished is not affected.
   */
  cancel(): Promise<void>;
  /** Whether the connection is inside a transaction, by the server's own account. */
  inTransaction(): boolean;
}

/**
 * A server-side cursor, opened by {@link DriverConnection.cursor}.
 */
export interface DriverCursor {
  /** The next `count` rows; an empty array once the rows are exhausted. */
  read(count: number): Promise<readonly Record<string, unknown>[]>;
  /** Closes the cursor. Safe to call after the rows are exhausted, and more than once. */
  close(): Promise<void>;
}
