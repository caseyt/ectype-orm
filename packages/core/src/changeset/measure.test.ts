import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { codepoints, graphemes, utf8Bytes } from "./measure.js";

describe("measuring strings", () => {
  test("graphemes matches Intl.Segmenter for any string", () => {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    fc.assert(
      fc.property(fc.string({ unit: "grapheme-composite" }), fc.string({ unit: "binary" }), (a, b) => {
        for (const text of [a, b, `${a}\r\n${b}`]) {
          expect(graphemes(text)).toBe([...segmenter.segment(text)].length);
        }
      }),
    );
  });

  test("codepoints matches the string iterator", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (text) => {
        expect(codepoints(text)).toBe([...text].length);
      }),
    );
  });

  test("utf8Bytes matches TextEncoder", () => {
    const encoder = new TextEncoder();
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (text) => {
        expect(utf8Bytes(text)).toBe(encoder.encode(text).length);
      }),
    );
    expect(utf8Bytes("\udc00")).toBe(3);
  });
});
