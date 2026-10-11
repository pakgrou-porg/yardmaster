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

### 2. Decide how to use the GB10s

The two GB10s share 256 GB between them. Pick one mode per model; don't load
the same weights both ways at full size.

| Mode | When | Config |
| --- | --- | --- |
| **Independent + replicated** | model fits in 128 GB (dense ≤ ~70B at FP8, MoE ≤ ~120B at FP4) | one vLLM per GB10, same `id` on both → throughput + failover |
| **Independent, different models** | you want more distinct models online | one vLLM per GB10, different ids |
| **Spanned** | model needs > 128 GB | one vLLM + Ray across both (TP=2 over QSFP), served from the head node; `[providers.gb10_pair_vllm] nodes = ["gb10_a", "gb10_b"]` |

Strix Halo (Ollama/ROCm) handles small, always-on models: utility, judge,
embeddings, the Harness's cheap default. GB10 prefill is much faster, so put
long-context and agentic work there.

### 3. Pick the default route

Anything whose `model` is not a declared id (for example `"model": "auto"`)
follows `[routes.default]`. To stay entirely on the LAN, with the big engine
as backstop:

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
**placement** column (`gb10_a | gb10_b`, `gb10_a+gb10_b (qsfp)`, `✗` on a down
replica). The **Metrics** tab shows `failover_count` per request.

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

A small judge on the Strix Halo scores each request. Easy requests go to one
GB10; hard ones go to the spanned engine. Keep `judge_egress = "deny"` so the
classifier never sees a cloud model.

```toml,norun
[routes.classified]
id = "classified"
type = "llm_classifier"
mode = "capability"
classifier_target = "local_llama32"     # judge on Strix Halo
weak_target = "gb10_a_qwen_a3b"
strong_target = "gb10_pair_big"         # spans both GB10s
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
models = ["qwen3.8-235b-a22b", "qwen3.6-35b-a3b"]   # pair first, single GB10 fallback

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
the best fit for the DeepSeek Harness: plans go to the spanned GB10 engine and
tool-call loops to a single GB10.

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
- A GB10 that is part of the spanned engine is down whenever either node is
  down. Replicas on the single-node servers keep working only if those
  servers are still running.
- The router does not start or stop vLLM. Switching a GB10 between
  "independent" and "spanned" is done on the GB10s themselves. The registry
  notices within one reconcile interval (`YM_CAPABILITIES_RECONCILE_S`,
  default 60 s).
