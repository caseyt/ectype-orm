import { runInNewContext } from "node:vm";
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import type { AnyFieldType } from "../contracts/type.js";
import { IDENTITY } from "../contracts/type.js";
import { CastError, SchemaDefinitionError } from "../errors.js";
import { dateType, localTimestampType, timestampType, timeType } from "./temporal.js";

const throwing = new Proxy(
  {},
  {
    get() {
      throw new Error("trap");
    },
    getPrototypeOf() {
      throw new Error("trap");
    },
  },
);
const withThrowingGetter = {
  get year(): number {
    throw new Error("getter");
  },
  month: 1,
  day: 1,
};
class OverriddenDate extends Date {
  override getTime(): number {
    throw new Error("overridden");
  }
}
const dateProxy = new Proxy(new Date(0), {});
const fakeDate = Object.create(Date.prototype);

function label(input: unknown): string {
  if (typeof input === "string")
    return input.length > 40 ? `a ${input.length}-character string` : JSON.stringify(input);
  if (input instanceof Date)
    return Number.isNaN(input.getTime()) ? "an invalid Date" : `Date(${input.toISOString()})`;
  if (typeof input === "object" && input !== null) {
    try {
      return JSON.stringify(input);
    } catch {
      return "a hostile object";
    }
  }
  return String(input);
}

function rejects(type: AnyFieldType, inputs: readonly unknown[]): void {
  const rows = inputs.map((input, i) => {
    let name: string;
    try {
      name = label(input);
    } catch {
      name = `hostile input ${i}`;
    }
    return [name, input] as const;
  });
  test.each(rows)("rejects %s", (_name, input) => {
    expect(type.cast(input)).toEqual({ success: false });
  });
}

const BASE = Date.UTC(2026, 9, 13, 9, 30, 0);

const utc = (...args: [number, number, number, number?, number?, number?, number?]): Date =>
  new Date(Date.UTC(...args));

const NOT_DATES = [
  "2026-02-30",
  "2023-02-29",
  "1900-02-29",
  "2100-02-29",
  "2026-04-31",
  "2026-13-01",
  "2026-00-10",
  "2026-10-00",
  "2026-10-32",
  "0000-01-01",
  "2026-1-5",
  "a026-10-13",
  "2a26-10-13",
  "20a6-10-13",
  "202a-10-13",
  "2026-a0-13",
  "2026-1a-13",
  "2026-10-a3",
  "2026-10-1a",
  "/026-10-13",
  "2/26-10-13",
  "20/6-10-13",
  "202/-10-13",
  "2026-/0-13",
  "2026-1/-13",
  "2026-10-/3",
  "2026-10-1/",
  "2026x10-13",
  "2026-10x13",
  "2026-10-१३",
  "26-10-13",
  "2026/10/13",
  "20261013",
  "2026-10-13T00:00:00Z",
  "2026-10-13 ",
  "+2026-10-13",
  "",
  "today",
  "x".repeat(1_000_000),
  new Date(Number.NaN),
  utc(10000, 0, 1),
  new Date("0000-06-01T00:00:00Z"),
  new Date(-1e15),
  fakeDate,
  dateProxy,
  { year: 2026, month: 10 },
  { year: 2026, month: 2, day: 30 },
  { year: 2026.5, month: 1, day: 1 },
  { year: 2026, month: 1, day: null },
  { year: "x", month: 1, day: 1 },
  { year: 0, month: 1, day: 1 },
  { year: 10000, month: 1, day: 1 },
  {},
  [],
  [2026, 10, 13],
  withThrowingGetter,
  throwing,
  20261013,
  1760313600000,
  true,
  null,
  undefined,
];

describe("date", () => {
  const type = dateType();

  test.each([
    ["2026-10-13", "2026-10-13"],
    ["2024-02-29", "2024-02-29"],
    ["2000-02-29", "2000-02-29"],
    ["0001-01-01", "0001-01-01"],
    ["9999-12-31", "9999-12-31"],
    [utc(2026, 9, 13), "2026-10-13"],
    [utc(2026, 9, 13, 23, 59, 59, 999), "2026-10-13"],
    [new Date("0050-03-01T12:00:00Z"), "0050-03-01"],
    [new Date("0001-01-01T00:00:00Z"), "0001-01-01"],
    [utc(9999, 11, 31, 23, 59), "9999-12-31"],
    [{ year: 2026, month: 10, day: 13 }, "2026-10-13"],
    [{ year: "2026", month: "1", day: "5" }, "2026-01-05"],
    [{ year: 7, month: 3, day: 9 }, "0007-03-09"],
    [{ year: 2024, month: 2, day: 29, hour: 12 }, "2024-02-29"],
    [Object.assign(Object.create(null), { year: 2026, month: 1, day: 2 }), "2026-01-02"],
  ])("accepts %j as %s", (input, expected) => {
    expect(type.cast(input)).toEqual({ success: true, data: expected });
  });

  rejects(type, NOT_DATES);

  test("reads the real timestamp of a Date subclass whose getTime throws", () => {
    expect(type.cast(new OverriddenDate(BASE))).toEqual({ success: true, data: "2026-10-13" });
  });

  test("takes the UTC date of a Date, whatever the local time zone", () => {
    // 23:30 on the 13th in UTC is already the 14th east of UTC and still the 13th west of it.
    expect(type.cast(new Date("2026-10-13T23:30:00Z"))).toEqual({ success: true, data: "2026-10-13" });
    expect(type.cast(new Date("2026-10-13T00:30:00Z"))).toEqual({ success: true, data: "2026-10-13" });
  });

  test("is a date column, read and written as the string", () => {
    expect(type.name).toBe("date");
    expect(type.db).toEqual({ kind: "date" });
    expect(type.fromDb).toBe(IDENTITY);
    expect(type.toDb).toBe(IDENTITY);
    expect(type.equal).toBe(Object.is);
    expect(dateType()).toBe(type);
    expect(dateType({})).toBe(type);
    expect(dateType({ as: "string" })).toBe(type);
  });

  test("rejects an unknown `as`", () => {
    const make = () => dateType({ as: "luxon" } as never);
    expect(make).toThrow(SchemaDefinitionError);
    expect(make).toThrow('as must be "string" or "date", but got "luxon"');
  });
});

describe('date with { as: "date" }', () => {
  const type = dateType({ as: "date" });

  test.each([
    ["2026-10-13", utc(2026, 9, 13)],
    ["2024-02-29", utc(2024, 1, 29)],
    [utc(2026, 9, 13, 23, 59, 59, 999), utc(2026, 9, 13)],
    [{ year: 2026, month: 10, day: 13 }, utc(2026, 9, 13)],
    ["0050-03-01", new Date("0050-03-01T00:00:00Z")],
    ["0004-02-29", new Date("0004-02-29T00:00:00Z")],
  ])("accepts %j as midnight UTC of that day", (input, expected) => {
    const result = type.cast(input);
    expect(result).toEqual({ success: true, data: expected });
    expect((result as { data: Date }).data.getTime()).toBe(expected.getTime());
  });

  rejects(type, NOT_DATES);

  test("reads the stored string as midnight UTC", () => {
    expect(type.fromDb("2026-10-13").getTime()).toBe(Date.UTC(2026, 9, 13));
    expect(type.fromDb("0050-03-01").toISOString()).toBe("0050-03-01T00:00:00.000Z");
    expect(type.fromDb("0004-02-29").toISOString()).toBe("0004-02-29T00:00:00.000Z");
    expect(type.fromDb("9999-12-31").toISOString()).toBe("9999-12-31T00:00:00.000Z");
  });

  test.each(["infinity", "-infinity", "0044-03-15 BC", "2026-10-13T00:00:00Z", "", "abcdefghij"])(
    'throws CastError for the stored value "%s"',
    (stored) => {
      const read = () => type.fromDb(stored);
      expect(read).toThrow(CastError);
      expect(read).toThrow(/not a "YYYY-MM-DD" date.*t\.date\(\)/);
    },
  );

  test("writes the UTC date of a Date", () => {
    expect(type.toDb(utc(2026, 9, 13))).toBe("2026-10-13");
    expect(type.toDb(utc(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(type.toDb(new Date("0050-03-01T00:00:00Z"))).toBe("0050-03-01");
  });

  test("throws CastError when asked to write an invalid Date", () => {
    const write = () => type.toDb(new Date(Number.NaN));
    expect(write).toThrow(CastError);
    expect(write).toThrow("An invalid Date cannot be written to a date column.");
  });

  test.each([
    ["the year 10000", new Date("+010000-01-01T00:00:00Z")],
    ["the year 0", new Date("0000-06-01T00:00:00Z")],
    ["a year before 0", new Date(-1e14)],
    ["the last instant before year 1", new Date(new Date("0001-01-01T00:00:00Z").getTime() - 1)],
  ])("throws CastError when asked to write a Date in %s, which it could not read back", (_label, date) => {
    const write = () => type.toDb(date);
    expect(write).toThrow(CastError);
    expect(write).toThrow("outside the years 1 to 9999");
  });

  test("writes the first and the last day it accepts, at any time of day", () => {
    expect(type.toDb(new Date("0001-01-01T00:00:00Z"))).toBe("0001-01-01");
    expect(type.toDb(new Date("9999-12-31T23:59:59.999Z"))).toBe("9999-12-31");
    expect(type.fromDb(type.toDb(new Date("9999-12-31T23:59:59.999Z"))).toISOString()).toBe(
      "9999-12-31T00:00:00.000Z",
    );
  });

  test("is a date column whose values are Dates, compared by timestamp", () => {
    expect(type.name).toBe("date(date)");
    expect(type.db).toEqual({ kind: "date" });
    expect(type.equal(utc(2026, 9, 13), utc(2026, 9, 13))).toBe(true);
    expect(type.equal(utc(2026, 9, 13), utc(2026, 9, 14))).toBe(false);
    expect(dateType({ as: "date" })).toBe(type);
  });
});

describe("time", () => {
  const type = timeType();

  test.each([
    ["09:30", "09:30:00"],
    ["00:00", "00:00:00"],
    ["23:59:59", "23:59:59"],
    ["00:00:00.5", "00:00:00.5"],
    ["12:00:00.123456", "12:00:00.123456"],
    ["12:00:00.500000", "12:00:00.5"],
    ["12:00:00.000", "12:00:00"],
    ["12:00:00.010", "12:00:00.01"],
  ])("accepts %s as %s", (input, expected) => {
    expect(type.cast(input)).toEqual({ success: true, data: expected });
  });

  rejects(type, [
    "24:00",
    "12:60",
    "12:00:60",
    "9:30",
    "09:3",
    "12",
    "12:00:00.",
    "12:00:00.1234567",
    "12:00.5",
    "12:00Z",
    "12:00:00+02",
    "12:00 PM",
    " 12:00",
    "12:00\n",
    "",
    "x".repeat(1_000_000),
    930,
    new Date(0),
    { hour: 9, minute: 30 },
    null,
    undefined,
  ]);

  test("is a time column, read and written without conversion", () => {
    expect(type.name).toBe("time");
    expect(type.db).toEqual({ kind: "time" });
    expect(type.fromDb).toBe(IDENTITY);
    expect(type.toDb).toBe(IDENTITY);
    expect(timeType()).toBe(type);
  });
});

const NOT_TIMESTAMPS = [
  "2026-10-13",
  "2026-02-30T00:00:00Z",
  "2026-13-01T00:00:00Z",
  "0000-01-01T00:00:00Z",
  "2026-10-13T24:00:00Z",
  "2026-10-13T09:60:00Z",
  "2026-10-13T09:30:60Z",
  "2026-10-13T09:30:00.Z",
  "2026-10-13T09:30:00+24:00",
  "2026-10-13T09:30:00+02:60",
  "2026-10-13T09:30:00+2",
  "2026-10-13T09:30:00+02:0",
  "2026-10-13T09:30:00 Z",
  "2026-10-13T09:30:00 UTC",
  "2026-10-13T9:30:00Z",
  "2026-10-13T09Z",
  "2026-10-13_09:30:00Z",
  " 2026-10-13T09:30:00Z",
  "Tue, 13 Oct 2026 09:30:00 GMT",
  "October 13, 2026",
  "now",
  "",
  `2026-10-13T09:30:00.${"1".repeat(60)}Z`,
  "x".repeat(1_000_000),
  new Date(Number.NaN),
  fakeDate,
  dateProxy,
  throwing,
  {},
  [],
  { year: 2026, month: 10, day: 13 },
  BASE,
  0,
  true,
  null,
  undefined,
];

describe("timestamp", () => {
  const type = timestampType();

  test.each([
    ["2026-10-13T09:30:00Z", BASE],
    ["2026-10-13T09:30:00.000Z", BASE],
    ["2026-10-13T09:30Z", BASE],
    ["2026-10-13t09:30:00z", BASE],
    ["2026-10-13 09:30:00Z", BASE],
    ["2026-10-13T11:30:00+02:00", BASE],
    ["2026-10-13T11:30:00+0200", BASE],
    ["2026-10-13T11:30:00+02", BASE],
    ["2026-10-13T04:00:00-05:30", BASE],
    ["2026-10-13T04:00:00-0530", BASE],
    ["2026-10-13T09:30:00+00:00", BASE],
    ["2026-10-13T09:30:00-00:00", BASE],
    ["2026-10-14T08:30:00+23:00", BASE],
    ["2026-10-13 11:30:00.250+02:00", BASE + 250],
    ["2026-10-13T09:30:00.5Z", BASE + 500],
    ["2026-10-13T09:30:00.123456Z", BASE + 123],
    ["2026-10-13T09:30:00.999999999Z", BASE + 999],
    ["2024-02-29T23:59:59.999Z", Date.UTC(2024, 1, 29, 23, 59, 59, 999)],
    ["1969-12-31T23:59:59Z", -1000],
    ["0050-01-01T00:00:00Z", new Date("0050-01-01T00:00:00Z").getTime()],
    ["0001-01-01T00:00:00+01:00", new Date("0001-01-01T00:00:00Z").getTime() - 3_600_000],
    ["9999-12-31T23:59:59Z", Date.UTC(9999, 11, 31, 23, 59, 59)],
  ])("accepts %s", (input, expected) => {
    const result = type.cast(input);
    expect(result.success).toBe(true);
    expect((result as { data: Date }).data.getTime()).toBe(expected);
  });

  rejects(type, ["2026-10-13T09:30:00", "2026-10-13 09:30", "2026-10-13T09:30:00.250", ...NOT_TIMESTAMPS]);

  test("accepts a Date made in another realm, as a copy", () => {
    const foreign = runInNewContext(`new Date(${BASE})`) as Date;
    expect(foreign instanceof Date).toBe(false);
    const { data } = type.cast(foreign) as { data: Date };
    expect(data).toBeInstanceOf(Date);
    expect(data.getTime()).toBe(BASE);
    expect(dateType().cast(foreign)).toEqual({ success: true, data: "2026-10-13" });
    expect(type.cast(runInNewContext("new Date(NaN)"))).toEqual({ success: false });
  });

  test("an object that only claims to be a Date is rejected", () => {
    expect(type.cast({ [Symbol.toStringTag]: "Date" })).toEqual({ success: false });
    expect(dateType().cast({ [Symbol.toStringTag]: "Date", year: 2026, month: 1, day: 2 })).toEqual({
      success: true,
      data: "2026-01-02",
    });
  });

  test("returns an accepted plain Date as it is", () => {
    const date = new Date(BASE + 123);
    expect(type.cast(date)).toEqual({ success: true, data: date });
    expect((type.cast(date) as { data: Date }).data).toBe(date);
    const farFuture = new Date(8.64e15);
    expect((type.cast(farFuture) as { data: Date }).data).toBe(farFuture);
  });

  test("copies an instance of a Date subclass into a plain Date, even one whose getTime throws", () => {
    for (const input of [new OverriddenDate(BASE), new (class Stamp extends Date {})(BASE)]) {
      const { data } = type.cast(input) as { data: Date };
      expect(Object.getPrototypeOf(data)).toBe(Date.prototype);
      expect(data.getTime()).toBe(BASE);
      expect(type.equal(data, new Date(BASE))).toBe(true);
    }
  });

  test("is a timestamptz column, read and written as the Date, compared by timestamp", () => {
    expect(type.name).toBe("timestamp");
    expect(type.db).toEqual({ kind: "timestamptz" });
    expect(type.fromDb).toBe(IDENTITY);
    expect(type.toDb).toBe(IDENTITY);
    expect(type.equal(new Date(5), new Date(5))).toBe(true);
    expect(type.equal(new Date(5), new Date(6))).toBe(false);
    expect(timestampType()).toBe(type);
    expect(timestampType({})).toBe(type);
    expect(timestampType({ precision: "ms" })).toBe(type);
  });

  test('{ precision: "s" } drops the milliseconds of accepted input', () => {
    const seconds = timestampType({ precision: "s" });
    expect(seconds.name).toBe("timestamp(s)");
    expect(seconds.db).toEqual({ kind: "timestamptz" });
    expect(seconds.fromDb).toBe(IDENTITY);
    expect(seconds.toDb).toBe(IDENTITY);
    expect(timestampType({ precision: "s" })).toBe(seconds);

    const withMillis = new Date(BASE + 999);
    const cast = seconds.cast(withMillis) as { data: Date };
    expect(cast.data.getTime()).toBe(BASE);
    expect(cast.data).not.toBe(withMillis);
    expect(withMillis.getTime()).toBe(BASE + 999);

    const whole = new Date(BASE);
    expect((seconds.cast(whole) as { data: Date }).data).toBe(whole);
    expect((seconds.cast("2026-10-13T09:30:00.999Z") as { data: Date }).data.getTime()).toBe(BASE);
    // Before 1970 the milliseconds are still dropped towards the earlier second.
    expect((seconds.cast(new Date(-1)) as { data: Date }).data.getTime()).toBe(-1000);
    expect((seconds.cast("1969-12-31T23:59:59.250Z") as { data: Date }).data.getTime()).toBe(-1000);
    expect(seconds.cast("2026-10-13T09:30:00")).toEqual({ success: false });
    expect(seconds.cast(new Date(Number.NaN))).toEqual({ success: false });
  });

  test('{ precision: "us" } is a type of its own that keeps what a Date holds', () => {
    const micros = timestampType({ precision: "us" });
    expect(micros.name).toBe("timestamp(us)");
    expect(micros).not.toBe(type);
    expect((micros.cast("2026-10-13T09:30:00.123456Z") as { data: Date }).data.getTime()).toBe(BASE + 123);
    const date = new Date(BASE + 7);
    expect((micros.cast(date) as { data: Date }).data).toBe(date);
  });

  test("rejects an unknown precision", () => {
    const make = () => timestampType({ precision: "ns" } as never);
    expect(make).toThrow(SchemaDefinitionError);
    expect(make).toThrow('t.timestamp: precision must be "s", "ms" or "us", but got "ns"');
  });
});

describe("localTimestamp", () => {
  const type = localTimestampType();

  test.each([
    ["2026-10-13T09:30:00", BASE],
    ["2026-10-13 09:30:00", BASE],
    ["2026-10-13T09:30", BASE],
    ["2026-10-13T09:30:00.250", BASE + 250],
    ["2026-10-13T09:30:00.123456", BASE + 123],
    ["0050-01-01T00:00:00", new Date("0050-01-01T00:00:00Z").getTime()],
  ])("accepts %s and reads it as UTC wall time", (input, expected) => {
    const result = type.cast(input);
    expect(result.success).toBe(true);
    expect((result as { data: Date }).data.getTime()).toBe(expected);
  });

  rejects(type, [
    "2026-10-13T09:30:00Z",
    "2026-10-13T09:30:00z",
    "2026-10-13T09:30:00+02:00",
    "2026-10-13T09:30:00-00:00",
    "2026-10-13T09:30:00+02",
    ...NOT_TIMESTAMPS,
  ]);

  test("returns an accepted Date as it is", () => {
    const date = new Date(BASE + 1);
    expect((type.cast(date) as { data: Date }).data).toBe(date);
  });

  test("is a timestamp column, read and written as the Date, compared by timestamp", () => {
    expect(type.name).toBe("localTimestamp");
    expect(type.db).toEqual({ kind: "timestamp" });
    expect(type.fromDb).toBe(IDENTITY);
    expect(type.toDb).toBe(IDENTITY);
    expect(type.equal(new Date(5), new Date(5))).toBe(true);
    expect(type.equal(new Date(5), new Date(6))).toBe(false);
    expect(localTimestampType()).toBe(type);
    expect(type).not.toBe(timestampType());
  });

  test("takes the same precision option as timestamp", () => {
    const seconds = localTimestampType({ precision: "s" });
    expect(seconds.name).toBe("localTimestamp(s)");
    expect((seconds.cast("2026-10-13T09:30:00.999") as { data: Date }).data.getTime()).toBe(BASE);
    expect(localTimestampType({ precision: "us" }).name).toBe("localTimestamp(us)");
    expect(() => localTimestampType({ precision: 3 } as never)).toThrow(
      't.localTimestamp: precision must be "s", "ms" or "us", but got 3',
    );
  });
});

describe("the instant computed from the parts of a string", () => {
  const inRange = fc.date({
    min: new Date("0001-01-01T00:00:00.000Z"),
    max: new Date("9999-12-31T23:59:59.999Z"),
    noInvalidDate: true,
  });

  test("agrees with the engine's own Date for sampled ISO timestamps", () => {
    const timestamp = timestampType();
    const local = localTimestampType();
    fc.assert(
      fc.property(inRange, (date) => {
        const iso = date.toISOString();
        const withZone = timestamp.cast(iso) as { data: Date };
        const withoutZone = local.cast(iso.slice(0, -1)) as { data: Date };
        return withZone.data.getTime() === date.getTime() && withoutZone.data.getTime() === date.getTime();
      }),
      { numRuns: 5000 },
    );
  });

  test("agrees with the engine's own Date for sampled calendar days, through every entry point", () => {
    const asDate = dateType({ as: "date" });
    const asString = dateType();
    fc.assert(
      fc.property(inRange, (date) => {
        const day = date.toISOString().slice(0, 10);
        const midnight = new Date(`${day}T00:00:00.000Z`).getTime();
        return (
          asDate.fromDb(day).getTime() === midnight &&
          asDate.toDb(new Date(midnight)) === day &&
          (asDate.cast(day) as { data: Date }).data.getTime() === midnight &&
          (asString.cast(date) as { data: string }).data === day
        );
      }),
      { numRuns: 5000 },
    );
  });

  test("agrees with the engine's own Date for every one of the 3,652,059 days from year 1 to 9999", () => {
    const asDate = dateType({ as: "date" });
    const first = new Date("0001-01-01T00:00:00.000Z").getTime();
    const last = new Date("9999-12-31T00:00:00.000Z").getTime();
    const day = new Date(first);
    let count = 0;
    let mismatches = 0;
    for (let time = first; time <= last; time += 86_400_000) {
      day.setTime(time);
      const text = day.toISOString().slice(0, 10);
      if (asDate.fromDb(text).getTime() !== time || asDate.toDb(day) !== text) mismatches++;
      count++;
    }
    expect(count).toBe(3_652_059);
    expect(mismatches).toBe(0);
  });

  test("applies an offset of any size and sign", () => {
    const timestamp = timestampType();
    fc.assert(
      fc.property(inRange, fc.integer({ min: -1439, max: 1439 }), (date, offsetMinutes) => {
        const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
        if (shifted.getUTCFullYear() < 1 || shifted.getUTCFullYear() > 9999) return true;
        const absolute = Math.abs(offsetMinutes);
        const two = (n: number) => String(n).padStart(2, "0");
        const zone = `${offsetMinutes < 0 ? "-" : "+"}${two(Math.floor(absolute / 60))}:${two(absolute % 60)}`;
        const result = timestamp.cast(shifted.toISOString().replace("Z", zone)) as { data: Date };
        return result.data.getTime() === date.getTime();
      }),
      { numRuns: 5000 },
    );
  });
});
