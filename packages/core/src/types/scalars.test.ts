import { describe, expect, test } from "vitest";
import type { AnyFieldType, CastResult } from "../contracts/type.js";
import { IDENTITY } from "../contracts/type.js";
import { CastError, SchemaDefinitionError } from "../errors.js";
import {
  bigintType,
  binaryType,
  booleanType,
  decimalType,
  floatType,
  INVALID,
  integerType,
  stringType,
  uuidType,
} from "./scalars.js";

const MAX = Number.MAX_SAFE_INTEGER;
const MIN = Number.MIN_SAFE_INTEGER;
const HUGE = "9".repeat(1_000_000);

/** Asserts the cast succeeded with exactly `expected` (`Object.is`, so 0 is not -0). */
function expectCast(type: AnyFieldType, input: unknown, expected: unknown): void {
  const result = type.cast(input);
  expect(result.success, `cast(${String(input)}) should succeed`).toBe(true);
  expect(Object.is((result as { data: unknown }).data, expected), `cast(${String(input)})`).toBe(true);
}

function expectRejected(type: AnyFieldType, input: unknown): void {
  expect(type.cast(input)).toEqual({ success: false });
}

function describeInput(input: unknown): string {
  if (typeof input === "string")
    return input.length > 40 ? `a ${input.length}-character string` : JSON.stringify(input);
  if (typeof input === "bigint") return `${input}n`;
  if (typeof input === "object" && input !== null) return Object.prototype.toString.call(input);
  return String(input);
}

function table(
  type: AnyFieldType,
  accepted: readonly (readonly [unknown, unknown])[],
  rejected: readonly unknown[],
) {
  test.each(accepted.map(([input, expected]) => [describeInput(input), input, expected] as const))(
    "accepts %s",
    (_label, input, expected) => {
      expectCast(type, input, expected);
    },
  );
  test.each(rejected.map((input) => [describeInput(input), input] as const))(
    "rejects %s",
    (_label, input) => {
      expectRejected(type, input);
    },
  );
}

function expectIdentityCodec(type: AnyFieldType): void {
  expect(type.fromDb).toBe(IDENTITY);
  expect(type.toDb).toBe(IDENTITY);
}

const OBJECTS = [
  {},
  [],
  Object.create(null),
  { toString: () => "42" },
  { valueOf: () => 42 },
  () => 42,
  Symbol("s"),
];

describe("INVALID", () => {
  test("is the frozen failure with no message", () => {
    const failure: CastResult<never> = INVALID;
    expect(failure).toEqual({ success: false });
    expect(Object.isFrozen(failure)).toBe(true);
  });
});

describe("string", () => {
  const type = stringType();
  table(
    type,
    [
      ["", ""],
      ["Ada", "Ada"],
      ["42", "42"],
      [" padded ", " padded "],
    ],
    [42, 0, true, 1n, null, undefined, new String("boxed"), ...OBJECTS],
  );

  test("returns a huge string as it is", () => {
    expectCast(type, HUGE, HUGE);
  });

  test("is text, read and written without conversion, compared with Object.is", () => {
    expect(type.name).toBe("string");
    expect(type.db).toEqual({ kind: "text" });
    expectIdentityCodec(type);
    expect(type.equal).toBe(Object.is);
    expect(stringType()).toBe(type);
  });
});

describe("integer", () => {
  const type = integerType();
  table(
    type,
    [
      [0, 0],
      [-0, 0],
      [42, 42],
      [-7, -7],
      [MAX, MAX],
      [MIN, MIN],
      ["42", 42],
      ["-7", -7],
      ["007", 7],
      ["0", 0],
      ["-0", 0],
      [String(MAX), MAX],
      [String(MIN), MIN],
      [10n, 10],
      [-10n, -10],
      [BigInt(MAX), MAX],
      [BigInt(MIN), MIN],
    ],
    [
      1.5,
      "1.0",
      "1.5",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2 ** 53,
      -(2 ** 53),
      "9007199254740992",
      "-9007199254740992",
      2n ** 53n,
      -(2n ** 53n),
      "",
      "-",
      " 1",
      "1 ",
      "1\n",
      "+1",
      "1e3",
      "0x10",
      "１２",
      "1_000",
      "abc",
      "0".repeat(41),
      HUGE,
      true,
      null,
      undefined,
      [1],
      new Number(1),
      ...OBJECTS,
    ],
  );

  test("is an integer column, read and written without conversion", () => {
    expect(type.name).toBe("integer");
    expect(type.db).toEqual({ kind: "integer" });
    expectIdentityCodec(type);
    expect(type.equal(1, 1)).toBe(true);
    expect(type.equal(1, 2)).toBe(false);
    expect(integerType()).toBe(type);
  });
});

describe("bigint", () => {
  const type = bigintType();
  const INT64_MAX = 2n ** 63n - 1n;
  const INT64_MIN = -(2n ** 63n);
  table(
    type,
    [
      [5n, 5n],
      [0n, 0n],
      [INT64_MAX, INT64_MAX],
      [INT64_MIN, INT64_MIN],
      [42, 42n],
      [-0, 0n],
      [MAX, BigInt(MAX)],
      ["42", 42n],
      ["-42", -42n],
      ["007", 7n],
      ["-0", 0n],
      ["9007199254740993", 9007199254740993n],
      ["9223372036854775807", INT64_MAX],
      ["-9223372036854775808", INT64_MIN],
    ],
    [
      1.5,
      2 ** 53,
      1e20,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      INT64_MAX + 1n,
      INT64_MIN - 1n,
      "9223372036854775808",
      "-9223372036854775809",
      "1.0",
      "",
      "abc",
      "1n",
      "0x10",
      " 1",
      "1".repeat(41),
      HUGE,
      true,
      null,
      undefined,
      ...OBJECTS,
    ],
  );

  test("is a bigint column, read and written without conversion", () => {
    expect(type.name).toBe("bigint");
    expect(type.db).toEqual({ kind: "bigint" });
    expectIdentityCodec(type);
    expect(type.equal(1n, 1n)).toBe(true);
    expect(type.equal(1n, 2n)).toBe(false);
    expect(bigintType()).toBe(type);
    expect(bigintType({})).toBe(type);
    expect(bigintType({ mode: "bigint" })).toBe(type);
  });

  test("rejects an unknown mode", () => {
    const make = () => bigintType({ mode: "string" } as never);
    expect(make).toThrow(SchemaDefinitionError);
    expect(make).toThrow('mode must be "bigint" or "number", but got "string"');
  });
});

describe('bigint with { mode: "number" }', () => {
  const type = bigintType({ mode: "number" });
  table(
    type,
    [
      [42, 42],
      [-0, 0],
      ["42", 42],
      [10n, 10],
      [MAX, MAX],
    ],
    [1.5, 2 ** 53, "9007199254740992", 2n ** 53n, "1.0", "abc", true, null, ...OBJECTS],
  );

  test("is a bigint column whose values are numbers", () => {
    expect(type.name).toBe("bigint(number)");
    expect(type.db).toEqual({ kind: "bigint" });
    expect(type.toDb).toBe(IDENTITY);
    expect(type.fromDb).not.toBe(IDENTITY);
    expect(bigintType({ mode: "number" })).toBe(type);
    expect(type).not.toBe(bigintType());
  });

  test.each([
    [5, 5],
    [5n, 5],
    ["5", 5],
    ["-5", -5],
    [BigInt(MAX), MAX],
    [String(MIN), MIN],
  ])("reads the stored value %s as a number", (stored, expected) => {
    expect(type.fromDb(stored)).toBe(expected);
  });

  test.each([
    ["a digit string beyond the safe range", "9007199254740993"],
    ["a bigint beyond the safe range", 2n ** 60n],
    ["a number beyond the safe range", 2 ** 53],
    ["a negative value beyond the safe range", "-9007199254740992"],
  ])("throws CastError when the stored value is %s, without quoting it", (_label, stored) => {
    const read = () => type.fromDb(stored);
    expect(read).toThrow(CastError);
    expect(read).toThrow(/outside the safe integer range.*t\.bigint\(\)/);
    try {
      read();
    } catch (error) {
      expect((error as Error).message).not.toContain(String(stored).replace("-", ""));
    }
  });
});

describe("float", () => {
  const type = floatType();
  table(
    type,
    [
      [1.5, 1.5],
      [0, 0],
      [-0, -0],
      [Number.MAX_VALUE, Number.MAX_VALUE],
      [Number.MIN_VALUE, Number.MIN_VALUE],
      ["1.5", 1.5],
      ["-2", -2],
      ["+1.5", 1.5],
      ["1e3", 1000],
      ["1E-2", 0.01],
      ["1.5e+2", 150],
      [".5", 0.5],
      ["5.", 5],
      ["007", 7],
    ],
    [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      "NaN",
      "Infinity",
      "-Infinity",
      "",
      ".",
      "e5",
      "abc",
      "1.5.5",
      "1,5",
      "0x10",
      " 1",
      "1 ",
      "1e",
      "1e999",
      "1".repeat(401),
      HUGE,
      1n,
      true,
      null,
      undefined,
      ...OBJECTS,
    ],
  );

  test("is a float column, read and written without conversion", () => {
    expect(type.name).toBe("float");
    expect(type.db).toEqual({ kind: "float" });
    expectIdentityCodec(type);
    expect(floatType()).toBe(type);
  });
});

describe("decimal", () => {
  const type = decimalType();
  table(
    type,
    [
      ["19.99", "19.99"],
      ["19.990", "19.990"],
      ["-0.5", "-0.5"],
      [".5", "0.5"],
      ["-.5", "-0.5"],
      ["5.", "5"],
      ["+1.5", "1.5"],
      ["007.10", "7.10"],
      ["0", "0"],
      ["000", "0"],
      ["-0", "0"],
      ["-0.00", "0.00"],
      ["123456789012345678901234567890.123456789", "123456789012345678901234567890.123456789"],
      [1.5, "1.5"],
      [-1.5, "-1.5"],
      [0, "0"],
      [-0, "0"],
      [42, "42"],
      [0.1 + 0.2, "0.30000000000000004"],
      [1e21, "1000000000000000000000"],
      [-1e21, "-1000000000000000000000"],
      [1.2345e25, "12345000000000000000000000"],
      [1e-7, "0.0000001"],
      [-1.5e-7, "-0.00000015"],
      [1.25e-10, "0.000000000125"],
    ],
    [
      "",
      ".",
      "-",
      "+",
      "-.",
      "1e5",
      "abc",
      "1.2.3",
      "1,5",
      " 1",
      "1 ",
      "--1",
      "NaN",
      "Infinity",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1n,
      true,
      null,
      undefined,
      ...OBJECTS,
    ],
  );

  test("accepts a huge string of digits without choking", () => {
    expectCast(type, HUGE, HUGE);
    expectCast(type, `0${HUGE}`, HUGE);
  });

  test("is a decimal column, read and written without conversion", () => {
    expect(type.name).toBe("decimal");
    expect(type.db).toEqual({ kind: "decimal" });
    expectIdentityCodec(type);
    expect(decimalType()).toBe(type);
  });

  test.each([
    ["1.50", "1.5"],
    ["1", "1.0"],
    ["1", "1.000"],
    ["0", "-0.0"],
    ["0.00", "0"],
    ["001", "1"],
    ["-1.50", "-1.5"],
    ["+2", "2"],
    [".5", "0.50"],
    ["NaN", "NaN"],
  ])("%s equals %s", (a, b) => {
    expect(type.equal(a, b)).toBe(true);
    expect(type.equal(b, a)).toBe(true);
  });

  test.each([
    ["1.5", "1.6"],
    ["1.5", "-1.5"],
    ["1", "10"],
    ["1.05", "1.5"],
    ["NaN", "1"],
    ["NaN", "Infinity"],
  ])("%s does not equal %s", (a, b) => {
    expect(type.equal(a, b)).toBe(false);
    expect(type.equal(b, a)).toBe(false);
  });
});

describe("decimal with a precision and a scale", () => {
  describe("decimal(10, 2)", () => {
    const type = decimalType({ precision: 10, scale: 2 });
    table(
      type,
      [
        ["19.99", "19.99"],
        ["19.994", "19.99"],
        ["19.995", "20.00"],
        ["19.999", "20.00"],
        ["-19.995", "-20.00"],
        ["-19.994", "-19.99"],
        ["1", "1.00"],
        ["1.5", "1.50"],
        ["0.004", "0.00"],
        ["-0.004", "0.00"],
        ["0.005", "0.01"],
        ["9.995", "10.00"],
        ["99999999.99", "99999999.99"],
        ["99999999.994", "99999999.99"],
        ["00000000099999999.99", "99999999.99"],
        [0.1 + 0.2, "0.30"],
        [19.99, "19.99"],
        [1e-7, "0.00"],
      ],
      ["99999999.995", "100000000", "123456789.00", 1e21, "abc", "", Number.NaN],
    );

    test("keeps the decimal column kind and names its options", () => {
      expect(type.name).toBe("decimal(10,2)");
      expect(type.db).toEqual({ kind: "decimal" });
      expectIdentityCodec(type);
      expect(type.equal("1.50", "1.5")).toBe(true);
    });
  });

  describe("decimal(2, 2)", () => {
    table(
      decimalType({ precision: 2, scale: 2 }),
      [
        ["0.99", "0.99"],
        [".5", "0.50"],
        ["0", "0.00"],
      ],
      ["0.999", "1", "1.00"],
    );
  });

  describe("decimal(3) has scale 0", () => {
    table(
      decimalType({ precision: 3 }),
      [
        ["12.4", "12"],
        ["12.5", "13"],
        ["-12.5", "-13"],
        ["0.5", "1"],
        ["0.4", "0"],
        ["-0.4", "0"],
        ["9.5", "10"],
        ["999.4", "999"],
        ["12", "12"],
      ],
      ["999.5", "1000"],
    );
  });

  test("the same options give the same type", () => {
    const type = decimalType({ precision: 10, scale: 2 });
    expect(decimalType({ scale: 2, precision: 10 })).toBe(type);
    expect(decimalType({ precision: 10, scale: 3 })).not.toBe(type);
    expect(decimalType({ precision: 5 })).toBe(decimalType({ precision: 5, scale: 0 }));
    expect(type).not.toBe(decimalType());
  });

  test.each([
    [{ precision: 0 }, /precision must be a whole number from 1 to 1000, but got 0/],
    [{ precision: 1.5 }, /precision must be a whole number/],
    [{ precision: 1001 }, /precision must be a whole number/],
    [{ precision: "10" }, /precision must be a whole number/],
    [{ scale: 2 }, /precision must be a whole number.*undefined/],
    [{ precision: 5, scale: -1 }, /scale must be a whole number from 0 to the precision \(5\), but got -1/],
    [{ precision: 5, scale: 6 }, /scale must be a whole number/],
    [{ precision: 5, scale: 1.5 }, /scale must be a whole number/],
  ])("rejects the options %j", (options, message) => {
    const make = () => decimalType(options as never);
    expect(make).toThrow(SchemaDefinitionError);
    expect(make).toThrow(message);
  });
});

describe("boolean", () => {
  const type = booleanType();
  table(
    type,
    [
      [true, true],
      [false, false],
      ["true", true],
      ["false", false],
      ["1", true],
      ["0", false],
      [1, true],
      [0, false],
      [-0, false],
    ],
    [
      "yes",
      "no",
      "on",
      "TRUE",
      "True",
      "t",
      "",
      " true",
      2,
      -1,
      0.5,
      Number.NaN,
      1n,
      0n,
      null,
      undefined,
      ...OBJECTS,
    ],
  );

  test("is a boolean column, read and written without conversion", () => {
    expect(type.name).toBe("boolean");
    expect(type.db).toEqual({ kind: "boolean" });
    expectIdentityCodec(type);
    expect(booleanType()).toBe(type);
  });
});

describe("uuid", () => {
  const type = uuidType();
  const lower = "6f9619ff-8b86-d011-b42d-00c04fc964ff";
  table(
    type,
    [
      [lower, lower],
      [lower.toUpperCase(), lower],
      ["6F9619ff-8B86-d011-B42D-00c04fc964FF", lower],
      ["00000000-0000-0000-0000-000000000000", "00000000-0000-0000-0000-000000000000"],
    ],
    [
      lower.replaceAll("-", ""),
      `{${lower}}`,
      `urn:uuid:${lower}`,
      lower.slice(0, 35),
      `${lower}0`,
      ` ${lower.slice(1)}`,
      lower.replace("6", "g"),
      "6f9619ff8-b86-d011-b42d-00c04fc964ff",
      "6f9619ff-8b86-d011-b42d-00c04fc964f\n",
      "",
      HUGE,
      42,
      null,
      undefined,
      ...OBJECTS,
    ],
  );

  test("is a uuid column, read and written without conversion", () => {
    expect(type.name).toBe("uuid");
    expect(type.db).toEqual({ kind: "uuid" });
    expectIdentityCodec(type);
    expect(uuidType()).toBe(type);
  });
});

describe("binary", () => {
  const type = binaryType();

  test("accepts a Uint8Array and a Buffer, and returns the same object", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const buffer = Buffer.from([1, 2, 3]);
    const empty = new Uint8Array(0);
    expectCast(type, bytes, bytes);
    expectCast(type, buffer, buffer);
    expectCast(type, empty, empty);
  });

  test.each([
    ["an ArrayBuffer", new ArrayBuffer(4)],
    ["a DataView", new DataView(new ArrayBuffer(4))],
    ["a Uint16Array", new Uint16Array(2)],
    ["an Int8Array", new Int8Array(2)],
    ["an array of numbers", [1, 2, 3]],
    ["a string", "abc"],
    ["a base64 string", "AQID"],
    ["an object that inherits from Uint8Array.prototype", Object.create(Uint8Array.prototype)],
    ["an array-like object", { length: 1, 0: 1 }],
    ["a number", 1],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s", (_label, input) => {
    expectRejected(type, input);
  });

  test("compares by bytes", () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(type.equal(a, a)).toBe(true);
    expect(type.equal(a, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(type.equal(a, Buffer.from([1, 2, 3]))).toBe(true);
    expect(type.equal(new Uint8Array(0), new Uint8Array(0))).toBe(true);
    expect(type.equal(a, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(type.equal(a, new Uint8Array([1, 2]))).toBe(false);
    expect(type.equal(a, new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });

  test("is a binary column, read and written without conversion", () => {
    expect(type.name).toBe("binary");
    expect(type.db).toEqual({ kind: "binary" });
    expectIdentityCodec(type);
    expect(binaryType()).toBe(type);
  });
});
