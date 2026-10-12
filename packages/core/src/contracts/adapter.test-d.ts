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
  InsertCell,
  InsertPlanOptions,
  InsertSource,
  IsolationLevel,
  OnConflict,
  OutputPlan,
  OutputPreload,
  ParamSlot,
  QueryEvent,
  RawResult,
  RowDecoder,
} from "./adapter.js";
import type { ExprNode, FragmentNode, ParamNode, QueryAst, QueryOperation, SelectNode } from "./query.js";
import type { FieldMeta, RowMeta, SchemaMeta } from "./schema.js";
import { ROW } from "./schema.js";
import type { AnyEctoType, Codec } from "./type.js";

declare const ast: QueryAst;
declare const meta: SchemaMeta;
declare const field: FieldMeta;
declare const fragment: FragmentNode;
declare const stringType: AnyEctoType;

const insertOne: InsertPlanOptions = {
  source: { kind: "values", rows: 1 },
  returning: [field],
  onConflict: "raise",
  conflictTarget: undefined,
};

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

const plan: CompiledQuery = {
  sql: "select 1",
  slots: [],
  output: undefined,
  prefix: undefined,
  decoder: undefined,
};
const result: RawResult = { rows: [], rowCount: 0, insertId: undefined };

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
  destroy: async () => {},
};

/** An adapter written against the contract only. */
const fake: Adapter = {
  dialect: "postgres",
  capabilities,
  compile: () => plan,
  compileFragment: () => plan,
  compileExplain: () => plan,
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
  test("compile methods are synchronous, take the effective prefix and return a CompiledQuery", () => {
    expectTypeOf(fake.compile(ast, "all", undefined)).toEqualTypeOf<CompiledQuery>();
    expectTypeOf(fake.compile(ast, "updateAll", "tenant_1")).toEqualTypeOf<CompiledQuery>();
    expectTypeOf(fake.compileUpdate(meta, [field], [field], [], "tenant_1")).toEqualTypeOf<CompiledQuery>();
    expectTypeOf(fake.compileDelete(meta, [field], [], undefined)).toEqualTypeOf<CompiledQuery>();
    expectTypeOf(fake.compileInsert(meta, [field], insertOne, undefined)).toEqualTypeOf<CompiledQuery>();
    expectTypeOf(fake.compileFragment(fragment)).toEqualTypeOf<CompiledQuery>();
    expectTypeOf<QueryOperation>().toEqualTypeOf<"all" | "updateAll" | "deleteAll">();
    // @ts-expect-error not a query operation
    fake.compile(ast, "insert", undefined);
    // @ts-expect-error the prefix must be stated, even as undefined
    fake.compile(ast, "all");
    // @ts-expect-error the prefix must be stated for row-level writes too
    fake.compileUpdate(meta, [field], [field], []);
    // @ts-expect-error the prefix must be stated for deletes too
    fake.compileDelete(meta, [field], []);
    // @ts-expect-error the options are required
    fake.compileInsert(meta, [field], undefined, undefined);
    // @ts-expect-error a fragment, not a string: raw SQL text cannot be compiled
    fake.compileFragment("select 1");
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
    // Step 16: a connection whose ROLLBACK failed is destroyed, not returned to the pool.
    expectTypeOf(connection.destroy()).resolves.toBeVoid();
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
      expectTypeOf(event.context).toBeUnknown();
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
    expectTypeOf(slot.redact).toEqualTypeOf<boolean>();
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
    const a: ParamSlot = { kind: "inline", index: 0, redact: false };
    // @ts-expect-error an element slot needs its element
    const b: ParamSlot = { kind: "element", index: 0, dump: undefined, redact: false };
    // @ts-expect-error no such kind
    const c: ParamSlot = { kind: "positional", index: 0, dump: undefined, redact: false };
    // @ts-expect-error whether the value is redacted must be stated
    const d: ParamSlot = { kind: "named", name: "x", dump: undefined };
    void [a, b, c, d];
  });
});

describe("CompiledQuery and OutputPlan", () => {
  test("only the decoder can be assigned after creation", () => {
    const decoder: RowDecoder = (row, constants) => [row.c0, constants[0]];
    plan.decoder = decoder;
    expectTypeOf(decoder).parameter(1).toEqualTypeOf<readonly unknown[]>();
    // @ts-expect-error the prefix a plan resolved to is fixed
    plan.prefix = "other";
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
        { kind: "row", meta, aliases: ["c1", "c2"], nullable: false, preloads: [] },
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
    const targets: ConflictTarget[] = [
      { fields: [field] },
      { constraint: "users_email_index" },
      { fragment },
    ];
    const options: InsertPlanOptions = {
      source: { kind: "values", rows: 2 },
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

// ---------------------------------------------------------------------------
// The features of later steps, written against the contract alone. None of these could
// be written against the first version of the contract (step 02 review, findings 1-9).
// ---------------------------------------------------------------------------

function bindParams(slots: readonly ParamSlot[], params: readonly unknown[]): unknown[] {
  return slots.map((slot) =>
    slot.kind === "inline" || slot.kind === "list" ? params[slot.index] : undefined,
  );
}

describe("what steps 08 to 17 need from the contract", () => {
  test("step 12: a read in a per-call prefix, without touching the AST, with rows stamped with that prefix", () => {
    async function all(
      adapter: Adapter,
      query: QueryAst,
      options: { prefix?: string },
      repoPrefix: string | undefined,
    ) {
      const compiled = adapter.compile(query, "all", options.prefix ?? repoPrefix);
      const raw = await adapter.execute(compiled.sql, bindParams(compiled.slots, query.params), {
        slots: compiled.slots,
        context: { operation: "all" },
      });
      const output = compiled.output;
      if (output === undefined || output.kind !== "row") return [];
      const rowMeta = output.meta.rowMeta("loaded", compiled.prefix);
      expectTypeOf(rowMeta).toEqualTypeOf<RowMeta>();
      return raw.rows.map((row) =>
        output.meta.create(
          output.aliases.map((alias) => row[alias]),
          rowMeta,
        ),
      );
    }
    expectTypeOf(all).returns.resolves.toEqualTypeOf<object[]>();
    expectTypeOf(plan.prefix).toEqualTypeOf<string | undefined>();
  });

  test("step 13: an update of a loaded row goes to the prefix the row came from", () => {
    function updatePlan(adapter: Adapter, row: { readonly [ROW]: RowMeta }, callPrefix: string | undefined) {
      return adapter.compileUpdate(meta, [field], meta.primaryKey, [], callPrefix ?? row[ROW].prefix);
    }
    expectTypeOf(updatePlan).returns.toEqualTypeOf<CompiledQuery>();
  });

  test("step 12: repo.query compiles a bare fragment and returns raw rows", () => {
    async function query(adapter: Adapter, sql: FragmentNode, params: readonly unknown[]) {
      const compiled = adapter.compileFragment(sql);
      const raw = await adapter.execute(compiled.sql, bindParams(compiled.slots, params), {
        slots: compiled.slots,
      });
      return { rows: raw.rows, rowCount: raw.rowCount };
    }
    expectTypeOf(query).returns.resolves.toEqualTypeOf<{
      rows: readonly Record<string, unknown>[];
      rowCount: number;
    }>();
  });

  test("steps 13 and 17: an insert without RETURNING reads the generated key from the result", () => {
    async function insertedId(adapter: Adapter, values: readonly unknown[]) {
      const options: InsertPlanOptions = {
        ...insertOne,
        returning: adapter.capabilities.returning ? [field] : [],
      };
      const compiled = adapter.compileInsert(meta, [field], options, undefined);
      const raw = await adapter.execute(compiled.sql, bindParams(compiled.slots, values));
      return adapter.capabilities.returning ? raw.rows[0]?.c0 : raw.insertId;
    }
    expectTypeOf(result.insertId).toEqualTypeOf<bigint | number | undefined>();
    expectTypeOf(insertedId).returns.resolves.toBeUnknown();
    // @ts-expect-error the insert id must be reported, even as undefined
    const incomplete: RawResult = { rows: [], rowCount: 1 };
    void incomplete;
  });

  test("step 13: insertAll expresses ragged rows, expressions, subqueries, placeholders and a source query", () => {
    const value: ParamNode = { kind: "param", value: 1, type: undefined, redact: false };
    const upper: ExprNode = { kind: "fn", name: "upper", args: [value] };
    const subquery: ExprNode = { kind: "subquery", query: ast };
    const cells: InsertCell[][] = [
      [{ kind: "value" }, { kind: "default" }, { kind: "expr", expr: upper }],
      [{ kind: "value" }, { kind: "placeholder", name: "now" }, { kind: "expr", expr: subquery }],
    ];
    const sources: InsertSource[] = [
      { kind: "values", rows: 500 },
      { kind: "cells", rows: cells },
      { kind: "query", query: ast },
    ];
    for (const source of sources) {
      const options: InsertPlanOptions = { ...insertOne, source };
      expectTypeOf(
        fake.compileInsert(meta, [field, field, field], options, "tenant_1"),
      ).toEqualTypeOf<CompiledQuery>();
    }
    // @ts-expect-error a cell holds no value: values go in the parameter array
    const withValue: InsertCell = { kind: "value", value: 1 };
    // @ts-expect-error an expression cell needs a node, not a value
    const rawExpr: InsertCell = { kind: "expr", expr: "now()" };
    // @ts-expect-error not a source
    const bad: InsertSource = { kind: "rows", rows: 1 };
    void [withValue, rawExpr, bad];
  });

  test("step 13: onConflict takes an update query and conflictTarget a fragment", () => {
    const options: InsertPlanOptions = {
      source: { kind: "values", rows: 1 },
      returning: [],
      onConflict: { query: ast },
      conflictTarget: { fragment },
    };
    expectTypeOf(fake.compileInsert(meta, [field], options, undefined)).toEqualTypeOf<CompiledQuery>();
  });

  test("step 08: a selected constant comes from the query, not from the plan or the database", () => {
    const select: SelectNode = {
      kind: "select",
      shape: { kind: "object", keys: ["kind"], values: [{ kind: "constant", index: 0 }] },
      constants: ["user"],
    };
    const output: OutputPlan = { kind: "object", keys: ["kind"], values: [{ kind: "constant", index: 0 }] };
    const decode: RowDecoder = (_row, constants) => ({ kind: constants[0] });
    expectTypeOf(decode({}, select.constants)).toBeUnknown();
    // @ts-expect-error the plan holds an index, never the value
    const leaked: OutputPlan = { kind: "constant", value: "user" };
    void [output, leaked];
  });

  test("step 14: a join preload is part of the output plan and rows come from a factory variant", () => {
    const posts: OutputPreload = {
      assoc: "posts",
      cardinality: "many",
      row: { kind: "row", meta, aliases: ["c2", "c3"], nullable: false, preloads: [] },
    };
    const users: OutputPlan = {
      kind: "row",
      meta,
      aliases: ["c0", "c1"],
      nullable: false,
      preloads: [posts],
    };
    if (users.kind === "row") {
      const create = users.meta.createWith(users.preloads.map((preload) => preload.assoc));
      expectTypeOf(create).toEqualTypeOf<
        (values: readonly unknown[], loaded: readonly unknown[], row: RowMeta) => object
      >();
    }
    // @ts-expect-error not a cardinality
    const bad: OutputPreload = { ...posts, cardinality: "several" };
    void bad;
  });

  test("steps 08 and 12: a whole binding from an outer join decodes to null", () => {
    const profile: OutputPlan = { kind: "row", meta, aliases: ["c2", "c3"], nullable: true, preloads: [] };
    const decode = (row: Readonly<Record<string, unknown>>): object | null => {
      if (profile.kind !== "row") return null;
      const absent =
        profile.nullable &&
        profile.meta.primaryKey.every((key) => row[profile.aliases[key.index] ?? ""] === null);
      return absent ? null : profile.meta.create([], profile.meta.rowMeta("loaded", undefined));
    };
    expectTypeOf(decode).returns.toEqualTypeOf<object | null>();
    // @ts-expect-error whether the row can be absent must be stated
    const unstated: OutputPlan = { kind: "row", meta, aliases: [], preloads: [] };
    void unstated;
  });

  test("steps 09 and 12: explain and named prepared statements go through the contract", () => {
    const explain = fake.compileExplain(ast, "all", undefined, { analyze: true, format: "json" });
    expectTypeOf(explain).toEqualTypeOf<CompiledQuery>();
    void fake.execute(plan.sql, [], { statementName: "user_by_email", slots: plan.slots });
    // @ts-expect-error not an explain format
    fake.compileExplain(ast, "all", undefined, { format: "yaml" });
    // @ts-expect-error the options are required
    fake.compileExplain(ast, "all", undefined);
  });

  test("steps 11 and 12: an event can be matched to its call and redacted parameters are known", () => {
    const slots: ParamSlot[] = [
      { kind: "inline", index: 0, dump: stringType.dump, redact: true },
      { kind: "inline", index: 1, dump: undefined, redact: false },
    ];
    const context = { operation: "insert", source: "users" };
    void fake.execute("insert", ["secret", 1], { slots, context });
    fake.on("query", (event) => {
      expectTypeOf(event.context).toBeUnknown();
      const mine: boolean = event.context === context;
      void mine;
    });
    const masked = (params: readonly unknown[]): unknown[] =>
      params.map((value, i) => (slots[i]?.redact === true ? "**redacted**" : value));
    expectTypeOf(masked).returns.toEqualTypeOf<unknown[]>();
    // @ts-expect-error slots are ParamSlots, not a list of booleans
    void fake.execute("insert", [], { slots: [true, false] });
  });
});
