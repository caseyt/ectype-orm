# Egon ORM

A TypeScript ORM with **schemas**, **changesets**, a composable **query builder** and a
**repo**, typed end to end with no code generation.

> **Status: under construction.** Nothing is published and there is no usable API yet.
> The design and build plan live in [`docs/plan/README.md`](docs/plan/README.md).

## Packages

| Package | Purpose | State |
|---|---|---|
| `egon-orm` | Schemas, types, changesets, queries, Repo | placeholder |
| `@egon-orm/postgres` | PostgreSQL adapter (tier 1) | placeholder |
| `@egon-orm/zod` | Derive Zod schemas from Egon ORM schemas | placeholder |
| `@egon-orm/sqlite`, `@egon-orm/mysql` | Tier 2 adapters | private placeholders |
| `@egon-orm/cli` | Migrations and generators | private placeholder (follow-up) |

## Development

Requires Node.js 22.12 or newer, pnpm 12 and Docker.

```sh
pnpm i
pnpm db:up              # Postgres 16 on localhost:54329
pnpm check              # lint + typecheck + unit tests + type tests + build
pnpm test:integration   # needs the database
pnpm bench              # micro-benchmarks
pnpm docs:dev           # documentation site
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for everything else.

## License

[MIT](LICENSE)
