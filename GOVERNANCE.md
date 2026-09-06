<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Governance

Yardmaster is, for now, a **single-maintainer project**. Karl Miller
(`@pakgrou-porg`) is the benevolent dictator for life (BDFL): the maintainer has
final say on scope, design, and what merges. This is stated plainly so that
contributors know what to expect; it is not aspirational and it is not a
committee.

## How changes are accepted

1. Open an issue describing the problem and the observable outcome you want.
2. Open a pull request. Every commit is signed off (`git commit -s`, Developer
   Certificate of Origin) and uses Conventional Commits. See
   [CONTRIBUTING.md](CONTRIBUTING.md).
3. CI must pass. The required checks are `rust`, `go`, `desktop`, `harness`,
   `integration`, and `CodeQL` (see `.github/workflows/ci.yml`).
4. The maintainer reviews and merges. Security-sensitive changes follow
   [SECURITY.md](SECURITY.md) instead of a public pull request.

## Vendored trees

`services/` and `desktop/` are vendored from NVIDIA Personal AI Router via
`git subtree`. Changes there follow that project's `AGENTS.md` and
`CONTRIBUTING.md` in addition to this repository's rules, and should be kept
minimal and upstreamable. `patches/switchyard/` follows NVIDIA NeMo Switchyard's
`AGENTS.md`.

## Releases

A release bumps `services/versions.json` where a compiled service changed, the
workspace crate versions, `NOTICE`, `THIRD_PARTY_NOTICES.md`, affected
documentation, and the ADR index, together in one change. Tags are `vX.Y.Z`
(pre-1.0 may use `-alpha.N` / `-beta.N`). Artifact signing and notarization are
out of scope today and the gap is documented in the release notes.

## Amendments

Amend this document through the same pull-request process. If governance moves
beyond a single maintainer, that change lands here first.
