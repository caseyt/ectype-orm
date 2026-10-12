# Changesets

Release notes and version bumps are managed with [changesets](https://github.com/changesets/changesets).
(Not to be confused with Ectype's own changesets, which validate data.)

- Every PR that changes a published package adds a changeset: `pnpm changeset`.
- All packages are versioned together (`fixed` in `config.json`): `ectype` and every
  `@ectype/*` package always share one version number.
- `pnpm version-packages` applies pending changesets and then runs
  `scripts/sync-version.mjs`, which updates the `VERSION` constant in each package.
- Nothing is published yet. Publishing is set up in step 21.

## Known caveat while the version is 0.x

The adapter packages declare `ectype` as a peer dependency (`workspace:^`). Changesets
bumps a package to the next **major** when one of its peer dependencies leaves the declared
range, and under `^0.y.z` every minor bump leaves the range. Because the group is fixed,
a `minor` changeset on a 0.x version therefore takes every package to `1.0.0`.
`onlyUpdatePeerDependentsWhenOutOfRange` is enabled, so this stops happening from 1.0.0 on
(verified: `1.0.0` + minor gives `1.1.0` for all packages). Until then use `patch`
changesets, or settle a pre-release scheme in step 21 before the first publish.
