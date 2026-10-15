import { EventEmitter } from "node:events";
import { QueryError } from "egon-orm";
import pg from "pg";
import Cursor from "pg-cursor";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type CursorClass, PG_RUNTIME, PgDriver, type PgRuntime } from "./driver.js";
import type { PoolSource } from "./options.js";
import { PG_TYPES } from "./values.js";

// --- pg without a database -----------------------------------------------------------

class FakeClient {
  processID: unknown = 4242;
  status: string | null = "I";
  readonly queries: unknown[] = [];
  readonly releases: unknown[] = [];
  answer: unknown = { rows: [{ one: 1 }], rowCount: 1 };

  query(config: unknown): unknown {
    this.queries.push(config);
    if (config instanceof FakeCursor) return config;
    return Promise.resolve(this.answer);
  }

  release(destroy?: unknown): void {
    this.releases.push(destroy);
  }

  getTransactionStatus(): string | null {
    return this.status;
  }
}

class FakeCursor {
  static created: FakeCursor[] = [];
  readonly reads: number[] = [];
  closed = 0;

  constructor(
    readonly text: string,
    readonly values: unknown[],
    readonly config: unknown,
  ) {
    FakeCursor.created.push(this);
  }

  async read(count: number): Promise<unknown[]> {
    this.reads.push(count);
    return [{ n: 1 }];
  }

  async close(): Promise<void> {
    this.closed++;
  }
}

class FakePool extends EventEmitter {
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
  ended = 0;
  readonly client = new FakeClient();

  constructor(readonly options: Record<string, unknown> = { max: 3 }) {
    super();
  }

  async connect(): Promise<FakeClient> {
    return this.client;
  }

  async end(): Promise<void> {
    this.ended++;
  }
}

class FakeCanceller {
  readonly calls: string[] = [];
  failQuery = false;
  failEnd = false;

  constructor(readonly config: unknown) {}

  async connect(): Promise<void> {
    this.calls.push("connect");
  }

  async query(sql: string, values: unknown[]): Promise<void> {
    this.calls.push(`${sql} ${JSON.stringify(values)}`);
    if (this.failQuery) throw new Error("permission denied");
  }

  async end(): Promise<void> {
    this.calls.push("end");
    if (this.failEnd) throw new Error("already ended");
  }
}

function setup(source?: PoolSource) {
  const pool = new FakePool();
  const cancellers: FakeCanceller[] = [];
  const runtime: PgRuntime = {
    createPool: vi.fn(() => pool as unknown as pg.Pool),
    createClient: vi.fn((config) => {
      const canceller = new FakeCanceller(config);
      cancellers.push(canceller);
      return canceller as unknown as pg.Client;
    }),
    loadCursor: vi.fn(async () => FakeCursor as unknown as CursorClass),
  };
  const hooks = { connected: vi.fn(), disconnected: vi.fn() };
  const driver = new PgDriver(source ?? { owned: true, config: { max: 3, host: "db" } }, hooks, runtime);
  return { driver, pool, runtime, hooks, cancellers };
}

afterEach(() => {
  FakeCursor.created = [];
  vi.restoreAllMocks();
  vi.doUnmock("pg-cursor");
  vi.resetModules();
});

// --- tests ------------------------------------------------------------------------

describe("the pool", () => {
  test("is created on init from the configuration, with listeners for its events", () => {
    const { driver, pool, runtime, hooks } = setup();
    driver.init();
    expect(runtime.createPool).toHaveBeenCalledWith({ max: 3, host: "db" });
    expect(pool.listenerCount("error")).toBe(1);
    pool.emit("connect");
    pool.emit("remove");
    expect(hooks.connected).toHaveBeenCalledTimes(1);
    expect(hooks.disconnected).toHaveBeenCalledTimes(1);
    // An idle connection's error does not end the process.
    expect(() => pool.emit("error", new Error("terminated"))).not.toThrow();
  });

  test("reports its state, and whether a checkout would wait", () => {
    const { driver, pool } = setup();
    driver.init();
    pool.totalCount = 3;
    pool.idleCount = 1;
    pool.waitingCount = 2;
    expect(driver.stats()).toEqual({ size: 3, idle: 1, waiting: 2 });
    expect(driver.saturated()).toBe(false);
    pool.idleCount = 0;
    expect(driver.saturated()).toBe(true);
    pool.totalCount = 2;
    expect(driver.saturated()).toBe(false);
  });

  test.each([{}, { max: 0 }])(
    "without a usable max in its options (%o) counts ten connections as full",
    (options) => {
      const pool = new FakePool(options);
      const { driver } = setup({ owned: false, pool: pool as unknown as pg.Pool });
      driver.init();
      pool.totalCount = 10;
      expect(driver.saturated()).toBe(true);
    },
  );

  test("without options at all counts ten connections as full", () => {
    const pool = new FakePool();
    (pool as { options: unknown }).options = undefined;
    const { driver } = setup({ owned: false, pool: pool as unknown as pg.Pool });
    driver.init();
    pool.totalCount = 10;
    expect(driver.saturated()).toBe(true);
  });

  test("is ended by destroy when the adapter created it, and its listeners are removed", async () => {
    const { driver, pool } = setup();
    driver.init();
    await driver.destroy();
    expect(pool.ended).toBe(1);
    expect(pool.listenerCount("connect") + pool.listenerCount("remove") + pool.listenerCount("error")).toBe(
      0,
    );
  });

  test("a pool you bring gets no error listener and is not ended, only unsubscribed from", async () => {
    const pool = new FakePool();
    pool.on("connect", () => undefined);
    const { driver, runtime } = setup({ owned: false, pool: pool as unknown as pg.Pool });
    driver.init();
    expect(runtime.createPool).not.toHaveBeenCalled();
    expect(pool.listenerCount("error")).toBe(0);
    expect(pool.listenerCount("connect")).toBe(2);
    await driver.destroy();
    expect(pool.ended).toBe(0);
    expect(pool.listenerCount("connect")).toBe(1);
  });

  test("destroy before init does nothing", async () => {
    const { driver, runtime } = setup();
    await driver.destroy();
    expect(runtime.createPool).not.toHaveBeenCalled();
  });

  test("using the wrapper before init is a programming error", () => {
    const { driver } = setup();
    expect(() => driver.stats()).toThrow(/before init/);
  });
});

describe("connections", () => {
  test("run statements with this adapter's parsers, and return pg's rows and row count", async () => {
    const { driver, pool } = setup();
    driver.init();
    const connection = await driver.acquire();
    await expect(connection.query("select $1", [1], undefined)).resolves.toEqual({
      rows: [{ one: 1 }],
      rowCount: 1,
      insertId: undefined,
    });
    await connection.query("select $1", [2], "named");
    expect(pool.client.queries).toEqual([
      { text: "select $1", values: [1], types: PG_TYPES },
      { text: "select $1", values: [2], types: PG_TYPES, name: "named" },
    ]);
  });

  test("report the last result of a statement list, and no row count as zero", async () => {
    const { driver, pool } = setup();
    driver.init();
    const connection = await driver.acquire();
    pool.client.answer = [
      { rows: [{ a: 1 }], rowCount: 1 },
      { rows: [], rowCount: null },
    ];
    await expect(connection.query("select 1; begin", [], undefined)).resolves.toEqual({
      rows: [],
      rowCount: 0,
      insertId: undefined,
    });
  });

  test("go back to the pool, or are closed", async () => {
    const { driver, pool } = setup();
    driver.init();
    const connection = await driver.acquire();
    await driver.release(connection, false);
    await driver.release(connection, true);
    expect(pool.client.releases).toEqual([false, true]);
  });

  test("know whether they are inside a transaction", async () => {
    const { driver, pool } = setup();
    driver.init();
    const connection = await driver.acquire();
    const answers: boolean[] = [];
    for (const status of ["I", "T", "E", null]) {
      pool.client.status = status;
      answers.push(connection.inTransaction());
    }
    expect(answers).toEqual([false, true, true, false]);
  });

  test("open cursors with this adapter's parsers", async () => {
    const { driver, pool } = setup();
    driver.init();
    const connection = await driver.acquire();
    const cursor = await connection.cursor("select n", [1]);
    await expect(cursor.read(5)).resolves.toEqual([{ n: 1 }]);
    await cursor.close();
    const created = FakeCursor.created[0];
    expect(created).toMatchObject({
      text: "select n",
      values: [1],
      config: { types: PG_TYPES },
      reads: [5],
      closed: 1,
    });
    expect(pool.client.queries).toEqual([created]);
  });
});

describe("cancelling", () => {
  test("asks the server, on a separate connection with the same settings, to cancel the backend's statement", async () => {
    const { driver, cancellers } = setup();
    driver.init();
    const connection = await driver.acquire();
    await connection.cancel();
    expect(cancellers).toHaveLength(1);
    expect(cancellers[0]?.config).toEqual({ max: 3, host: "db" });
    expect(cancellers[0]?.calls).toEqual(["connect", "select pg_cancel_backend($1) [4242]", "end"]);
  });

  test("uses the settings of a pool you bring", async () => {
    const pool = new FakePool({ max: 2, host: "theirs" });
    const { driver, cancellers } = setup({ owned: false, pool: pool as unknown as pg.Pool });
    driver.init();
    await (await driver.acquire()).cancel();
    expect(cancellers[0]?.config).toEqual({ max: 2, host: "theirs" });
  });

  test("ends the separate connection even when the request fails, and reports the failure", async () => {
    const { driver, runtime, cancellers } = setup();
    vi.mocked(runtime.createClient).mockImplementation((config) => {
      const canceller = new FakeCanceller(config);
      canceller.failQuery = true;
      canceller.failEnd = true;
      cancellers.push(canceller);
      return canceller as unknown as pg.Client;
    });
    driver.init();
    await expect((await driver.acquire()).cancel()).rejects.toThrow("permission denied");
    expect(cancellers[0]?.calls.at(-1)).toBe("end");
  });

  test("does nothing for a client without a backend process id", async () => {
    const { driver, pool, cancellers } = setup();
    driver.init();
    pool.client.processID = null;
    await (await driver.acquire()).cancel();
    expect(cancellers).toHaveLength(0);
  });
});

describe("pg-cursor", () => {
  test("is loaded once", async () => {
    const { driver, runtime } = setup();
    await Promise.all([driver.cursorClass(), driver.cursorClass()]);
    await driver.cursorClass();
    expect(runtime.loadCursor).toHaveBeenCalledTimes(1);
  });

  test("a failed load is tried again next time", async () => {
    const { driver, runtime } = setup();
    vi.mocked(runtime.loadCursor).mockRejectedValueOnce(new QueryError("missing"));
    await expect(driver.cursorClass()).rejects.toThrow("missing");
    await expect(driver.cursorClass()).resolves.toBe(FakeCursor);
    expect(runtime.loadCursor).toHaveBeenCalledTimes(2);
  });

  test("the real loader gives pg-cursor's class", async () => {
    await expect(PG_RUNTIME.loadCursor()).resolves.toBe(Cursor);
  });

  test("the real loader explains how to install pg-cursor when it is missing", async () => {
    vi.doMock("pg-cursor", () => {
      throw new Error("Cannot find package 'pg-cursor'");
    });
    const { PG_RUNTIME: fresh } = await import("./driver.js");
    const error = await fresh.loadCursor().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("QueryError");
    expect((error as Error).message).toContain("pnpm add pg-cursor");
  });
});

describe("the real runtime", () => {
  test("creates pg pools and clients without connecting", async () => {
    const pool = PG_RUNTIME.createPool({ max: 1 });
    expect(pool).toBeInstanceOf(pg.Pool);
    expect(pool.totalCount).toBe(0);
    await pool.end();
    expect(PG_RUNTIME.createClient({})).toBeInstanceOf(pg.Client);
  });
});
