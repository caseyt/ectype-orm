import { afterEach, describe, expect, test, vi } from "vitest";
import type { ParamSlot, QueryEvent } from "../contracts/adapter.js";
import { redactParams, Telemetry } from "./telemetry.js";

const slot = (redact: boolean): ParamSlot => ({ kind: "inline", index: 0, toDb: undefined, redact });

function emitOne(telemetry: Telemetry, slots: readonly ParamSlot[] | undefined = undefined): void {
  telemetry.emitQuery("select $1, $2", ["a", "b"], slots, 1.5, 0.25, 3, undefined, { requestId: 7 });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listener flags", () => {
  test("start false and follow subscriptions per event", () => {
    const telemetry = new Telemetry();
    expect([
      telemetry.query,
      telemetry.queryParams,
      telemetry.connect,
      telemetry.disconnect,
      telemetry.poolExhausted,
    ]).toEqual([false, false, false, false, false]);
    const offQuery = telemetry.on("query", () => undefined, undefined);
    const offParams = telemetry.on("query", () => undefined, { params: true });
    const offConnect = telemetry.on("connect", () => undefined, undefined);
    const offDisconnect = telemetry.on("disconnect", () => undefined, undefined);
    const offExhausted = telemetry.on("poolExhausted", () => undefined, undefined);
    expect([
      telemetry.query,
      telemetry.queryParams,
      telemetry.connect,
      telemetry.disconnect,
      telemetry.poolExhausted,
    ]).toEqual([true, true, true, true, true]);
    offQuery();
    expect(telemetry.query).toBe(true); // the params listener still listens
    offParams();
    expect([telemetry.query, telemetry.queryParams]).toEqual([false, false]);
    offConnect();
    offDisconnect();
    offExhausted();
    expect([telemetry.connect, telemetry.disconnect, telemetry.poolExhausted]).toEqual([false, false, false]);
  });

  test("unsubscribing twice removes one subscription only", () => {
    const telemetry = new Telemetry();
    const seen: string[] = [];
    const listener = (): void => {
      seen.push("x");
    };
    const first = telemetry.on("connect", listener, undefined);
    telemetry.on("connect", listener, undefined);
    first();
    first();
    telemetry.emitPool("connect", { size: 1, idle: 0, waiting: 0 });
    expect(seen).toEqual(["x"]);
  });
});

describe("query events", () => {
  test("carry everything but the parameters when no listener asked for them", () => {
    const telemetry = new Telemetry();
    const events: QueryEvent[] = [];
    telemetry.on("query", (event) => events.push(event), undefined);
    telemetry.on("query", (event) => events.push(event), { params: false });
    emitOne(telemetry);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      sql: "select $1, $2",
      paramCount: 2,
      durationMs: 1.5,
      queueMs: 0.25,
      rowCount: 3,
      error: undefined,
      params: undefined,
      context: { requestId: 7 },
    });
    expect(Object.keys(events[0] ?? {})).toEqual([
      "sql",
      "paramCount",
      "durationMs",
      "queueMs",
      "rowCount",
      "error",
      "params",
      "context",
    ]);
  });

  test("carry redacted parameters only to listeners that asked, in the same shape", () => {
    const telemetry = new Telemetry();
    const plain: QueryEvent[] = [];
    const detailed: QueryEvent[] = [];
    telemetry.on("query", (event) => plain.push(event), undefined);
    telemetry.on("query", (event) => detailed.push(event), { params: true });
    emitOne(telemetry, [slot(false), slot(true)]);
    expect(plain[0]?.params).toBeUndefined();
    expect(detailed[0]?.params).toEqual(["a", "**redacted**"]);
    expect(Object.keys(detailed[0] ?? {})).toEqual(Object.keys(plain[0] ?? {}));
  });

  test("without slots every parameter is redacted", () => {
    expect(redactParams(["a", 1, null], undefined)).toEqual(["**redacted**", "**redacted**", "**redacted**"]);
  });

  test("a parameter without a slot is redacted", () => {
    expect(redactParams(["a", "b"], [slot(false)])).toEqual(["a", "**redacted**"]);
  });

  test("an unsubscribed listener is not called", () => {
    const telemetry = new Telemetry();
    const listener = vi.fn();
    const off = telemetry.on("query", listener, { params: true });
    off();
    emitOne(telemetry);
    expect(listener).not.toHaveBeenCalled();
  });

  test("a listener that unsubscribes another during an emit does not disturb that emit", () => {
    const telemetry = new Telemetry();
    const calls: string[] = [];
    let offSecond: () => void = () => undefined;
    telemetry.on(
      "query",
      () => {
        calls.push("first");
        offSecond();
      },
      undefined,
    );
    offSecond = telemetry.on("query", () => calls.push("second"), undefined);
    emitOne(telemetry);
    emitOne(telemetry);
    expect(calls).toEqual(["first", "second", "first"]);
  });
});

describe("pool events", () => {
  test.each(["connect", "disconnect", "poolExhausted"] as const)(
    "%s reaches its own listeners only",
    (event) => {
      const telemetry = new Telemetry();
      const seen: string[] = [];
      telemetry.on("connect", () => seen.push("connect"), undefined);
      telemetry.on("disconnect", () => seen.push("disconnect"), undefined);
      telemetry.on("poolExhausted", () => seen.push("poolExhausted"), undefined);
      telemetry.emitPool(event, { size: 2, idle: 0, waiting: 1 });
      expect(seen).toEqual([event]);
    },
  );
});

describe("a listener that throws", () => {
  test("does not stop the others, and its error is rethrown on a later microtask", async () => {
    const telemetry = new Telemetry();
    const failure = new Error("listener bug");
    const scheduled: (() => void)[] = [];
    vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
      scheduled.push(callback);
    });
    const after = vi.fn();
    telemetry.on(
      "poolExhausted",
      () => {
        throw failure;
      },
      undefined,
    );
    telemetry.on("poolExhausted", after, undefined);
    expect(() => telemetry.emitPool("poolExhausted", { size: 1, idle: 0, waiting: 1 })).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);
    expect(() => scheduled[0]?.()).toThrow(failure);
  });
});

describe("subscribing wrongly", () => {
  test("an unknown event is a TypeError naming the events", () => {
    const telemetry = new Telemetry();
    expect(() => telemetry.on("queries" as "query", () => undefined, undefined)).toThrow(
      /unknown event\. The events are "query", "connect", "disconnect" and "poolExhausted"/,
    );
  });

  test("a listener that is not a function is a TypeError", () => {
    const telemetry = new Telemetry();
    expect(() => telemetry.on("query", "log" as unknown as () => void, undefined)).toThrow(TypeError);
  });

  test("options on a pool event are a TypeError", () => {
    const telemetry = new Telemetry();
    expect(() => telemetry.on("connect", () => undefined, { params: true })).toThrow(
      /only "query" listeners take options/,
    );
  });
});
