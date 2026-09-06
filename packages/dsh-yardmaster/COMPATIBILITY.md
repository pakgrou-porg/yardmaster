<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Compatibility

`@deepseek-ai/dsh` is a developer preview with a stated promise of
compatibility-breaking changes. All Yardmaster code that touches dsh lives in
this package and `../dsh-bundle-yardmaster/` so the blast radius of a break is
contained.

## Verified against

| dsh version | Source | Status |
| --- | --- | --- |
| `0.1.2-rc.1` | npm `latest` dist-tag at bootstrap (2026-09-06) | **pinned / required in CI** |

## The pinned-version discrepancy

Specification section 1.10 asks for a pin "recorded with the upstream SHA". The
pinned upstream commit `d347e703908d0406b7a7ef80e3a0e594d86b2215` declares
`0.1.3-alpha.1` in its `package.json`, but **that version is not published to
npm** (npm has up to `0.1.2-rc.1` / `latest` and `0.1.2-alpha.5` / `alpha`). An
`npm`/`pnpm` dependency must resolve to a published version, so this package
pins the installable **`0.1.2-rc.1`** and records the upstream SHA separately.
See `../../docs/decisions/0021-dsh-version-pin.md`.

## Verified range

`peerDependencies` declares `>=0.1.2-rc.1 <0.2.0`. Widen this only after the
plugin's tests pass against the new version.

## CI

- **Required:** `harness` job installs the pinned `0.1.2-rc.1` and runs
  `pnpm test` for this package and the bundle.
- **Allowed to fail:** `harness-latest` job installs `@deepseek-ai/dsh@latest`,
  runs the same tests with `continue-on-error: true`, and posts the result as a
  PR comment. Dependabot opens the bump PR; the compatibility job decides
  whether it can merge.

## What a break looks like

An extension-point rename, a `SessionEventMap` shape change, a `cordis.patch.yml`
row id change, or an adapter-seam contract change. When `harness-latest` goes
red, update this package against the new version, bump the pin, widen the range,
and note the new verified row above — in one PR.
