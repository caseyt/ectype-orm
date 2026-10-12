<!-- Title: "Step NN: <name>". See docs/plan/README.md §9 for the full protocol. -->

## Summary

<!-- What this PR delivers, in a few sentences. Link the step file: docs/plan/NN-name.md -->

## Acceptance

<!-- Copy the step's Acceptance list. Tick a box only if it is true and you verified it; say how. -->

- [ ] …

## Benchmarks

<!-- Numbers for every benchmark added or affected (machine, Node version), or "none: no hot path touched". -->

## Deviations and decisions

<!-- Anything that differs from the step file or the README, and every judgement call. "None" if none. -->

## How to verify locally

```sh
pnpm i && pnpm db:up && pnpm check && pnpm test:integration
```

<!-- Add anything specific to this step. -->

## Checklist (definition of done)

- [ ] Acceptance list complete; no `TODO` without an issue reference; no `any` in public types.
- [ ] No `@ts-ignore`; `@ts-expect-error` only in type tests.
- [ ] Unit, type and (where applicable) integration tests pass; coverage thresholds met.
- [ ] Benchmarks added for hot paths, numbers recorded in the status note.
- [ ] TSDoc on all exports; guide page delivered.
- [ ] `index.ts` exports updated; nothing internal exported.
- [ ] Status note written (`docs/plan/status/NN.md`).
- [ ] Only owned paths touched (or the exception is explained above).
