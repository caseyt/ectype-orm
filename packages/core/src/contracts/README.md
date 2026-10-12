# Contracts

The interfaces the rest of `ectype` is written against. Step 02 froze them so that steps
03 to 18 can be built in parallel without colliding.

**Changing anything here is a contract change**: it needs an ADR (`docs/adr/`) and the
agreement of the steps that consume the file (plan README §9, item 4). Adding a member
that existing code does not have to know about (a new capability flag, a new optional
option) is an addition, not a change, but it is still recorded in the status note of the
step that makes it.

`index.ts` is an internal barrel: modules inside the package import from it. What is
public is decided by `src/index.ts`, and each step exports the contract types that belong
to its feature (step 03 exports `EctoType`, step 04 exports `Row` and `Loaded`, and so on).
Step 02 itself made public only `Result`, `ok`, `err` and the error classes.

## Who implements and who consumes each file

| File | Defines | Implemented by | Consumed by |
|---|---|---|---|
| `type.ts` | `EctoType`, `AnyEctoType`, `CastResult`, `DbType`, `Codec`, `IDENTITY` | 03 (`types/`); 11 and 17 supply `Codec`s through `Adapter.typeOverrides` | 04, 05, 06, 07, 08, 09, 10, 12, 13, 15, 18 |
| `schema.ts` (runtime) | `META`, `ROW`, `FieldMeta`, `AssocMeta`, `EmbedMeta`, `SchemaMeta`, `RowMeta` | 04 (`schema/`) | 05, 06, 07, 08, 09, 10, 12, 13, 14, 15, 16, 18, and `@ectype/zod` (06) |
| `schema.ts` (types) | `FieldBuilder`, `FieldFlags`, `SchemaClass`, `AnySchema`, `Row`, `InsertShape`, `PrimaryKeyOf`, `Assoc`, `AssocKeys`, `Target`, `PreloadSpec`, `Loaded` | 04 (`Schema()`, `t`, `hasMany`, …) | 05, 06, 08, 09, 12, 13, 14, 15, 16 |
| `query.ts` | `QueryAst`, `ExprNode` and every other node, the node rules, parameter order, `shape` | 07 (expression nodes), 08 and 09 (queries) | 10 (compiler), 12, 13, 14 (`select`, `preloads`, `updates`) |
| `adapter.ts` | `Adapter`, `Executor`, `Connection`, `CompiledQuery`, `ParamSlot`, `OutputPlan`, `RowDecoder`, `Capabilities`, events | 10 (`compile*`, plan cache), 11 (everything else, `@ectype/postgres`), 17 (SQLite, MySQL) | 12, 13, 14, 16, 18 |
| `changeset.ts` | `ChangesetError`, `Constraint`, `Action`, `ChangesetLike`, `ValidatorFn`, `ValidationIssue`, `Validator` | 05 (changeset), 06 (validators), 15 (nested) | 13 (constraint matching), 16 (Multi), `errors.ts` |
| `result.ts` | `Result`, `ok`, `err` | here | 05, 13, 15, 16 |
| `standard-schema.ts` | `StandardSchemaV1` and its parts, vendored types | the validator libraries | 06, `@ectype/zod` |

Next to this directory: `../errors.ts` (every error class and its `code`; thrown by all
steps) and `../internal/` (hash, LRU, naming, inspect; used by 04, 05, 07, 08, 10, 11, 12).

## Rules that cut across the files

- **No Kysely type appears here** (`contracts.test.ts` checks it). Kysely is the back end
  behind `Adapter` (ADR 0002) and must stay replaceable.
- **No value in SQL text** (decision D9). A caller's value exists in exactly two places: the
  `value` of a `ParamNode` or `ListNode`, and `QueryAst.params`. A compiled plan
  (`CompiledQuery`) holds no values at all, only `ParamSlot`s that say where each
  placeholder's value comes from.
- **Parameter order is canonical, not historical.** `QueryAst.params` is the values of the
  query's parameter nodes in a depth-first walk in interface declaration order (see the
  module documentation of `query.ts`). The invariant `ast.params` equals
  `collectParams(ast)` is what lets one plan serve every query of the same shape.
- **Identity conversions are the `IDENTITY` function itself**, never a look-alike, so that
  hot paths skip them with a reference check. In a `ParamSlot`, `dump: undefined` means the same.
- **Nodes and metadata are plain objects with a fixed shape.** Every property is assigned,
  in declaration order, with `undefined` for an absent part.
- **`null` never reaches a type.** Callers of `cast`, `load`, `dump` and `equal` handle `null` first.
- **Keys are field names**, not column names, everywhere except where a member is called
  `column` or `source`.

## Refinements made while writing them down

The step file gives the shapes as sketches and asks for refinements to be recorded. The
full list, with reasons, is in `docs/plan/status/02.md` under "Decisions". The ones a
consumer is most likely to trip over:

- `ParamSlot` has four kinds, not two (`list` and `element` exist for arrays), and carries `dump`.
- `CompiledQuery` has `output` (the `OutputPlan`) next to `decoder`.
- `Adapter.execute` and `Adapter.stream` take no connection argument: a `Connection` has
  the same two methods, and both are `Executor`s.
- `Adapter.typeOverrides` is a function from a type to a `Codec`.
- `ValidatorFn` returns `undefined`, not `void`, when it has nothing to report.
- `ConstraintError` exposes the constraint's name as `constraint` (an `Error` already has a `name`).
- The Standard Schema types use flat names (`StandardSchemaV1Issue`) instead of a namespace.

## Open until step 07 merges

Step 07 owns the complete expression node list. The top-level shape of `QueryAst`, the node
rules and the parameter order are frozen now; the **fields of individual expression nodes**
may still be refined by step 07 (it is their first consumer), recorded in its status note.
After step 07 merges they are frozen like the rest. Known open point: `between` has no
node kind of its own.
