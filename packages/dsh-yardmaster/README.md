<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# @pakgrou-porg/dsh-yardmaster

A DeepSeek Harness (Cordis) plugin. It makes the Yardmaster data plane the
harness's model adapter, maps the harness's planning/execution structure onto
Yardmaster tiers, and correlates every harness step with a Yardmaster metrics
event. **It does not fork or vendor dsh** and touches only documented extension
points.

## What it registers

| Extension point | What |
| --- | --- |
| `ctx.llm` | Adapter `yardmaster` → data plane on loopback (`:1234/v1`, or `:4000` for Anthropic-preferring routes). Streaming, tool calls, usage. Sets `X-Yardmaster-Tier/-Session/-Agent/-Step`. Never holds a provider key. |
| `agent/pre-step` | Picks the tier hint for the coming step from harness-native structure via the user-patchable `tierPolicy`; records `{tier, rule}` as a `yardmaster/decision` session event. |
| subagent provider | Runs children through the same adapter with `X-Yardmaster-Tier: worker` fixed; fan-out helper turns N independent tasks into N children placed across the cluster in parallel. |
| `ctx.tools` (read-only) | `yardmaster_models`, `yardmaster_status`, `yardmaster_report`. Nothing that changes routing, egress, or providers. |
| `ctx.commands` | `/yardmaster` — prints the last decision trace and session cost, no model turn. |
| `telemetry/*` | Forwards per-step token/cache counts + ids (no content) to the data plane's loopback `metrics.ingest`. |
| Web Client Chat node | Renders `yardmaster/decision` inline: tier, model, node/provider, locality badge, cost. |

It registers **no** `ctx.fs`, `ctx.shell`, `ctx.sandbox`, or `ctx.subprocess`
provider and does not touch approval policy. dsh's `SAFETY.md` governs what the
agent may do on the machine; Yardmaster neither weakens nor claims to enforce it.

## The default tier policy

Implemented and unit-tested in `src/tier-policy.ts` (`src/index.test.ts`). It is
a plain array in the plugin config — a user patch can rewrite it without code.
See `docs/harness.md` for the table and `docs/decisions/0014` / `0015`.

## Install into an existing dsh

```
dsh plugin --profile web add @pakgrou-porg/dsh-yardmaster
```

## Status

**Scaffold.** The tier-policy evaluator and adapter correlation headers are
implemented and tested. The streaming adapter body, subagent fan-out, tool
handlers, the command, and the chat node are tracked by a `blocked` issue.
Compatibility policy: [COMPATIBILITY.md](COMPATIBILITY.md).
