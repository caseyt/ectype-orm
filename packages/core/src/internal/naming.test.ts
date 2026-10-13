import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { camelToSnake, memoizeBounded, snakeToCamel } from "./naming.js";

describe("camelToSnake", () => {
  test.each([
    ["createdAt", "created_at"],
    ["id", "id"],
    ["authorId", "author_id"],
    ["passwordHash", "password_hash"],
    ["lockVersion", "lock_version"],
    ["a", "a"],
    ["", ""],
    // acronyms
    ["userID", "user_id"],
    ["HTMLParser", "html_parser"],
    ["parseHTMLString", "parse_html_string"],
    ["ID", "id"],
    ["XMLHttpRequest", "xml_http_request"],
    // digits
    ["address2", "address2"],
    ["address2Line", "address2_line"],
    ["x1Y2Z", "x1_y2_z"],
    ["oauth2Token", "oauth2_token"],
    // leading capital
    ["User", "user"],
    ["UserProfile", "user_profile"],
    // already snake_case, and other characters, pass through
    ["already_snake", "already_snake"],
    ["with_Mixed", "with_mixed"],
    ["_private", "_private"],
    ["$meta", "$meta"],
    ["trailing_", "trailing_"],
    // only ASCII letters have case here
    ["straßeName", "straße_name"],
    ["nameÉtendu", "nameÉtendu"],
  ])("%j -> %j", (input, expected) => {
    expect(camelToSnake(input)).toBe(expected);
  });

  test("never produces an ASCII upper-case letter and is idempotent", () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        const snake = camelToSnake(name);
        expect(snake).not.toMatch(/[A-Z]/);
        expect(camelToSnake(snake)).toBe(snake);
      }),
      { numRuns: 2000 },
    );
  });

  test("returns the same answer from the memo as from a first call", () => {
    const fresh = `memoCheck${"Abc".repeat(3)}`;
    const first = camelToSnake(fresh);
    expect(first).toBe("memo_check_abc_abc_abc");
    expect(camelToSnake(fresh)).toBe(first);
  });

  test("the memo is emptied when it is full, and keeps answering correctly", () => {
    for (let i = 0; i < 5000; i++) expect(camelToSnake(`fieldNumber${i}X`)).toBe(`field_number${i}_x`);
    expect(camelToSnake("fieldNumber0X")).toBe("field_number0_x");
    expect(camelToSnake("createdAt")).toBe("created_at");
  });
});

describe("snakeToCamel", () => {
  test.each([
    ["created_at", "createdAt"],
    ["id", "id"],
    ["author_id", "authorId"],
    ["lock_version", "lockVersion"],
    ["a", "a"],
    ["", ""],
    ["a_b_c", "aBC"],
    // leading and trailing underscores are kept
    ["_private_flag", "_privateFlag"],
    ["__meta", "__meta"],
    ["trailing_", "trailing_"],
    ["_", "_"],
    ["__", "__"],
    // repeated underscores collapse
    ["double__underscore", "doubleUnderscore"],
    // digits and other characters are kept; nothing to upper-case
    ["address_2", "address2"],
    ["oauth2_token", "oauth2Token"],
    ["with_Upper", "withUpper"],
    ["with_émoji", "withémoji"],
    // already camelCase passes through
    ["alreadyCamel", "alreadyCamel"],
  ])("%j -> %j", (input, expected) => {
    expect(snakeToCamel(input)).toBe(expected);
  });

  test("is idempotent", () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        const camel = snakeToCamel(name);
        expect(snakeToCamel(camel)).toBe(camel);
      }),
      { numRuns: 2000 },
    );
  });

  test("the memo is emptied when it is full, and keeps answering correctly", () => {
    for (let i = 0; i < 5000; i++) expect(snakeToCamel(`field_number_${i}_x`)).toBe(`fieldNumber${i}X`);
    expect(snakeToCamel("created_at")).toBe("createdAt");
  });
});

describe("round trip", () => {
  // Conventional camelCase: lower-case words of two or more letters, each later word
  // capitalised. That excludes acronyms, one-letter words (which read as acronyms once
  // capitalised) and a digit directly before a capital.
  const word = fc.stringMatching(/^[a-z]{2,8}$/);
  const camelName = fc
    .tuple(word, fc.array(word, { maxLength: 4 }))
    .map(([first, rest]) => first + rest.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(""));

  test("snakeToCamel reverses camelToSnake for conventional camelCase names", () => {
    fc.assert(
      fc.property(camelName, (name) => {
        expect(snakeToCamel(camelToSnake(name))).toBe(name);
      }),
      { numRuns: 2000 },
    );
  });

  test("camelToSnake reverses snakeToCamel for conventional snake_case names", () => {
    const snakeName = fc.array(word, { minLength: 1, maxLength: 5 }).map((words) => words.join("_"));
    fc.assert(
      fc.property(snakeName, (name) => {
        expect(camelToSnake(snakeToCamel(name))).toBe(name);
      }),
      { numRuns: 2000 },
    );
  });

  test("the documented exceptions do not round-trip", () => {
    expect(snakeToCamel(camelToSnake("userID"))).toBe("userId");
    expect(snakeToCamel(camelToSnake("address2Line"))).toBe("address2Line");
    expect(camelToSnake(snakeToCamel("address_2"))).toBe("address2");
    // One-letter words turn into a run of capitals, which reads as an acronym.
    expect(camelToSnake(snakeToCamel("a_b_c"))).toBe("a_bc");
    expect(snakeToCamel(camelToSnake("aBC"))).toBe("aBc");
  });
});

describe("memoizeBounded", () => {
  test("computes each input once while there is room", () => {
    const calls: string[] = [];
    const upper = memoizeBounded((name) => {
      calls.push(name);
      return name.toUpperCase();
    }, 3);
    expect([upper("a"), upper("b"), upper("a"), upper("c"), upper("b")]).toEqual(["A", "B", "A", "C", "B"]);
    expect(calls).toEqual(["a", "b", "c"]);
  });

  test("never holds more than the limit: it empties itself when full", () => {
    const calls: string[] = [];
    const upper = memoizeBounded((name) => {
      calls.push(name);
      return name.toUpperCase();
    }, 3);
    for (const name of ["a", "b", "c"]) upper(name);
    // The fourth distinct input finds the memo full, so the first three are forgotten.
    expect(upper("d")).toBe("D");
    expect(upper("d")).toBe("D");
    expect(calls).toEqual(["a", "b", "c", "d"]);
    expect(upper("a")).toBe("A");
    expect(calls).toEqual(["a", "b", "c", "d", "a"]);
    // "d" and "a" are held now; "b" is the third entry and fits without emptying.
    upper("b");
    upper("d");
    expect(calls).toEqual(["a", "b", "c", "d", "a", "b"]);
  });

  test("an empty string is a result like any other", () => {
    let calls = 0;
    const blank = memoizeBounded(() => {
      calls += 1;
      return "";
    }, 3);
    expect([blank("x"), blank("x")]).toEqual(["", ""]);
    expect(calls).toBe(1);
  });
});
