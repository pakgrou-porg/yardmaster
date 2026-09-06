<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 10. Judge and classifier calls obey the primary request's locality

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

`llm_classifier` and `escalation` routes make judge/classifier calls that carry
prompt content. Specification 1.3: judge models "are never allowed to leave the
local network unless the route explicitly sets judge_egress = 'allow'."
Specification section 4 requires a test that "a route with a remote judge and
allow_remote = false fails config validation."

## Decision

Judge and classifier calls go through placement and egress translation like any
other request. Their effective locality ceiling is the stricter of the primary
request's locality and the route's `judge_egress` (default `deny`, meaning
cluster/LAN only). A route referencing a `remote` judge target requires both
`[egress] allow_remote = true` and `judge_egress = "allow"`; otherwise config
validation fails.

## Alternatives considered

- **Let judges inherit `allow_remote` implicitly** — a user enabling one remote
  worker tier would silently start sending judge prompts off-LAN too.
- **Always keep judges local** — too restrictive for users who deliberately want
  a strong remote judge; make it explicit instead.

## Consequences

Judge prompts never leave the LAN by accident. `judge_egress` is a per-route
knob documented in `docs/routing.md` and `docs/plan-execute.md`.
