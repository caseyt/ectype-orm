import { CastError } from "egon-orm";
import pg from "pg";
import { describe, expect, test } from "vitest";
import {
  formatTimestamp,
  OID,
  PG_DRIVER_CODECS,
  PG_TYPES,
  parseArrayLiteral,
  parseTimestamp,
} from "./values.js";

const keep = (text: string): string => text;

describe("parseArrayLiteral", () => {
  test.each([
    ["{}", []],
    ["{1,2,3}", ["1", "2", "3"]],
    ["{NULL,null,Null,x}", [null, null, null, "x"]],
    ['{"NULL"}', ["NULL"]],
    ['{"a b","c,d","e\\"f","g\\\\h",""}', ["a b", "c,d", 'e"f', "g\\h", ""]],
    [
      "{{1,2},{3,4}}",
      [
        ["1", "2"],
        ["3", "4"],
      ],
    ],
    ["{{},{}}", [[], []]],
    ["[0:1]={7,8}", ["7", "8"]],
    ['{"{braces}"}', ["{braces}"]],
  ])("%s", (text, expected) => {
    expect(parseArrayLiteral(text, keep)).toEqual(expected);
  });

  test("applies the element function to non-null items only", () => {
    expect(parseArrayLiteral("{1,NULL,3}", (item) => Number(item) * 10)).toEqual([10, null, 30]);
  });

  test("returns text that is not an array literal unchanged", () => {
    expect(parseArrayLiteral("plain", keep)).toBe("plain");
    expect(parseArrayLiteral("[1:2]", keep)).toBe("[1:2]");
    expect(parseArrayLiteral("[1:2]=x", keep)).toBe("[1:2]=x");
  });

  test("an unterminated quoted item ends at the end of the text", () => {
    expect(parseArrayLiteral('{"abc', keep)).toEqual(["abc"]);
    expect(parseArrayLiteral('{"ab\\', keep)).toEqual(["ab"]);
  });
});

describe("parseTimestamp", () => {
  test.each([
    ["2026-10-13 09:30:00", false, "2026-10-13T09:30:00.000Z"],
    ["2026-10-13 09:30:00.123456", false, "2026-10-13T09:30:00.123Z"],
    ["2026-10-13 09:30:00.5", false, "2026-10-13T09:30:00.500Z"],
    ["0001-01-01 00:00:00", false, "0001-01-01T00:00:00.000Z"],
    ["0099-06-01 00:00:00", false, "0099-06-01T00:00:00.000Z"],
    ["9999-12-31 23:59:59.999", false, "9999-12-31T23:59:59.999Z"],
    ["2026-10-13 11:30:00+02", true, "2026-10-13T09:30:00.000Z"],
    ["2026-10-13 04:00:00-05:30", true, "2026-10-13T09:30:00.000Z"],
    ["0001-01-01 00:19:32+00:19:32", true, "0001-01-01T00:00:00.000Z"],
    ["2026-10-13 09:30:00+00", true, "2026-10-13T09:30:00.000Z"],
    ["2026-10-13 09:30:00+05", false, "2026-10-13T09:30:00.000Z"],
    ["2024-02-29 12:00:00", false, "2024-02-29T12:00:00.000Z"],
  ])("%s (with zone: %s) is %s", (text, withZone, iso) => {
    const parsed = parseTimestamp(text, withZone);
    expect(parsed).toBeInstanceOf(Date);
    expect((parsed as Date).toISOString()).toBe(iso);
  });

  test("a BC year counts year 1 BC as year 0", () => {
    const parsed = parseTimestamp("0044-03-15 12:00:00 BC", false) as Date;
    expect(parsed.getUTCFullYear()).toBe(-43);
    expect([parsed.getUTCMonth(), parsed.getUTCDate(), parsed.getUTCHours()]).toEqual([2, 15, 12]);
    expect((parseTimestamp("0001-01-01 00:00:00+00 BC", true) as Date).getUTCFullYear()).toBe(0);
  });

  test("a year beyond 9999 is read", () => {
    expect((parseTimestamp("12345-01-01 00:00:00", false) as Date).getUTCFullYear()).toBe(12_345);
  });

  test("infinity is read as pg reads it, and anything else is returned unchanged", () => {
    expect(parseTimestamp("infinity", true)).toBe(Number.POSITIVE_INFINITY);
    expect(parseTimestamp("-infinity", false)).toBe(Number.NEGATIVE_INFINITY);
    expect(parseTimestamp("13/10/2026", false)).toBe("13/10/2026");
  });
});

describe("formatTimestamp", () => {
  test.each([
    ["2026-10-13T09:30:00.250Z", true, "2026-10-13T09:30:00.250+00"],
    ["2026-10-13T09:30:00.250Z", false, "2026-10-13T09:30:00.250"],
    ["0001-01-01T00:00:00.000Z", true, "0001-01-01T00:00:00.000+00"],
    ["9999-12-31T23:59:59.999Z", false, "9999-12-31T23:59:59.999"],
  ])("%s (with zone: %s) is %s", (iso, withZone, text) => {
    expect(formatTimestamp(new Date(iso), withZone)).toBe(text);
  });

  test("a year before 1 is written with BC, and reads back", () => {
    const date = new Date(0);
    date.setUTCFullYear(-43, 2, 15);
    const text = formatTimestamp(date, true);
    expect(text).toBe("0044-03-15T00:00:00.000+00 BC");
    expect(parseTimestamp(text.replace("T", " "), true)).toEqual(date);
  });

  test("an invalid Date is a CastError", () => {
    expect(() => formatTimestamp(new Date(Number.NaN), true)).toThrow(CastError);
  });

  test("does not depend on the process's time zone", () => {
    const zone = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Chatham";
      expect(formatTimestamp(new Date("2026-03-29T01:00:00.000Z"), true)).toBe("2026-03-29T01:00:00.000+00");
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});

describe("PG_TYPES", () => {
  const parser = (oid: number, format?: "text" | "binary"): ((text: string) => unknown) =>
    PG_TYPES.getTypeParser(oid, format) as (text: string) => unknown;

  test("keeps int8, numeric and date as the text Postgres sends, arrays included", () => {
    expect(parser(OID.int8)("9223372036854775807")).toBe("9223372036854775807");
    expect(parser(OID.numeric)("1.50")).toBe("1.50");
    expect(parser(OID.date)("2026-03-29")).toBe("2026-03-29");
    expect(parser(OID.int8Array)("{1,NULL}")).toEqual(["1", null]);
    expect(parser(OID.numericArray)("{1.5}")).toEqual(["1.5"]);
    expect(parser(OID.dateArray)("{0001-01-01,9999-12-31}")).toEqual(["0001-01-01", "9999-12-31"]);
  });

  test("reads timestamps, arrays included", () => {
    expect(parser(OID.timestamp)("2026-10-13 09:30:00")).toEqual(new Date("2026-10-13T09:30:00Z"));
    expect(parser(OID.timestamptz)("2026-10-13 11:30:00+02")).toEqual(new Date("2026-10-13T09:30:00Z"));
    expect(parser(OID.timestampArray)('{"2026-10-13 09:30:00",NULL}')).toEqual([
      new Date("2026-10-13T09:30:00Z"),
      null,
    ]);
    expect(parser(OID.timestamptzArray)('{"2026-10-13 09:30:00+00"}')).toEqual([
      new Date("2026-10-13T09:30:00Z"),
    ]);
  });

  test("leaves every other type, and binary formats, to pg's own parsers", () => {
    expect(parser(23)).toBe(pg.types.getTypeParser(23));
    expect(parser(OID.date, "binary")).toBe(pg.types.getTypeParser(OID.date, "binary"));
    expect(parser(3802)("[1]")).toEqual([1]);
  });
});

describe("PG_DRIVER_CODECS", () => {
  test("bigint text becomes a bigint; other values pass", () => {
    const read = PG_DRIVER_CODECS.bigint?.fromDb as (value: unknown) => unknown;
    expect(read("-9223372036854775808")).toBe(-9_223_372_036_854_775_808n);
    expect(read(5n)).toBe(5n);
    expect(read(5)).toBe(5);
  });

  test("bigint text that is not a whole number is a CastError", () => {
    const read = PG_DRIVER_CODECS.bigint?.fromDb as (value: unknown) => unknown;
    expect(() => read("1.5")).toThrow(CastError);
  });

  test("a Buffer becomes a plain Uint8Array over the same memory", () => {
    const read = PG_DRIVER_CODECS.binary?.fromDb as (value: unknown) => unknown;
    const buffer = Buffer.from([1, 2, 3]);
    const bytes = read(buffer) as Uint8Array;
    expect(Object.getPrototypeOf(bytes)).toBe(Uint8Array.prototype);
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(bytes.buffer).toBe(buffer.buffer);
    const plain = Uint8Array.of(9);
    expect(read(plain)).toBe(plain);
    expect(read("x")).toBe("x");
  });

  test("JSON is serialised for both json kinds", () => {
    expect(PG_DRIVER_CODECS.json?.toDb?.([1, "a"])).toBe('[1,"a"]');
    expect(PG_DRIVER_CODECS.jsonb?.toDb?.("text")).toBe('"text"');
  });

  test("timestamps are written as UTC text; anything else passes", () => {
    const instant = new Date("2026-10-13T09:30:00.000Z");
    expect(PG_DRIVER_CODECS.timestamptz?.toDb?.(instant)).toBe("2026-10-13T09:30:00.000+00");
    expect(PG_DRIVER_CODECS.timestamp?.toDb?.(instant)).toBe("2026-10-13T09:30:00.000");
    expect(PG_DRIVER_CODECS.timestamptz?.toDb?.("2026")).toBe("2026");
    expect(PG_DRIVER_CODECS.timestamp?.toDb?.(7)).toBe(7);
  });

  test("have no fix for kinds pg already gets right", () => {
    expect(Object.keys(PG_DRIVER_CODECS).sort()).toEqual([
      "bigint",
      "binary",
      "json",
      "jsonb",
      "timestamp",
      "timestamptz",
    ]);
  });
});
