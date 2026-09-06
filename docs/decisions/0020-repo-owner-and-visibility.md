<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 20. Repository is public under pakgrou-porg

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

The build specification uses the placeholder `<GH_OWNER>` and calls for
`gh repo create <GH_OWNER>/yardmaster --public --license apache-2.0`. The
authenticated GitHub account for this work is `pakgrou-porg`; npm is not
authenticated in the bootstrap environment.

## Decision

`<GH_OWNER>` resolves to `pakgrou-porg`. The repository
`github.com/pakgrou-porg/yardmaster` is created public, Apache-2.0, default
branch `main`. npm-scoped package names use `@pakgrou-porg`. Because npm
publishing is not available during bootstrap, the npm/pnpm publish steps run as
CI dry-runs and real publish is gated on a tag; the gap is tracked by a `blocked`
issue.

## Alternatives considered

- **Private repo, flip later** — Scorecard and Dependabot behave differently on
  private repos and the spec asks for public; the maintainer chose public now.
- **Local-only, no push** — leaves no shared artifact; contradicts the
  end-to-end instruction.

## Consequences

Subtree'd NVIDIA code and the DeepSeek MIT notice are published from the first
push. Branch protection is applied after the bootstrap series is pushed to
`main`, per specification section 2.
