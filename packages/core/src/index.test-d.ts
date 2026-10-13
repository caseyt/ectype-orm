import { expectTypeOf, test } from "vitest";
import type {
  AnyFieldType,
  AppTypeOf,
  CastResult,
  Codec,
  DbType,
  DbTypeKind,
  DbTypeOf,
  FieldType,
  TypeDefinition,
} from "./index.js";
import { defineType, parameterized, VERSION } from "./index.js";

test("VERSION is a string, not any", () => {
  expectTypeOf(VERSION).toBeString();
  expectTypeOf(VERSION).not.toBeAny();
});

test("a custom type can be written against the public entry point alone", () => {
  const cast = (input: unknown): CastResult<string> =>
    typeof input === "string"
      ? { success: true, data: input.toLowerCase() }
      : { success: false, message: "is not a slug" };
  const db: DbType = { kind: "text" };
  const kind: DbTypeKind = db.kind;
  const definition: TypeDefinition<string> = { name: "slug", db, cast };
  const slug = defineType(definition);
  expectTypeOf(slug).toEqualTypeOf<FieldType<string, string>>();
  expectTypeOf<AppTypeOf<typeof slug>>().toEqualTypeOf<string>();
  expectTypeOf<DbTypeOf<typeof slug>>().toEqualTypeOf<string>();
  expectTypeOf(slug).toExtend<AnyFieldType>();
  expectTypeOf(kind).not.toBeAny();

  const sized = parameterized((options: { readonly max: number }) =>
    defineType<string>({ name: `slug(${options.max})`, db, cast }),
  );
  expectTypeOf(sized({ max: 40 })).toEqualTypeOf<FieldType<string, string>>();
  expectTypeOf<Codec["fromDb"]>().toEqualTypeOf<(value: unknown) => unknown>();
});
