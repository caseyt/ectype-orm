---
"egon-orm": minor
---

Add the error classes (`EgonError` and its subclasses, each with a stable `code`, and
`isEgonError`) and the `Result` type with `success` and `failure`.

The packages are ESM only: there is no CommonJS build. A CommonJS project loads them with
`require()`, which needs Node 22.12 or newer; `engines.node` is now `>=22.12`.
