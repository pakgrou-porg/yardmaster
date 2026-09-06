<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Migrating from Switchyard

Written for someone running `switchyard-server` with a `routes.toml` today.

## What carries over unchanged

`schema_version`, `[llm_clients]`, `[targets]`, `[routes]`, and every routing
algorithm (`passthrough`, `random`, `stage_router`, `llm_classifier` with its
`capability` / `escalation` / `custom` modes, `composite`, `noop`) keep their
meaning. `yardmaster.toml` is a **strict superset**: an existing `routes.toml` is
a valid starting point. Validation is still `--dry-run`-strict and still rejects
unknown keys.

The launcher conventions for Claude Code, Codex, and OpenClaw carry over and are
surfaced in the desktop **Endpoints** view.

## The new axis: placement

In Switchyard a target names a URL (via its `llm_client`). In Yardmaster a target
also has a **`locality`**:

| Switchyard target | Yardmaster equivalent |
| --- | --- |
| points at a local engine you run | `locality = "cluster"` (default) — drop the URL; the `id` is a **logical model name** resolved by placement against paired nodes |
| points at a LAN box that is not a paired node | `locality = "lan"` with an `llm_client` or `provider`; gated by `[egress] allow_lan` (default true) |
| points at a cloud provider (OpenRouter, Anthropic, OpenAI, a cloud NIM/Bedrock/OCI endpoint) | `locality = "remote"` — **off unless** `[egress] allow_remote = true` **and** the desktop toggle |

### Converting a URL target to `locality = "remote"`

Before (Switchyard):

```toml,norun
[llm_clients.openrouter]
format = "openai_chat"
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"

[targets.strong]
id = "anthropic/claude-opus-5"
llm_client = "openrouter"
```

After (Yardmaster): move the endpoint into a `[providers.<name>]` table and mark
the target `remote`.

```toml,norun
[providers.openrouter]
api_key_env = "OPENROUTER_API_KEY"
budget_usd_per_day = 10.0

[targets.strong]
id = "anthropic/claude-opus-5"
locality = "remote"
provider = "openrouter"
```

Then set `[egress] allow_remote = true` and flip Settings → Egress. Until you do,
routes that select `strong` fall through to their next tier, and config
validation **rejects** a route whose only reachable target is `remote` while
`allow_remote = false`. Judge/classifier targets follow the same rule and also
need `judge_egress = "allow"`.

See [providers.md](providers.md) for `openrouter`, `venice`, `kie`, and the
generic `openai_compatible` kind (use it for a cloud NIM, OCI Generative AI, or a
Bedrock proxy — Yardmaster has no hosted control plane; those appear only as
`remote` targets).

### Converting a self-hosted vLLM target into a cluster node

If your Switchyard `routes.toml` points at a vLLM server you run, you have two
choices in Yardmaster:

1. **Keep it as an endpoint** — declare it as a `[providers.<name>]` of kind
   `openai_compatible` with an `http://<private-ip>:8000/v1` `base_url` and use
   a `locality = "lan"` target. It feeds placement, but ordered after cluster
   nodes at equal pressure (no telemetry).
2. **Make it a real cluster node** (recommended for machines you control) —
   install Yardmaster on that machine, pair it into the cluster with the PIN,
   and let PAIR's engine manager supervise an engine there. The model then has
   full scheduler telemetry and `locality = "cluster"`. vLLM itself is not a
   managed engine (non-goal), so run Ollama or LM Studio on that node for the
   managed path, or keep vLLM and treat the node as manual.

## Metrics

Switchyard's Prometheus metric names are preserved on `:4000/metrics`;
Yardmaster's are added under `yardmaster_`. Switchyard's `--routing-log-file`
becomes `--log-routing-file` (same JSON-lines decision-trace format, extended
with the placement fields). See [metrics.md](metrics.md).
