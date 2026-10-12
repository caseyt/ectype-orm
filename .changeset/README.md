# Changesets

Release notes and version bumps are managed with [changesets](https://github.com/changesets/changesets).
(Not to be confused with Ectype's own changesets, which validate data.)

- Every PR that changes a published package adds a changeset: `pnpm changeset`.
- All packages are versioned together (`fixed` in `config.json`): `ectype` and every
  `@ectype/*` package always share one version number.
- `pnpm version-packages` applies pending changesets and then runs
  `scripts/sync-version.mjs`, which updates the `VERSION` constant in each package.
- Nothing is published yet. Publishing is set up in step 21.
