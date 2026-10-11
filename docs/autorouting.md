<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Auto-routing on Strix Halo + two GB10s

How to get requests to the right box automatically: what runs today in the
interim router, and how the remaining Switchyard algorithms map onto this
hardware once the Rust data plane runs them.

## Status

| Feature | Runs today (interim Node router, `YM_DATAPLANE_MODE=router`) | Needs the Rust data plane ([#25](https://github.com/pakgrou-porg/yardmaster/issues/25)/[#26](https://github.com/pakgrou-porg/yardmaster/issues/26)) |
| --- | --- | --- |
| Model-name routing (request `model` = a `[targets.*].id`) | yes | |
| `[routes.default]` `passthrough` | yes | |
| `[routes.default]` `escalation` (weak, then strong **on upstream failure**) | yes | |
| Replica failover between GB10s ([ADR-0029](decisions/0029-node-topology-and-replicas.md)) | yes | |
| Retry with backoff on 429/502/503/529 | yes | |
| `[egress]` gate, decision headers, Metrics tab | yes | |
| Harness model list + default from the capability registry | yes | |
| Named routes (`"model": "<route id>"` selects that route) ([ADR-0030](decisions/0030-interim-classifier-routing.md)) | yes | |
| `random` (weighted, optional `seed`) | yes | |
| `llm_classifier`, capability mode (judge picks weak or strong) | yes | |
| `llm_classifier`, escalation mode | **no**: runs as failure-based weak → strong | yes |
| `stage_router` | **no** | yes |
| `plan_execute` + `[tiers.*]` | **no** | yes |
| PAIR placement (`warm_first`, `vram_aware`) | **no** | yes |

The Console's Validate button accepts every Switchyard route type, because the
config schema is the long-term contract, and warns about the ones the interim
router can't run. A `stage_router`, `plan_execute`, `composite` or
`prefill_router` route only passes through to its `target`; without one,
requests to it fail with `needs a target this router understands`.

## What to configure now

### 1. Describe the hardware and where each model runs

Use [`yardmaster.toml.example`](../deploy/portainer/yardmaster.toml.example)
as the starting point. It declares `[nodes.strix]`, `[nodes.gb10_a]` and
`[nodes.gb10_b]` (with `fabric = "qsfp"` on the GB10s), and gives every
provider a `nodes = [...]` list. Each GB10 runs its own vLLM servers; nothing
is sharded over the QSFP link.

| Node | Models | Targets |
| --- | --- | --- |
| `gb10_b` (`10.116.2.120`) | `qwen3.8-flash-next`, which owns the whole memory pool | `gb10_b_flash_next` |
| `gb10_a` (`10.116.2.56`) | `qwen3.6-35b-a3b` (`:8000`), `gemma-4-12b-utility` (`:8002`) | `gb10_a_qwen_a3b`, `gb10_a_gemma_utility` |
| `strix` (desktop) | small Ollama models: `llama3.2:latest`, `deepseek-r1:32b` by name only | `local_llama32`, `local_r1_32b` |

The Strix Halo is also the desktop (Claude Desktop runs there), so keep its
models small: utility, judge, embeddings. GB10 prefill is much faster, so
agentic and long-context work goes to the GB10s.

### 2. Replicas (optional)

No model is on both GB10s in this layout, so a request naming
`qwen3.8-flash-next` fails while `gb10_b` is down. Declaring the same `id` on
a second target makes it a **replica** (ADR-0029):

```toml,norun
[targets.gb10_a_qwen_a3b]
id = "qwen3.6-35b-a3b"
locality = "lan"
provider = "gb10_a_vllm"

[targets.gb10_b_qwen_a3b]
id = "qwen3.6-35b-a3b"          # same id = replica
locality = "lan"
provider = "gb10_b_vllm"
```

Requests go to the first one declared. If it is down, or still returns
429/503 after retries, they move to the next. A replica the registry last
probed as unreachable is tried last. Failover never moves a request to a cloud
copy of the same id. A replica costs memory on the second box, which
`qwen3.8-flash-next` leaves none of on `gb10_b`.

### 3. Pick the default route

Anything whose `model` is not a declared id (for example `"model": "auto"`)
follows `[routes.default]`. The example stays on the LAN:

```toml,norun
[routes.default]
id = "auto"
type = "escalation"
weak_target = "gb10_b_flash_next"   # gb10_b first
strong_target = "gb10_a_qwen_a3b"   # gb10_a if gb10_b is down or busy

[harness]
default_model = "qwen3.8-flash-next"   # a model id, not a target name
```

The chain is `gb10_b` → `gb10_a`. `escalation` here is **failure-based**, not
quality-based. Clients that must survive a `gb10_b` outage should send
`"model": "auto"` instead of naming `qwen3.8-flash-next`. A cloud model as
`strong_target` is allowed, but it is the only way an unnamed request leaves
the LAN, so make that choice deliberately.

For **quality-based** routing, make the default route an `llm_classifier`
(next section). Keep the failure-based chain reachable as a named route if
you want both:

```toml,norun
[routes.default]
id = "auto"
type = "llm_classifier"
mode = "capability"
classifier_target = "gb10_a_gemma_utility"   # judge on gb10_a
weak_target = "gb10_a_qwen_a3b"              # gb10_a
strong_target = "gb10_b_flash_next"          # gb10_b
base_threshold = 0.6
threshold_step = 0.1

[routes.failover]
id = "failover"                              # "model": "failover"
type = "escalation"
weak_target = "gb10_b_flash_next"
strong_target = "gb10_a_qwen_a3b"
```

### 4. Verify

```bash
curl -s -D- -o /dev/null http://<strix-ip>:11435/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}' \
  | grep -i '^x-yardmaster'
#   x-yardmaster-target: gb10_b_flash_next
#   x-yardmaster-nodes: gb10_b
#   x-yardmaster-failover: 0          (1 = served by the next hop, gb10_a)

curl -s http://<strix-ip>:11435/v1/capabilities | jq '.records[] | {id, reachability, placement}'
```

The Console's **Capabilities** tab shows the same information in its
**placement** column (`✗` on a down replica). The **Metrics** tab shows
`failover_count` per request.

## Routes that run today

In Switchyard, and in this router since ADR-0030, the request's `model` can
name a **route**: `"model": "classified"` runs the route whose `id` is
`"classified"`. A `[targets.*]` id with the same name takes precedence. The
full key reference is in [routing.md](routing.md).

### `llm_classifier`, capability mode: a judge decides per request

A small judge scores each request. Easy requests go to `qwen3.6-35b-a3b` on
`gb10_a`; hard ones go to `qwen3.8-flash-next` on `gb10_b`. Keep
`judge_egress = "deny"` so the classifier never sees a cloud model.

```toml,norun
[routes.classified]
id = "classified"
type = "llm_classifier"
mode = "capability"
classifier_target = "gb10_a_gemma_utility"   # judge on gb10_a
weak_target = "gb10_a_qwen_a3b"
strong_target = "gb10_b_flash_next"
base_threshold = 0.7
threshold_step = 0.1
judge_egress = "deny"
```

How it decides (a port of Switchyard's `llm_task_classifier`): the judge gets
Switchyard's capability-forecaster prompt with the opening user instruction
and the latest user follow-up (text only), and must answer with
`{crux, primary_rule, capability_boundary, p_solve}`. The threshold is
`base_threshold` plus one `threshold_step` for an `uncertain`/`unmatched`
boundary or two for `unsupported`. If `p_solve` is at or above the threshold,
the request goes to `weak_target`; otherwise it goes to `strong_target`. Any
other outcome goes to `strong_target`: a judge that is down, times out
(`YM_ROUTER_JUDGE_TIMEOUT_MS`, default 10 s) or returns malformed JSON.

- The judge call adds latency to every request on the route, so use a fast
  model. Check that it returns valid JSON with
  `curl … -D- | grep x-yardmaster-classifier`. `reason=ambiguous` on every
  request means the judge can't follow the schema, so try a larger judge.
  `local_llama32` on the Strix Halo is a lighter alternative to the 12B
  utility model, if it follows the schema.
- Responses carry `x-yardmaster-classifier: tier=…; p_solve=…; threshold=…;
  rule=…; boundary=…`, and the Metrics tab records `rule=judge:<boundary>`.
  The judge's `crux` (a paraphrase of the prompt) is never logged or returned.
- A remote judge sees every prompt, so `classifier_target` on a `remote`
  target is refused unless `judge_egress = "allow"`.
- `mode = "escalation"` (judge the weak answer, then maybe retry on strong) is
  not ported yet. It runs as failure-based weak → strong.

### `random`: A/B two models

```toml,norun
[routes.ab]
id = "ab"
type = "random"
targets = ["gb10_b_flash_next", "gb10_a_qwen_a3b"]
weights = [3, 1]
```

## Switchyard algorithms that need the data plane

These configs pass validation today, and they are the intended mapping for
this hardware. Add them once the Rust data plane runs them. Tiers are
described in [plan-execute.md](plan-execute.md).

### `stage_router`: cheap model unless the conversation needs more

The router uses conversation-stage signals. `efficient_first` starts on the
efficient model and moves up once confidence drops below the threshold.

```toml,norun
[routes.staged]
id = "staged"
type = "stage_router"
efficient_target = "local_llama32"      # Strix Halo
capable_target = "gb10_b_flash_next"    # gb10_b
picker = "efficient_first"
confidence_threshold = 0.6
recent_turn_window = 3
```

### `plan_execute`: big model plans, fast model executes

```toml,norun
[tiers.planner]
role = "planner"
models = ["qwen3.8-flash-next", "qwen3.6-35b-a3b"]   # gb10_b, then gb10_a

[tiers.worker]
role = "worker"
models = ["qwen3.6-35b-a3b", "qwen3.8-flash-next"]   # gb10_a, then gb10_b

[tiers.judge]
role = "judge"
models = ["gemma-4-12b-utility", "llama3.2:latest"] # gb10_a, then Strix Halo

[routes.plan-execute]
id = "plan-execute"
type = "plan_execute"
planner_tier = "planner"
worker_tier = "worker"
judge_tier = "judge"
escalate_on = ["tool_error", "repeated_failure", "long_context"]
demote_after_plan = true
judge_egress = "deny"
```

Clients can force a tier with `X-Yardmaster-Tier: planner|worker`. This is
the best fit for the DeepSeek Harness: plans go to `qwen3.8-flash-next` on
`gb10_b`, and tool-call loops go to `qwen3.6-35b-a3b` on `gb10_a`.

## Hard limits

- Replica order is declaration order. There is no load- or memory-aware
  balancing until PAIR `vram_aware` placement
  ([#33](https://github.com/pakgrou-porg/yardmaster/issues/33)) exists.
- A model on only one GB10 has no failover by name. Use `"model": "auto"`
  (the default route) or replicate it.
- The router does not start or stop vLLM, or move models between boxes. The
  registry notices model changes within one reconcile interval
  (`YM_CAPABILITIES_RECONCILE_S`, default 60 s).
