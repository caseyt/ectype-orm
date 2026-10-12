// Question 4 — Cost.
//
//   Part A  CPU cost of the cold path (lower + compile + slot recovery) and of the pieces
//           of the cached path. No database involved; measured with mitata.
//   Part B  Cached execution through Kysely's driver versus calling `pg` directly, for a
//           1-row and a 1,000-row SELECT, against the Compose Postgres. Both sides use the
//           SAME pg.Pool with one connection, so they talk to the same backend, and they
//           alternate within every round so that drift hits both alike.
//   Part C  The same driver-layer overhead with the network taken out: a stub pool whose
//           client answers immediately. This is NOT a database measurement and decides
//           nothing by itself; it puts an absolute number on what part B can only bound.
//           (It runs in the same mitata pass as part A, before part B.)
//
// Run with: pnpm --filter @ectype/spike-kysely-bridge run spike:cost
// Writes results/04-cost.local.json (git-ignored). The committed results/04-cost.json,
// which ADR 0002 quotes, is replaced only with SPIKE_COST_RECORD=1.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { createQueryId, type Driver, PostgresDriver, PostgresQueryCompiler, ValueNode } from "kysely";
import { bench, do_not_optimize, group, run } from "mitata";
import pg from "pg";
import type { Expr, SelectAst, Source } from "./ast.js";
import { col, collectParams, param, select, table } from "./ast.js";
import { bindParams, compile, compileNode, lower, type Plan } from "./bridge.js";
import { main } from "./db.js";
import { cte, REFERENCE_SQL, reference, update, upsert } from "./queries.js";

const REFERENCE = reference(18, 10);
const CTE = cte(9, 7);
const UPSERT = upsert("a@example.com", "A", 30, 1);
const UPDATE = update("A", 1, 1, 1);

const QUICK = process.env.SPIKE_COST_QUICK === "1";
/** Only a run that is meant to replace the committed evidence writes results/04-cost.json. */
const RECORD = process.env.SPIKE_COST_RECORD === "1" && !QUICK;

/** The version of a dependency as installed, read from its own package.json. */
function installedVersion(name: string): string {
  const manifest = new URL(`./node_modules/${name}/package.json`, import.meta.url);
  return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
}

// ---------------------------------------------------------------------------
// A hand-written string emitter for the reference query's node kinds: the lower bound a
// compiler of our own could approach. Only here to put Kysely's cold cost in proportion.
// ---------------------------------------------------------------------------
function emitDirect(ast: SelectAst): { sql: string; slots: number[] } {
  const slots: number[] = [];
  const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const expr = (e: Expr): string => {
    switch (e.kind) {
      case "column":
        return `${q(e.binding)}.${q(e.column)}`;
      case "param":
        slots.push(slots.length);
        return `$${slots.length}`;
      case "binary":
        return `${expr(e.left)} ${e.op} ${expr(e.right)}`;
      case "nary":
        return e.args.map(expr).join(` ${e.op} `);
      case "aggregate":
        return `${e.fn}(${e.args.map(expr).join(", ")})`;
      default:
        throw new Error(`emitDirect does not handle ${e.kind}`);
    }
  };
  let sql = `select ${ast.select.map((e, i) => `${expr(e)} as ${q(`c${i}`)}`).join(", ")}`;
  const tableOf = (source: Source): string => {
    if (source.kind !== "table") throw new Error("emitDirect handles tables only");
    return `${q(source.table)} as ${q(source.alias)}`;
  };
  sql += ` from ${tableOf(ast.from)}`;
  for (const join of ast.joins) {
    sql += ` ${join.type} join ${tableOf(join.source)} on ${expr(join.on)}`;
  }
  if (ast.wheres.length > 0) sql += ` where ${ast.wheres.map(expr).join(" and ")}`;
  if (ast.groupBys.length > 0) sql += ` group by ${ast.groupBys.map(expr).join(", ")}`;
  if (ast.orderBys.length > 0)
    sql += ` order by ${ast.orderBys.map((o) => `${expr(o.expr)} ${o.direction}`).join(", ")}`;
  if (ast.limit !== undefined) sql += ` limit ${expr(ast.limit)}`;
  return { sql, slots };
}
if (emitDirect(REFERENCE).sql !== REFERENCE_SQL)
  throw new Error("emitDirect disagrees with the Kysely output");

// ---------------------------------------------------------------------------
// Queries for part B: the ten columns of `users`.
// ---------------------------------------------------------------------------
const USER_COLUMNS = [
  "id",
  "email",
  "name",
  "age",
  "role",
  "password_hash",
  "settings",
  "lock_version",
  "inserted_at",
  "updated_at",
];
const ONE_ROW: SelectAst = select({
  from: table("users", "u"),
  select: USER_COLUMNS.map((name) => col("u", name)),
  wheres: [{ kind: "binary", op: "=", left: col("u", "id"), right: param(0) }],
});
const MANY_ROWS: SelectAst = select({
  from: table("users", "u"),
  select: USER_COLUMNS.map((name) => col("u", name)),
  orderBys: [{ expr: col("u", "id"), direction: "asc" }],
  limit: param(0),
});

interface Stat {
  readonly name: string;
  /** Nanoseconds per call. */
  readonly avg: number;
  readonly p50: number;
  readonly p75: number;
  readonly p99: number;
  readonly min: number;
  readonly samples: number;
}

async function runMitata(): Promise<Stat[]> {
  const { benchmarks } = await run();
  const stats: Stat[] = [];
  for (const trial of benchmarks) {
    for (const { name, stats: s, error } of trial.runs) {
      if (error !== undefined) throw new Error(`benchmark "${name}" threw`, { cause: error });
      if (s === undefined) continue;
      stats.push({
        name,
        avg: s.avg,
        p50: s.p50,
        p75: s.p75,
        p99: s.p99,
        min: s.min,
        samples: s.samples.length,
      });
    }
  }
  return stats;
}

const median = (values: readonly number[]): number => quantile(values, 0.5);
function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return (sorted[low] as number) + ((sorted[high] as number) - (sorted[low] as number)) * (position - low);
}

interface Variant {
  readonly name: string;
  readonly call: () => Promise<number>;
}

interface Comparison {
  readonly rows: number;
  readonly mode: string;
  readonly rounds: number;
  readonly callsPerRound: number;
  /** Median over rounds of the mean time per call, in microseconds. */
  readonly rawUs: number;
  readonly bridgeUs: number;
  /** Median, 25th and 75th percentile over rounds of (bridge / raw - 1), in percent. */
  readonly overheadPct: { p25: number; p50: number; p75: number };
  /** Median over rounds of (bridge - raw), in microseconds per call. */
  readonly differenceUs: number;
}

/** Alternates the two variants within each round and compares them round by round. */
async function compare(
  rows: number,
  mode: string,
  raw: Variant,
  bridge: Variant,
  rounds: number,
  calls: number,
): Promise<Comparison> {
  const time = async (variant: Variant): Promise<number> => {
    const start = process.hrtime.bigint();
    for (let i = 0; i < calls; i++) {
      if ((await variant.call()) !== rows)
        throw new Error(`${variant.name} returned the wrong number of rows`);
    }
    return Number(process.hrtime.bigint() - start) / calls / 1000;
  };
  // Warm both paths before measuring.
  await time(raw);
  await time(bridge);
  const rawTimes: number[] = [];
  const bridgeTimes: number[] = [];
  for (let round = 0; round < rounds; round++) {
    // Swap the order every round, so neither side always runs first.
    if (round % 2 === 0) {
      rawTimes.push(await time(raw));
      bridgeTimes.push(await time(bridge));
    } else {
      bridgeTimes.push(await time(bridge));
      rawTimes.push(await time(raw));
    }
  }
  const ratios = rawTimes.map((rawTime, i) => ((bridgeTimes[i] as number) / rawTime - 1) * 100);
  const differences = rawTimes.map((rawTime, i) => (bridgeTimes[i] as number) - rawTime);
  const result: Comparison = {
    rows,
    mode,
    rounds,
    callsPerRound: calls,
    rawUs: median(rawTimes),
    bridgeUs: median(bridgeTimes),
    overheadPct: { p25: quantile(ratios, 0.25), p50: median(ratios), p75: quantile(ratios, 0.75) },
    differenceUs: median(differences),
  };
  const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
  console.log(
    `  ${String(rows).padStart(5)} row(s), ${mode.padEnd(22)} raw ${result.rawUs.toFixed(1).padStart(7)} µs   bridge ${result.bridgeUs.toFixed(1).padStart(7)} µs   overhead ${pct(result.overheadPct.p50)} (IQR ${pct(result.overheadPct.p25)} .. ${pct(result.overheadPct.p75)})   difference ${result.differenceUs >= 0 ? "+" : ""}${result.differenceUs.toFixed(2)} µs`,
  );
  return result;
}

await main("Question 4: cost", { users: 1000, postsPerUser: 3 }, async (db) => {
  // ----- Part A ------------------------------------------------------------
  console.log("Parts A and C: CPU cost, no database (mitata, time per call)\n");
  const lowered = lower(REFERENCE, "postgres");
  const referencePlan = compile(REFERENCE);
  const planCache = new WeakMap<object, Plan>([[REFERENCE, referencePlan]]);
  const referenceParams = collectParams(REFERENCE);

  group("cold path, reference 3-clause query", () => {
    bench("lower: AST -> Kysely nodes", () => do_not_optimize(lower(REFERENCE, "postgres")));
    bench("Kysely compile + slot recovery (pre-lowered tree)", () =>
      do_not_optimize(compileNode(lowered.node, lowered.created, "postgres")),
    );
    bench("cold compile: lower + compile + slots", () => do_not_optimize(compile(REFERENCE)));
    bench("for scale: hand-written string emitter, same query", () => do_not_optimize(emitDirect(REFERENCE)));
  });
  group("cold path, other statements", () => {
    bench("cold compile: CTE + join", () => do_not_optimize(compile(CTE)));
    bench("cold compile: INSERT ... ON CONFLICT ... RETURNING", () => do_not_optimize(compile(UPSERT)));
    bench("cold compile: UPDATE ... RETURNING", () => do_not_optimize(compile(UPDATE)));
    bench("cold compile: SELECT 10 columns WHERE id = $1", () => do_not_optimize(compile(ONE_ROW)));
  });
  group("cached path (Kysely not involved until the driver call)", () => {
    bench("bindParams, 2 slots", () =>
      do_not_optimize(bindParams(referencePlan.slots, referenceParams, undefined)),
    );
    bench("plan lookup (WeakMap) + bindParams + CompiledQuery object", () => {
      const plan = planCache.get(REFERENCE) as Plan;
      return do_not_optimize({
        sql: plan.sql,
        parameters: bindParams(plan.slots, referenceParams, undefined),
        query: plan.node,
        queryId: createQueryId(),
      });
    });
  });
  group("why the compiler and the nodes are built the way they are", () => {
    bench("new PostgresQueryCompiler() (must be reused, not per query)", () =>
      do_not_optimize(new PostgresQueryCompiler()),
    );
    bench("ValueNode.create(x) (factory: object + Object.freeze)", () =>
      do_not_optimize(ValueNode.create(referenceParams)),
    );
    bench("{ kind: 'ValueNode', value: x } (literal, not frozen)", () =>
      do_not_optimize({ kind: "ValueNode", value: referenceParams } satisfies ValueNode),
    );
  });
  // ----- Part C (registered here so that one mitata run covers parts A and C) -----
  const canned = { command: "SELECT" as const, rowCount: 1, rows: [{ c0: 1 }] };
  const stubClient = { query: () => Promise.resolve(canned), release() {} };
  const stubPool = { connect: () => Promise.resolve(stubClient), end: () => Promise.resolve(), options: {} };
  const stubDriver: Driver = new PostgresDriver({ pool: stubPool as never });
  await stubDriver.init();
  const stubParams = [500];
  const stubPlan = compile(ONE_ROW);
  group("part C, stub pool (no I/O; NOT a database measurement): one call, checkout included", () => {
    bench("stub client directly: connect + query + release", async () => {
      const client = await stubPool.connect();
      try {
        return (await client.query()).rows.length;
      } finally {
        client.release();
      }
    });
    bench("through PostgresDriver: acquire + executeQuery + release", async () => {
      const connection = await stubDriver.acquireConnection();
      try {
        return (
          await connection.executeQuery({
            sql: stubPlan.sql,
            parameters: bindParams(stubPlan.slots, stubParams, undefined),
            query: stubPlan.node,
            queryId: createQueryId(),
          })
        ).rows.length;
      } finally {
        await stubDriver.releaseConnection(connection);
      }
    });
  });

  const cpu = await runMitata();

  // ----- Part B ------------------------------------------------------------
  console.log("\nPart B: cached execution against Postgres, bridge versus pg (same pool, same backend)\n");
  const pool = new pg.Pool({ ...db.config, max: 1 });
  const driver: Driver = new PostgresDriver({ pool });
  await driver.init();
  const onePlan = compile(ONE_ROW);
  const manyPlan = compile(MANY_ROWS);
  const comparisons: Comparison[] = [];
  try {
    // The two sides must run byte-identical SQL.
    const cases = [
      { rows: 1, plan: onePlan, params: [500], rounds: QUICK ? 4 : 40, calls: QUICK ? 200 : 1500 },
      { rows: 1000, plan: manyPlan, params: [1000], rounds: QUICK ? 4 : 40, calls: QUICK ? 20 : 150 },
    ];
    for (const { rows, plan, params, rounds, calls } of cases) {
      // (1) Checking a connection out of the pool for every call: what Adapter.execute does.
      comparisons.push(
        await compare(
          rows,
          "pool checkout per call",
          {
            name: "pg",
            call: async () => {
              const client = await pool.connect();
              try {
                return (await client.query(plan.sql, params)).rows.length;
              } finally {
                client.release();
              }
            },
          },
          {
            name: "bridge",
            call: async () => {
              const connection = await driver.acquireConnection();
              try {
                return (
                  await connection.executeQuery({
                    sql: plan.sql,
                    parameters: bindParams(plan.slots, params, undefined),
                    query: plan.node,
                    queryId: createQueryId(),
                  })
                ).rows.length;
              } finally {
                await driver.releaseConnection(connection);
              }
            },
          },
          rounds,
          calls,
        ),
      );
      // (2) On a connection that is already held: what a transaction does. The pool has one
      // connection, so the client taken and returned here is the one the driver then wraps:
      // both sides send over the same socket to the same backend.
      const client = await pool.connect();
      client.release();
      const connection = await driver.acquireConnection();
      try {
        comparisons.push(
          await compare(
            rows,
            "held connection",
            { name: "pg", call: async () => (await client.query(plan.sql, params)).rows.length },
            {
              name: "bridge",
              call: async () =>
                (
                  await connection.executeQuery({
                    sql: plan.sql,
                    parameters: bindParams(plan.slots, params, undefined),
                    query: plan.node,
                    queryId: createQueryId(),
                  })
                ).rows.length,
            },
            rounds,
            calls,
          ),
        );
      } finally {
        await driver.releaseConnection(connection);
      }
    }
  } finally {
    await driver.destroy();
  }

  // ----- Report ------------------------------------------------------------
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  const report = {
    date: new Date().toISOString(),
    quick: QUICK,
    gitSha: git("rev-parse", "HEAD"),
    /** Uncommitted changes to the spike's own code (results/ excluded) at the time of the run. */
    gitDirty: git("status", "--porcelain", "--", ".", ":(exclude)results") !== "",
    node: process.version,
    kysely: installedVersion("kysely"),
    pg: installedVersion("pg"),
    server: db.serverVersion,
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? "unknown",
      cores: cpus().length,
      memoryBytes: totalmem(),
    },
    /** Parts A and C. The entries whose name starts with "stub" or "through PostgresDriver" are part C. */
    cpuNsPerCall: cpu,
    executionAgainstPostgres: comparisons,
  };
  const out = new URL(RECORD ? "./results/04-cost.json" : "./results/04-cost.local.json", import.meta.url);
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${out.pathname}`);
});
