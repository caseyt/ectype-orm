# Step 07 — Query AST and expressions

**Depends on:** 02. **Parallel with:** 03, 04, 11.
**Owns:** `packages/core/src/query/ast.ts`, `packages/core/src/query/expr.ts`,
`packages/core/src/query/functions.ts`, `benchmarks/micro/expr.bench.ts`,
`docs/site/guide/query-expressions.md`.

## Goal

The complete AST node set and the typed expression layer: column references, operators,
functions, aggregates, fragments, parameters. This is what users write inside
`.where(...)`, `.select(...)`, `.orderBy(...)` callbacks. No builder methods, no SQL.

Until step 04 lands, test against a minimal fake schema that satisfies `contracts/schema.ts`.

## Public API

```ts
import { and, or, not, count, countDistinct, sum, avg, min, max, coalesce, fragment,
         param, val, lit, now, caseWhen, exists, type Expr } from "ectype";

u.age.gte(18)                         u.email.eq("a@b.c")            u.role.in(["admin", "member"])
u.name.isNull()                       u.name.ilike("%ann%")          u.age.between(18, 65)
u.age.gte(18).and(u.role.eq("admin")) or(a, b, c)                    not(u.banned)
u.loginCount.add(1)                   u.first.concat(" ", u.last)    coalesce(u.name, u.email)
count()                               count(p.id)                    sum(p.views).filter(p.published)
u.settings.path("theme")              p.tags.contains(["ts"])        u.age.cast(types.string)
fragment`lower(${u.email})`.as<string>()                             param("minAge", types.integer)
u.insertedAt.desc().nullsLast()
caseWhen(u.age.lt(18), "minor").else("adult")
```

### `Expr<T>` methods

| Group | Methods |
|---|---|
| Comparison | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `between`, `in`, `notIn`, `isNull`, `isNotNull`, `isDistinctFrom` |
| Boolean (on `Expr<boolean>`) | `and`, `or`, `not` |
| Text (on string) | `like`, `ilike`, `notLike`, `concat`, `lower`, `upper` |
| Arithmetic (on number/bigint) | `add`, `sub`, `mul`, `div`, `mod`, `neg` |
| Array (on arrays) | `contains`, `containedBy`, `overlaps`, `has(element)` |
| JSON (on json/map) | `path(...keys)` → `Expr<unknown>`, `pathText(...keys)` → `Expr<string \| null>` |
| Typing | `cast(ectoType)` (Ecto `type/2`), `as<U>()` (assertion only, no SQL) |
| Ordering | `asc()`, `desc()`, then `.nullsFirst()` / `.nullsLast()` → `OrderExpr` |
| Aggregates only | `filter(cond)`, `over(windowNameOrSpec?)` (window part is step 09) |

Free functions: `and(...xs)`, `or(...xs)` (zero args → `true`/`false` literal), `not`,
aggregates (`count`, `countDistinct`, `sum`, `avg`, `min`, `max`, `arrayAgg`, `jsonAgg`,
`stringAgg`), `coalesce`, `now`, `caseWhen`, `exists(query)`, `val(value, type?)`
(explicit bound parameter), `lit(true | false | null | number)` (inlined literal, restricted
to those safe kinds), `param(name, type)`, `fragment`.

## Behaviour

1. **Representation.** `Expr<T>` is one class holding `{ node: ExprNode, type: EctoType | undefined }`
   with operators on the prototype. `Col<T>` extends it and adds `binding`, `field`. No
   closures per instance, no Proxy. All instances immutable.
2. **Operand rules.** An operand is an `Expr`, or a JS value that becomes a `param` node.
   - The param **inherits the type of the other side** (`u.role.eq("admin")` dumps
     `"admin"` with `role`'s enum type; `u.insertedAt.gt(new Date())` with the datetime
     type). Ecto does the same cast. With no type available the value passes to the driver unchanged.
   - Type-level: the operand must be `NonNullable<T> | Expr<T | null>`. Passing `null` or
     `undefined` to a comparison is a compile error **and** a runtime `QueryError`
     ("comparison with null is always unknown; use isNull()"), as in Ecto.
   - `in([])` compiles to `false`; `notIn([])` to `true`. `in` accepts an array, an
     `Expr` of array type, or a subquery (step 09).
   - Arrays passed to `in` are one param node of kind `list` (the compiler decides between
     `= ANY($1)` and expansion).
3. **Result types.** Comparisons and predicates → `Expr<boolean>`. Arithmetic keeps the
   operand type and propagates `null`. `count` → `number`; `sum`/`avg`/`min`/`max` →
   `T | null`; `sum` over integer stays `number` (document bigint overflow caveat and the
   `cast` escape). `coalesce(a, b)` drops `null` when the last argument is non-null.
   Result types carry an `EctoType` when one is derivable, so results are loaded correctly.
4. **`fragment`.** Tagged template only. Static strings become SQL text, interpolations
   become expressions or params. Calling it as a normal function with a non-template
   argument throws (guard on `strings.raw`). Typed as `Expr<unknown>` until `.as<T>()` or
   `.cast(type)`. Identifiers that must be dynamic use `fragment.ident(name)`, validated
   against `/^[A-Za-z_][A-Za-z0-9_$]*$/` and quoted by the compiler.
5. **Named parameters.** `param(name, type)` creates a placeholder whose value is supplied
   at execution (`repo.all(q, { minAge: 18 })`). Its name and type are tracked at the type
   level so the query's required params object is inferred (plumbed through in step 08).
6. **Shape hash.** Every node contributes to the incremental `shape` hash by kind,
   operator, column identity, and param **type**, never by param **value**. Two expressions
   that differ only in bound values have equal shapes. Decided in `contracts/query.ts`:
   `shape` is length-agnostic, and the lengths of the `list` params are kept beside it in
   `QueryAst.listLengths`, which the compiler adds to the cache key on dialects that expand.
7. **Param collection.** Each `Expr` knows its params in **canonical order** (depth-first,
   node properties in interface declaration order; see `contracts/query.ts`) so that
   builders can splice param arrays without re-walking the tree. Provide
   `collectParams(node, out)`, which defines that order for every node kind including a
   whole `QueryAst`, and test that both agree.
8. **Node set.** Define and export (internally) every node kind needed by steps 08–10:
   column, param, namedParam, list, literal, unary, binary, nary (and/or), fn, aggregate
   (with distinct/filter/over), ident, fragment, cast, case, jsonPath, subquery, exists,
   tuple, order, selectedAs, star. `param`, `list` and `namedParam` carry `redact`, which
   an operand inherits from the field on the other side, like its type. Each with a TSDoc line giving the SQL it stands for.

## Tests

- Type tests: every method on every operand type (accepted and rejected), null rejection,
  result nullability, aggregate result types, `fragment` typing, `param` name/type tracking.
- Unit: node output for each operator (snapshot the AST, not SQL); param typing
  inheritance; empty `in`; runtime null rejection; `fragment` non-template guard;
  identifier validation; immutability (operators never mutate operands).
- Property: shape equality is invariant under changing param values and sensitive to any
  structural change (generate random expression trees, mutate one node).
- Benchmarks: build `a.gte(1).and(b.eq("x"))` (target < 250 ns); `fragment` with three interpolations.

## Docs (`guide/query-expressions.md`)

Operator reference table with the SQL each produces, Ecto equivalents column, null
semantics, aggregates and `filter`, JSON and array operators, fragments and safety,
explicit `val`/`cast`, named parameters.

## Acceptance

- [ ] Full operator table implemented and typed; rejected cases fail to compile.
- [ ] All values end up in `param`/`list` nodes; no code path concatenates a user value into a node's SQL text (grep-level review plus the property test).
- [ ] Shape hash property test passes with 5,000 runs.
- [ ] AST node set documented in `ast.ts` and stable for steps 08–10.

## Out of scope

Query clauses (08). Subquery, window and CTE construction (09), beyond defining their node kinds. SQL text (10).
