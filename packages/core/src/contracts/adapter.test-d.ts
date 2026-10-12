// Type tests for the adapter contract. The fake adapter below is the proof that the
// interface can be implemented without any type from the SQL back end, and that the
// repo-side code of steps 12, 13 and 16 can be written against the interface alone.
import { describe, expectTypeOf, test } from "vitest";
import type {
  Adapter,
  AdapterEvents,
  BeginOptions,
  Capabilities,
  CompiledQuery,
  ConflictTarget,
  Connection,
  Dialect,
  Executor,
  InsertPlanOptions,
  IsolationLevel,
  OnConflict,
  OutputPlan,
  ParamSlot,
  QueryEvent,
  QueryOperation,
  RawResult,
  RowDecoder,
} from "./adapter.js";
import type { QueryAst } from "./query.js";
import type { FieldMeta, SchemaMeta } from "./schema.js";
import type { AnyEctoType, Codec } from "./type.js";

declare const ast: QueryAst;
declare const meta: SchemaMeta;
declare const field: FieldMeta;

const capabilities: Capabilities = {
  returning: true,
  onConflict: true,
  conflictTarget: true,
  ilike: true,
  lateralJoin: true,
  fullJoin: true,
  distinctOn: true,
  arrays: true,
  arrayParams: true,
  jsonb: true,
  nullsOrder: true,
  updateJoin: true,
  cteMaterialized: true,
  insertDefaultValues: true,
  lockModes: ["FOR UPDATE", "FOR SHARE"],
  isolationLevels: ["read committed", "repeatable read", "serializable"],
  savepoints: true,
  ddlTransactions: true,
  stream: true,
  maxParams: 65_535,
};

const plan: CompiledQuery = { sql: "select 1", slots: [], output: undefined, decoder: undefined };
const result: RawResult = { rows: [], rowCount: 0 };

async function* noRows(): AsyncIterable<Record<string, unknown>> {}

const connection: Connection = {
  execute: async () => result,
  stream: noRows,
  begin: async () => {},
  commit: async () => {},
  rollback: async () => {},
  savepoint: async () => {},
  rollbackTo: async () => {},
  releaseSavepoint: async () => {},
  release: async () => {},
};

/** An adapter written against the contract only. */
const fake: Adapter = {
  dialect: "postgres",
  capabilities,
  compile: () => plan,
  compileInsert: () => plan,
  compileUpdate: () => plan,
  compileDelete: () => plan,
  execute: async () => result,
  stream: noRows,
  acquire: async () => connection,
  normalizeError: (error) => error,
  typeOverrides: () => undefined,
  on: () => () => {},
  close: async () => {},
};

describe("Adapter", () => {
  test("compile methods are synchronous and return a CompiledQuery", () => {
    expectTypeOf(fake.compile(ast, "all")).toEqualTypeOf<CompiledQuery>();
    expectTypeOf(fake.compileUpdate(meta, [field], [field], [])).toEqualTypeOf<CompiledQuery>();
    expectTypeOf(fake.compileDelete(meta, [field], [])).toEqualTypeOf<CompiledQuery>();
    expectTypeOf(
      fake.compileInsert(meta, [field], {
        rows: 1,
        returning: [field],
        onConflict: "raise",
        conflictTarget: undefined,
      }),
    ).toEqualTypeOf<CompiledQuery>();
    expectTypeOf<QueryOperation>().toEqualTypeOf<"all" | "updateAll" | "deleteAll">();
    // @ts-expect-error not a query operation
    fake.compile(ast, "insert");
    // @ts-expect-error the options are required
    fake.compileInsert(meta, [field]);
  });

  test("execute and stream return rows as plain records, never any", () => {
    expectTypeOf(fake.execute("select 1", [])).resolves.toEqualTypeOf<RawResult>();
    expectTypeOf(fake.stream("select 1", [], { batchSize: 100 })).toEqualTypeOf<
      AsyncIterable<Record<string, unknown>>
    >();
    expectTypeOf<RawResult["rows"][number]>().toEqualTypeOf<Record<string, unknown>>();
    expectTypeOf<RawResult["rows"][number][string]>().toBeUnknown();
    // @ts-expect-error parameters are an array
    fake.execute("select 1", { id: 1 });
    // @ts-expect-error batchSize is a stream option only
    fake.execute("select 1", [], { batchSize: 1 });
  });

  test("an Adapter and a Connection are both Executors, so repo code takes either", () => {
    expectTypeOf(fake).toExtend<Executor>();
    expectTypeOf(connection).toExtend<Executor>();
    async function count(db: Executor): Promise<number> {
      return (await db.execute("select 1", [])).rowCount;
    }
    void [count(fake), count(connection)];
    // An adapter is not a connection: it cannot begin a transaction.
    expectTypeOf(fake).not.toExtend<Connection>();
  });

  test("transactions go through a Connection, with typed options", () => {
    expectTypeOf(fake.acquire()).resolves.toEqualTypeOf<Connection>();
    expectTypeOf(connection.begin).parameter(0).toEqualTypeOf<BeginOptions | undefined>();
    expectTypeOf<IsolationLevel>().toEqualTypeOf<"read committed" | "repeatable read" | "serializable">();
    connection.begin({ isolation: "serializable", readOnly: true, deferrable: true });
    // @ts-expect-error not an isolation level
    connection.begin({ isolation: "snapshot" });
    // @ts-expect-error a savepoint needs a name
    connection.savepoint();
  });

  test("typeOverrides answers with a codec or undefined", () => {
    const type = {} as AnyEctoType;
    expectTypeOf(fake.typeOverrides(type)).toEqualTypeOf<Codec | undefined>();
  });

  test("events are typed by name", () => {
    fake.on("query", (event) => {
      expectTypeOf(event).toEqualTypeOf<QueryEvent>();
      expectTypeOf(event.durationMs).toEqualTypeOf<number>();
      expectTypeOf(event.params).toEqualTypeOf<readonly unknown[] | undefined>();
    });
    fake.on("poolExhausted", (event) => expectTypeOf(event).toEqualTypeOf<AdapterEvents["poolExhausted"]>());
    expectTypeOf(fake.on("connect", () => {})).toEqualTypeOf<() => void>();
    // @ts-expect-error no such event
    fake.on("commit", () => {});
  });

  test("dialect and capabilities are closed sets", () => {
    expectTypeOf<Dialect>().toEqualTypeOf<"postgres" | "mysql" | "sqlite">();
    // @ts-expect-error not a dialect
    const bad: Adapter = { ...fake, dialect: "mssql" };
    // @ts-expect-error every capability must be stated
    const partial: Capabilities = { returning: true };
    // @ts-expect-error capabilities are booleans, lists or numbers, not strings
    const wrong: Capabilities = { ...capabilities, returning: "yes" };
    void [bad, partial, wrong];
  });

  test("an adapter is missing nothing and may not skip a member", () => {
    const { close: _close, ...withoutClose } = fake;
    // @ts-expect-error close is required
    const incomplete: Adapter = withoutClose;
    void incomplete;
  });
});

describe("ParamSlot", () => {
  test("discriminates on kind", () => {
    const slot = {} as ParamSlot;
    if (slot.kind === "inline" || slot.kind === "list") expectTypeOf(slot.index).toEqualTypeOf<number>();
    if (slot.kind === "element") expectTypeOf(slot.element).toEqualTypeOf<number>();
    if (slot.kind === "named") {
      expectTypeOf(slot.name).toEqualTypeOf<string>();
      // @ts-expect-error a named slot has no index
      slot.index;
    }
    expectTypeOf(slot.dump).toEqualTypeOf<((value: unknown) => unknown) | undefined>();
  });

  test("is enough to write bindParams", () => {
    function bindParams(
      slots: readonly ParamSlot[],
      params: readonly unknown[],
      named: Record<string, unknown>,
    ): unknown[] {
      const out = new Array<unknown>(slots.length);
      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i]!;
        let value: unknown;
        switch (slot.kind) {
          case "inline":
          case "list":
            value = params[slot.index];
            break;
          case "element":
            value = (params[slot.index] as readonly unknown[])[slot.element];
            break;
          case "named":
            value = named[slot.name];
            break;
          default:
            expectTypeOf(slot).toBeNever();
        }
        out[i] = slot.dump === undefined || value === null ? value : slot.dump(value);
      }
      return out;
    }
    expectTypeOf(bindParams).returns.toEqualTypeOf<unknown[]>();
  });

  test("rejects incomplete and unknown slots", () => {
    // @ts-expect-error dump must be given, even as undefined
    const a: ParamSlot = { kind: "inline", index: 0 };
    // @ts-expect-error an element slot needs its element
    const b: ParamSlot = { kind: "element", index: 0, dump: undefined };
    // @ts-expect-error no such kind
    const c: ParamSlot = { kind: "positional", index: 0, dump: undefined };
    void [a, b, c];
  });
});

describe("CompiledQuery and OutputPlan", () => {
  test("only the decoder can be assigned after creation", () => {
    const decoder: RowDecoder = (row) => row.c0;
    plan.decoder = decoder;
    // @ts-expect-error the sql is fixed
    plan.sql = "select 2";
    // @ts-expect-error the slots are fixed
    plan.slots = [];
    expectTypeOf(decoder).returns.toBeUnknown();
  });

  test("an output plan mirrors objects, tuples, rows and values", () => {
    const output: OutputPlan = {
      kind: "object",
      keys: ["id", "author", "pair"],
      values: [
        { kind: "value", alias: "c0", type: undefined },
        { kind: "row", meta, aliases: ["c1", "c2"] },
        { kind: "tuple", items: [{ kind: "value", alias: "c3", type: undefined }] },
      ],
    };
    if (output.kind === "object") expectTypeOf(output.values).toEqualTypeOf<readonly OutputPlan[]>();
    // @ts-expect-error a value needs its alias
    const bad: OutputPlan = { kind: "value", type: undefined };
    void bad;
  });
});

describe("insert options", () => {
  test("cover Ecto's on_conflict and conflict_target forms", () => {
    const forms: OnConflict[] = [
      "raise",
      "nothing",
      "replaceAll",
      { replace: [field] },
      { replaceAllExcept: [field] },
      { query: ast },
    ];
    const targets: ConflictTarget[] = [{ fields: [field] }, { constraint: "users_email_index" }];
    const options: InsertPlanOptions = {
      rows: 2,
      returning: [],
      onConflict: forms[3]!,
      conflictTarget: targets[0],
    };
    void options;
    // @ts-expect-error not an on_conflict form
    const bad: OnConflict = "ignore";
    // @ts-expect-error fields are FieldMeta, not names
    const names: OnConflict = { replace: ["name"] };
    void [bad, names];
  });
});
