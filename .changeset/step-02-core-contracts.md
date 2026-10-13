---
"ectype": minor
---

Add the error classes (`EctypeError` and its subclasses, each with a stable `code`, and
`isEctypeError`) and the `Result` type with `ok` and `err`.

The packages are ESM only: there is no CommonJS build. A CommonJS project loads them with
`require()`, which needs Node 22.12 or newer; `engines.node` is now `>=22.12`.
