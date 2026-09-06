<!--
SPDX-FileCopyrightText: Copyright (c) 2026 Karl Miller
SPDX-License-Identifier: Apache-2.0
-->

# Providers

A **provider** is a remote or off-cluster model source. Providers are declared
with `[providers.<name>]` and referenced by a target with `provider = "<name>"`.
All four kinds sit behind one trait (`list_models`, `chat`, `stream`, `usage`,
`cost_estimate`) in `crates/yardmaster-providers`. See
[decisions/0011](decisions/0011-provider-trait-and-kinds.md).

Remote providers are **off by default**. A `locality = "remote"` target needs
`[egress] allow_remote = true` in `yardmaster.toml` **and** the desktop
Settings → Egress toggle. See [security.md](security.md).

## Common keys (every `[providers.<name>]`)

| Key | Meaning |
| --- | --- |
| `base_url` | Override the default endpoint. HTTPS required for `openrouter`/`venice`/`kie`; HTTP allowed only for `openai_compatible` on a private range. |
| `api_key_env` | Name of an environment variable holding the key. |
| `api_key_ref` | Key into the OS credential store (entered in Settings → Providers). |
| `models_allow` | Glob list; empty means all. |
| `models_deny` | Glob list. |
| `rate_limit_rpm` | Client-side request cap. |
| `budget_usd_per_day` | Daily spend cap, per provider per node. Exhaustion marks the provider unavailable; routes fall to their next tier; the UI shows it. |
| `timeout_s` | Per-request timeout. |
| `pricing` | `[providers.<name>.pricing]` sub-table: per-model `input_usd_per_mtok` / `output_usd_per_mtok`, used when the provider does not expose pricing. |

**Exactly one** of `api_key_env` / `api_key_ref` is required for `openrouter`,
`venice`, and `kie`. `openai_compatible` may omit both for an unauthenticated
local server. Keys never appear in `yardmaster.toml`, the renderer, JSON-RPC
payloads, decision traces, metric labels, or logs.

## `openrouter`

OpenAI-compatible at `https://openrouter.ai/api/v1`. Switchyard already supports
this shape. Yardmaster fetches `/models` for **pricing and context length** and
caches it 24 h so the cost model has inputs.

```toml,norun
[providers.openrouter]
api_key_env = "OPENROUTER_API_KEY"
budget_usd_per_day = 10.0
models_allow = ["anthropic/*", "deepseek/*"]

[targets.opus]
id = "anthropic/claude-opus-5"
locality = "remote"
provider = "openrouter"
```

List valid model ids: `curl https://openrouter.ai/api/v1/models`. Pricing source:
OpenRouter's `/models` response (`pricing.prompt` / `pricing.completion`).

## `venice`

OpenAI-compatible at `https://api.venice.ai/api/v1`. Yardmaster fetches `/models`
for inventory. **Venice-specific request parameters are passed through unchanged
when present** (e.g. `venice_parameters`).

```toml,norun
[providers.venice]
api_key_ref = "venice-default"
timeout_s = 120

[targets.venice_big]
id = "qwen3-235b"
locality = "remote"
provider = "venice"
```

List valid model ids: `curl -H "Authorization: Bearer $VENICE_API_KEY" https://api.venice.ai/api/v1/models`.
Pricing source: Venice `/models` where present, else `[providers.venice.pricing]`.
Known limitation: not all Venice models report pricing; set `pricing` for those.

## `kie`

`https://api.kie.ai`. **Not a plain OpenAI base URL** — it is a task-based
aggregator. The adapter is create-task + poll-result with a streaming shim: it
submits the task, polls until completion, and synthesizes a stream from the
final result. Its chat surface is read from kie's live API documentation **at
build time**; if kie changes it, the `kie` module is the single place to update.

kie's image, video, and music endpoints are **out of scope for routing**. The
provider exposes a `media` capability flag so a future tool layer can use them;
Yardmaster does not route to them.

```toml,norun
[providers.kie]
api_key_env = "KIE_API_KEY"
budget_usd_per_day = 3.0

[targets.kie_chat]
id = "kie/aggregated-chat-model"
locality = "remote"
provider = "kie"
```

Known limitation: latency includes the task queue; `timeout_s` should account
for it. Streaming is a shim over a completed result, so time-to-first-token
reflects the poll interval, not true first-token latency.

## `openai_compatible`

Generic, for any other URL: vLLM, NVIDIA NIM, OCI Generative AI's
OpenAI-compatible endpoint, a Bedrock proxy. This is also how OCI/AWS endpoints
appear — only as `locality = "remote"` targets, never a hosted control plane
(non-goal, section 9).

```toml,norun
[providers.local_vllm]
base_url = "http://192.168.1.50:8000/v1"   # HTTP allowed: private range
# no key: unauthenticated local server

[targets.vllm_llama]
id = "meta-llama/Llama-3.3-70B-Instruct"
locality = "lan"
provider = "local_vllm"
```

For a self-hosted vLLM you can reach on the LAN, prefer `locality = "lan"` (gated
by `[egress] allow_lan`, default true) over `remote`. See
[migrating-from-switchyard.md](migrating-from-switchyard.md) for turning a vLLM
target into a full cluster node instead.
