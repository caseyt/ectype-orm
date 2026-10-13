# Expressions

Expressions are what you write inside `where`, `select`, `orderBy` and the other clause
callbacks. Operators are methods on columns and on other expressions.

```ts
u.age.gte(18)                          u.email.eq("a@b.c")
u.role.in(["admin", "member"])         u.name.isNull()
u.name.ilike("%ann%")                  u.age.between(18, 65)
u.age.gte(18).and(u.role.eq("admin"))  or(a, b, c)
u.loginCount.add(1)                    coalesce(u.name, u.email)
count(p.id)                            sum(p.views).filter(p.published)
u.createdAt.desc().nullsLast()         caseWhen(u.age.lt(18), "minor").else("adult")
```

## Values are always bound

A JavaScript value passed to an operator becomes a bound parameter. It is never written
into the SQL text.

The value takes the type of the other side: in `u.role.eq("admin")` the string is written
with the type of `role`, and in `u.createdAt.gt(new Date())` with the timestamp type.

## Operators

| Group | Methods | SQL |
|---|---|---|
| Comparison | `eq`, `neq`, `gt`, `gte`, `lt`, `lte` | `=`, `<>`, `>`, `>=`, `<`, `<=` |
| | `between(a, b)` | `BETWEEN a AND b` |
| | `in(list)`, `notIn(list)` | `= ANY($1)`, or `IN (...)` |
| | `isNull()`, `isNotNull()` | `IS NULL`, `IS NOT NULL` |
| | `isDistinctFrom(x)` | `IS DISTINCT FROM` |
| Boolean | `and(x)`, `or(x)`, `not()` | `AND`, `OR`, `NOT` |
| Text | `like`, `notLike`, `ilike` | `LIKE`, `NOT LIKE`, `ILIKE` |
| | `concat(...)`, `lower()`, `upper()` | `\|\|`, `lower()`, `upper()` |
| Number | `add`, `sub`, `mul`, `div`, `mod`, `neg` | `+`, `-`, `*`, `/`, `%`, unary `-` |
| Array | `contains`, `containedBy`, `overlaps` | `@>`, `<@`, `&&` |
| | `has(element)` | `element = ANY(col)` |
| | `append(element)`, `remove(element)` | `array_append`, `array_remove` |
| JSON | `path(...keys)`, `pathText(...keys)` | `#>`, `#>>` |
| Typing | `cast(t.string())` | `CAST(x AS text)` |
| | `as<T>()` | none; changes the TypeScript type only |
| Ordering | `asc()`, `desc()`, then `nullsFirst()` or `nullsLast()` | `ASC`, `DESC`, `NULLS FIRST`, `NULLS LAST` |

Each method exists only on expressions of a fitting type: `ilike` on a number column is a
compile error.

## Functions

| Function | Notes |
|---|---|
| `and(...xs)`, `or(...xs)`, `not(x)` | With no arguments, `and()` is true and `or()` is false. |
| `count()`, `count(x)`, `countDistinct(x)` | `number` |
| `sum(x)`, `avg(x)`, `min(x)`, `max(x)` | `T \| null`: an aggregate over no rows is `NULL`. |
| `arrayAgg(x)`, `jsonAgg(x)`, `stringAgg(x, sep)` | |
| `coalesce(a, b, ...)` | Not nullable when the last argument is not. |
| `now()` | The database's current time. |
| `caseWhen(cond, value).when(...).else(value)` | `CASE WHEN`. |
| `exists(query)` | See [Advanced queries](/guide/queries-advanced#subqueries). |
| `val(value, type?)` | An explicit bound parameter, for where the type cannot be inferred. |
| `lit(true \| false \| null \| number)` | A literal written into the SQL. Restricted to these safe kinds. |
| `param(name, type)` | A [named parameter](/guide/queries#named-parameters). |
| `fragment` | Raw SQL. See [Fragments](#fragments). |

An aggregate takes `.filter(condition)` for `FILTER (WHERE ...)` and `.over(...)` to become
a [window function](/guide/queries-advanced#window-functions).

## Null

Comparing with `null` is rejected: `u.name.eq(null)` is a compile error and throws
`QueryError`. In SQL, `name = NULL` is never true, so the query would silently match
nothing. Use `isNull()` or `isNotNull()`.

The [object form](/guide/queries#object-form) of `where` is the exception: there,
`{ name: null }` means `IS NULL`.

Arithmetic on a nullable column gives a nullable result.

## Lists

```ts
u.id.in([1, 2, 3])        // one array parameter on Postgres: the SQL is the same for any length
u.id.in([])               // false
u.id.notIn([])            // true
u.id.in(subqueryOfIds)
```

## JSON

```ts
u.settings.path("theme")            // Expr<unknown>
u.settings.pathText("theme")        // Expr<string | null>
u.settings.path("a", "b").cast(t.integer())
```

For a typed alternative on embedded schemas, see
[Embeds](/guide/embeds#querying-inside-an-embed).

## Fragments

`fragment` is the only way to write raw SQL. It is a tagged template: the literal parts
become SQL text and every interpolation becomes an expression or a bound parameter.

```ts
fragment`lower(${u.email})`.as<string>()
fragment`similarity(${u.name}, ${search}) > ${0.3}`.as<boolean>()
```

- Calling `fragment` as an ordinary function throws. A string can never become SQL text.
- A fragment's type is `unknown` until you give it one with `.as<T>()` or `.cast(type)`.
- A dynamic identifier goes through `fragment.ident(name)`, which checks it against
  `/^[A-Za-z_][A-Za-z0-9_$]*$/` and quotes it.

## Result types

- Comparisons and predicates are `boolean`.
- Arithmetic keeps the operand's type.
- `sum` over an integer column is a `number`. A sum that can exceed the safe integer range
  should be cast: `sum(p.views).cast(t.bigint())`.
