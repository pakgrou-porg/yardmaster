<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 14. plan_execute is a first-class libsy routing algorithm

- Status: accepted
- Date: 2026-09-06
- Deciders: @pakgrou-porg

## Context

Specification 1.9 requires planner/worker/judge tiering "as a first-class pattern
on top of Switchyard's routing, not as a special case", implemented as a libsy
algorithm `plan_execute` in `crates/yardmaster-plan-execute`, with tiers declared
by `[tiers.<name>]` (role `planner` | `worker` | `judge`, ordered model list,
cost ceiling).

## Decision

`crates/yardmaster-plan-execute` implements the libsy algorithm trait. It
classifies each turn as planning or execution using, in order and stopping at the
first that applies: (1) explicit client hints (`X-Yardmaster-Tier` header, OpenAI
`metadata.yardmaster_tier`, Anthropic `metadata.user_id` suffix `#tier=planner`);
(2) conversation signals reusing Switchyard's `stage_router` signal machinery;
(3) a judge-tier fallback with a bounded prompt (default in
`docs/prompts/plan_execute_judge.md`). It supports `escalate_on = ["tool_error",
"repeated_failure", "long_context"]` and `demote_after_plan = true`. Within a
tier, the first model that is available (cluster/LAN/enabled provider with budget)
and under the cost ceiling is used; the list is a preference order and a fallback
chain. Every decision names the rule that fired in the decision trace.

## Alternatives considered

- **A bespoke non-libsy code path** — would not "serve the embedded and proxy
  cases with the same code" and would sit outside Switchyard's decision tracing.
- **Only client hints, no signals/judge** — many clients cannot set headers.

## Consequences

`examples/plan-execute.toml` is wired to Claude Code and Codex via Switchyard's
launcher, passes config validation in CI, and is the worked example in
`docs/plan-execute.md`. `demote_when_cache_hit_rate_above` (default off) is added
once harness correlation exists (ADR-0015).
