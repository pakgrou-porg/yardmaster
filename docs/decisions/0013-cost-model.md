<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 13. Cost model: provider pricing, else config, else notional local cost

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

Specification 1.8 "Cost model": providers supply per-model USD/million tokens
from their `/models` responses where available (OpenRouter does), otherwise from
`[providers.<name>.pricing]` in the config; local models are costed at
`[metrics] local_cost_usd_per_million_tokens` (default 0).

## Decision

`crates/yardmaster-cost` holds a pricing table resolved in this order: (1)
provider `/models` pricing (cached 24 h for OpenRouter); (2)
`[providers.<name>.pricing]` overrides; (3) for cluster/LAN models,
`[metrics] local_cost_usd_per_million_tokens` (default `0`, so local is free
unless the user assigns a notional electricity/amortization cost). Every metrics
event carries the estimate. Daily rollups sum by provider, tier, and route.
Budgets (`budget_usd_per_day` per provider per node) are checked **before
dispatch**: a request whose estimated cost would exceed the remaining daily
budget is not sent and the route falls to its next tier; the UI shows the
exhaustion.

## Alternatives considered

- **Charge local models a fixed non-zero rate** — imposes a number the user did
  not choose; default 0 with an opt-in knob is neutral.
- **Enforce budgets after the fact** — the spend has already left; section 4
  requires pre-dispatch enforcement.

## Consequences

Savings estimates in reports compare actual cost against "everything on the most
expensive tier used" and "everything on the cheapest". A missing price for a
remote model is a validation warning, not a silent zero.
