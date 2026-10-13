# Changesets

Release notes and version bumps are managed with [changesets](https://github.com/changesets/changesets).
(Not to be confused with Egon's own changesets, which validate data.)

- Every PR that changes a published package adds a changeset: `pnpm changeset`.
- All packages are versioned together (`fixed` in `config.json`): `egon-orm` and every
  `@egon-orm/*` package always share one version number.
- `pnpm version-packages` applies pending changesets and then runs
  `scripts/sync-version.mjs`, which updates the `VERSION` constant in each package.
- Nothing is published yet. Publishing is set up in step 21.
