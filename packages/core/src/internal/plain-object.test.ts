import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { isPlainObject } from "./plain-object.js";

describe("isPlainObject", () => {
  test.each([
    ["an object literal", { a: 1 }],
    ["an empty object", {}],
    ["an object without a prototype", Object.create(null)],
    ["the result of JSON.parse", JSON.parse('{"a":1}')],
    ["an object literal from another realm", runInNewContext("({ a: 1 })")],
    ["the result of JSON.parse in another realm", runInNewContext("JSON.parse('{\"a\":1}')")],
  ])("%s is plain", (_label, value) => {
    expect(isPlainObject(value as object)).toBe(true);
  });

  class Point {
    x = 1;
  }
  class Bare extends (null as unknown as new () => object) {}
  const overToJson = Object.create(
    Object.assign(Object.create(null), {
      toJSON() {
        return 1;
      },
    }),
  );
  const fakePrototype = Object.assign(Object.create(null), { hasOwnProperty: true });

  test.each([
    ["an array", []],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["a class instance", new Point()],
    ["a class instance from another realm", runInNewContext("new (class Point { x = 1 })()")],
    ["a Date from another realm", runInNewContext("new Date(0)")],
    ["an object created over an ordinary object", Object.create({ inherited: 1 })],
    ["an object created over an object without a prototype", Object.create(Object.create(null))],
    ["an object created over a null-prototype object with a toJSON", overToJson],
    [
      "an object whose prototype only has a hasOwnProperty that is not a function",
      Object.create(fakePrototype),
    ],
    ["the prototype of a class that extends null", Object.create(Bare.prototype)],
    ["a function", () => 1],
  ])("%s is not plain", (_label, value) => {
    expect(isPlainObject(value as object)).toBe(false);
  });
});
