<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Planner and worker tiers (`plan_execute`)

The stated use is heavier models for planning and cheaper models for individual
tasks. Yardmaster implements this as a first-class pattern on top of Switchyard's
routing — a `switchyard-libsy` algorithm named `plan_execute`
(`crates/yardmaster-plan-execute`), not a special case. See
[decisions/0014](decisions/0014-plan-execute-algorithm.md).

## Tiers

`[tiers.<name>]` declares a named, ordered list of models with a role:

```toml,norun
[tiers.planner]
role = "planner"
models = ["openrouter/anthropic/claude-opus-5", "venice/qwen3-235b", "qwen4:72b"]
max_cost_usd_per_1k_tokens = 0.05

[tiers.worker]
role = "worker"
models = ["qwen4:12b", "nemotron-3.5-lightning", "openrouter/deepseek/deepseek-v4"]
max_cost_usd_per_1k_tokens = 0.002

[tiers.judge]
role = "judge"
models = ["qwen4:4b"]
```

Within a tier, the **first** model that is currently available (cluster, LAN, or
an enabled provider with budget remaining) and under the cost ceiling is used.
The list is both a preference order and a fallback chain. Tiers are referenced by
routes in place of raw targets.

## Classifying a turn

The algorithm classifies each turn as **planning** or **execution** using, in
order, stopping at the first that applies:

### 1. Explicit client hints

| Mechanism | How | For clients that |
| --- | --- | --- |
| `X-Yardmaster-Tier: planner` (or `worker`) | HTTP header | can set headers (Claude Code, Codex, `curl`) |
| OpenAI `metadata.yardmaster_tier` | request body field | speak OpenAI Chat/Responses and set `metadata` |
| Anthropic `metadata.user_id` suffix `#tier=planner` | appended to `user_id` | speak Anthropic Messages and cannot set headers |

### 2. Conversation signals (reuse Switchyard's `stage_router` machinery)

Marks the turn **planning** when: it is the first user turn with no tool results;
the system prompt mentions planning or decomposition; the previous assistant turn
emitted a plan or a task list; or the latest instruction is an explicit "plan" or
"replan".

Marks the turn **execution** when: it follows a tool result; its latest user
message is a single sub-task; or a tool call is in flight.

### 3. Judge fallback

The judge tier answers "planning or execution" over the last `N` messages with a
bounded prompt. `N` (`judge_recent_turn_window`, default `6`) and the prompt
(`judge_prompt_path`) are configurable; the default prompt is checked in at
[prompts/plan_execute_judge.md](prompts/plan_execute_judge.md). A failed or
unparseable verdict falls to the **worker** tier (local-first) with
`rule = "judge:fallback"`.

## Escalation and demotion

| Key | Effect |
| --- | --- |
| `escalate_on = ["tool_error", "repeated_failure", "long_context"]` | Promotes an execution turn to the planner tier when the named signal fires. `long_context` fires when the session context exceeds the worker tier's smallest model context window. |
| `demote_after_plan = true` | Returns to the worker tier on the turn after a plan is produced. |
| `demote_when_cache_hit_rate_above = 0.9` | Off by default. Uses the harness-reported cache hit rate for the session to prefer the worker tier on long, stable sessions. Requires the DeepSeek Harness integration for the signal. See [decisions/0014](decisions/0014-plan-execute-algorithm.md) for the rationale. |

Every decision names the rule that fired (`hint:header`, `signal:first_user_turn`,
`judge`, `escalate:tool_error`, `demote_after_plan`, ...) in the decision trace,
so the **Jobs** view can show it.

## Worked example: Claude Code

[`../examples/plan-execute.toml`](../examples/plan-execute.toml) is wired to
Claude Code and Codex through Switchyard's launcher. It uses a **local** planner
where one is present and a **provider** planner otherwise, and a worker tier of
**local models only**. It passes config validation in CI.

```bash
# Point Claude Code at the Anthropic ingress and the plan-execute route.
export ANTHROPIC_BASE_URL=http://localhost:4000
export ANTHROPIC_MODEL=plan-execute
claude
```

The first turn (a fresh task, no tool results) classifies as **planning** →
planner tier → placed on whichever node holds `qwen4:72b`, or on the provider
planner if no local planner is available. Each subsequent turn that follows a
tool result classifies as **execution** → worker tier → placed on a node holding
`qwen4:12b`. A tool error promotes the next turn back to the planner tier for one
step, then `demote_after_plan` returns to worker.

## How the DeepSeek Harness improves on this

When the request comes from `dsh`, the harness plugin's `agent/pre-step`
listener decides the tier from **harness-native structure** (root vs subagent,
tool-results-owed, `ctx.goals` changes, `job_*` steps) — a cleaner signal than
the conversation heuristics above — and sets `X-Yardmaster-Tier` accordingly, so
hint mechanism 1 does the work and the judge is rarely needed. See
[harness.md](harness.md).
