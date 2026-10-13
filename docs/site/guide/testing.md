# Testing

The test helpers are a separate entry point:

```ts
import { createSandbox, expectQueries } from "egon-orm/testing";
```

## The sandbox

The sandbox runs each test inside a transaction that is rolled back afterwards. Tests see
their own writes, nothing is committed, and there is no cleanup to write.

```ts
import { beforeEach, afterEach, test, expect } from "vitest";
import { createSandbox } from "egon-orm/testing";
import { repo } from "../src/repo";

const sandbox = await createSandbox(repo);

beforeEach(() => sandbox.begin());
afterEach(() => sandbox.rollback());

test("registers a user", async () => {
  await register({ email: "ada@example.com" });          // application code using `repo`
  expect(await repo.count(User)).toBe(1);
});
```

- **`sandbox.begin()`** takes one connection, opens a transaction, and routes every
  operation of `repo` through it, including code that imports the repo itself.
- **`sandbox.rollback()`** undoes everything and restores the repo.
- **`repo.transaction` inside a test** becomes a savepoint, so code that uses
  transactions works unchanged.

### Parallelism

Vitest and Jest run each test file in its own worker. Each file therefore has its own
sandbox and connection: files run in parallel without seeing each other's data, and the
tests within one file run one after another.

### Limits

- Code that opens its own connection or pool is outside the sandbox.
- A test cannot observe a real commit. Behaviour that depends on one, such as two
  connections seeing each other's work, needs a test without the sandbox.

## Counting queries

`expectQueries(repo, fn)` runs `fn` and returns the query events it caused. Use it to pin
down the number of queries, so an N+1 cannot creep in:

```ts
test("loads the feed in three queries", async () => {
  const queries = await expectQueries(repo, () => loadFeed(userId));
  expect(queries).toHaveLength(3);
});
```

Each event has `sql`, `operation`, `source` and `durationMs`.

## A database for tests

- **SQLite in memory** needs no service and is the fastest:
  `sqlite({ filename: ":memory:" })`. Check
  [Dialect support](/reference/dialect-support) for features your queries use.
- **The same database as production**, in Docker, is the most faithful. Create the tables
  once before the run; the sandbox keeps them empty between tests.

## Test data

There is no factory helper. A plain function is enough, and `insertOrThrow` makes a bad
fixture fail loudly:

```ts
export const insertUser = (attrs: Partial<InsertShape<typeof User>> = {}) =>
  repo.insertOrThrow(change(User, { email: `user${Math.random()}@example.com`, ...attrs }));
```
