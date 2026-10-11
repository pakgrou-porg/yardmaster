<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# 29. Node topology and model replicas in the capability registry

- Status: accepted
- Date: 2026-10-11
- Deciders: @pakgrou-porg
- Extends [ADR-0028](0028-capability-registry-pipeline.md)

## Context

The reference home deployment is one AMD Strix Halo box (Radeon 8060S, 128 GB
unified, Ollama on ROCm) plus two NVIDIA GB10 boxes (128 GB unified each)
joined by a dedicated QSFP link. A model can run on either GB10 alone, or on
both as one engine (vLLM tensor/pipeline parallel over Ray, NCCL over the QSFP
link) when it does not fit in 128 GB.

ADR-0028's registry knew a model's *locality* (`cluster | lan | remote`) and
nothing about *where* it runs. Two concrete gaps:

1. **No placement.** `/v1/capabilities` could not say that a model is on
   `gb10_a`, or sharded across both GB10s, so neither the operator nor a
   client could tell a 256 GB-spanning engine from a single-box one.
2. **Duplicate ids were silently dropped.** `discover()` keyed records by
   model id, so the same model declared on both GB10s collapsed to whichever
   `[targets.*]` came last, and `resolveRoute()` only ever used the first. A
   second copy of a model gave no failover at all.

PAIR's scheduler (the real placement stage, [#24](https://github.com/pakgrou-porg/yardmaster/issues/24))
covers paired `cluster` nodes only once the Rust data plane lands. The GB10s
serve plain OpenAI-compatible vLLM endpoints (`locality = "lan"`), which PAIR
never sees.

## Decision

Describe hardware declaratively and make repeated model ids **replicas**.

```toml,norun
[nodes.gb10_a]
accelerator = "gb10"       # free-form label
memory_gb = 128
fabric = "qsfp"            # dedicated interconnect this node is on (optional)

[providers.gb10_pair_vllm]
base_url = "http://10.116.2.56:8010/v1"
nodes = ["gb10_a", "gb10_b"]   # one engine spanning both
```

- **`[nodes.<name>]`**: `accelerator`, `memory_gb`, `fabric`. Informational
  plus validation; no secrets, no addresses (the provider's `base_url` already
  has those).
- **`[providers.<name>].nodes`**: the nodes that provider's engine runs on.
  More than one means a sharded engine. The validator warns when the listed
  nodes do not share one `fabric`.
- **Capability record** gains `placement`
  (`{nodes, span: "single"|"multi", accelerators, memory_gb, fabric}`, or
  `null` for a provider with no `nodes`) and `replicas[]`
  (`{target, provider, locality, placement, reachability, reachability_checked_ms}`).
  The first-declared target is the primary: its `target`/`provider`/`locality`/
  `placement` stay on the record and its TOML metadata wins; later replicas
  only fill metadata gaps.
- **Reachability** is per replica. The record is `validated` if any replica
  is, `unreachable` once every probed replica failed, otherwise `discovered`.
  The dsh render still lists each model id once.
- **Routing.** Any hop for a replicated id (direct model-name match, the
  `passthrough` default route, each side of an `escalation` route) expands to
  every replica in declaration order. Replicas the registry last probed
  `unreachable` move to the back but are still tried. Failover is the existing
  `dispatch()` chain, with the same retry and backoff behaviour.
- **Failover never leaves the LAN.** A `remote` replica joins a chain only if
  the primary is itself `remote`. The validator warns on any id declared on
  both remote and non-remote targets.
- Responses carry **`x-yardmaster-nodes`** (for example `gb10_a,gb10_b`) when
  the hop that served them declares nodes, and `/v1/models` entries carry
  `placement[]`.
- An escalation hop is tagged `escalated`; only that changes the metrics
  `tier_decided`. Failing over between replicas is the same tier.

## Alternatives considered

- **A `nodes` key on `[targets.*]`.** Placement belongs to the engine
  endpoint, not the model. Every model on one vLLM server shares it, so
  putting it on the provider avoids repeating it per target.
- **Ranking replicas by free memory or load.** Needs live telemetry from each
  GB10. PAIR already gathers that for paired nodes, and `vram_aware`
  placement (#33) is its home. Declaration order is predictable and lets the
  operator decide.
- **Allow LAN-to-cloud replica failover.** It breaks the "prompts stay on the
  LAN by default" rule. Cloud fallback stays explicit (`escalation` route or
  naming a cloud model id).

## Consequences

- One model on both GB10s gives node-level failover today, in the interim
  router, with no Rust dependency.
- `[nodes]` is a new top-level key. The Console validator accepts it; the Rust
  `yardmaster-dataplane dry-run` must learn it when it stops being a stub.
- Still interim, same as ADR-0027. When PAIR placement runs for paired
  `cluster` nodes, replicas remain the mechanism for `lan` endpoints.
- Tests: `providerPlacement`, replica ordering and health, the LAN-only rule,
  and escalation tagging (`router.test.mjs`); replica discovery and
  per-replica reachability (`capabilities.test.mjs`); `[nodes]` validation
  (`validate.test.mjs`).
