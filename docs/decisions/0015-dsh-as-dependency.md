<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 15. DeepSeek Harness is a pinned npm dependency plus a plugin, never vendored

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

Specification 1.10: dsh "is a pinned npm dependency (@deepseek-ai/dsh, exact
version...), not a vendored tree", MIT-compatible with Apache-2.0, and "all
dsh-facing code lives in one pnpm workspace package, packages/dsh-yardmaster/".
Upstream promises breaking changes.

## Decision

Pin `@deepseek-ai/dsh` at upstream commit
`d347e703908d0406b7a7ef80e3a0e594d86b2215` (which declares `0.1.3-alpha.1`). The
**installable** pin is `0.1.2-rc.1` because `0.1.3-alpha.1` is not published to
npm; see [ADR-0021](0021-dsh-version-pin.md). All integration code is in
`packages/dsh-yardmaster/` (the Cordis plugin) and
`packages/dsh-bundle-yardmaster/` (the bundle + `cordis.patch.yml` + the
`yardmaster-web` / `yardmaster-headless` profile templates). `COMPATIBILITY.md`
states the verified dsh version range. CI runs the plugin's tests against the
pinned version (required) and against `@latest` (allowed to fail, reported as a
PR comment). The plugin uses only documented extension points: an `ctx.llm`
adapter, an `agent/pre-step` listener, a subagent provider, read-only `ctx.tools`,
one `ctx.commands` entry, a `telemetry/*` listener, and a Web Client Chat node.
It registers no `ctx.fs`, `ctx.shell`, `ctx.sandbox`, or `ctx.subprocess`
provider and does not touch approval policy.

## Alternatives considered

- **Vendor or fork dsh** — explicitly a non-goal; upstream's breaking-change
  cadence would make a fork rot fast.
- **Spread dsh code across several packages** — the spec wants one blast-radius
  package for the breakage risk.

## Consequences

A dsh bump is a Dependabot PR gated by the compatibility job. `THIRD_PARTY_NOTICES.md`
reproduces dsh's MIT text. The desktop Agent tab and TUI action launch dsh; dsh
owns sessions, tools, sandboxing, approvals, and the agent loop.
