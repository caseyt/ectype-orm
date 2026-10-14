# 0004 — A validator function's result that is not a list throws

- **Status:** accepted (2026-10-14, by the owner)
- **Date:** 2026-10-14
- **Step:** 06 (an open question from its review, decided after the merge)
- **Affects:** the documented behaviour of `ValidatorResult` and `ValidatorFn` in
  `packages/core/src/contracts/changeset.ts`; `validate`, `validateAsync`,
  `validateField` and `validateFieldAsync` (`packages/core/src/changeset/validators/`);
  decision 10 of `docs/plan/status/06.md`; the guide page `validation.md`

## Context

A validator function returns `readonly ValidationIssue[] | void`, or a promise of it. The
contract's TSDoc said that code receiving such a result "treats anything that is not an
array as no issues", and step 06 implemented exactly that (its decision 10). The review of
step 06 found the consequence: a function that returns a single issue, having forgotten
the brackets, or a message string, leaves the changeset **valid**:

```ts
cs.validate(() => ({ path: "email", message: "is taken" })); // valid
cs.validate(() => "is taken");                               // valid
```

The type checker rejects both returns when the function is typed against `ValidatorFn`,
but not when the function comes from JavaScript, from code typed loosely (`any`, a cast,
a helper returning `unknown`), or from an async function whose promise type was widened.
In all those cases the mistake is silent, and the failure it causes (invalid data
accepted) is the one a validator exists to prevent. Step 06 left the question to the
owner because the answer changes the contract's documented behaviour.

The rest of the validator code already refuses malformed input loudly: an element of the
array that is not `{ message: string, … }`, a bad path, a non-object `meta`, or a Standard
Schema result of the wrong shape each throw a `TypeError`.

## Options

1. **Keep the rule: anything that is not an array means no issues.** No change. A
   forgotten pair of brackets passes validation without a trace.
2. **Throw a `TypeError` for any result other than an array or nothing.** The mistake is
   reported at the first run, with a message that says what was returned and what is
   expected. Code that returned some other value on purpose to mean "no issues" (a
   `true`, a `0`) breaks; the contract's type never allowed that.
3. **Read a single issue as a list of one, and a string as an issue on the record.**
   Forgiving, but it makes two shapes legal that the type does not describe, and a string
   has no field to go on.

## Decision

**Option 2**, decided by the owner on 2026-10-14.

A validator function given to `validate`, `validateAsync`, `validateField` or
`validateFieldAsync` may return, or resolve to:

- an **array** (an `Array.isArray` value) of issues, empty or not;
- **nothing**: `undefined`, which is what a function without a `return` gives;
- **`null`**, which untyped code commonly returns for "nothing". The contract's type does
  not include `null`; the run time keeps accepting it as before.

Anything else throws a `TypeError` (from the async forms, the promise rejects with it).
The message names the method, shows an example of a valid result and says what was
returned: for an object with a string `message`, that it is a single issue and must be
put in an array; for a string, the string (shortened past 60 characters); for a number,
bigint or boolean, the value; otherwise its kind.

```
validate(): a validator function must return an array of issues, such as
[{ path: "email", message: "is invalid" }], or nothing, but it returned a single issue,
not an array. Put it in an array: return [issue].
```

Standard Schemas are not affected: their result shape is defined by the Standard Schema
specification and was already checked.

## Consequences

- The TSDoc of `ValidatorResult`, `ValidatorFn`, `FieldValidatorFn` and the four
  `Changeset` methods says what is accepted and what throws. The contract's type is
  unchanged.
- The guide page states the rule and adds it to its "Good to know" box.
- `docs/plan/status/06.md` records this under "Owner decisions after merge"; its
  decision 10 is superseded.
- The check runs only after `Array.isArray` has failed, so the passing path costs nothing
  more (the function-validator benchmark stays at about 85 ns).
- A validator that returned some other value to mean "no issues" now throws at its first
  run. Such code did not type-check against the contract.
