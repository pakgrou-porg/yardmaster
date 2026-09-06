<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 21. dsh version pin: installable 0.1.2-rc.1, upstream SHA declares 0.1.3-alpha.1

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

Specification section 1.10 asks for `@deepseek-ai/dsh` pinned to an "exact
version, recorded with the upstream SHA". The pinned upstream commit
`d347e703908d0406b7a7ef80e3a0e594d86b2215` declares version `0.1.3-alpha.1` in
its `package.json`, but that version is **not published to npm**. As of
2026-09-06, npm has up to `0.1.2-rc.1` (`latest` dist-tag) and `0.1.2-alpha.5`
(`alpha` dist-tag). An npm/pnpm dependency must resolve to a published version.

## Decision

- `packages/dsh-yardmaster` and `packages/dsh-bundle-yardmaster` pin the
  installable **`@deepseek-ai/dsh@0.1.2-rc.1`** (the `latest` dist-tag at
  bootstrap) as an exact `devDependency`, and declare
  `peerDependencies: ">=0.1.2-rc.1 <0.2.0"`.
- The upstream **commit SHA** `d347e703...` and its declared `0.1.3-alpha.1` are
  recorded in `NOTICE`, `THIRD_PARTY_NOTICES.md`, and
  `packages/dsh-yardmaster/COMPATIBILITY.md` as the source-of-truth reference,
  distinct from the installable pin.
- CI's `harness` job (required) uses the installable pin; `harness-latest`
  (allowed to fail) tracks `@deepseek-ai/dsh@latest` and posts its result as a
  PR comment. When `0.1.3-*` (or later) is published and the plugin's tests
  pass against it, bump the pin, widen the range, and record a new verified row
  in `COMPATIBILITY.md` — in one PR.

## Alternatives considered

- **Pin `0.1.3-alpha.1` anyway** — `pnpm install` cannot resolve it; CI would
  never be green.
- **Install dsh from the git SHA** — the spec explicitly says "a pinned npm
  dependency, not a vendored tree"; a git dependency is closer to vendoring and
  loses npm's integrity/version semantics.

## Consequences

The "pinned version" has two values with a documented relationship. The
`harness-latest` job is the early-warning for the gap closing or for a breaking
change landing first.
