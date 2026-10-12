import { expect } from "vitest";
import { withDatabase } from "./db.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Body shared by `parallel-a.itest.ts` and `parallel-b.itest.ts`, which together check
 * the step 01 acceptance item "two integration test files run in parallel without interfering".
 *
 * Each file takes its own database, writes rows that would collide with its peer's if
 * anything were shared (same table, same primary keys, same unique email), and then
 * refuses to finish until it has seen the peer's connection alive on the same server.
 * So the pair passes only if both files really overlapped in time, and each then checks
 * that it still sees exactly its own rows.
 *
 * The two files must run in the same `vitest` invocation; filtering down to one of them
 * fails with the timeout message below.
 */
export async function runParallelPeer(self: "a" | "b", rowCount: number): Promise<void> {
  const peer = self === "a" ? "b" : "a";
  await withDatabase("postgres", { label: `parallel_${self}`, fixtures: ["blog"] }, async (db) => {
    // application_name is visible server-wide in pg_stat_activity: this is the rendezvous signal.
    await db.query("SELECT set_config('application_name', $1, false)", [`ectype-parallel-${self}`]);

    for (let i = 1; i <= rowCount; i += 1) {
      await db.query("INSERT INTO users (id, email, name) VALUES ($1, $2, $3)", [
        i,
        `user${i}@example.com`,
        self,
      ]);
    }

    const deadline = Date.now() + 20_000;
    let peerDatabase: string | undefined;
    while (peerDatabase === undefined) {
      const rows = await db.query<{ datname: string }>(
        "SELECT datname FROM pg_stat_activity WHERE application_name = $1",
        [`ectype-parallel-${peer}`],
      );
      peerDatabase = rows[0]?.datname;
      if (peerDatabase !== undefined) break;
      if (Date.now() > deadline) {
        throw new Error(
          `parallel-${self} never saw parallel-${peer} running. The two files must run in the same ` +
            "vitest invocation with file parallelism enabled (`pnpm test:integration`).",
        );
      }
      await sleep(25);
    }

    // Stay visible long enough for the peer to see this connection too.
    await sleep(500);

    expect(peerDatabase).toMatch(new RegExp(`^ectype_parallel_${peer}_`));
    expect(peerDatabase).not.toBe(db.name);
    const rows = await db.query<{ name: string }>("SELECT name FROM users ORDER BY id");
    expect(rows).toEqual(Array.from({ length: rowCount }, () => ({ name: self })));
  });
}
