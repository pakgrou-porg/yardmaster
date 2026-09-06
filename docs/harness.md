<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# DeepSeek Harness as the default agent framework

DeepSeek Harness (`dsh`) is the agent layer that ships on top of Yardmaster.
Yardmaster is the model substrate underneath it. Neither replaces the other's
job:

- **dsh owns** sessions, tools, sandboxing, approvals, the agent loop, and the
  agent UI.
- **Yardmaster owns** which model answers, where it runs, what it costs, and what
  happened.

dsh is a **pinned npm dependency**, never vendored or forked. All dsh-facing code
is in `packages/dsh-yardmaster` (a Cordis plugin) and
`packages/dsh-bundle-yardmaster` (a bundle + profiles). See
[decisions/0015](decisions/0015-dsh-as-dependency.md),
[decisions/0016](decisions/0016-dsh-child-env-stripped.md), and
[decisions/0021](decisions/0021-dsh-version-pin.md).

## Version and compatibility

| | |
| --- | --- |
| Installable pin | `@deepseek-ai/dsh@0.1.2-rc.1` (npm `latest` at bootstrap) |
| Upstream SHA | `d347e703908d0406b7a7ef80e3a0e594d86b2215` (declares an unpublished `0.1.3-alpha.1`) |
| Verified range | `>=0.1.2-rc.1 <0.2.0` |

`packages/dsh-yardmaster/COMPATIBILITY.md` is the source of truth. CI runs the
plugin's tests against the pinned version (**required**) and against
`@deepseek-ai/dsh@latest` (**allowed to fail**, posted as a PR comment).
Dependabot opens the bump PR; the compatibility job decides whether it merges.

## The plugin: `dsh-yardmaster`

Registers, using documented extension points and nothing else:

### `ctx.llm` adapter — `yardmaster`

Speaks to the data plane on loopback (`http://127.0.0.1:1234/v1` by default; the
Anthropic ingress on `:4000` when the route prefers it). Implements the adapter
seam per dsh's `docs/cookbook/adding-an-llm-adapter.md`: streaming, tool calls,
usage reporting, the protocol obligations (emit `usage` before `finish`, raw
JSON tool arguments, first-seen block index order, honor `options.signal`,
`UNSUPPORTED_OPTION` rather than silently dropping an option it cannot pass
through). Sets `X-Yardmaster-Tier`, `X-Yardmaster-Session`, `X-Yardmaster-Agent`,
`X-Yardmaster-Step` on every request. **Never holds a provider API key** —
Yardmaster does. Config exposes `endpoint`, `route`, and `tierPolicy`.

### `agent/pre-step` listener — the tier policy

Decides the tier hint for the coming step from **harness-native structure**,
which is a better signal than the conversation heuristics in `plan_execute`. The
policy is a plain, user-patchable array (`tierPolicy` in the plugin config).
Default (implemented and unit-tested in `src/tier-policy.ts`):

| Rule id | When | Tier |
| --- | --- | --- |
| `root-first-step` | root agent's first step in a turn with no tool results owed | planner |
| `after-goals-change` | a step after a `ctx.goals` change | planner |
| `input-plan-command` | claimed input contains a `plan` / `replan` command | planner |
| `two-tool-failures` | after two consecutive tool failures | planner (one step, then worker) |
| `tools-execute-error` | a `tools/execute` error | planner (one step, then worker) |
| `context-over-worker-window` | session context exceeds the worker tier's smallest context window | planner (one step, then worker) |
| `after-tool-result` | any step following a tool result | worker |
| `inside-subagent` | any step inside a subagent | worker |
| `job-collection-step` | any `job_*` collection step | worker |
| `default-worker` | anything else | worker |

First matching rule wins; `default-worker` guarantees a decision. The chosen
tier and the rule that fired are attached to the step as a
`yardmaster/decision` session event (`SessionEventMap` is extended) so the Web
UI and transcripts show them and the fact survives reload.

**Patching the policy:** override the `tierPolicy` array in the plugin's config
(a user `cordis.patch.yml` layer). No code change needed.

### Subagent provider

Runs child agents through the same adapter with `X-Yardmaster-Tier: worker`
fixed. A fan-out helper turns a plan with N independent tasks into N child agents
that Yardmaster places across the cluster in parallel — the concrete
"distribution" that PAIR's routing exists for.

### `ctx.tools` (read-only)

`yardmaster_models` (cluster + provider inventory with locality),
`yardmaster_status` (nodes, pressure, budgets), `yardmaster_report` (calls
`metrics.report` for a date range). **No** tool changes routing, egress, or
providers — those stay in the Yardmaster UI.

### `ctx.commands` — `/yardmaster`

Prints the last decision trace and the session's cost so far, without spending a
model turn.

### `telemetry/*` listener

Forwards dsh's per-step token and cache statistics to the data plane's
`metrics.ingest` JSON-RPC (loopback, **no content**) so Yardmaster's event for
that step carries the harness's view of tokens, cache hit rate, and turn count
alongside the engine's. Adds `session_id`, `agent_id`, `step_id`, `tier_rule` to
the event schema. Reports gain a per-session section. A canary-key test asserts
only numbers and ids reach `metrics.ingest`.

### Web Client Chat node

Renders `yardmaster/decision` inline: tier, model, node or provider, locality
badge, cost.

### What it does NOT register

No `ctx.fs`, `ctx.shell`, `ctx.sandbox`, or `ctx.subprocess` provider; no
approval-policy change. dsh's `SAFETY.md` governs what the agent may do on the
machine. Yardmaster does not weaken it and does not claim to enforce it.

## The profile: `yardmaster`

`packages/dsh-bundle-yardmaster` declares `dsh.bundle` with a `cordis.patch.yml`
that (1) mounts `dsh-yardmaster` and (2) repoints `agent-default-model` at
`provider: yardmaster`, `model: plan-execute` — and **disables nothing else**.

| Profile template | `dsh.profile.bundles` | `patchReload` |
| --- | --- | --- |
| `yardmaster-web` | `dsh-base`, `dsh-web-app`, `dsh-bundle-yardmaster` | `live` |
| `yardmaster-headless` | `dsh-base`, `dsh-headless`, `dsh-bundle-yardmaster` | `startup` |

Both boot from `dsh --profile <name> --dump-config` without warnings (checked by
CI). `dsh-web-config.reference.yml` in the bundle is the captured `--dump-config`
for the pinned version and is the authoritative list of rows the patch may
target.

### Install into an existing dsh

```
dsh plugin --profile web add @pakgrou-porg/dsh-yardmaster
```

## The Agent tab

The desktop app gains **Agent** as a top-level item beside Overview and Jobs. It
shows whether dsh is installed (a user install is detected and preferred; the
Electron-bundled Node can run it otherwise), a **Start Harness** button that runs
`dsh web --profile yardmaster-web --no-open` under the existing supervisor as a
**non-restarting** child, and an embedded view of `http://127.0.0.1:3080` in a
sandboxed webview (`nodeIntegration` off, `contextIsolation` on, `sandbox` on, a
`will-navigate` handler refusing any non-loopback origin). **Stop** terminates
it. The TUI gets `dsh headless --profile yardmaster-headless` as an action on the
same tab with a prompt argument. The README onboarding gains one step after
"Send a request": **"Start the agent."**

The child process is started only on explicit user action, binds `127.0.0.1`
only, and inherits an environment with `*_API_KEY`, `*_TOKEN`, `*_SECRET`
stripped (tested).

## Metrics feedback into routing

With harness correlation in place, `plan_execute` gains one optional signal:
`demote_when_cache_hit_rate_above = 0.9` uses the harness-reported cache hit rate
for the session to prefer the worker tier on long, stable sessions. **Off by
default**; rationale in [decisions/0014](decisions/0014-plan-execute-algorithm.md).

## Out of scope

No fork of dsh. No reimplementation of its agent loop. No Yardmaster-side
storage of harness session content. No exposure of the dsh Web UI beyond
loopback — LAN access to it is a dsh plugin concern, not Yardmaster's.
