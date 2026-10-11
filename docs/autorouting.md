<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Auto-routing on Strix Halo + two GB10s

How to get requests to the right box automatically, what runs today, and how
the Switchyard algorithms map onto this hardware once the Rust data plane runs
them.

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
| Named routes (`"model": "<route id>"` selecting `[routes.<name>]`) | **no**: only `[routes.default]` is read | yes |
| `random`, `stage_router`, `llm_classifier` (capability / escalation mode) | **no** | yes |
| `plan_execute` + `[tiers.*]` | **no** | yes |
| PAIR placement (`warm_first`, `vram_aware`) | **no** | yes |

The Console's Validate button accepts every Switchyard route type, because the
config schema is the long-term contract. The interim router only reads
`[routes.default]`. If that route's `type` is anything other than
`passthrough` or `escalation`, the router passes through to its `target`. If
there is no `target`, every unmatched request fails with `needs a target this
router understands`. **Do not set `[routes.default]` to `stage_router`,
`llm_classifier` or `plan_execute` yet.**

## What to configure now

### 1. Describe the hardware and declare replicas

Use [`yardmaster.toml.example`](../deploy/portainer/yardmaster.toml.example)
as the starting point. It declares `[nodes.strix]`, `[nodes.gb10_a]` and
`[nodes.gb10_b]` (with `fabric = "qsfp"` on the GB10s), gives every provider a
`nodes = [...]` list, and declares one model on **both** GB10s:

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

A request for `qwen3.6-35b-a3b` goes to `gb10_a`. If `gb10_a` is down, or
still returns 429/503 after retries, the request moves to `gb10_b`. A replica
the registry last probed as unreachable is tried last. Failover never moves a
request to a cloud copy of the same id.

### 2. Split the work across the boxes

Each GB10 runs its own vLLM with its own models (128 GB each); nothing is
sharded over the QSFP link. Two useful patterns, mixable per model:

- **Replicated**: the same model id on both GB10s. Throughput plus failover.
  Use it for the model the Harness and agents hit hardest.
- **Specialized**: different models per GB10, for example a fast mid-size
  model on `gb10_a` and the largest model that fits in 128 GB on `gb10_b`.
  This gives more distinct models online, with no failover for those ids.

The Strix Halo is also the desktop (Claude Desktop runs there), so keep its
Ollama models small: utility, judge, embeddings, and a last-resort fallback.
GB10 prefill is much faster, so put long-context and agentic work there.

### 3. Pick the default route

Anything whose `model` is not a declared id (for example `"model": "auto"`)
follows `[routes.default]`. To stay entirely on the LAN, with Strix Halo as
backstop:

```toml,norun
[routes.default]
id = "auto"
type = "escalation"
weak_target = "gb10_a_qwen_a3b"   # expands to the gb10_a + gb10_b replicas
strong_target = "local_r1_32b"    # Strix Halo, if both GB10s are unavailable
```

The chain is `gb10_a` → `gb10_b` → Strix Halo. `escalation` here is
**failure-based**, not quality-based. A cloud model as `strong_target` is
allowed, but it is the only way an unnamed request leaves the LAN, so make
that choice deliberately.

### 4. Verify

```bash
curl -s -D- -o /dev/null http://<strix-ip>:11435/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3.6-35b-a3b","messages":[{"role":"user","content":"hi"}]}' \
  | grep -i '^x-yardmaster'
#   x-yardmaster-target: gb10_a_qwen_a3b
#   x-yardmaster-nodes: gb10_a
#   x-yardmaster-failover: 0          (1 = served by the second replica)

curl -s http://<strix-ip>:11435/v1/capabilities | jq '.records[] | {id, reachability, placement, replicas: [.replicas[] | {target, reachability}]}'
```

The Console's **Capabilities** tab shows the same information in its
**placement** column (`gb10_a | gb10_b`, `✗` on a down replica). The **Metrics** tab shows `failover_count` per request.

## Switchyard algorithms on this hardware (once the data plane runs them)

In Switchyard, the request's `model` names a **route**: `"model": "classified"`
runs `[routes.classified]`. These configs pass validation today, and they are
the intended mapping for this hardware. Add them once the data plane routes
named routes. The full key reference is in [routing.md](routing.md); tiers
are described in [plan-execute.md](plan-execute.md).

### `stage_router`: cheap model unless the conversation needs more

The router uses conversation-stage signals. `efficient_first` starts on the
efficient model and moves up once confidence drops below the threshold.

```toml,norun
[routes.staged]
id = "staged"
type = "stage_router"
efficient_target = "local_llama32"      # Strix Halo
capable_target = "gb10_a_qwen_a3b"      # GB10 (replicated)
picker = "efficient_first"
confidence_threshold = 0.6
recent_turn_window = 3
```

### `llm_classifier`, capability mode: a judge decides per request

A small judge on the Strix Halo scores each request. Easy requests go to the
replicated mid-size model; hard ones go to the largest model on `gb10_b`. Keep `judge_egress = "deny"` so the
classifier never sees a cloud model.

```toml,norun
[routes.classified]
id = "classified"
type = "llm_classifier"
mode = "capability"
classifier_target = "local_llama32"     # judge on Strix Halo
weak_target = "gb10_a_qwen_a3b"
strong_target = "gb10_b_large"          # declare: largest model that fits on gb10_b
base_threshold = 0.7
threshold_step = 0.1
judge_egress = "deny"
```

`mode = "escalation"` uses the same judge to decide whether to escalate after
a weak answer, instead of before the request.

### `plan_execute`: big model plans, fast model executes

```toml,norun
[tiers.planner]
role = "planner"
models = ["<largest model on gb10_b>", "qwen3.6-35b-a3b"]   # gb10_b first, replicated model fallback

[tiers.worker]
role = "worker"
models = ["qwen3.6-35b-a3b", "deepseek-r1:32b"]      # GB10 replicas, then Strix Halo

[tiers.judge]
role = "judge"
models = ["llama3.2:latest"]                          # Strix Halo

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
the best fit for the DeepSeek Harness: plans go to the large model on
`gb10_b`, and tool-call loops go to the replicated model.

### `random`: A/B two models

```toml,norun
[routes.ab]
id = "ab"
type = "random"
targets = ["gb10_a_qwen_a3b", "gb10_b_gemma_utility"]
weights = [3, 1]
```

## Hard limits

- Replica order is declaration order. There is no load- or memory-aware
  balancing until PAIR `vram_aware` placement
  ([#33](https://github.com/pakgrou-porg/yardmaster/issues/33)) exists.
- A model on only one GB10 has no failover. Replicate it if that matters.
- The router does not start or stop vLLM, or move models between boxes. The
  registry notices model changes within one reconcile interval
  (`YM_CAPABILITIES_RECONCILE_S`, default 60 s).
